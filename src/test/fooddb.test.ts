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

describe('USDA FoodData Central and the Thai Food Composition Database', () => {
  const usdaResponse = {
    foods: [
      { fdcId: 168878, description: 'Rice, white, long-grain, regular, enriched, cooked', dataType: 'SR Legacy', foodNutrients: [
        { nutrientId: 1008, nutrientNumber: '208', nutrientName: 'Energy', unitName: 'KCAL', value: 130 },
        { nutrientId: 1003, nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 2.69 },
        { nutrientId: 1005, nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 28.17 },
        { nutrientId: 1004, nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.28 },
      ] },
      // Foundation foods may give energy only as Atwater energy (and in kJ too).
      { fdcId: 748967, description: 'Eggs, Grade A, Large, egg whole', dataType: 'Foundation', foodNutrients: [
        { nutrientId: 1062, nutrientNumber: '268', nutrientName: 'Energy', unitName: 'kJ', value: 599 },
        { nutrientId: 2048, nutrientNumber: '958', nutrientName: 'Energy (Atwater Specific Factors)', unitName: 'KCAL', value: 143 },
        { nutrientId: 1003, nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: 12.4 },
        { nutrientId: 1004, nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: 9.96 },
      ] },
      { fdcId: 1, description: 'No energy listed', dataType: 'Survey (FNDDS)', foodNutrients: [] },
    ],
  };

  it('searches generic foods per 100 g, with the demo key unless a key is set', async () => {
    const { usdaSearch, usdaLine } = await import('../nutrition');
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), Response.json(usdaResponse))) as typeof fetch;
    const found = await usdaSearch('rice, white, cooked', '', fetchFn);
    expect(urls[0]).toContain('api.nal.usda.gov/fdc/v1/foods/search?');
    expect(urls[0]).toContain('api_key=DEMO_KEY');
    expect(urls[0]).toContain('dataType=SR+Legacy');
    expect(found).toEqual([
      { fdcId: 168878, name: 'Rice, white, long-grain, regular, enriched, cooked', dataType: 'SR Legacy', kcal: 130, protein: 2.7, carbs: 28.2, fat: 0.3 },
      { fdcId: 748967, name: 'Eggs, Grade A, Large, egg whole', dataType: 'Foundation', kcal: 143, protein: 12.4, carbs: 0, fat: 10 },
    ]);
    expect(usdaLine(found[0])).toBe('Rice, white, long-grain, regular, enriched, cooked [SR Legacy, FDC 168878] per 100 g: 130 kcal · P 2.7 g · C 28.2 g · F 0.3 g');
    await usdaSearch('egg', 'my-key', fetchFn);
    expect(urls[1]).toContain('api_key=my-key');
    const limited = (async () => new Response('', { status: 429 })) as typeof fetch;
    await expect(usdaSearch('egg', '', limited)).rejects.toThrow(/too many requests for this hour \(set a free USDA_API_KEY/);
  });

  it('is a tool the AI can use, and looked-up values are saved with where they came from', async () => {
    vi.stubGlobal('fetch', async () => Response.json(usdaResponse));
    const store = new Store(null);
    const ctx = { chatKey: 'c', store, cfg: testConfig(), google: null, now: () => NOW };
    const r = await runTool('usda_food_search', { query: 'cooked rice' }, ctx);
    expect(r.content).toMatch(/^USDA FoodData Central, per 100 g:\nRice, white/);
    await runTool('food_db_save', { barcode: '', name: 'ข้าวมันไก่', brand: '', serving: '1 plate (300 g)', kcal: 596, protein_g: 23, carbs_g: 78, fat_g: 21, source: 'thaifcd' }, ctx);
    expect(store.foodDb('c')[0]).toMatchObject({ name: 'ข้าวมันไก่', source: 'thaifcd' });
    const { systemPrompt } = await import('../agent');
    expect(systemPrompt({ botName: 'Bot', persona: '' }, false)).toContain('Thai Food Composition Database of the Institute of Nutrition, Mahidol University (INMU');
  });
});
