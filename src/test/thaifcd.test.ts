import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Secretary } from '../channel';
import { Store } from '../store';
import { importThaiFcdFile, parseThaiFcd } from '../thaifcd';
import { NOW, echoProvider, testConfig } from './helpers';

/** A food page download in ThaiFCD's format (an HTML table saved as .xls); made-up products and values. */
function foodFile(o: { code: string; th: string; en: string; serving?: [string, string]; rows: [string, string, string, string][] }): string {
  const label = (s: string) => `<tr><td colspan="12">${s}</td></tr>\r\n`;
  const nutrient = ([name, unit, perServing, per100]: [string, string, string, string]) =>
    `<tr><td>${name}</td><td>method</td><td>${unit}</td><td>${perServing}</td><td>${per100}</td><td></td><td>-</td><td>-</td><td>-</td><td>-</td><td></td><td></td></tr>\r\n`;
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><title>Food search - Food search by food name</title></head><body><table>\r\n' +
    label(`Food Code:\t\t\n\t\t${o.code}`) +
    label(`Thai name:\n\t\t${o.th}`) +
    label(`English name:\n\t\t${o.en}`) +
    label('Scientific name:') +
    label('Manufacturer:\n\t\tบริษัท ทดสอบ จำกัด') +
    label(`Serving Size (หนึ่งหน่วยบริโภค) (g or mL):\n\t\t${o.serving?.[1] ?? '-'}`) +
    label(`Unit per serving (บรรจุภัณฑ์):\n\t\t${o.serving?.[0] ?? ''}`) +
    '<tr><td>Nutrients(สารอาหาร)</td><td>Detail(รายละเอียด)</td><td>Unit(หน่วย)</td><td>Content per 1 Serving</td><td>Content per 100 g of food(ปริมาณต่อ 100 กรัมอาหาร)</td><td>Deriv.By</td><td>n</td><td>Min</td><td>Max</td><td>SD</td><td>Footnote</td><td>Last Updated</td></tr>\r\n' +
    o.rows.map(nutrient).join('') +
    label('Data collected from nutrition labelling: 2015') +
    '</table><a href="http://www.inmu.mahidol.ac.th/thaifcd">Thai FCD</a></body></html>'
  );
}

const CRACKER = foodFile({
  code: 'Z999901',
  th: 'แครกเกอร์ทดสอบ, ทดสอบ',
  en: 'Cracker, test',
  serving: ['2 ห่อ', '36.00'],
  rows: [
    ['Energy, by calculation', 'kcal', '-', '-'],
    ['Total energy - by calculation', 'kcal', '170', '(472)'],
    ['Protein, total', 'g', '3.00', '8.33'],
    ['Fat, total', 'g', '6.00', '16.67'],
    ['Carbohydrate, available', 'g', '-', '-'],
    ['Carbohydrate, total', 'g', '26.00', '72.22'],
    ['Dietary fibre', 'g', '1.0', '2.8'],
    ['Sugars, total', 'g', '5.00', '13.89'],
    ['Sodium', 'mg', '220', '611'],
  ],
});

const RICE = foodFile({
  code: 'A999901',
  th: 'ข้าวทดสอบ, หุงสุก',
  en: 'Rice, test, cooked',
  rows: [
    ['Energy, by calculation', 'kcal', '-', '145'],
    ['Protein, total', 'g', '-', '2.6'],
    ['Fat, total', 'g', '-', '0.4'],
    ['Carbohydrate, available', 'g', '-', '32.1'],
  ],
});

const LIST =
  '<html><body><table><tr><td>No.(ลำดับ)</td><td>Thai Name(ชื่อภาษาไทย)</td><td>English Name(ชื่อภาษาอังกฤษ)</td><td>Scientific Name (ชื่อวิทยาศาสตร์)</td><td>Food Code<br>(รหัส)</td></tr>' +
  '<tr><td>1</td><td>แครกเกอร์ทดสอบ</td><td>Cracker</td><td>บริษัท ทดสอบ จำกัด</td><td>Z999901</td></tr></table><a href="http://www.inmu.mahidol.ac.th/thaifcd">x</a></body></html>';

describe('Thai Food Composition Database files', () => {
  it('reads a food: labels, and nutrients per serving and per 100 g', () => {
    expect(parseThaiFcd(CRACKER)).toEqual({
      code: 'Z999901',
      nameTh: 'แครกเกอร์ทดสอบ, ทดสอบ',
      nameEn: 'Cracker, test',
      manufacturer: 'บริษัท ทดสอบ จำกัด',
      servingG: 36,
      servingUnit: '2 ห่อ',
      perServing: { kcal: 170, protein: 3, fat: 6, carbs: 26, fibre: 1, sugar: 5, sodiumMg: 220 },
      per100: { kcal: 472, protein: 8.33, fat: 16.67, carbs: 72.22, fibre: 2.8, sugar: 13.89, sodiumMg: 611 },
    });
    // A generic food has only per-100 g values.
    expect(parseThaiFcd(RICE)).toMatchObject({ code: 'A999901', per100: { kcal: 145, carbs: 32.1 } });
    expect(parseThaiFcd(RICE)!.perServing).toBeUndefined();
    expect(parseThaiFcd(LIST)).toBeNull();
    expect(parseThaiFcd('<html>hello</html>')).toBeNull();
  });

  it('saves foods to the personal database (per serving, or per 100 g), updating rather than duplicating', () => {
    const store = new Store(null);
    expect(importThaiFcdFile(store, 'c', Buffer.from(CRACKER))).toMatch(/^🥫 Saved from the Thai Food Composition Database: #\d+ แครกเกอร์ทดสอบ, ทดสอบ · 2 ห่อ \(36 g\): 170 kcal · P 3 g · C 26 g · F 6 g \(code Z999901\)/);
    importThaiFcdFile(store, 'c', Buffer.from(CRACKER));
    importThaiFcdFile(store, 'c', Buffer.from(RICE));
    expect(store.foodDb('c').map((f) => [f.fcdCode, f.name, f.brand, f.serving, f.kcal, f.source])).toEqual([
      ['Z999901', 'แครกเกอร์ทดสอบ, ทดสอบ', 'Cracker, test', '2 ห่อ (36 g)', 170, 'thaifcd'],
      ['A999901', 'ข้าวทดสอบ, หุงสุก', 'Rice, test, cooked', '100 g', 145, 'thaifcd'],
    ]);
    expect(importThaiFcdFile(store, 'c', Buffer.from(LIST))).toMatch(/^📋 This ThaiFCD file is a list of foods/);
    expect(importThaiFcdFile(store, 'c', Buffer.from('<html><body>An unrelated page</body></html>'))).toBeNull();
  });

  it('imports a ThaiFCD file sent to the bot without asking the AI; other files still go to the AI', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const echo = echoProvider('a summary');
    const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent, () => NOW), null, async () => '');
    const msg = (name: string, data: string) => ({ platform: 'telegram' as const, chatKey: 'telegram:1', userId: '1', text: '', file: { name, mime: 'application/vnd.ms-excel', data: Buffer.from(data) } });
    const r = await s.handle(msg('ThaiFCD-food-search-by-food-name-Z999901_261111185400.xls', CRACKER));
    expect(r!.text).toMatch(/^🥫 Saved from the Thai Food Composition Database/);
    expect(echo.requests).toHaveLength(0);
    expect(store.foodDb('telegram:1')).toHaveLength(1);
    await s.handle(msg('notes.txt', 'Shopping list: eggs, rice'));
    expect(echo.requests).toHaveLength(1);
  });
});
