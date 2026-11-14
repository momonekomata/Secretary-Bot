import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { unzipEntry } from './documents';
import type { DayRecord, HealthDb } from './healthdb';
import type { SleepSummary, Workout } from './healthsync';
import { t } from './i18n';

/** node:sqlite, loaded only when an export is read (the test runner can't resolve it statically; it's experimental on Node 22). */
type Sqlite = typeof import('node:sqlite');
const sqlite = (): Sqlite => createRequire(import.meta.url)('node:sqlite') as Sqlite;

/**
 * Android's Health Connect export: a zip with health_connect_export.db (SQLite), which the phone can save to a
 * folder on the NAS every day. It holds everything Health Connect has, from every app that writes to it.
 *
 * Several apps often record the same thing (Samsung Health, Google Fit, the phone's own step counter…), so a day
 * never adds them up: for each day and kind of data, the most complete single app is used.
 *
 * Units in the database: energy in small calories, weight in grams, height in metres, basal metabolic rate in
 * watts, times in epoch milliseconds with a zone offset in seconds, local_date in days since 1970.
 */

const DB_NAME = 'health_connect_export.db';

/** Health Connect sleep stage types. */
const STAGE = { awake: [1, 3, 7], sleeping: [2], light: [4], deep: [5], rem: [6] };

/** Exercise codes seen with a clear meaning in exports ("Night Walk" sessions are 53); others show the session title. */
const EXERCISE: Record<number, string> = { 53: 'walking' };

/** 1 W = 20.65 kcal a day. */
const WATTS_TO_KCAL_DAY = 20.65;

export interface HealthConnectReport {
  file: string;
  days: number;
  from: string;
  to: string;
  /** Days with each kind of data. */
  types: Record<string, number>;
}

const dayOf = (epochDays: number) => new Date(epochDays * 86_400_000).toISOString().slice(0, 10);
/** Local date and HH:MM of an instant, using its stored zone offset (seconds). */
const local = (ms: number, offsetSec: number | null) => new Date(ms + (offsetSec ?? 0) * 1000).toISOString();

type Row = Record<string, number | string | null>;

