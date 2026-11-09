import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { runCommand } from '../commands';
import { unzipEntry } from '../documents';
import { buildExport, crc32, csv, zip } from '../export';
import { formatDay } from '../healthsync';
import { HealthDb, toSummary } from '../healthdb';
import { SamsungImporter } from '../samsungexport';
import { Store } from '../store';
import { runTool } from '../tools';
import { NOW, echoProvider, testConfig } from './helpers';

function setup(dataDir = '') {
  const store = new Store(dataDir || null);
  const cfg = testConfig({ dataDir });
  const echo = echoProvider('ok');
  const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
  return { store, cfg, agent, ctx, echo };
}

describe('standing preferences', () => {
  it('adds, lists and removes preferences with /prefs, and puts them in every system prompt', async () => {
    const { ctx, store, agent, echo } = setup();
    expect((await runCommand('/prefs', ctx))!.text).toContain('No standing preferences yet');
    expect((await runCommand('/prefs add Always reply in Thai', ctx))!.text).toContain('Always reply in Thai');
    await runCommand('/prefs add Use emoji', ctx);
    expect(store.settings().preferences).toEqual(['Always reply in Thai', 'Use emoji']);
    expect((await runCommand('/prefs', ctx))!.text).toContain('1. Always reply in Thai\n2. Use emoji');

    await runCommand('/persona butler', ctx);
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[0].system).toContain("The user's standing preferences");
    expect(echo.requests[0].system).toContain('• Always reply in Thai\n• Use emoji');
    expect(echo.requests[0].system).toContain('Your personality: A refined butler');

    expect((await runCommand('/prefs remove 1', ctx))!.text).toBe('🗑️ Removed: Always reply in Thai');
    expect((await runCommand('/prefs remove 9', ctx))!.text).toMatch(/No preference #9/);
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[1].system).not.toContain('Always reply in Thai');
    await runCommand('/prefs clear', ctx);
    expect(store.settings().preferences ?? []).toEqual([]);
  });

  it('lets the AI save and remove preferences itself', async () => {
    const store = new Store(null);
    const tctx = { chatKey: 'c', store, cfg: testConfig(), google: null, now: () => NOW };
    expect((await runTool('preference_add', { text: 'Keep answers short' }, tctx)).content).toBe('Saved preference #1: Keep answers short');
    expect((await runTool('preference_remove', { number: 3 }, tctx)).content).toMatch(/No preference #3/);
    await runTool('preference_remove', { number: 1 }, tctx);
    expect(store.settings().preferences).toEqual([]);
  });

  it('survives a restart because it is saved in data/store.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-prefs-'));
    const first = setup(dir);
    await runCommand('/prefs add ตอบเป็นภาษาไทยเสมอ', first.ctx);
    await runCommand('/persona butler', first.ctx);
    first.store.addFood('telegram:1', { ts: NOW.toISOString(), day: '2026-11-07', meal: 'lunch', name: 'Pad thai', portion: '1 plate', kcal: 600, protein: 20, carbs: 80, fat: 20 });
    first.store.logWeight('telegram:1', '2026-11-07', 70.5);
    const again = new Store(dir);
    expect(again.settings()).toMatchObject({ preferences: ['ตอบเป็นภาษาไทยเสมอ'], personaKey: 'butler' });
    expect(again.food('telegram:1')).toHaveLength(1);
    expect(again.weights('telegram:1')).toEqual([{ day: '2026-11-07', kg: 70.5 }]);
  });
});

describe('Samsung export extras', () => {
  it('reads HRV, breathing, stress, floors, water, blood pressure, height and food', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-extras-'));
    const f = (type: string, header: string, rows: string[]) =>
      writeFileSync(join(dir, `com.samsung.${type}.20261109120000.csv`), [`com.samsung.${type},6313005,3`, header, ...rows].join('\n'));
    f('health.hrv', 'start_time,rmssd,time_offset', ['2025-03-01 01:00:00.000,40,UTC+0700', '2025-03-01 02:00:00.000,50,UTC+0700']);
    f('health.respiratory_rate', 'start_time,average,time_offset', ['2025-03-01 01:00:00.000,15.5,UTC+0700']);
    f('shealth.stress', 'start_time,score,time_offset', ['2025-03-01 03:00:00.000,30,UTC+0700', '2025-03-01 04:00:00.000,50,UTC+0700']);
    f('health.floors_climbed', 'start_time,floor,time_offset', ['2025-03-01 03:00:00.000,3,UTC+0700', '2025-03-01 05:00:00.000,4,UTC+0700']);
    f('health.water_intake', 'start_time,amount,time_offset', ['2025-03-01 03:00:00.000,250,UTC+0700', '2025-03-01 06:00:00.000,500,UTC+0700']);
    f('health.blood_pressure', 'start_time,systolic,diastolic,time_offset', ['2025-03-01 03:00:00.000,118,76,UTC+0700']);
    f('health.height', 'start_time,height,time_offset', ['2020-01-01 03:00:00.000,170,UTC+0700', '2025-03-01 03:00:00.000,171.5,UTC+0700']);
    f('health.food_intake', 'start_time,name,calorie,meal_type,time_offset', ['2025-03-01 01:00:00.000,Rice,200,100001,UTC+0700', '2025-03-01 05:00:00.000,Som tam,150,100002,UTC+0700']);

    const { records, report } = await new SamsungImporter('Asia/Bangkok').importDir(dir);
    expect(records['2025-03-01'].extra).toEqual({
      hrv: 45,
      respiratory: 15.5,
      stress: 40,
      floors: 7,
      waterMl: 750,
      bloodPressure: { systolic: 118, diastolic: 76 },
      heightCm: 171.5,
      food: { kcal: 350, items: [{ name: 'Rice', kcal: 200, meal: 'breakfast' }, { name: 'Som tam', kcal: 150, meal: 'lunch' }] },
    });
    expect(report.latestHeightCm).toBe(171.5);
    expect(report.skipped).toEqual([]);
    const text = formatDay(toSummary('2025-03-01', records['2025-03-01']));
    expect(text).toMatch(/HRV/);
    expect(text).toMatch(/118\/76/);
  });
});

