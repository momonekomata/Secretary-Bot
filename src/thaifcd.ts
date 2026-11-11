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
  // Labels are table rows in the downloads ("Food Code: Z060002"), plain text on the web page.
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const label = (name: string) => {
    const row = rows.find((r) => r.length === 1 && r[0].toLowerCase().startsWith(name.toLowerCase()))?.[0];
    if (row !== undefined) return row.replace(/^[^:]*:\s*/, '').trim();
    const m = new RegExp(`${name.replace(/[()]/g, '\\$&')}[^:\\n]*:\\s*\\n*\\s*([^\\n]+)`, 'i').exec(text);
    return m && !/^[A-Z][a-z]+ name:|^Scientific|^Save as/.test(m[1].trim()) ? m[1].trim() : '';
  };
  const code = label('Food Code');
  // Columns are found by their headings: branded products have "per 1 Serving" and "per 100 g"; other foods only "per 100 g".
  const head = rows.find((r) => /^Nutrients/i.test(r[0] ?? '') && r.length >= 3);
  if (!code || !head) return null;
  const per100Col = head.findIndex((c) => /per 100 g/i.test(c));
  const servingCol = head.findIndex((c) => /per 1 Serving/i.test(c));
  if (per100Col < 0) return null;
  const table = rows.slice(rows.indexOf(head) + 1).filter((r) => r.length > per100Col);
  const pick = (col: number): ThaiFcdNutrients => {
    const v = (...names: string[]) => {
      for (const n of names) {
        const x = value(table.find((r) => r[0].toLowerCase() === n.toLowerCase())?.[col]);
        if (Number.isFinite(x)) return x;
      }
      return NaN;
    };
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
  const per100 = pick(per100Col);
  const perServing = servingCol >= 0 ? pick(servingCol) : null;
  if (!Number.isFinite(per100.kcal) && !(perServing && Number.isFinite(perServing.kcal))) return null;
  const servingG = value(label('Serving Size'));
  return {
    code,
    nameTh: label('Thai name'),
    nameEn: label('English name'),
    manufacturer: label('Manufacturer'),
    ...(Number.isFinite(servingG) && servingG > 0 ? { servingG, servingUnit: label('Unit per serving') } : {}),
    ...(perServing && Number.isFinite(perServing.kcal) ? { perServing } : {}),
    per100,
  };
}

/** A ThaiFCD food page link ("…/thaifcd/…food_name/?dbcode=STD&…&id=952…") → its database and food number. */
export function thaiFcdRef(text: string): { dbcode: string; id: string; url?: string } | null {
  const url = /https?:\/\/(?:www\.)?inmu\.mahidol\.ac\.th\/thaifcd\/\S+/i.exec(text)?.[0];
  if (!url) return null;
  const q = url.replace(/&amp;/g, '&');
  const id = /[?&](?:food_)?id=(\d+)/.exec(q)?.[1];
  if (!id) return null;
  return { dbcode: /[?&]dbcode=(\w+)/.exec(q)?.[1] ?? 'STD', id, url: q };
}

const FCD = 'https://inmu.mahidol.ac.th/thaifcd/foodsearch';

/**
 * Fetches a food by its number: the site's "Save as Excel" export, or else the food page itself (same table).
 * Returns null when neither has the food's values.
 */
export async function fetchThaiFcd(ref: { dbcode: string; id: string; url?: string }, fetchFn: typeof fetch = fetch): Promise<ThaiFcdFood | null> {
  const db = encodeURIComponent(ref.dbcode);
  const id = encodeURIComponent(ref.id);
  // The export first; then the page the user linked (with its own parameters), else the page by number.
  const pages = [`${FCD}/food_name_result_std_excel/?dbcode=${db}&food_id=${id}&mode=EXCEL`, ref.url ?? `${FCD}/food_name/?dbcode=${db}&id=${id}`];
  for (const url of pages) {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': 'SecretaryBot/1.0 (personal Telegram bot)' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const food = parseThaiFcd(await res.text());
      if (food) return food;
    } catch {
      // Timed out or unreachable: try the next address.
    }
  }
  return null;
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

/** Reply for a ThaiFCD link the user sent: fetches the food and saves it. Null when the text has no food link. */
export async function importThaiFcdLink(store: Store, chatKey: string, text: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const ref = thaiFcdRef(text);
  if (!ref) return null;
  const food = await fetchThaiFcd(ref, fetchFn);
  if (!food) return t(`I couldn't read food ${ref.id} from the Thai Food Composition Database.`, `อ่านข้อมูลอาหารหมายเลข ${ref.id} จากฐานข้อมูลคุณค่าทางโภชนาการอาหารไทยไม่ได้`);
  return savedReply(saveThaiFcd(store, chatKey, food), food.code);
}

function savedReply(saved: PersonalFood, code: string): string {
  return t(
    `🥫 Saved from the Thai Food Composition Database: #${saved.id} ${saved.name} · ${saved.serving}: ${saved.kcal} kcal · P ${saved.protein} g · C ${saved.carbs} g · F ${saved.fat} g (code ${code}). See /fooddb.`,
    `🥫 บันทึกจากฐานข้อมูลคุณค่าทางโภชนาการอาหารไทยแล้ว: #${saved.id} ${saved.name} · ${saved.serving}: ${saved.kcal} kcal · โปรตีน ${saved.protein} g · คาร์บ ${saved.carbs} g · ไขมัน ${saved.fat} g (รหัส ${code}) ดูได้ที่ /fooddb`,
  );
}

/** Reply for a file the user sent: imports a ThaiFCD food, or explains a list file. Null when it isn't ThaiFCD. */
export function importThaiFcdFile(store: Store, chatKey: string, data: Buffer): string | null {
  const html = data.toString('utf8');
  if (!/thaifcd|Food Code/i.test(html)) return null;
  const food = parseThaiFcd(html);
  if (food) return savedReply(saveThaiFcd(store, chatKey, food), food.code);
  if (isThaiFcdList(html)) {
    return t(
      "📋 This ThaiFCD file is a list of foods (names and codes) without nutrient values. Open a food on the site and send me its download; I'll save it to your food database.",
      '📋 ไฟล์ ThaiFCD นี้เป็นรายชื่ออาหาร (ชื่อและรหัส) ไม่มีค่าสารอาหาร เปิดอาหารแต่ละรายการบนเว็บแล้วส่งไฟล์ดาวน์โหลดของรายการนั้นมา ฉันจะบันทึกลงฐานข้อมูลอาหารให้',
    );
  }
  return null;
}
