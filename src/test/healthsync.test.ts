import { describe, expect, it } from 'vitest';
import { Channels } from '../channel';
import type { Google } from '../google';
import { formatDay, HealthSync, parseCsv } from '../healthsync';
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
};

const FOLDER_NAMES: Record<string, string> = {
  steps: 'Health Sync Steps',
  heart: 'Health Sync Heart rate',
  oxygen: 'Health Sync Oxygen saturation',
  weight: 'Health Sync Weight',
  activities: 'Health Sync Activities',
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
    });
    expect(formatDay(s)).toBe(
      '2026-11-06: 200 steps; heart rate avg 82 (lowest 62, highest 110) bpm; SpO2 avg 95% (lowest 94%); weighed 70.4 kg, body fat 22.5%, skeletal muscle 28.2 kg, scale BMR 1560 kcal; workout: running 39 min, 5 km, 311 kcal, avg HR 145',
    );
    expect(formatDay(await new HealthSync(google).day('2026-11-05'))).toBe('2026-11-05: no watch data');
  });

  it('finds the latest daily weigh-in, not the weekly summary', async () => {
    const { google } = fakeDrive();
    expect(await new HealthSync(google).latestWeighIn()).toMatchObject({ day: '2026-11-06', kg: 70.4 });
  });

  it('gives the AI several days of watch data', async () => {
    const { google } = fakeDrive();
    const ctx = { chatKey: 'telegram:1', store: new Store(null), cfg: testConfig(), google, healthSync: new HealthSync(google), now: () => NOW };
    const r = await runTool('watch_health_data', { days: 2 }, ctx);
    expect(r.content.split('\n')).toEqual([
      "Samsung Health data from the user's watch and scale, oldest first:",
      expect.stringMatching(/^2026-11-06: 200 steps;/),
      '2026-11-07: no watch data',
    ]);
  });

  it('copies new weigh-ins into the weight history every hour', async () => {
    const { google } = fakeDrive();
    const store = new Store(null);
    const cfg = testConfig({ notifyChats: ['telegram:1'], schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '', japanese: '' } });
    const s = new Scheduler(cfg, store, new Channels(), null, () => undefined, null, new HealthSync(google));
    await s.syncWeight(NOW);
    await s.syncWeight(new Date(NOW.getTime() + 60_000)); // within the hour: skipped
    expect(store.weights('telegram:1')).toEqual([{ day: '2026-11-06', kg: 70.4 }]);
    expect(store.body('telegram:1').weightKg).toBe(70.4);
  });
});
