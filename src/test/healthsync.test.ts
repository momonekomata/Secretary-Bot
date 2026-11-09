import { describe, expect, it } from 'vitest';
import { Channels } from '../channel';
import type { Google } from '../google';
import { HealthData, HealthDb } from '../healthdb';
import { formatDay, HealthSync, parseCsv, sleepNight } from '../healthsync';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { runTool } from '../tools';
import { NOW, testConfig } from './helpers';

// Same layout as Health Sync's files (values made up).
const FILES: Record<string, { folder: string; text: string }> = {
  'Steps 2026.11.06 Samsung Health.csv': { folder: 'steps', text: 'Date,Time,Steps  \n2026.11.06 08:00:00,08:00:00,120  \n2026.11.06 08:01:00,08:01:00,80  \n' },
  'Heart rate 2026.11.06 Samsung Health.csv': { folder: 'heart', text: 'Date,Time,Heart rate,Source  \n2026.11.06 08:00:00,08:00:00,62,  \n2026.11.06 08:01:00,08:01:00,110,  \n2026.11.06 08:02:00,08:02:00,74,  \n' },
  'Oxygen saturation 2026.11.06 Samsung Health.csv': { folder: 'oxygen', text: 'Date,Time,Oxygen saturation  \n2026.11.06 03:08:00,03:08:00,96.0  \n2026.11.06 23:32:00,23:32:00,94.0  \n' },
  'Weight 2026.11.06 Samsung Health.csv': {
    folder: 'weight',
    text:
      'Date,Time,Weight,Body fat percentage,Body fat mass,Fat free percentage,Fat free mass,Skeletal muscle percentage,Skeletal muscle mass,Muscle mass percentage,Muscle mass,Bone mass,Total body water,Base metabolic rate  \n' +
      '2026.11.06 07:30:38,07:30:38,"70.4","22.5","15.8","77.5","54.6","40.1","28.2","0.0","0.0","0.0","40.3","1560"  \n',
  },
  'Weight 45-2026 Samsung Health.csv': { folder: 'weight', text: 'Date,Time,Weight  \n2026.11.01 07:00:00,07:00:00,"71.0"  \n' },
  'RUNNING 2026.11.06 18.10 Samsung Health.csv': {
    folder: 'activities',
    text:
      'Source app,Activity type,Activity name,Date,Time,Elapsed time,Active time,Distance (miles),Calories (kcal),Steps,Average heart rate,Max heart rate,Average speed,Max speed  \n' +
      'null,RUNNING,,2026.11.06 18:10:00,18:10:00,2400,2340,3.1068559,310.5,4200,145,171,2.7,4.5  \n',
  },
  'RUNNING-06.11.2026 18.10.tcx': { folder: 'activities', text: '<xml/>' },
  'Energy burned 2026.11.06 Health Connect.csv': {
    folder: 'energy',
    text: 'Date,Time,Active calories,Resting calories,Total calories  \n2026.11.06 00:00:00,00:00:00,"420.5","1500.2","1920.7"  \n',
  },
  'Energy burned 2026.10.07-2026.11.06 Health Connect.csv': { folder: 'energy', text: 'Date,Time,Active calories,Resting calories,Total calories  \n' },
  // Went to bed before midnight: the night is split over two daily files.
  'Sleep 2026.11.05 00:00:00 Samsung Health.csv': {
    folder: 'sleep',
    text: 'Date,Time,Duration in seconds,Sleep stage  \n2026.11.05 01:00:00,01:00:00,3600,light  \n2026.11.05 23:30:00,23:30:00,1800,light  \n',
  },
  'Sleep 2026.11.06 00:00:00 Samsung Health.csv': {
    folder: 'sleep',
    text: 'Date,Time,Duration in seconds,Sleep stage  \n2026.11.06 00:00:00,00:00:00,3600,deep  \n2026.11.06 01:00:00,01:00:00,600,awake  \n2026.11.06 01:10:00,01:10:00,5400,rem  \n2026.11.06 02:40:00,02:40:00,10800,light  \n',
  },
  'Sleep 2026.11.06 00:00:00 Health Connect.csv': { folder: 'sleep', text: 'Date,Time,Duration in seconds,Sleep stage  \n2026.11.06 00:00:00,00:00:00,99999,light  \n' },
};

const FOLDER_NAMES: Record<string, string> = {
  steps: 'Health Sync Steps',
  heart: 'Health Sync Heart rate',
  oxygen: 'Health Sync Oxygen saturation',
  weight: 'Health Sync Weight',
  activities: 'Health Sync Activities',
  energy: 'Health Sync Energy burned',
  sleep: 'Health Sync Sleep',
};