describe('/export', () => {
  it('sends a zip of CSV files with everything the bot keeps', async () => {
    const { ctx, store, agent } = setup();
    store.addFood('telegram:1', { ts: NOW.toISOString(), day: '2026-11-07', meal: 'lunch', name: 'Pad thai, extra "egg"', portion: '1 plate', kcal: 600, protein: 20, carbs: 80, fat: 20 });
    store.logWeight('telegram:1', '2026-11-07', 70.5);
    store.addMemory('telegram:1', 'Likes matcha');
    store.updateSettings({ preferences: ['Use emoji'] });
    agent.health.db.merge({ '2026-11-06': { steps: 8000, extra: { hrv: 42 }, workouts: [{ type: 'running', start: '07:00', minutes: 30, km: 5, kcal: 300, steps: 4000, avgHr: 150, maxHr: 170 }] } }, true);

    const r = (await runCommand('/export', ctx))!;
    expect(r.file!.name).toBe('secretary-bot-export-2026-11-07.zip');
    expect(r.text).toContain('food_diary.csv: 1 entries');
    const food = unzipEntry(r.file!.data, 'food_diary.csv')!.toString('utf8');
    expect(food.startsWith('﻿date,time,meal,food,')).toBe(true);
    expect(food).toContain('2026-11-07,17:00,lunch,"Pad thai, extra ""egg""",1 plate,600,20,80,20\r\n');
    expect(unzipEntry(r.file!.data, 'weight.csv')!.toString('utf8')).toContain('2026-11-07,70.5');
    const daily = unzipEntry(r.file!.data, 'health_daily.csv')!.toString('utf8').split('\r\n');
    const cols = daily[0].replace('﻿', '').split(',');
    const row = daily[1].split(',');
    expect(row[cols.indexOf('steps')]).toBe('8000');
    expect(row[cols.indexOf('hrv_ms')]).toBe('42');
    expect(row[cols.indexOf('workout_min')]).toBe('30');
    expect(unzipEntry(r.file!.data, 'workouts.csv')!.toString('utf8')).toContain('2026-11-06,07:00,running,30,5,300');
    expect(unzipEntry(r.file!.data, 'memories.csv')!.toString('utf8')).toContain('Likes matcha');
    const json = JSON.parse(unzipEntry(r.file!.data, 'profile_and_settings.json')!.toString('utf8'));
    expect(json).toMatchObject({ timeZone: 'Asia/Bangkok', bodyProfile: { weightKg: 70.5 }, settings: { preferences: ['Use emoji'] } });
  });

  it('keeps a copy in data/backups on the NAS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-exp-'));
    const { ctx } = setup(dir);
    const r = (await runCommand('/export', ctx))!;
    expect(existsSync(join(dir, 'backups', r.file!.name))).toBe(true);
  });

  it('writes standard zip files (valid CRC, UTF-8 names)', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const data = zip([{ name: 'อาหาร.csv', data: csv(['a'], [['ข้าว']]) }], NOW);
    expect(data.readUInt32LE(0)).toBe(0x04034b50);
    expect(data.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(unzipEntry(data, 'อาหาร.csv')!.toString('utf8')).toBe('﻿a\r\nข้าว\r\n');
  });

  it('exports nothing but headers when there is no data yet', () => {
    const exp = buildExport(new Store(null), new HealthDb(null), 'telegram:1', 'Asia/Bangkok', NOW);
    expect(unzipEntry(exp.data, 'food_diary.csv')!.toString('utf8')).toBe('﻿date,time,meal,food,portion,kcal,protein_g,carbs_g,fat_g\r\n');
  });
});
