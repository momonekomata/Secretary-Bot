import { afterEach, describe, expect, it } from 'vitest';
import { Agent, BudgetExceeded } from '../agent';
import { Channels, friendlyError } from '../channel';
import { fileToInput, UserFacingError } from '../documents';
import { formatEmails, formatEvents, formatTasks } from '../google';
import { useLanguage } from '../i18n';
import type { Provider } from '../llm/types';
import { formatPlaces } from '../maps';
import { aqiAlertText, nudgeText, reminderText, Scheduler } from '../scheduler';
import { Store } from '../store';
import { aqiCategory, describeCode, formatWeather, type Forecast } from '../weather';
import { NOW, testConfig } from './helpers';

afterEach(() => useLanguage(() => 'en'));

const thai = () => useLanguage(() => 'th');

/** A provider whose every call costs $1. */
const dollarProvider: Provider = {
  async run(req) {
    req.onUsage({ model: req.model, input: 1_000_000, output: 0 });
    return { text: 'ok' };
  },
};

function capped(gemini: { warnUsd: number | null; capUsd: number | null }) {
  const base = testConfig().billing;
  const cfg = testConfig({
    billing: { ...base, priceOverrides: '{"gemini-3.8-flash":{"input":1,"output":0}}', providers: { ...base.providers, gemini } },
  });
  return new Agent(cfg, new Store(null), { gemini: dollarProvider, claude: dollarProvider }, null, () => NOW);
}

const FORECAST: Forecast = {
  current: { temp: 31.6, feelsLike: 36.2, humidity: 70, wind: 9.4, code: 61 },
  days: [{ date: '2026-11-07', code: 3, min: 25, max: 33, rainChance: 40, uvMax: 8 }],
};

