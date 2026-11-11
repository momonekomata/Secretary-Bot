import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { Agent } from '../agent';
import { findBarcodes, validBarcode } from '../barcode';
import { Briefings } from '../briefings';
import { Secretary } from '../channel';
import { runCommand } from '../commands';
import { unzipEntry } from '../documents';
import { buildExport } from '../export';
import { lookupBarcode, openFoodFacts } from '../fooddb';
import { HealthDb } from '../healthdb';
import { Store } from '../store';
import { runTool } from '../tools';
import { NOW, echoProvider, testConfig } from './helpers';

afterEach(() => vi.unstubAllGlobals());

/** A barcode image made offline with ZXing's writer (made-up product number). */
async function barcodePng(code: string): Promise<Buffer> {
  const wasm = readFileSync(createRequire(import.meta.url).resolve('zxing-wasm/writer/zxing_writer.wasm'));
  await prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  const out = await writeBarcode(code, { format: 'EAN13', scale: 3 });
  return Buffer.from(await out.image!.arrayBuffer());
}

/** Open Food Facts answers for made-up products. */
function offFetch(products: Record<string, Record<string, unknown>>) {
  const asked: string[] = [];
  const fn = (async (url: string) => {
    const code = /product\/(\d+)\.json/.exec(url)![1];
    asked.push(code);
    const product = products[code];
    return product ? Response.json({ status: 1, product }) : Response.json({ status: 0 }, { status: 404 });
  }) as typeof fetch;
  return { fn, asked };
}
const CHIPS = { product_name: 'Test Potato Chips', brands: 'TestBrand, Other', serving_size: '1 pack (48 g)', nutriments: { 'energy-kcal_serving': 255, proteins_serving: 3, carbohydrates_serving: 25.2, fat_serving: 16 } };
const MILK = { product_name_th: 'นมทดสอบ', product_name: 'Test Milk', quantity: '225 ml', nutriments: { 'energy-kcal_100g': 62, proteins_100g: 3.2, carbohydrates_100g: 4.8, fat_100g: 3.4 } };

describe('reading barcodes', () => {
  it('checks the check digit of EAN-13, EAN-8 and UPC-A numbers', () => {
    expect(validBarcode('8850999220017')).toBe(true);
    expect(validBarcode('8850999220018')).toBe(false);
    expect(validBarcode('96385074')).toBe(true); // EAN-8
    expect(validBarcode('036000291452')).toBe(true); // UPC-A
    expect(validBarcode('12345')).toBe(false);
  });

  it('reads a barcode from an image on the NAS itself, without the network', async () => {
    const png = await barcodePng('8850999220017');
    vi.stubGlobal('fetch', async () => {
      throw new Error('the barcode reader must not use the network');
    });
    expect(await findBarcodes(png)).toEqual(['8850999220017']);
    expect(await findBarcodes(Buffer.from('not an image'))).toEqual([]);
  });
});

describe('Open Food Facts', () => {
  it('gives values per serving, or per 100 g/ml, and tries UPC-A with a leading 0', async () => {
    const off = offFetch({ '8850999220017': CHIPS, '0036000291452': MILK });
    expect(await openFoodFacts('8850999220017', off.fn)).toEqual({ barcode: '8850999220017', name: 'Test Potato Chips', brand: 'TestBrand', serving: '1 pack (48 g)', kcal: 255, protein: 3, carbs: 25.2, fat: 16 });
    expect(await openFoodFacts('036000291452', off.fn)).toMatchObject({ name: 'นมทดสอบ', serving: '100 ml', kcal: 62, protein: 3.2 });
    expect(off.asked).toEqual(['8850999220017', '036000291452', '0036000291452']);
    expect(await openFoodFacts('4006381333931', off.fn)).toBeNull();
  });

  it('checks the personal database first and saves what Open Food Facts finds', async () => {
    const store = new Store(null);
    const off = offFetch({ '8850999220017': CHIPS });
    const first = await lookupBarcode(store, 'c', '8850999220017', off.fn);
    expect(first).toMatchObject({ found: 'openfoodfacts', food: { name: 'Test Potato Chips', kcal: 255, source: 'openfoodfacts' } });
    const again = await lookupBarcode(store, 'c', '8 850999 220017', off.fn);
    expect(again).toMatchObject({ found: 'mine' });
    expect(off.asked).toHaveLength(1);
    expect(await lookupBarcode(store, 'c', '8850999220018', off.fn)).toEqual({ food: null, invalid: true });
  });
});

