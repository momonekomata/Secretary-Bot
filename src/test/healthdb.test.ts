import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HealthData, HealthDb, history } from '../healthdb';
import { exportType, extract, formatReport, SamsungImporter } from '../samsungexport';
import { Store } from '../store';
import { runTool } from '../tools';
import { NOW, testConfig } from './helpers';

const banner = (type: string) => `com.samsung.${type},6313005,32`;

/** A small export folder in Samsung Health's layout (values made up). */
function fakeExport(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-export-'));
  const dir = join(root, 'samsunghealth_someone_20261109120000');
  mkdirSync(dir, { recursive: true });
  const f = (name: string, lines: string[]) => writeFileSync(join(dir, name), lines.join('\n'));
  f('com.samsung.shealth.tracker.pedometer_day_summary.20261109120000.csv', [
    banner('shealth.tracker.pedometer_day_summary'),
    'create_sh_ver,step_count,binning_data,active_time,run_step_count,update_time,create_time,distance,calorie,deviceuuid,day_time,walk_step_count,',
    '6.2,8450,x.json,3600000,120,2025-03-01 10:00:00.000,2025-03-01 10:00:00.000,6200.5,310.2,dev1,1740787200000,8330,',
    '6.2,9100,x.json,3600000,0,2025-03-01 10:00:00.000,2025-03-01 10:00:00.000,6500.1,330.0,all,1740787200000,9100,',
    '6.2,4300,x.json,1800000,0,2025-03-02 10:00:00.000,2025-03-02 10:00:00.000,3000,150,dev1,1740873600000,4300,',
  ]);
  f('com.samsung.health.weight.20261109120000.csv', [
    banner('health.weight'),
    'com.samsung.health.weight.start_time,com.samsung.health.weight.weight,body_fat,skeletal_muscle_mass,total_body_water,basal_metabolic_rate,time_offset,com.samsung.health.weight.deviceuuid',
    '2025-03-01 23:30:00.000,72.4,24.1,29.0,41.2,1600,UTC+0700,scale',
  ]);
  f('com.samsung.shealth.tracker.heart_rate.20261109120000.csv', [
    banner('shealth.tracker.heart_rate'),
    'com.samsung.health.heart_rate.start_time,com.samsung.health.heart_rate.heart_rate,com.samsung.health.heart_rate.min,com.samsung.health.heart_rate.max,time_offset',
    '2025-03-01 01:00:00.000,60,55,64,UTC+0700',
    '2025-03-01 05:00:00.000,100,90,120,UTC+0700',
  ]);
  f('com.samsung.shealth.sleep.20261109120000.csv', [
    banner('shealth.sleep'),
    'com.samsung.health.sleep.start_time,com.samsung.health.sleep.end_time,sleep_score,efficiency,time_offset',
    '2025-02-28 16:00:00.000,2025-02-28 23:30:00.000,82,90,UTC+0700', // 23:00 → 06:30 local, woke on 1 March
  ]);
  f('com.samsung.health.sleep_stage.20261109120000.csv', [
    banner('health.sleep_stage'),
    'start_time,end_time,stage,time_offset',
    '2025-02-28 16:00:00.000,2025-02-28 18:00:00.000,40002,UTC+0700',
    '2025-02-28 18:00:00.000,2025-02-28 19:30:00.000,40003,UTC+0700',
    '2025-02-28 19:30:00.000,2025-02-28 21:00:00.000,40004,UTC+0700',
    '2025-02-28 21:00:00.000,2025-02-28 21:30:00.000,40001,UTC+0700',
    '2025-02-28 21:30:00.000,2025-02-28 23:30:00.000,40002,UTC+0700',
  ]);
  f('com.samsung.shealth.exercise.20261109120000.csv', [
    banner('shealth.exercise'),
    'com.samsung.health.exercise.start_time,com.samsung.health.exercise.duration,com.samsung.health.exercise.calorie,com.samsung.health.exercise.distance,com.samsung.health.exercise.exercise_type,com.samsung.health.exercise.mean_heart_rate,com.samsung.health.exercise.max_heart_rate,time_offset',
    '2025-03-01 11:00:00.000,2400000,310.5,5021.3,1002,145,171,UTC+0700',
  ]);
  f('com.samsung.shealth.calories_burned.details.20261109120000.csv', [
    banner('shealth.calories_burned.details'),
    'com.samsung.shealth.calories_burned.active_calorie,com.samsung.shealth.calories_burned.rest_calorie,com.samsung.shealth.calories_burned.tef_calorie,day_time',
    '420.2,1500.4,0,1740787200000',
  ]);
  f('com.samsung.shealth.badge.20261109120000.csv', [banner('shealth.badge'), 'a,b', '1,2']);
  return root;
}

