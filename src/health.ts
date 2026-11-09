import type { BodyProfile, FoodEntry } from './store';

export const ACTIVITY: Record<NonNullable<BodyProfile['activity']>, { factor: number; label: string }> = {
  sedentary: { factor: 1.2, label: 'little or no exercise' },
  light: { factor: 1.375, label: 'light exercise 1-3 days a week' },
  moderate: { factor: 1.55, label: 'moderate exercise 3-5 days a week' },
  active: { factor: 1.725, label: 'hard exercise 6-7 days a week' },
  very_active: { factor: 1.9, label: 'very hard exercise or a physical job' },
};

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export function bmi(heightCm: number, weightKg: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

/** Asia-Pacific cut-offs (WHO 2004), which suit Thai and other Asian adults better than the global ones. */
export function bmiCategory(value: number): string {
  if (value < 18.5) return 'underweight';
  if (value < 23) return 'healthy weight';
  if (value < 25) return 'overweight (at risk)';
  if (value < 30) return 'obese class I';
  return 'obese class II';
}

/** Basal metabolic rate, Mifflin-St Jeor equation (kcal/day). */
export function bmr(sex: 'male' | 'female', weightKg: number, heightCm: number, age: number): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

export interface BodyNumbers {
  age: number;
  bmi: number;
  category: string;
  bmr: number;
  /** Total daily energy expenditure. */
  tdee: number;
  target: number;
}

/** Everything that can be worked out from the profile, or null with what's missing. */
export function bodyNumbers(p: BodyProfile, year: number): BodyNumbers | { missing: string[] } {
  const missing = [
    !p.sex && 'sex (male/female)',
    !p.birthYear && 'age or birth year',
    !p.heightCm && 'height (cm)',
    !p.weightKg && 'weight (kg)',
  ].filter(Boolean) as string[];
  if (missing.length) return { missing };
  const age = year - p.birthYear!;
  const value = bmi(p.heightCm!, p.weightKg!);
  const base = bmr(p.sex!, p.weightKg!, p.heightCm!, age);
  const tdee = base * ACTIVITY[p.activity ?? 'light'].factor;
  const adjust = p.goal === 'lose' ? -500 : p.goal === 'gain' ? 300 : 0;
  // Don't suggest going below a safe floor without a doctor.
  const floor = p.sex === 'male' ? 1500 : 1200;
  const target = p.targetKcal ?? Math.max(floor, Math.round((tdee + adjust) / 10) * 10);
  return { age, bmi: value, category: bmiCategory(value), bmr: Math.round(base), tdee: Math.round(tdee), target };
}

export function formatBody(p: BodyProfile, year: number): string {
  const n = bodyNumbers(p, year);
  if ('missing' in n) {
    return `To work out your BMI and calories I still need: ${n.missing.join(', ')}.\nTell me in chat, e.g. "I'm a 30 year old woman, 160 cm, 55 kg, I exercise 3 times a week and want to lose a little weight", or use /profile.`;
  }
  return [
    `⚖️ ${p.weightKg} kg, ${p.heightCm} cm, ${n.age} years`,
    `BMI ${n.bmi.toFixed(1)}: ${n.category} (Asian cut-offs: healthy 18.5-22.9)`,
    `BMR ${n.bmr} kcal/day (what your body burns at rest)`,
    `Daily burn about ${n.tdee} kcal (${ACTIVITY[p.activity ?? 'light'].label})`,
    `Daily target: ${n.target} kcal${p.targetKcal ? ' (your own target)' : p.goal === 'lose' ? ' (to lose about 0.5 kg a week)' : p.goal === 'gain' ? ' (to gain slowly)' : ' (to stay the same)'}`,
    'These are estimates, not medical advice.',
  ].join('\n');
}

export interface Totals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export function totals(entries: FoodEntry[]): Totals {
  return entries.reduce((t, e) => ({ kcal: t.kcal + e.kcal, protein: t.protein + e.protein, carbs: t.carbs + e.carbs, fat: t.fat + e.fat }), {
    kcal: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
  });
}

const MEAL_ICON: Record<FoodEntry['meal'], string> = { breakfast: '🍳', lunch: '🍜', dinner: '🍲', snack: '🍪' };

export function formatFoodDay(entries: FoodEntry[], target: number | null, label = 'Today'): string {
  if (!entries.length) return `🍽️ ${label}: nothing logged yet. Tell me what you ate, or send a photo of your food.`;
  const lines = [`🍽️ ${label}'s food`];
  for (const meal of MEALS) {
    const items = entries.filter((e) => e.meal === meal);
    if (!items.length) continue;
    lines.push(`${MEAL_ICON[meal]} ${meal[0].toUpperCase()}${meal.slice(1)}: ${Math.round(totals(items).kcal)} kcal`);
    for (const e of items) lines.push(`  • ${e.name}${e.portion ? ` (${e.portion})` : ''}: ${Math.round(e.kcal)} kcal  #${e.id}`);
  }
  const t = totals(entries);
  lines.push('', `Total: ${Math.round(t.kcal)} kcal · protein ${Math.round(t.protein)} g · carbs ${Math.round(t.carbs)} g · fat ${Math.round(t.fat)} g`);
  if (target) {
    const left = Math.round(target - t.kcal);
    lines.push(left >= 0 ? `Target ${target} kcal: ${left} kcal left` : `Target ${target} kcal: ${-left} kcal over`);
  }
  lines.push('Calories are average estimates. Remove a wrong one with /food remove <#>.');
  return lines.join('\n');
}