describe('food database tools', () => {
  it('look up, save corrections, search, and count what is logged', async () => {
    const store = new Store(null);
    const ctx = { chatKey: 'c', store, cfg: testConfig(), google: null, now: () => NOW };
    vi.stubGlobal('fetch', offFetch({ '8850999220017': CHIPS }).fn);
    const found = await runTool('food_barcode_lookup', { barcode: '8850999220017' }, ctx);
    expect(found.content).toMatch(/^Found from Open Food Facts \(now saved to the personal database\):\n#\d+ Test Potato Chips \(TestBrand\) · 1 pack \(48 g\): 255 kcal/);
    const id = store.foodDb('c')[0].id;
    expect(found.content).toContain(`food_db_id ${id}`);

    // The user corrects it from the label: same barcode updates the entry and keeps its #.
    await runTool('food_db_save', { barcode: '8850999220017', name: 'Test Potato Chips', brand: 'TestBrand', serving: '1 pack (48 g)', kcal: 250, protein_g: 3, carbs_g: 24, fat_g: 16, source: 'label' }, ctx);
    expect(store.foodDb('c')).toHaveLength(1);
    expect(store.foodDb('c')[0]).toMatchObject({ id, kcal: 250, source: 'label' });

    await runTool('food_db_save', { barcode: '', name: 'My protein shake', brand: '', serving: '1 glass', kcal: 180, protein_g: 25, carbs_g: 8, fat_g: 4, source: 'user' }, ctx);
    const item = { name: 'Test Potato Chips', portion: '1 pack', kcal: 250, protein_g: 3, carbs_g: 24, fat_g: 16, food_db_id: id };
    await runTool('food_log_add', { meal: 'snack', eaten_at: '', items: [item] }, ctx);
    await runTool('food_log_add', { meal: 'snack', eaten_at: '', items: [item] }, ctx);
    expect(store.foodDb('c').find((f) => f.id === id)!.timesLogged).toBe(2);
    expect((await runTool('food_db_search', { query: 'shake' }, ctx)).content).toMatch(/My protein shake · 1 glass: 180 kcal/);
    expect((await runTool('food_db_search', { query: '' }, ctx)).content.split('\n')[0]).toContain('Test Potato Chips'); // most logged first
    expect((await runTool('food_barcode_lookup', { barcode: '1234567890123' }, ctx)).content).toMatch(/not a valid barcode/);
  });
});

describe('barcodes in photos', () => {
  it('tells the AI the barcode found in a food photo', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const echo = echoProvider('logged');
    const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent, () => NOW), null, async () => '');
    const png = await barcodePng('8850999220017');
    await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'snack', images: [{ mediaType: 'image/png', data: png.toString('base64') }] });
    expect(echo.requests[0].userText).toBe('snack\n[Barcode in the photo: 8850999220017]');
  });
});

describe('/fooddb', () => {
  it('lists, searches and removes foods, and /export includes them', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const agent = new Agent(cfg, store, { gemini: echoProvider().provider }, null, () => NOW);
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings: new Briefings(cfg, store, agent, () => NOW), status: async () => '', now: () => NOW };
    expect((await runCommand('/fooddb', ctx))!.text).toMatch(/^🥫 Your food database is empty\./);
    const chips = store.saveFood('telegram:1', { barcode: '8850999220017', name: 'Test Potato Chips', serving: '1 pack', kcal: 255, protein: 3, carbs: 25, fat: 16, source: 'openfoodfacts' });
    store.saveFood('telegram:1', { name: 'My protein shake', serving: '1 glass', kcal: 180, protein: 25, carbs: 8, fat: 4, source: 'user' });
    expect((await runCommand('/fooddb', ctx))!.text).toMatch(/^🥫 Your food database \(2\), most logged first/);
    const found = (await runCommand('/fooddb chips', ctx))!.text;
    expect(found).toContain('Test Potato Chips');
    expect(found).not.toContain('protein shake');
    const csv = unzipEntry(buildExport(store, new HealthDb(null), 'telegram:1', 'Asia/Bangkok', NOW).data, 'food_database.csv')!.toString('utf8');
    expect(csv).toContain(`${chips.id},8850999220017,Test Potato Chips,,1 pack,255,3,25,16,openfoodfacts,0`);
    expect((await runCommand(`/fooddb remove ${chips.id}`, ctx))!.text).toBe('🗑️ Removed from your food database: Test Potato Chips');
    expect(store.foodDb('telegram:1')).toHaveLength(1);
  });
});