describe('Samsung Health export import', () => {
  it('recognises export file types', () => {
    expect(exportType('/x/com.samsung.shealth.tracker.pedometer_day_summary.20261109120000.csv')).toBe('tracker.pedometer_day_summary');
    expect(exportType('com.samsung.health.weight.20261109120000.csv')).toBe('weight');
    expect(exportType('notes.csv')).toBeNull();
  });

  it('reads steps, weight, heart rate, sleep with stages, workouts and calories into days', async () => {
    const { records, report } = await new SamsungImporter('Asia/Bangkok').importDir(fakeExport());
    expect(report).toMatchObject({ days: 2, from: '2025-03-01', to: '2025-03-02', skipped: ['com.samsung.shealth.badge.20261109120000.csv'] });
    expect(records['2025-03-01']).toMatchObject({
      steps: 9100,
      heart: { avg: 80, min: 55, max: 120 },
      sleep: { asleepMin: 420, awakeMin: 30, lightMin: 240, deepMin: 90, remMin: 90, bedtime: '23:00', wake: '06:30', score: 82 },
      workouts: [{ type: 'running', minutes: 40, km: 5.02, kcal: 311, avgHr: 145, maxHr: 171 }],
      energy: { active: 420, resting: 1500, total: 1921 },
      source: 'samsung-export',
    });
    // The weigh-in at 23:30 UTC is 06:30 the next morning in Bangkok.
    expect(records['2025-03-02']).toMatchObject({ steps: 4300, weight: { day: '2025-03-02', time: '06:30', kg: 72.4, bodyFatPct: 24.1, skeletalMuscleKg: 29, bmr: 1600 } });
    expect(records['2025-03-01'].weight).toBeUndefined();
  });

  it.skipIf(spawnSync('bsdtar', ['--version']).status !== 0)('unpacks an archive and keeps live data when merging', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sb-zip-'));
    const zip = join(work, 'samsung_health.zip');
    expect(spawnSync('bsdtar', ['-a', '-cf', zip, '-C', fakeExport(), '.']).status).toBe(0);
    await extract(zip, join(work, 'out'));
    const { records, report } = await new SamsungImporter('Asia/Bangkok').importDir(join(work, 'out'));
    expect(report.days).toBe(2);

    const db = new HealthDb(work);
    db.merge({ '2025-03-01': { steps: 9999, source: 'healthsync' } }, true);
    db.merge(records, false); // imports fill gaps, never overwrite
    db.noteImport('samsung_health.zip', Object.keys(records));
    expect(db.get('2025-03-01')).toMatchObject({ steps: 9999, heart: { avg: 80 } });
    expect(new HealthDb(work).size).toBe(2); // saved to healthdb.json
    expect(formatReport({ file: 'samsung_health.zip', ...report }, db.size)).toMatch(/^📦 Imported samsung_health.zip\n2 days of data, 2025-03-01 to 2025-03-02/);
  });

  it('summarises long-term trends and answers from history when Health Sync has no data', async () => {
    const db = new HealthDb(null);
    db.merge(
      {
        '2025-03-03': { steps: 8000, sleep: { asleepMin: 420, awakeMin: 20, lightMin: 0, deepMin: 0, remMin: 0, bedtime: '23:00', wake: '06:40' }, weight: { day: '2025-03-03', time: '', kg: 72 } },
        '2025-03-04': { steps: 10000, workouts: [{ type: 'running', start: '', minutes: 30, km: 5, kcal: 300, steps: 0, avgHr: 0, maxHr: 0 }], weight: { day: '2025-03-04', time: '', kg: 71.6 } },
        '2025-04-02': { steps: 6000 },
      },
      true,
    );
    expect(history(db.range('2025-03-01', '2025-04-30'), 'month')).toBe(
      '2025-03 (2 days): avg 9,000 steps/day; avg sleep 7h 00m; weight 72→71.6 kg; 1 workouts, 30 min, 300 kcal\n2025-04 (1 days): avg 6,000 steps/day',
    );
    const health = new HealthData(db, null);
    const r = await runTool('health_history', { from: '2025-03-01', to: '2025-03-31', group: 'week' }, { chatKey: 'c', store: new Store(null), cfg: testConfig(), google: null, health, now: () => NOW });
    expect(r.content).toContain('week of 2025-03-03 (2 days)');
    expect((await health.day('2025-03-04')).workouts).toHaveLength(1);
  });
});
