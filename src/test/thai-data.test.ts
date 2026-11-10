import { afterEach, describe, expect, it } from 'vitest';
import { usageStats } from '../briefings';
import { buildExport } from '../export';
import { formatBody, formatFoodDay } from '../health';
import { HealthDb } from '../healthdb';
import { formatDay } from '../healthsync';
import { useLanguage } from '../i18n';
import { budgetAlerts, findCategory, labelOf, periodOf, scanSummary, txnLine } from '../money';
import { formatReport, ImportJob } from '../samsungexport';
import { Store, type UsageRow } from '../store';
import { runTool } from '../tools';
import { NOW, testConfig } from './helpers';

afterEach(() => useLanguage(() => 'en'));

const TZ = 'Asia/Bangkok';
const at = (iso: string) => new Date(iso);
const thai = () => useLanguage(() => 'th');

function ctxFor(store: Store, now = at('2026-11-09T12:00:00Z')) {
  return { chatKey: 'telegram:1', store, cfg: testConfig(), google: null, now: () => now };
}

describe('money in Thai', () => {
  it('labels periods with Thai month names and Gregorian years', () => {
    thai();
    expect(periodOf(at('2026-11-09T05:00:00Z'), TZ).label).toBe('พฤศจิกายน 2026');
    expect(periodOf(at('2026-11-09T05:00:00Z'), TZ, 25).label).toBe('25 ต.ค. – 24 พ.ย. 2026');
    useLanguage(() => 'en');
    expect(periodOf(at('2026-11-09T05:00:00Z'), TZ).label).toBe('November 2026');
  });

  it('reads category labels at call time, and finds categories by their Thai labels', () => {
    expect(labelOf('food')).toBe('🍜 Food & drinks');
    thai();
    expect(labelOf('food')).toBe('🍜 อาหารและเครื่องดื่ม');
    expect(labelOf('unknown')).toBe('unknown');
    expect(findCategory('เงินออมและการลงทุน')).toBe('savings');
    expect(findCategory('อาหาร')).toBe('food');
  });

  it('writes the report, transaction lines and budget alerts in Thai', async () => {
    thai();
    const store = new Store(null);
    const now = at('2026-11-09T12:00:00Z');
    await runTool('budget_set', { category: 'total', amount: 10000, start_day: 0 }, ctxFor(store, now));
    await runTool('budget_set', { category: 'food', amount: 1000, start_day: 0 }, ctxFor(store, now));
    const base = { time: '', currency: 'THB', account: '', ref: '', note: '', discount: 0 };
    const log = (items: object[]) => runTool('money_log', { source: 'chat', items }, ctxFor(store, now));
    await log([{ ...base, date: '2026-11-01', amount: 45000, category: 'salary', payee: 'Employer' }]);
    await log([{ ...base, date: '2026-11-02', amount: 1000, category: 'savings', payee: 'Bank' }]);
    const r = await log([{ ...base, date: '2026-11-08', amount: 850, category: 'food', payee: 'Dinner', discount: 50 }]);

    expect(r.content).toContain('💰 พฤศจิกายน 2026');
    expect(r.content).toContain('ใช้ไป ฿850 จาก ฿10,000 (9%) · เหลือ ฿9,150 ใช้ได้ประมาณวันละ');
    expect(r.content).toContain('รายรับ ฿45,000 · สุทธิ +฿44,150');
    expect(r.content).toContain('• 🍜 อาหารและเครื่องดื่ม ฿850 / ฿1,000 (85%)');
    expect(r.content).toContain('ไม่นับเป็นรายจ่าย: 🏦 เงินออมและการลงทุน ฿1,000');
    expect(r.content).toContain('โครงการร่วมจ่ายช่วยออกให้ ฿50');
    expect(r.content).toContain('⚠️ ใช้งบหมวด 🍜 อาหารและเครื่องดื่มไปแล้ว 85%: ฿850 จาก ฿1,000');
    expect(r.content).not.toMatch(/Spent|Income|budget:/);

    const over = await log([{ ...base, date: '2026-11-09', amount: 200, category: 'food', payee: 'Lunch' }]);
    expect(over.content).toContain('🚨 ใช้เกินงบหมวด 🍜 อาหารและเครื่องดื่มแล้ว: ฿1,050 จาก ฿1,000');
    expect(budgetAlerts(store, 'telegram:1', now, TZ)).toEqual([]);

    const dinner = store.money('telegram:1').find((x) => x.payee === 'Dinner')!;
    expect(txnLine(dinner)).toBe(`#${dinner.id} 11-08 ฿850 🍜 Dinner (ส่วนลดร่วมจ่าย ฿50)`);

    const empty = await runTool('money_report', { period: 'last', from: '', to: '', category: '', list_transactions: false }, ctxFor(store, now));
    expect(empty.content).toContain('💰 ตุลาคม 2026: ยังไม่มีรายการ');
  });

  it('warns about the monthly budget in Thai', () => {
    thai();
    const store = new Store(null);
    store.updateBudget('telegram:1', { monthly: 1000 });
    store.addMoney('telegram:1', { ts: '2026-11-05T05:00:00.000Z', day: '2026-11-05', amount: 900, category: 'food', payee: 'x', source: 'chat' });
    expect(budgetAlerts(store, 'telegram:1', at('2026-11-09T12:00:00Z'), TZ)).toEqual(['⚠️ ใช้งบรายเดือนไปแล้ว 90%: ฿900 จาก ฿1,000']);
  });

  it('summarises an email scan in Thai', () => {
    thai();
    expect(scanSummary({ emails: 0, added: [], duplicates: 0 })).toBe('📧 ไม่มีอีเมลเรื่องเงินใหม่ตั้งแต่ตรวจครั้งล่าสุด');
    expect(scanSummary({ emails: 3, added: [], duplicates: 2 })).toBe('📧 ตรวจอีเมล 3 ฉบับแล้ว: ไม่มีรายการใหม่ (บันทึกไว้แล้ว 2 รายการ)');
  });

  it('describes the data export in Thai', () => {
    thai();
    const { summary, name } = buildExport(new Store(null), new HealthDb(null), 'telegram:1', TZ, NOW);
    expect(name).toMatch(/^secretary-bot-export-.*\.zip$/);
    expect(summary).toMatch(/^💾 ข้อมูลของคุณ ณ /);
    expect(summary).toContain('• money.csv: 0 รายการ');
  });
});