describe('fixed messages in Thai', () => {
  it('says the spending cap is reached in Thai, and keeps the English unchanged', async () => {
    const agent = capped({ warnUsd: null, capUsd: 1 });
    expect(await agent.reply({ chatKey: 'c', text: '1' })).toBe('ok');
    thai();
    const blocked = await agent.reply({ chatKey: 'c', text: '2' });
    expect(blocked).toMatch(/^🛑 Gemini ถึงวงเงินรายวันแล้ว: \$1\.0000 จาก \$1\.00/);
    expect(blocked).toContain('/limit gemini 2');
    expect(blocked).not.toMatch(/cap reached/);
    useLanguage(() => 'en');
    expect(await agent.reply({ chatKey: 'c', text: '3' })).toMatch(/^🛑 Gemini's daily cap reached/);
  });

  it('adds the billing warning in Thai', async () => {
    const agent = capped({ warnUsd: 1, capUsd: null });
    thai();
    expect(await agent.reply({ chatKey: 'c', text: '1' })).toBe('ok\n\n⚠️ แจ้งเตือนค่าใช้จ่าย: Gemini วันนี้ อยู่ที่ $1.0000 (แจ้งเตือนที่ $1.00)');
  });

  it('explains errors in Thai', () => {
    thai();
    expect(friendlyError(Object.assign(new Error('x'), { status: 429 }))).toBe('บริการ AI จำกัดการใช้งานอยู่ตอนนี้ ลองใหม่อีกครั้งในอีกสักนาทีนะ');
    expect(friendlyError(new Error('boom'))).toBe('เกิดข้อผิดพลาดฝั่งบอท ลองใหม่อีกครั้ง หรือดู log ของบอท');
    expect(friendlyError(new Error('The selected model gemini-3.8-flash needs GEMINI_API_KEY. Set it, or pick another model with /settings.'))).toBe(
      'โมเดล gemini-3.8-flash ที่เลือกไว้ต้องใช้ GEMINI_API_KEY ตั้งค่าคีย์นี้ หรือเลือกโมเดลอื่นใน /settings',
    );
    expect(friendlyError(new BudgetExceeded('🛑 cap'))).toBe('🛑 cap');
    useLanguage(() => 'en');
    expect(friendlyError(new Error('boom'))).toBe('Something went wrong on my side. Try again, or check the bot logs.');
  });

  it('describes weather and air quality in Thai, decided at call time', () => {
    expect(aqiCategory(124).label).toBe('🟠 Unhealthy for sensitive groups');
    thai();
    expect(aqiCategory(124).label).toBe('🟠 เริ่มมีผลต่อกลุ่มเสี่ยง');
    expect(aqiCategory(30).advice).toBe('อากาศดี ทำกิจกรรมกลางแจ้งได้สบาย');
    expect(describeCode(61)).toBe('🌦️ ฝนตกเล็กน้อย');
    const text = formatWeather({ name: 'Bangkok', country: 'Thailand', lat: 13.75, lon: 100.5 }, FORECAST, { usAqi: 160, pm25: 70.25, pm10: 90 });
    expect(text.split('\n')[0]).toBe('อากาศที่ Bangkok, Thailand:');
    expect(text).toContain('ตอนนี้: 🌦️ ฝนตกเล็กน้อย, 32°C (รู้สึกเหมือน 36°C), ความชื้น 70%, ลม 9 km/h');
    expect(text).toContain('โอกาสฝน 40%');
    expect(text).toContain('คุณภาพอากาศ: US AQI 160 (🔴 มีผลต่อสุขภาพ), PM2.5 70.3 µg/m³');
  });

  it('formats calendar, email, tasks and places in Thai, leaving user content as-is', () => {
    thai();
    expect(formatEvents([], 'Asia/Bangkok')).toBe('ไม่มีนัดหมาย');
    expect(formatEvents([{ summary: 'Team lunch', start: '2026-11-08', end: '2026-11-09' }], 'Asia/Bangkok')).toBe('• 2026-11-08 (ทั้งวัน): Team lunch');
    expect(formatEmails([])).toBe('ไม่พบอีเมล');
    expect(formatEmails([{ from: 'Ann', subject: 'Hello', snippet: 'Hi there', date: '' }])).toBe('• จาก Ann: "Hello" — Hi there');
    expect(formatTasks([])).toBe('ไม่มีงานค้างใน Google Tasks');
    expect(formatTasks([{ id: '1', title: 'Pay rent', due: '2026-11-30T00:00:00Z' }])).toBe('• Pay rent (กำหนด 2026-11-30)');
    expect(formatPlaces([{ name: 'Ramen Bar', address: 'Asok', openNow: true }])).toBe('• Ramen Bar — Asok, เปิดอยู่ตอนนี้');
    useLanguage(() => 'en');
    expect(formatEmails([])).toBe('No emails found.');
  });

  it('sends reminders, nudges and air quality alerts in Thai', async () => {
    thai();
    expect(reminderText('Stretch!')).toBe('⏰ แจ้งเตือน: Stretch!');
    expect(nudgeText(3, 1, 5)).toBe('🔥 ภารกิจประจำวัน: มีรีวิว 1 ข้อ และบทเรียน 3 บท รออยู่ใน WaniKani (เลเวล 5) がんばって！');
    expect(aqiAlertText('Bangkok', 180, 80)).toBe('😷 แจ้งเตือนคุณภาพอากาศที่ Bangkok: US AQI 180 (🔴 มีผลต่อสุขภาพ) PM2.5 80.0 µg/m³\nใส่หน้ากาก N95 เมื่อออกนอกบ้าน ลดกิจกรรมกลางแจ้ง และปิดหน้าต่างไว้');

    const cfg = testConfig({ notifyChats: [], schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '', japanese: '' } });
    const store = new Store(null);
    store.addReminder('test:42', 'Stretch!', new Date(NOW.getTime() - 1000));
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'test', send: async (id, text) => void sent.push(`${id}:${text}`) });
    await new Scheduler(cfg, store, channels, null, () => undefined).tick(NOW);
    expect(sent).toEqual(['42:⏰ แจ้งเตือน: Stretch!']);
  });

  it('rejects files with a Thai UserFacingError', () => {
    thai();
    expect(() => fileToInput('sheet.xlsx', 'application/vnd.ms-excel', Buffer.from('x'))).toThrow(UserFacingError);
    expect(() => fileToInput('sheet.xlsx', 'application/vnd.ms-excel', Buffer.from('x'))).toThrow(/^ยังอ่านไฟล์ sheet\.xlsx ไม่ได้/);
    expect(() => fileToInput('big.pdf', 'application/pdf', Buffer.alloc(16 * 1024 * 1024))).toThrow('ไฟล์ big.pdf ใหญ่เกินไป (สูงสุดประมาณ 15 MB)');
    useLanguage(() => 'en');
    expect(() => fileToInput('big.pdf', 'application/pdf', Buffer.alloc(16 * 1024 * 1024))).toThrow('big.pdf is too big for me (max about 15 MB).');
  });
});