/** Reads the export database into per-day records. */
export function readHealthConnect(dbPath: string): Record<string, DayRecord> {
  const db = new (sqlite().DatabaseSync)(dbPath, { readOnly: true });
  try {
    const has = new Set((db.prepare("select name from sqlite_master where type='table'").all() as Row[]).map((r) => String(r.name)));
    const all = (sql: string, ...params: (number | string)[]) => db.prepare(sql).all(...params) as Row[];
    const days = new Map<string, DayRecord>();
    const get = (day: string) => {
      let d = days.get(day);
      if (!d) days.set(day, (d = { source: 'healthconnect' }));
      return d;
    };
    /** Per day, the value from the app that has the most of it (the most complete source). */
    const bestPerDay = (rows: Row[], score: string) => {
      const best = new Map<string, Row>();
      for (const r of rows) {
        const day = dayOf(Number(r.d));
        const cur = best.get(day);
        if (!cur || Number(r[score]) > Number(cur[score])) best.set(day, r);
      }
      return best;
    };

    if (has.has('steps_record_table')) {
      for (const [day, r] of bestPerDay(all('select local_date d, app_info_id a, sum(count) n from steps_record_table group by d, a'), 'n')) {
        if (Number(r.n) > 0) get(day).steps = Math.round(Number(r.n));
      }
    }

    const totals = has.has('total_calories_burned_record_table') ? bestPerDay(all('select local_date d, app_info_id a, sum(energy) e from total_calories_burned_record_table group by d, a'), 'e') : new Map();
    const actives = has.has('active_calories_burned_record_table') ? bestPerDay(all('select local_date d, app_info_id a, sum(energy) e from active_calories_burned_record_table group by d, a'), 'e') : new Map();
    for (const day of new Set([...totals.keys(), ...actives.keys()])) {
      const total = totals.has(day) ? Number(totals.get(day)!.e) / 1000 : NaN;
      const active = actives.has(day) ? Number(actives.get(day)!.e) / 1000 : NaN;
      if (!(total > 0) && !(active > 0)) continue;
      const a = Math.round(active > 0 ? active : 0);
      const tot = Math.round(total > 0 ? total : a);
      get(day).energy = { active: a, resting: Math.max(0, tot - a), total: tot };
    }

    if (has.has('heart_rate_record_series_table') && has.has('heart_rate_record_table')) {
      const hr = all(
        'select r.local_date d, r.app_info_id a, count(*) c, avg(s.beats_per_minute) av, min(s.beats_per_minute) mn, max(s.beats_per_minute) mx ' +
          'from heart_rate_record_series_table s join heart_rate_record_table r on s.parent_key = r.row_id group by d, a',
      );
      for (const [day, r] of bestPerDay(hr, 'c')) get(day).heart = { avg: Math.round(Number(r.av)), min: Number(r.mn), max: Number(r.mx) };
    }

    if (has.has('oxygen_saturation_record_table')) {
      const o2 = all('select local_date d, app_info_id a, count(*) c, avg(percentage) av, min(percentage) mn from oxygen_saturation_record_table group by d, a');
      for (const [day, r] of bestPerDay(o2, 'c')) get(day).oxygen = { avg: Math.round(Number(r.av)), min: Math.round(Number(r.mn)) };
    }

    const extra = (day: string, patch: Partial<NonNullable<DayRecord['extra']>>) => {
      const d = get(day);
      d.extra = { ...(d.extra ?? {}), ...patch };
    };
    if (has.has('resting_heart_rate_record_table')) {
      for (const r of all('select local_date d, avg(beats_per_minute) v from resting_heart_rate_record_table group by d')) extra(dayOf(Number(r.d)), { restingHr: Math.round(Number(r.v)) });
    }
    if (has.has('blood_pressure_record_table')) {
      for (const r of all('select local_date d, systolic s, diastolic di from blood_pressure_record_table order by time')) {
        extra(dayOf(Number(r.d)), { bloodPressure: { systolic: Math.round(Number(r.s)), diastolic: Math.round(Number(r.di)) } });
      }
    }
    if (has.has('vo2_max_record_table')) {
      for (const r of all('select local_date d, vo2_milliliters_per_minute_kilogram v from vo2_max_record_table order by time')) extra(dayOf(Number(r.d)), { vo2max: Math.round(Number(r.v) * 10) / 10 });
    }
    if (has.has('height_record_table')) {
      for (const r of all('select local_date d, height h from height_record_table order by time')) extra(dayOf(Number(r.d)), { heightCm: Math.round(Number(r.h) * 1000) / 10 });
    }

    // Weigh-ins: the day's last one, with body fat and BMR measured with it (same app, within 10 minutes).
    if (has.has('weight_record_table')) {
      const near = (table: string, col: string) => (has.has(table) ? all(`select time, app_info_id a, ${col} v from ${table}`) : []);
      const fats = near('body_fat_record_table', 'percentage');
      const bmrs = near('basal_metabolic_rate_record_table', 'basal_metabolic_rate');
      const match = (list: Row[], w: Row) => list.find((x) => x.a === w.a && Math.abs(Number(x.time) - Number(w.time)) <= 600_000);
      for (const w of all('select time, zone_offset z, local_date d, weight g, app_info_id a from weight_record_table order by time')) {
        const day = dayOf(Number(w.d));
        const fat = match(fats, w);
        const bmr = match(bmrs, w);
        get(day).weight = {
          day,
          time: local(Number(w.time), Number(w.z)).slice(11, 16),
          kg: Math.round(Number(w.g) / 100) / 10,
          ...(fat ? { bodyFatPct: Math.round(Number(fat.v) * 10) / 10 } : {}),
          ...(bmr ? { bmr: Math.round(Number(bmr.v) * WATTS_TO_KCAL_DAY) } : {}),
        };
      }
    }

    // Sleep: the night belongs to the morning you woke up; per night, the one app with the most recorded sleep.
    if (has.has('sleep_session_record_table')) {
      const stages = has.has('sleep_stages_table') ? all('select parent_key p, stage_start_time s, stage_end_time e, stage_type t from sleep_stages_table') : [];
      const byParent = new Map<number, Row[]>();
      for (const s of stages) byParent.set(Number(s.p), [...(byParent.get(Number(s.p)) ?? []), s]);
      const nights = new Map<string, Map<number, SleepSummary & { start: number; end: number; minutes: number }>>();
      for (const s of all('select row_id id, app_info_id a, start_time st, start_zone_offset so, end_time en, end_zone_offset eo from sleep_session_record_table')) {
        const day = local(Number(s.en), Number(s.eo)).slice(0, 10);
        const min = (types: number[]) =>
          (byParent.get(Number(s.id)) ?? []).filter((x) => types.includes(Number(x.t))).reduce((n, x) => n + (Number(x.e) - Number(x.s)) / 60_000, 0);
        const light = min(STAGE.light) + min(STAGE.sleeping);
        const deep = min(STAGE.deep);
        const rem = min(STAGE.rem);
        const awake = min(STAGE.awake);
        const staged = light + deep + rem;
        const duration = (Number(s.en) - Number(s.st)) / 60_000;
        const asleep = staged > 0 ? staged : Math.max(0, duration - awake);
        const perApp = nights.get(day) ?? new Map();
        const prev = perApp.get(Number(s.a));
        const start = Math.min(prev?.start ?? Infinity, Number(s.st) + Number(s.so ?? 0) * 1000);
        const end = Math.max(prev?.end ?? 0, Number(s.en) + Number(s.eo ?? 0) * 1000);
        perApp.set(Number(s.a), {
          asleepMin: Math.round((prev?.asleepMin ?? 0) + asleep),
          awakeMin: Math.round((prev?.awakeMin ?? 0) + awake),
          lightMin: Math.round((prev?.lightMin ?? 0) + light),
          deepMin: Math.round((prev?.deepMin ?? 0) + deep),
          remMin: Math.round((prev?.remMin ?? 0) + rem),
          bedtime: new Date(start).toISOString().slice(11, 16),
          wake: new Date(end).toISOString().slice(11, 16),
          start,
          end,
          minutes: (prev?.minutes ?? 0) + staged + (staged > 0 ? 0 : asleep),
        });
        nights.set(day, perApp);
      }
      for (const [day, perApp] of nights) {
        const best = [...perApp.values()].sort((x, y) => y.minutes - x.minutes)[0];
        if (!best || best.asleepMin <= 0) continue;
        const { start: _s, end: _e, minutes: _m, ...sleep } = best;
        get(day).sleep = sleep;
      }
    }

    // Workouts: sessions recorded by two apps at the same time count once (the longer one is kept).
    if (has.has('exercise_session_record_table')) {
      const sessions = all('select app_info_id a, start_time st, start_zone_offset so, end_time en, title, exercise_type x from exercise_session_record_table order by (end_time - start_time) desc');
      const kept: Row[] = [];
      for (const s of sessions) {
        const overlap = kept.some((k) => Math.min(Number(k.en), Number(s.en)) - Math.max(Number(k.st), Number(s.st)) > 0.5 * (Number(s.en) - Number(s.st)));
        if (!overlap) kept.push(s);
      }
      const hrIn = has.has('heart_rate_record_series_table') ? db.prepare('select avg(beats_per_minute) av, max(beats_per_minute) mx from heart_rate_record_series_table where epoch_millis between ? and ?') : null;
      for (const s of kept.sort((x, y) => Number(x.st) - Number(y.st))) {
        const startIso = local(Number(s.st), Number(s.so));
        const hr = (hrIn?.get(Number(s.st), Number(s.en)) ?? {}) as Row;
        const w: Workout = {
          type: EXERCISE[Number(s.x)] ?? (String(s.title ?? '').trim() || 'workout'),
          start: startIso.slice(11, 16),
          minutes: Math.round((Number(s.en) - Number(s.st)) / 60_000),
          km: 0,
          kcal: 0,
          steps: 0,
          avgHr: Math.round(Number(hr.av) || 0),
          maxHr: Math.round(Number(hr.mx) || 0),
        };
        const d = get(startIso.slice(0, 10));
        d.workouts = [...(d.workouts ?? []), w];
      }
    }

    return Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)));
  } finally {
    db.close();
  }
}