describe('health in Thai', () => {
  it('formats the food diary and body numbers', () => {
    thai();
    const e = (meal: 'dinner' | 'snack', name: string, kcal: number, id: number) => ({ id, ts: '', day: 'd', meal, name, portion: '', kcal, protein: 1, carbs: 2, fat: 3 });
    const text = formatFoodDay([e('snack', 'ชาไทย', 250, 7), e('dinner', 'ส้มตำ', 150, 8)], 1800);
    expect(text).toContain('🍽️ อาหารวันนี้');
    expect(text).toContain('🍲 มื้อเย็น: 150 kcal');
    expect(text).toContain('🍪 ของว่าง: 250 kcal');
    expect(text).toContain('รวม: 400 kcal · โปรตีน 2 g · คาร์บ 4 g · ไขมัน 6 g');
    expect(text).toContain('เป้าหมาย 1800 kcal: เหลืออีก 1400 kcal');
    expect(formatFoodDay([], null)).toMatch(/^🍽️ วันนี้: ยังไม่มีรายการ/);
    expect(formatFoodDay([], null, '2026-11-08')).toMatch(/^🍽️ วันที่ 2026-11-08: /);

    const body = formatBody({ sex: 'male', birthYear: 1990, heightCm: 175, weightKg: 72.4, activity: 'moderate', goal: 'lose' }, 2026);
    expect(body).toContain('⚖️ 72.4 kg, 175 cm, อายุ 36 ปี');
    expect(body).toContain('BMI 23.6: น้ำหนักเกิน (เริ่มเสี่ยง) (เกณฑ์คนเอเชีย: ปกติ 18.5-22.9)');
    expect(body).toContain('(ออกกำลังกายปานกลาง 3-5 วันต่อสัปดาห์)');
    expect(body).toContain('(เพื่อลดน้ำหนักประมาณ 0.5 kg ต่อสัปดาห์)');
    expect(formatBody({ sex: 'female', heightCm: 160 }, 2026)).toContain('ยังต้องรู้อีก: อายุหรือปีเกิด, น้ำหนัก (kg)');
  });

  it('formats a watch day', () => {
    thai();
    const text = formatDay({
      day: '2026-11-08',
      steps: 8123,
      heart: { avg: 72, min: 55, max: 130 },
      oxygen: null,
      weight: { day: '2026-11-08', time: '07:00', kg: 72.4, bodyFatPct: 20.5 },
      workouts: [{ type: 'running', start: '', minutes: 30, km: 5, kcal: 300, steps: 0, avgHr: 150, maxHr: 170 }],
      sleep: { asleepMin: 420, awakeMin: 15, lightMin: 240, deepMin: 90, remMin: 90, bedtime: '23:30', wake: '07:00' },
      energy: { active: 500, resting: 1600, total: 2100 },
    });
    expect(text).toContain('นอนหลับ 7 ชม. 00 นาที (23:30–07:00; หลับลึก 1 ชม. 30 นาที, REM 1 ชม. 30 นาที');
    expect(text).toContain('เดิน 8,123 ก้าว');
    expect(text).toContain('อัตราการเต้นของหัวใจเฉลี่ย 72 (ต่ำสุด 55, สูงสุด 130) bpm');
    expect(text).toContain('น้ำหนัก 72.4 kg, ไขมัน 20.5%');
    expect(text).toContain('ออกกำลังกาย: running 30 นาที, 5 km, 300 kcal');
    expect(text).toContain('เผาผลาญ 2100 kcal');
    expect(formatDay({ day: '2026-11-07', steps: null, heart: null, oxygen: null, weight: null, workouts: [], sleep: null, energy: null })).toBe('2026-11-07: ไม่มีข้อมูลจากนาฬิกา');
  });

  it('reports a Samsung Health import and its status in Thai', async () => {
    thai();
    const text = formatReport(
      { file: 'x.rar', days: 2, from: '2025-03-01', to: '2025-03-02', skipped: ['a.csv'], types: { 'tracker.heart_rate': { rows: 3, days: 0, columns: ['odd_time', 'bpm'] }, weight: { rows: 1, days: 1 } } },
      5,
    );
    expect(text).toContain('📦 นำเข้า x.rar แล้ว');
    expect(text).toContain('ข้อมูล 2 วัน ตั้งแต่ 2025-03-01 ถึง 2025-03-02 ตอนนี้ประวัติครอบคลุม 5 วัน');
    expect(text).toContain('• weight: 1 แถว, 1 วัน');
    expect(text).toContain('• tracker.heart_rate: 3 แถว, 0 วัน\n   คอลัมน์: odd_time, bpm');
    expect(text).toContain('ไม่ได้ใช้ (1 ไฟล์): a.csv');

    const job = new ImportJob();
    expect(job.status()).toBe('ไม่มีการนำเข้าข้อมูลสุขภาพที่กำลังทำอยู่');
    const sent: string[] = [];
    let finish!: () => void;
    job.start(
      () => new Promise<string>((_, reject) => (finish = () => reject(new Error('boom')))),
      async (m) => void sent.push(m),
    );
    expect(job.status()).toMatch(/^📦 กำลังนำเข้าข้อมูลสุขภาพ \(เริ่มเมื่อ 0 นาทีที่แล้ว\) ขั้นตอนล่าสุด: กำลังเริ่ม$/);
    finish();
    await job.running?.done;
    expect(sent).toEqual(['❌ นำเข้าข้อมูลสุขภาพไม่สำเร็จ: boom\nลองใหม่ได้ด้วย /healthimport']);
  });
});

describe('usage stats in Thai', () => {
  it('writes /stats in Thai', () => {
    thai();
    const row: UsageRow = { ts: NOW.toISOString(), kind: 'chat', model: 'gemini-3.8-flash', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost: 0.25 };
    const stats = usageStats([row], TZ, NOW);
    expect(stats).toContain('📊 การใช้งาน AI และค่าใช้จ่ายโดยประมาณ');
    expect(stats).toContain('วันนี้: $0.2500 (1 ครั้ง) · Gemini $0.2500');
    expect(stats).toContain('• gemini-3.8-flash: เข้า 100 / ออก 10 โทเคน, $0.2500');
    expect(usageStats([], TZ, NOW)).toContain('• ยังไม่มีการเรียกใช้');
  });
});

describe('Thai category names', () => {
  it('match full names but not short fragments', async () => {
    const { findCategory } = await import('../money');
    expect(findCategory('เงิน')).toBeNull();
    expect(findCategory('เงินเดือน')).toBe('salary');
    expect(findCategory('อาหาร')).toBe('food');
  });
});
