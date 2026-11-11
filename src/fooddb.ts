import { barcodeDigits, validBarcode } from './barcode';
import { t } from './i18n';
import type { PersonalFood, Store } from './store';

/**
 * The user's own food database: products found by barcode, read from nutrition labels, or corrected by the user.
 * Lookups go: personal database → Open Food Facts (free, no key) → the user's label photo or an estimate.
 */

export interface FoodFacts {
  barcode?: string;
  name: string;
  brand?: string;
  /** What the numbers are for, e.g. "1 pack (60 g)" or "100 g". */
  serving: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

const OFF_FIELDS = 'code,product_name,product_name_th,product_name_ja,product_name_en,brands,serving_size,quantity,nutriments';

/**
 * Looks a barcode up on Open Food Facts. Per serving when the product lists it, else per 100 g/ml.
 * Returns null when the product isn't there or has no calories.
 */
export async function openFoodFacts(barcode: string, fetchFn: typeof fetch = fetch): Promise<FoodFacts | null> {
  // UPC-A (12 digits) is also stored as EAN-13 with a leading 0.
  const codes = barcode.length === 12 ? [barcode, `0${barcode}`] : [barcode];
  for (const code of codes) {
    const res = await fetchFn(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, {
      headers: { 'User-Agent': 'SecretaryBot/1.0 (personal Telegram bot)' },
    });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Open Food Facts ${res.status}`);
    const json = (await res.json()) as { status?: number; product?: Record<string, unknown> };
    const p = json.product;
    if (!json.status || !p) continue;
    const n = (p.nutriments ?? {}) as Record<string, number | string | undefined>;
    const num = (k: string) => (n[k] === undefined || n[k] === '' ? NaN : Number(n[k]));
    const perServing = Number.isFinite(num('energy-kcal_serving'));
    const per = perServing ? 'serving' : '100g';
    const kcal = num(`energy-kcal_${per}`);
    if (!Number.isFinite(kcal)) continue;
    const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
    const name = String(p.product_name_th || p.product_name_ja || p.product_name || p.product_name_en || '').trim();
    return {
      barcode,
      name: name || t('Unnamed product', 'สินค้าไม่มีชื่อ'),
      brand: String(p.brands ?? '').split(',')[0].trim() || undefined,
      serving: perServing ? `${String(p.serving_size ?? '1 serving')}` : `100 ${/ml|l\b/i.test(String(p.quantity ?? '')) ? 'ml' : 'g'}`,
      kcal: Math.round(kcal),
      protein: round(num(`proteins_${per}`)),
      carbs: round(num(`carbohydrates_${per}`)),
      fat: round(num(`fat_${per}`)),
    };
  }
  return null;
}

/** "#12 Lay's Classic (Lay's) · 1 pack (48 g): 255 kcal · P 3 g · C 25 g · F 16 g · logged 4×" */
export function foodLine(f: PersonalFood): string {
  return (
    `#${f.id} ${f.name}${f.brand ? ` (${f.brand})` : ''} · ${f.serving}: ${f.kcal} kcal · P ${f.protein} g · C ${f.carbs} g · F ${f.fat} g` +
    `${f.barcode ? ` · ${f.barcode}` : ''}${f.timesLogged ? t(` · logged ${f.timesLogged}×`, ` · บันทึก ${f.timesLogged} ครั้ง`) : ''}`
  );
}

/**
 * The barcode's food: from the personal database, else Open Food Facts (then saved to the database).
 * `found` says where it came from; null when it's in neither.
 */
export async function lookupBarcode(
  store: Store,
  chatKey: string,
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ food: PersonalFood; found: 'mine' | 'openfoodfacts' } | { food: null; invalid?: boolean }> {
  const barcode = barcodeDigits(code);
  if (!validBarcode(barcode) && !/^\d{6,8}$/.test(barcode)) return { food: null, invalid: true };
  const mine = store.foodDb(chatKey).find((f) => f.barcode === barcode);
  if (mine) return { food: mine, found: 'mine' };
  const off = await openFoodFacts(barcode, fetchFn);
  if (!off) return { food: null };
  return { food: store.saveFood(chatKey, { ...off, source: 'openfoodfacts' }), found: 'openfoodfacts' };
}
