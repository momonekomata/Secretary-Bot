/**
 * USDA FoodData Central: the US government's free food composition database (public domain), for ingredients and
 * generic foods. Values are per 100 g. Works with USDA's shared DEMO_KEY (a low hourly limit); a free personal
 * key (USDA_API_KEY) raises the limit.
 */

export interface UsdaFood {
  fdcId: number;
  name: string;
  dataType: string;
  /** Per 100 g. */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  nutrientName?: string;
  unitName?: string;
  value?: number;
}

/**
 * A nutrient's value, by USDA nutrient number (the classic SR numbers) or id.
 * Energy: kcal (208 / 1008); Foundation foods often give it only as Atwater energy (958 or 957 / 2048 or 2047).
 */
function nutrient(list: UsdaNutrient[], numbers: string[], ids: number[], unit?: string): number {
  for (const [i, num] of numbers.entries()) {
    const n = list.find((x) => (x.nutrientNumber === num || x.nutrientId === ids[i]) && (!unit || (x.unitName ?? '').toUpperCase() === unit));
    if (n && typeof n.value === 'number') return n.value;
  }
  return NaN;
}

/** Generic foods matching an English query (Foundation, SR Legacy and survey foods; not branded products). */
export async function usdaSearch(query: string, apiKey = '', fetchFn: typeof fetch = fetch): Promise<UsdaFood[]> {
  const params = new URLSearchParams({ query, pageSize: '6', api_key: apiKey || 'DEMO_KEY' });
  params.append('dataType', 'Foundation');
  params.append('dataType', 'SR Legacy');
  params.append('dataType', 'Survey (FNDDS)');
  const res = await fetchFn(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) throw new Error('USDA FoodData Central: too many requests for this hour (set a free USDA_API_KEY to raise the limit).');
  if (!res.ok) throw new Error(`USDA FoodData Central ${res.status}`);
  const json = (await res.json()) as { foods?: { fdcId: number; description?: string; dataType?: string; foodNutrients?: UsdaNutrient[] }[] };
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
  return (json.foods ?? [])
    .map((f) => {
      const list = f.foodNutrients ?? [];
      return {
        fdcId: f.fdcId,
        name: f.description ?? '?',
        dataType: f.dataType ?? '',
        kcal: Math.round(nutrient(list, ['208', '958', '957'], [1008, 2048, 2047], 'KCAL')),
        protein: round(nutrient(list, ['203'], [1003])),
        carbs: round(nutrient(list, ['205'], [1005])),
        fat: round(nutrient(list, ['204'], [1004])),
      };
    })
    .filter((f) => Number.isFinite(f.kcal));
}

export const usdaLine = (f: UsdaFood) => `${f.name} [${f.dataType}, FDC ${f.fdcId}] per 100 g: ${f.kcal} kcal · P ${f.protein} g · C ${f.carbs} g · F ${f.fat} g`;
