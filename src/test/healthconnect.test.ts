import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { zip } from '../export';
import { formatHealthConnectReport, importHealthConnect, newestExport, readHealthConnect } from '../healthconnect';
import { HealthData, HealthDb } from '../healthdb';
import { HealthSync } from '../healthsync';
import { Channels } from '../channel';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { testConfig } from './helpers';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Made-up data only. Times are UTC ms; the zone offset is Bangkok's (+7 h). */
const TZ = 7 * 3600;
const ms = (iso: string) => Date.parse(iso);
const epochDay = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
const D1 = '2026-03-10';
const D2 = '2026-03-11';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'hc-test-'));
  dirs.push(d);
  return d;
}

/** A small export database with the same tables and columns as Android's, two apps writing overlapping data. */
function makeExport(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    create table steps_record_table (local_date integer, app_info_id integer, count integer);
    create table total_calories_burned_record_table (local_date integer, app_info_id integer, energy real);
    create table active_calories_burned_record_table (local_date integer, app_info_id integer, energy real);
    create table heart_rate_record_table (row_id integer primary key, local_date integer, app_info_id integer);
    create table heart_rate_record_series_table (parent_key integer, epoch_millis integer, beats_per_minute integer);
    create table oxygen_saturation_record_table (local_date integer, app_info_id integer, percentage real);
    create table resting_heart_rate_record_table (local_date integer, beats_per_minute integer);
    create table weight_record_table (time integer, zone_offset integer, local_date integer, weight real, app_info_id integer);
    create table body_fat_record_table (time integer, app_info_id integer, percentage real);
    create table basal_metabolic_rate_record_table (time integer, app_info_id integer, basal_metabolic_rate real);
    create table sleep_session_record_table (row_id integer primary key, app_info_id integer, start_time integer, start_zone_offset integer, end_time integer, end_zone_offset integer);
    create table sleep_stages_table (parent_key integer, stage_start_time integer, stage_end_time integer, stage_type integer);
    create table exercise_session_record_table (app_info_id integer, start_time integer, start_zone_offset integer, end_time integer, title text, exercise_type integer);
  `);
  const run = (sql: string, ...rows: (number | string | null)[][]) => {
    const st = db.prepare(sql);
    for (const r of rows) st.run(...r);
  };
  const d1 = epochDay(D1);
  // Steps: app 1 counted 5,000; app 2 counted 3,000 + 5,000 = 8,000. The day is 8,000, not 13,000.
  run('insert into steps_record_table values (?, ?, ?)', [d1, 1, 5000], [d1, 2, 3000], [d1, 2, 5000]);
  // Energy in small calories: 2,100 kcal total, 400 kcal active.
  run('insert into total_calories_burned_record_table values (?, ?, ?)', [d1, 1, 2_100_000], [d1, 2, 1_500_000]);
  run('insert into active_calories_burned_record_table values (?, ?, ?)', [d1, 1, 400_000]);
  // Heart rate: app 1 has three samples, app 2 one; app 1 is used.
  run('insert into heart_rate_record_table values (?, ?, ?)', [1, d1, 1], [2, d1, 2]);
  run(
    'insert into heart_rate_record_series_table values (?, ?, ?)',
    [1, ms('2026-03-10T01:00:00Z'), 60],
    [1, ms('2026-03-10T01:10:00Z'), 90],
    [1, ms('2026-03-10T01:20:00Z'), 120],
    [2, ms('2026-03-10T05:00:00Z'), 150],
  );
  run('insert into oxygen_saturation_record_table values (?, ?, ?)', [d1, 1, 97], [d1, 1, 95]);
  run('insert into resting_heart_rate_record_table values (?, ?)', [d1, 62]);
  // Weigh-ins: the day's last one counts, with the body fat and BMR measured with it.
  run('insert into weight_record_table values (?, ?, ?, ?, ?)', [ms('2026-03-10T00:00:00Z'), TZ, d1, 71_000, 3], [ms('2026-03-10T12:00:00Z'), TZ, d1, 70_500, 3]);
  run('insert into body_fat_record_table values (?, ?, ?)', [ms('2026-03-10T12:01:00Z'), 3, 22.5], [ms('2026-03-10T00:00:00Z'), 3, 30]);
  run('insert into basal_metabolic_rate_record_table values (?, ?, ?)', [ms('2026-03-10T12:01:00Z'), 3, 80]);
  // Sleep ending on the morning of D2 (local): app 1 recorded stages, app 2 only a shorter session.
  run(
    'insert into sleep_session_record_table values (?, ?, ?, ?, ?, ?)',
    [1, 1, ms('2026-03-10T16:00:00Z'), TZ, ms('2026-03-10T23:30:00Z'), TZ],
    [2, 2, ms('2026-03-10T17:00:00Z'), TZ, ms('2026-03-10T22:00:00Z'), TZ],
  );
  const stage = (from: string, to: string, type: number) => [1, ms(`2026-03-10T${from}:00Z`), ms(`2026-03-10T${to}:00Z`), type];
  run('insert into sleep_stages_table values (?, ?, ?, ?)', stage('16:00', '19:00', 4), stage('19:00', '20:00', 5), stage('20:00', '21:00', 6), stage('21:00', '21:30', 1), stage('21:30', '23:30', 4));
  // Workouts: the same walk recorded by two apps (counted once), and a gym session.
  run(
    'insert into exercise_session_record_table values (?, ?, ?, ?, ?, ?)',
    [1, ms('2026-03-10T01:00:00Z'), TZ, ms('2026-03-10T01:30:00Z'), 'Morning walk', 53],
    [2, ms('2026-03-10T01:02:00Z'), TZ, ms('2026-03-10T01:28:00Z'), '', 53],
    [4, ms('2026-03-11T11:00:00Z'), TZ, ms('2026-03-11T12:00:00Z'), 'Leg day', 999],
  );
  db.close();
}

describe('Health Connect export', () => {
  it('reads each day from the most complete app, in the right units', () => {
    const path = join(tempDir(), 'health_connect_export.db');
    makeExport(path);
    const days = readHealthConnect(path);
    expect(Object.keys(days)).toEqual([D1, D2]);
    const d1 = days[D1];
    expect(d1.source).toBe('healthconnect');
    expect(d1.steps).toBe(8000);
    expect(d1.energy).toEqual({ active: 400, resting: 1700, total: 2100 });
    expect(d1.heart).toEqual({ avg: 90, min: 60, max: 120 });
    expect(d1.oxygen).toEqual({ avg: 96, min: 95 });
    expect(d1.extra).toMatchObject({ restingHr: 62 });
    expect(d1.weight).toEqual({ day: D1, time: '19:00', kg: 70.5, bodyFatPct: 22.5, bmr: 1652 });
    expect(d1.workouts).toEqual([{ type: 'walking', start: '08:00', minutes: 30, km: 0, kcal: 0, steps: 0, avgHr: 90, maxHr: 120 }]);
    // Bedtime 23:00, up 06:30 local: 7 h asleep (light 5 h, deep 1 h, REM 1 h) and 30 min awake.
    expect(days[D2].sleep).toEqual({ asleepMin: 420, awakeMin: 30, lightMin: 300, deepMin: 60, remMin: 60, bedtime: '23:00', wake: '06:30' });
    expect(days[D2].workouts).toEqual([expect.objectContaining({ type: 'Leg day', start: '18:00', minutes: 60 })]);
  });

  it('imports the newest zip in the folder without overwriting days already there', () => {
    const dir = tempDir();
    const work = tempDir();
    makeExport(join(work, 'x.db'));
    writeFileSync(join(dir, 'Health Connect.zip'), zip([{ name: 'health_connect_export.db', data: readFileSync(join(work, 'x.db')) }]));
    writeFileSync(join(dir, 'notes.txt'), 'not an export');
    expect(newestExport(dir)).toBe(join(dir, 'Health Connect.zip'));

    const db = new HealthDb(null);
    db.merge({ [D1]: { source: 'healthsync', steps: 1234 } }, true);
    const report = importHealthConnect(dir, db);
    expect(report).toMatchObject({ days: 2, from: D1, to: D2 });
    expect(report.types).toMatchObject({ steps: 1, sleep: 1, weight: 1, workouts: 2, restingHr: 1 });
    expect(db.get(D1)!.steps).toBe(1234); // kept
    expect(db.get(D1)!.weight?.kg).toBe(70.5); // filled in
    expect(db.get(D2)!.sleep?.asleepMin).toBe(420);

    const text = formatHealthConnectReport(report, db.size);
    expect(text).toContain('📲 Health Connect: 2 days (2026-03-10 to 2026-03-11) read from Health Connect.zip.');
    expect(text).toContain('• workouts: 2 days');
    expect(text).toContain('History now covers 2 days.');
  });

  it('says why there is nothing to import: not connected, empty, or no zip', () => {
    expect(() => importHealthConnect('/no/such/folder', new HealthDb(null))).toThrow(/doesn't exist inside the bot's container/);
    const dir = tempDir();
    expect(() => importHealthConnect(dir, new HealthDb(null))).toThrow(/is connected but empty/);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(() => importHealthConnect(dir, new HealthDb(null))).toThrow(/No Health Connect export \(\.zip\) in .*It has: notes\.txt/);
    expect(newestExport('/no/such/folder')).toBeNull();
  });

  it('finds an export one folder down', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Health Connect'));
    writeFileSync(join(dir, 'Health Connect', 'Health Connect.zip'), zip([]));
    expect(newestExport(dir)).toBe(join(dir, 'Health Connect', 'Health Connect.zip'));
  });

  it('runs every night once the folder is mounted', () => {
    const google = {} as never;
    const make = (dir: string) =>
      new Scheduler(testConfig({ healthConnectDir: dir }), new Store(null), new Channels(), null, () => undefined, null, new HealthData(new HealthDb(null), new HealthSync(google)));
    expect(make('/no/such/folder').jobs.map((j) => j.key)).not.toContain('healthconnect');
    expect(make(tempDir()).jobs.map((j) => j.key)).toContain('healthconnect'); // mounted, even before the first export arrives
  });
});