/** The newest Health Connect export (.zip or .db) in `dir`, or null. */
export function newestExport(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.(zip|db)$/i.test(f));
  } catch {
    return null;
  }
  const newest = files.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
  return newest ? join(dir, newest.f) : null;
}

/** Reads the newest export in `dir` and adds its days to the health history (filling gaps, never overwriting). */
export function importHealthConnect(dir: string, db: HealthDb): HealthConnectReport {
  const file = newestExport(dir);
  if (!file) throw new Error(t(`No Health Connect export (.zip) found in ${dir}.`, `ไม่พบไฟล์ส่งออกของ Health Connect (.zip) ใน ${dir}`));
  const work = mkdtempSync(join(tmpdir(), 'healthconnect-'));
  try {
    let dbPath = file;
    if (/\.zip$/i.test(file)) {
      const data = unzipEntry(readFileSync(file), DB_NAME);
      if (!data) throw new Error(t(`${file} has no ${DB_NAME} inside.`, `ใน ${file} ไม่มี ${DB_NAME}`));
      dbPath = join(work, DB_NAME);
      writeFileSync(dbPath, data);
    }
    const records = readHealthConnect(dbPath);
    db.merge(records, false);
    const days = Object.keys(records);
    db.noteImport(file.split('/').pop()!, days);
    const types: Record<string, number> = {};
    for (const r of Object.values(records)) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'source' || v == null) continue;
        if (k === 'extra') for (const ek of Object.keys(v as object)) types[ek] = (types[ek] ?? 0) + 1;
        else types[k] = (types[k] ?? 0) + 1;
      }
    }
    return { file, days: days.length, from: days[0] ?? '', to: days.at(-1) ?? '', types };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function formatHealthConnectReport(r: HealthConnectReport, historyDays: number): string {
  const names: Record<string, [string, string]> = {
    steps: ['steps', 'ก้าวเดิน'],
    energy: ['calories burned', 'แคลอรี่ที่เผาผลาญ'],
    heart: ['heart rate', 'อัตราการเต้นของหัวใจ'],
    oxygen: ['SpO2', 'ออกซิเจนในเลือด'],
    sleep: ['sleep', 'การนอน'],
    weight: ['weigh-ins', 'ชั่งน้ำหนัก'],
    workouts: ['workouts', 'ออกกำลังกาย'],
    restingHr: ['resting heart rate', 'ชีพจรขณะพัก'],
    bloodPressure: ['blood pressure', 'ความดันโลหิต'],
    vo2max: ['VO₂ max', 'VO₂ max'],
    heightCm: ['height', 'ส่วนสูง'],
  };
  const lines = Object.entries(r.types)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `• ${names[k] ? t(names[k][0], names[k][1]) : k}: ${t(`${n} days`, `${n} วัน`)}`);
  return [
    t(`📲 Health Connect: ${r.days} days (${r.from} to ${r.to}) read from ${r.file.split('/').pop()}.`, `📲 Health Connect: อ่าน ${r.days} วัน (${r.from} ถึง ${r.to}) จาก ${r.file.split('/').pop()}`),
    t('Added what was missing; days you already had keep their values.', 'เพิ่มข้อมูลที่ยังขาด วันที่มีข้อมูลอยู่แล้วไม่ถูกเขียนทับ'),
    ...lines,
    t(`History now covers ${historyDays} days.`, `ตอนนี้ประวัติมีทั้งหมด ${historyDays} วัน`),
  ].join('\n');
}
