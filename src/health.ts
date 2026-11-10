import { t } from './i18n';
import type { BodyProfile, FoodEntry } from './store';

export const ACTIVITY: Record<NonNullable<BodyProfile['activity']>, { factor: number; label: string }> = {
  sedentary: { factor: 1.2, label: 'little or no exercise' },
  light: { factor: 1.375, label: 'light exercise 1-3 days a week' },
  moderate: { factor: 1.55, label: 'moderate exercise 3-5 days a week' },
  active: { factor: 1.725, label: 'hard exercise 6-7 days a week' },
  very_active: { factor: 1.9, label: 'very hard exercise or a physical job' },
};

/** Thai for the activity levels, by the English label in ACTIVITY. */
const ACTIVITY_TH: Record<string, string> = {
  'little or no exercise': 'ออกกำลังกายน้อยหรือไม่ได้ออกเลย',
  'light exercise 1-3 days a week': 'ออกกำลังกายเบาๆ 1-3 วันต่อสัปดาห์',
  'moderate exercise 3-5 days a week': 'ออกกำลังกายปานกลาง 3-5 วันต่อสัปดาห์',
  'hard exercise 6-7 days a week': 'ออกกำลังกายหนัก 6-7 วันต่อสัปดาห์',
  'very hard exercise or a physical job': 'ออกกำลังกายหนักมากหรือทำงานใช้แรง',
};

/** Thai for bmiCategory() and the missing-profile items of bodyNumbers(), which stay English for the AI and tests. */
const BODY_TH: Record<string, string> = {
  underweight: 'น้ำหนักน้อย',
  'healthy weight': 'น้ำหนักปกติ',
  'overweight (at risk)': 'น้ำหนักเกิน (เริ่มเสี่ยง)',
  'obese class I': 'อ้วนระดับ 1',
  'obese class II': 'อ้วนระดับ 2',
  'sex (male/female)': 'เพศ (ชาย/หญิง)',
  'age or birth year': 'อายุหรือปีเกิด',
  'height (cm)': 'ส่วนสูง (cm)',
  'weight (kg)': 'น้ำหนัก (kg)',
};
const bodyTh = (en: string) => t(en, BODY_TH[en] ?? en);

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const MEAL_TH: Record<string, string> = { breakfast: 'มื้อเช้า', lunch: 'มื้อกลางวัน', dinner: 'มื้อเย็น', snack: 'ของว่าง' };

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
    return t(
      `To work out your BMI and calories I still need: ${n.missing.join(', ')}.\nTell me in chat, e.g. "I'm a 30 year old woman, 160 cm, 55 kg, I exercise 3 times a week and want to lose a little weight", or use /profile.`,
      `ถ้าจะคำนวณ BMI และแคลอรี่ ยังต้องรู้อีก: ${n.missing.map(bodyTh).join(', ')}\nบอกในแชทได้เลย เช่น "ผู้หญิงอายุ 30 ปี สูง 160 cm หนัก 55 kg ออกกำลังกายสัปดาห์ละ 3 ครั้ง อยากลดน้ำหนักนิดหน่อย" หรือใช้ /profile`,
    );
  }
  const activity = ACTIVITY[p.activity ?? 'light'].label;
  const goal = p.targetKcal
    ? t(' (your own target)', ' (เป้าหมายที่ตั้งเอง)')
    : p.goal === 'lose'
      ? t(' (to lose about 0.5 kg a week)', ' (เพื่อลดน้ำหนักประมาณ 0.5 kg ต่อสัปดาห์)')
      : p.goal === 'gain'
        ? t(' (to gain slowly)', ' (เพื่อเพิ่มน้ำหนักช้าๆ)')
        : t(' (to stay the same)', ' (เพื่อรักษาน้ำหนักเดิม)');
  return [
    t(`⚖️ ${p.weightKg} kg, ${p.heightCm} cm, ${n.age} years`, `⚖️ ${p.weightKg} kg, ${p.heightCm} cm, อายุ ${n.age} ปี`),
    t(`BMI ${n.bmi.toFixed(1)}: ${n.category} (Asian cut-offs: healthy 18.5-22.9)`, `BMI ${n.bmi.toFixed(1)}: ${bodyTh(n.category)} (เกณฑ์คนเอเชีย: ปกติ 18.5-22.9)`),
    t(`BMR ${n.bmr} kcal/day (what your body burns at rest)`, `BMR ${n.bmr} kcal/วัน (พลังงานที่ร่างกายใช้ตอนพัก)`),
    t(`Daily burn about ${n.tdee} kcal (${activity})`, `ใช้พลังงานวันละประมาณ ${n.tdee} kcal (${ACTIVITY_TH[activity] ?? activity})`),
    t(`Daily target: ${n.target} kcal${goal}`, `เป้าหมายต่อวัน: ${n.target} kcal${goal}`),
    t('These are estimates, not medical advice.', 'ตัวเลขเหล่านี้เป็นการประมาณ ไม่ใช่คำแนะนำทางการแพทย์'),
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
  // Callers pass 'Today' or a YYYY-MM-DD day.
  const thLabel = label === 'Today' || label === 'วันนี้' ? 'วันนี้' : /^\d{4}-\d{2}-\d{2}$/.test(label) ? `วันที่ ${label}` : label;
  if (!entries.length) return t(`🍽️ ${label}: nothing logged yet. Tell me what you ate, or send a photo of your food.`, `🍽️ ${thLabel}: ยังไม่มีรายการ บอกได้เลยว่ากินอะไรไป หรือส่งรูปอาหารมาก็ได้`);
  const lines = [t(`🍽️ ${label}'s food`, `🍽️ อาหาร${thLabel}`)];
  for (const meal of MEALS) {
    const items = entries.filter((e) => e.meal === meal);
    if (!items.length) continue;
    lines.push(`${MEAL_ICON[meal]} ${t(`${meal[0].toUpperCase()}${meal.slice(1)}`, MEAL_TH[meal])}: ${Math.round(totals(items).kcal)} kcal`);
    for (const e of items) lines.push(`  • ${e.name}${e.portion ? ` (${e.portion})` : ''}: ${Math.round(e.kcal)} kcal  #${e.id}`);
  }
  const sum = totals(entries);
  lines.push(
    '',
    t(
      `Total: ${Math.round(sum.kcal)} kcal · protein ${Math.round(sum.protein)} g · carbs ${Math.round(sum.carbs)} g · fat ${Math.round(sum.fat)} g`,
      `รวม: ${Math.round(sum.kcal)} kcal · โปรตีน ${Math.round(sum.protein)} g · คาร์บ ${Math.round(sum.carbs)} g · ไขมัน ${Math.round(sum.fat)} g`,
    ),
  );
  if (target) {
    const left = Math.round(target - sum.kcal);
    lines.push(left >= 0 ? t(`Target ${target} kcal: ${left} kcal left`, `เป้าหมาย ${target} kcal: เหลืออีก ${left} kcal`) : t(`Target ${target} kcal: ${-left} kcal over`, `เป้าหมาย ${target} kcal: เกินมา ${-left} kcal`));
  }
  lines.push(t('Calories are average estimates. Remove a wrong one with /food remove <#>.', 'แคลอรี่เป็นค่าประมาณโดยเฉลี่ย ถ้ามีรายการผิด ลบได้ด้วย /food remove <#>'));
  return lines.join('\n');
}
