import { t } from './i18n';
import type { PersonalFood, Store } from './store';

/**
 * Thai Food Composition Database (INMU, Mahidol University). The site has no API; each food's page has a download
 * (an HTML table saved as .xls) with its labels and a nutrient table per serving and per 100 g. The user sends
 * those files to the bot, which reads them here and saves them to the personal food database.
 */

export interface ThaiFcdNutrients {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  fibre: number;
  sugar: number;
  sodiumMg: number;
}

export interface ThaiFcdFood {
  code: string;
  nameTh: string;
  nameEn: string;
  manufacturer: string;
  /** Serving size in g or mL, and how it's described ("2 ห่อ"); absent for generic foods. */
  servingG?: number;
  servingUnit?: string;
  perServing?: ThaiFcdNutrients;
  per100: ThaiFcdNutrients;
}

/** The rows of the (first) HTML table, cell text with whitespace collapsed. */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) =>
      c
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    rows.push(cells);
  }
  return rows;
}

/** "472", "(472)", "1,234.5" → number; "-" or empty → NaN. */
const value = (s: string | undefined) => {
  const v = (s ?? '').replace(/[(),\s]/g, '');
  return v === '' || v === '-' ? NaN : Number(v);
};

/**
 * Reads one food's ThaiFCD download. Returns null when the file isn't one (for example the food-group list, which
 * has names and codes but no nutrients).
 */
export function parseThaiFcd(html: string): ThaiFcdFood | null {
  const rows = tableRows(html);
  const label = (name: string) => rows.find((r) => r.length === 1 && r[0].toLowerCase().startsWith(name.toLowerCase()))?.[0].replace(/^[^:]*:\s*/, '').trim() ?? '';
  const code = label('Food Code');
  const header = rows.findIndex((r) => /^Nutrients/i.test(r[0] ?? '') && r.length >= 5);
  if (!code || header < 0) return null;
  const table = rows.slice(header + 1).filter((r) => r.length >= 5);
  const find = (...names: string[]) => names.map((n) => table.find((r) => r[0].toLowerCase() === n.toLowerCase())).find((r) => r && (Number.isFinite(value(r[3])) || Number.isFinite(value(r[4]))));
  const pick = (col: 3 | 4): ThaiFcdNutrients => {
    const v = (...names: string[]) => value(find(...names)?.[col]);
    return {
      kcal: v('Energy, by calculation', 'Total energy - by calculation'),
      protein: v('Protein, total'),
      fat: v('Fat, total'),
      carbs: v('Carbohydrate, available', 'Carbohydrate, total'),
      fibre: v('Dietary fibre'),
      sugar: v('Sugars, total'),
      sodiumMg: v('Sodium'),
    };
  };
  const per100 = pick(4);
  const perServing = pick(3);
  if (!Number.isFinite(per100.kcal) && !Number.isFinite(perServing.kcal)) return null;
  const servingG = value(label('Serving Size'));
  return {
    code,
    nameTh: label('Thai name'),
    nameEn: label('English name'),
    manufacturer: label('Manufacturer'),
    ...(Number.isFinite(servingG) && servingG > 0 ? { servingG, servingUnit: label('Unit per serving') } : {}),
    ...(Number.isFinite(perServing.kcal) ? { perServing } : {}),
    per100,
  };
}

/** True for a ThaiFCD food-group list (names and codes only, no nutrients). */
export function isThaiFcdList(html: string): boolean {
  const rows = tableRows(html);
  const head = rows.find((r) => r.some((c) => /^Food Code/i.test(c)) && r.some((c) => /^Thai Name/i.test(c)));
  return !!head && !rows.some((r) => /^Nutrients/i.test(r[0] ?? ''));
}

/** Saves a ThaiFCD food to the personal database: per serving when the label gives one, else per 100 g. */
export function saveThaiFcd(store: Store, chatKey: string, f: ThaiFcdFood): PersonalFood {
  const n = f.perServing ?? f.per100;
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
  const serving = f.perServing && f.servingG ? `${f.servingUnit ? `${f.servingUnit} ` : ''}(${f.servingG} g)`.trim() : '100 g';
  return store.saveFood(chatKey, {
    fcdCode: f.code,
    name: f.nameTh || f.nameEn || f.code,
    ...(f.nameEn && f.nameTh ? { brand: f.nameEn } : {}),
    serving,
    kcal: Math.round(Number.isFinite(n.kcal) ? n.kcal : 0),
    protein: r(n.protein),
    carbs: r(n.carbs),
    fat: r(n.fat),
    source: 'thaifcd',
  });
}

/** Reply for a file the user sent: imports a ThaiFCD food, or explains a list file. Null when it isn't ThaiFCD. */
export function importThaiFcdFile(store: Store, chatKey: string, data: Buffer): string | null {
  const html = data.toString('utf8');
  if (!/thaifcd|Food Code/i.test(html)) return null;
  const food = parseThaiFcd(html);
  if (food) {
    const saved = saveThaiFcd(store, chatKey, food);
    return t(
      `🥫 Saved from the Thai Food Composition Database: #${saved.id} ${saved.name} · ${saved.serving}: ${saved.kcal} kcal · P ${saved.protein} g · C ${saved.carbs} g · F ${saved.fat} g (code ${food.code}). See /fooddb.`,
      `🥫 บันทึกจากฐานข้อมูลคุณค่าทางโภชนาการอาหารไทยแล้ว: #${saved.id} ${saved.name} · ${saved.serving}: ${saved.kcal} kcal · โปรตีน ${saved.protein} g · คาร์บ ${saved.carbs} g · ไขมัน ${saved.fat} g (รหัส ${food.code}) ดูได้ที่ /fooddb`,
    );
  }
  if (isThaiFcdList(html)) {
    return t(
      "📋 This ThaiFCD file is a list of foods (names and codes) without nutrient values. Open a food on the site and send me its download; I'll save it to your food database.",
      '📋 ไฟล์ ThaiFCD นี้เป็นรายชื่ออาหาร (ชื่อและรหัส) ไม่มีค่าสารอาหาร เปิดอาหารแต่ละรายการบนเว็บแล้วส่งไฟล์ดาวน์โหลดของรายการนั้นมา ฉันจะบันทึกลงฐานข้อมูลอาหารให้',
    );
  }
  return null;
}