/** A fake Drive answering the queries HealthSync makes. */
function fakeDrive() {
  const queries: string[] = [];
  const google = {
    async listFiles(q: string) {
      queries.push(q);
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return Object.entries(FOLDER_NAMES).map(([id, name]) => ({ id, name, modifiedTime: '' }));
      const folder = /'(\w+)' in parents/.exec(q)?.[1];
      const exact = /name = '([^']+)'/.exec(q)?.[1];
      const part = /name contains '([^']+)'/.exec(q)?.[1];
      return Object.entries(FILES)
        .filter(([name, f]) => f.folder === folder && (exact ? name === exact : part ? name.includes(part) : true))
        .map(([name]) => ({ id: name, name, modifiedTime: name.includes('45-2026') ? '2026-11-02' : '2026-11-06' }))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    },
    async downloadText(id: string) {
      return FILES[id].text;
    },
    has: () => true,
  };
  return { google: google as unknown as Google, queries };
}

describe('Health Sync', () => {
  it('drops the repeated segments in Health Connect sleep files', () => {
    const rows = parseCsv(
      'Date,Time,Duration in seconds,Sleep stage\n2026.11.09 06:05:00,x,1050,light\n2026.11.09 06:22:30,x,90,awake\n2026.11.09 06:05:00,x,1049,light\n2026.11.09 06:22:29,x,0,light\n2026.11.09 06:22:30,x,89,awake\n',
    );
    expect(sleepNight(rows, '2026-11-09')).toMatchObject({ asleepMin: 18, awakeMin: 2, bedtime: '06:05', wake: '06:24' });
  });

  it('parses quoted CSV with trailing spaces', () => {
    expect(parseCsv('A,B  \n"1.5","x, y"  \n')).toEqual([{ A: '1.5', B: 'x, y' }]);
  });

  it('summarises a day from the daily files', async () => {
    const { google } = fakeDrive();
    const s = await new HealthSync(google).day('2026-11-06');
    expect(s).toMatchObject({
      steps: 200,
      heart: { avg: 82, min: 62, max: 110 },
      oxygen: { avg: 95, min: 94 },
      weight: { day: '2026-11-06', kg: 70.4, bodyFatPct: 22.5, skeletalMuscleKg: 28.2, bmr: 1560 },
      workouts: [{ type: 'running', minutes: 39, km: 5, kcal: 311, steps: 4200, avgHr: 145, maxHr: 171 }],
      energy: { active: 421, resting: 1500, total: 1921 },
      // 23:30 → 05:40, Samsung Health file preferred over the Health Connect copy.
      sleep: { asleepMin: 360, awakeMin: 10, lightMin: 210, deepMin: 60, remMin: 90, bedtime: '23:30', wake: '05:40' },
    });
    expect(formatDay(s)).toBe(
      '2026-11-06: slept 6h 00m (23:30–05:40; deep 1h 00m, REM 1h 30m, light 3h 30m; awake 10 min); 200 steps; heart rate avg 82 (lowest 62, highest 110) bpm; SpO2 avg 95% (lowest 94%); weighed 70.4 kg, body fat 22.5%, skeletal muscle 28.2 kg, scale BMR 1560 kcal; workout: running 39 min, 5 km, 311 kcal, avg HR 145; burned 1921 kcal (421 active, 1500 resting)',
    );
    expect(formatDay(await new HealthSync(google).day('2026-11-04'))).toBe('2026-11-04: no watch data');
  });

  it('finds the latest daily weigh-in, not the weekly summary', async () => {
    const { google } = fakeDrive();
    expect(await new HealthSync(google).latestWeighIn()).toMatchObject({ day: '2026-11-06', kg: 70.4 });
  });

  it('gives the AI several days of watch data', async () => {
    const { google } = fakeDrive();
    const ctx = { chatKey: 'telegram:1', store: new Store(null), cfg: testConfig(), google, health: new HealthData(new HealthDb(null), new HealthSync(google)), now: () => NOW };
    const r = await runTool('watch_health_data', { days: 2 }, ctx);
    expect(r.content.split('\n')).toEqual([
      "Samsung Health data from the user's watch and scale, oldest first:",
      expect.stringMatching(/^2026-11-06: slept 6h 00m .*; 200 steps;/),
      '2026-11-07: no watch data',
    ]);
  });

  it('copies new weigh-ins into the weight history every hour', async () => {
    const { google } = fakeDrive();
    const store = new Store(null);
    const cfg = testConfig({ notifyChats: ['telegram:1'], schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '', japanese: '' } });
    const s = new Scheduler(cfg, store, new Channels(), null, () => undefined, null, new HealthData(new HealthDb(null), new HealthSync(google)));
    await s.syncWeight(NOW);
    await s.syncWeight(new Date(NOW.getTime() + 60_000)); // within the hour: skipped
    expect(store.weights('telegram:1')).toEqual([{ day: '2026-11-06', kg: 70.4 }]);
    expect(store.body('telegram:1').weightKg).toBe(70.4);
  });
});
