import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { helpText, limitsView, personaView, ROLEPLAYS, runCommand, settingsView } from '../commands';
import { useLanguage } from '../i18n';
import { PERSONAS } from '../personas';
import { Store } from '../store';
import { NOW, echoProvider, testConfig } from './helpers';

afterEach(() => useLanguage(() => 'en'));

function setup() {
  const store = new Store(null);
  const cfg = testConfig();
  const echo = echoProvider('ok');
  const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
  return { store, ctx };
}

const thai = /[฀-๿]/;

describe('command replies in Thai', () => {
  it('switches /help at call time, keeping commands and emoji', async () => {
    const { ctx } = setup();
    expect((await runCommand('/help', ctx))!.text).toMatch(/^Hi! I am your personal secretary/);
    useLanguage(() => 'th');
    const help = (await runCommand('/help', ctx))!.text;
    expect(help).toBe(helpText());
    expect(help).toMatch(/^สวัสดี!/);
    expect(help).toContain('🗓️ เลขา: /todo, /add <งาน>, /done <id>, /clear');
    expect(help).toContain('/budget set 20000');
    expect(help).not.toContain('Secretary:');
  });

  it('shows /settings and /limit in Thai, with Thai button labels and unchanged commands', () => {
    const { ctx } = setup();
    const en = settingsView(ctx);
    useLanguage(() => 'th');
    const s = settingsView(ctx);
    expect(s.text).toMatch(/^⚙️ ตั้งค่า\n/);
    expect(s.text).toContain('โมเดล AI: ');
    expect(s.text).toContain('ความพยายามในการคิด: medium');
    expect(s.text).toContain('GEMINI_API_KEY');
    expect(s.buttons!.flat().map((b) => b.command)).toEqual(en.buttons!.flat().map((b) => b.command));
    expect(s.buttons!.flat().find((b) => b.command === '/limit')!.label).toBe('💵 วงเงินค่า AI ต่อวัน');
    expect(s.buttons!.flat().find((b) => b.command === '/voice off')!.label).toContain('ข้อความอย่างเดียว');

    const l = limitsView(ctx);
    expect(l.text).toContain('💵 วงเงินค่า AI ต่อวัน (USD รีเซ็ตตอนเที่ยงคืน)');
    expect(l.text).toContain('Gemini: วันนี้ใช้ไป $0.0000 · เตือนที่ ปิด · จำกัดที่ ปิด');
    expect(l.text).toContain('/limit gemini 3');
    const labels = l.buttons!.flat().map((b) => b.label);
    expect(labels).toContain('✅ ไม่จำกัด');
    expect(labels).toContain('↩️ ใช้ค่าจาก .env');
  });

  it('answers /limit changes in Thai', async () => {
    const { ctx } = setup();
    useLanguage(() => 'th');
    expect((await runCommand('/limit gemini 3', ctx))!.text).toMatch(/^✅ Gemini จำกัดที่ \$3\.00 ต่อวัน\n/);
    expect((await runCommand('/limit all warn 1', ctx))!.text).toMatch(/^✅ AI ทั้งหมดรวมกัน เตือนที่ \$1\.00 ต่อวัน/);
    expect((await runCommand('/limit nope', ctx))!.text).toMatch(/^"nope" ไม่ใช่ gemini, claude หรือ all/);
  });

  it('handles /prefs and to-dos in Thai', async () => {
    const { ctx, store } = setup();
    useLanguage(() => 'th');
    expect((await runCommand('/prefs', ctx))!.text).toMatch(/^📌 ยังไม่มีสิ่งที่ตั้งค่าไว้ให้ทำเสมอ\n\nเพิ่ม: \/prefs add Always reply in Thai/);
    expect((await runCommand('/prefs add Always reply in Thai', ctx))!.text).toBe('📌 บันทึกแล้ว: Always reply in Thai');
    expect((await runCommand('/prefs', ctx))!.text).toMatch(/^📌 สิ่งที่คุณตั้งค่าไว้ให้ฉันทำเสมอ:\n1\. Always reply in Thai/);
    expect(store.settings().preferences).toEqual(['Always reply in Thai']);

    expect((await runCommand('/todo', ctx))!.text).toBe('📋 ยังไม่มีสิ่งที่ต้องทำ เพิ่มได้ด้วย /add <งาน>');
    expect((await runCommand('/add Call the dentist', ctx))!.text).toBe('➕ เพิ่มแล้ว #1: Call the dentist');
    expect((await runCommand('/todo', ctx))!.text).toBe('📋 สิ่งที่ต้องทำ:\n#1 Call the dentist\n\nทำเครื่องหมายว่าเสร็จด้วย /done <id>');
    expect((await runCommand('/done 1', ctx))!.text).toBe('✅ เสร็จแล้ว: Call the dentist');
    expect((await runCommand('/done 9', ctx))!.text).toBe('ไม่มีรายการที่ #9 ดูได้ที่ /todo');
    expect((await runCommand('/clear', ctx))!.text).toBe('🗑️ ล้างสิ่งที่ต้องทำแล้ว 0 รายการ');
  });

  it('labels personas and roleplays in Thai, but keeps what goes to the AI in English', async () => {
    const { ctx, store } = setup();
    useLanguage(() => 'th');
    const view = personaView(ctx);
    expect(view.text).toContain('บุคลิกของ');
    const labels = view.buttons!.flat().map((b) => b.label);
    expect(labels).toContain('🎩 พ่อบ้าน');
    expect(labels.at(-1)).toBe('✅ ↩️ ค่าเริ่มต้น');
    expect((await runCommand('/persona butler', ctx))!.text).toMatch(/^✅ ตอนนี้ฉันเป็น: 🎩 พ่อบ้าน/);
    expect(store.settings().persona).toMatch(/^A refined butler/);

    const rp = (await runCommand('/roleplay', ctx))!;
    expect(rp.buttons!.flat().map((b) => b.label)).toContain('🍜 ร้านราเมงในโตเกียว');
    expect(rp.buttons!.flat().map((b) => b.command)).toContain('/roleplay ramen');
    expect(ROLEPLAYS[0].scenario).toMatch(/^Japanese practice/);

    for (const p of PERSONAS) expect(p.label).toMatch(thai);
    useLanguage(() => 'en');
    expect(PERSONAS.find((p) => p.key === 'butler')!.label).toBe('🎩 Butler');
  });

  it('keeps budget usage commands and category keys as typed', async () => {
    const { ctx } = setup();
    useLanguage(() => 'th');
    const r = (await runCommand('/budget set', ctx))!;
    expect(r.text).toMatch(/^💰 งบประมาณและรายจ่าย/);
    expect(r.text).toContain('/budget set food 6000');
    expect(r.text).toMatch(/หมวดหมู่: .*food/);
    expect((await runCommand('/budget', ctx))!.buttons![0].map((b) => b.label)).toEqual(['📅 เดือนที่แล้ว', '🧾 ล่าสุด']);
  });
});
