import type { Google } from './google';

/**
 * Reads Samsung Health data that the Health Sync app uploads to Google Drive: folders named
 * "Health Sync Steps", "Health Sync Heart rate", ... with one CSV per day, e.g.
 * "Steps 2026.11.08 Samsung Health.csv" (minute rows), "Weight 2026.11.08 Samsung Health.csv" (scale readings),
 * and one CSV per workout in "Health Sync Activities", e.g. "RUNNING 2026.03.21 11.03 Samsung Health.csv".
 */

export type Row = Record<string, string>;

/** Splits one CSV line; handles quotes and trailing spaces. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Parses CSV with a header row; handles quotes and Health Sync's trailing spaces. */
export function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

const FOLDERS = {
  steps: 'Steps',
  heart: 'Heart rate',
  weight: 'Weight',
  activities: 'Activities',
  oxygen: 'Oxygen saturation',
  sleep: 'Sleep',
  energy: 'Energy burned',
} as const;
type Kind = keyof typeof FOLDERS;

export interface Workout {
  type: string;
  start: string;
  minutes: number;
  km: number;
  kcal: number;
  steps: number;
  avgHr: number;
  maxHr: number;
}

export interface WeighIn {
  day: string;
  time: string;
  kg: number;
  bodyFatPct?: number;
  skeletalMuscleKg?: number;
  waterKg?: number;
  bmr?: number;
}

export interface SleepSummary {
  /** Light + deep + REM. */
  asleepMin: number;
  awakeMin: number;
  lightMin: number;
  deepMin: number;
  remMin: number;
  /** Local "HH:MM" of falling asleep and waking. */
  bedtime: string;
  wake: string;
  /** Samsung sleep score, when known (from the Samsung Health export). */
  score?: number;
}

export interface Energy {
  active: number;
  resting: number;
  total: number;
}

/** Extra measurements, mostly from the Samsung Health export. */
export interface Extras {
  /** Heart-rate variability (ms). */
  hrv?: number;
  /** Breaths per minute. */
  respiratory?: number;
  floors?: number;
  /** Samsung stress score (0-100). */
  stress?: number;
  waterMl?: number;
  bloodPressure?: { systolic: number; diastolic: number };
  heightCm?: number;
  /** Food logged in Samsung Health. */
  food?: { kcal: number; items: { name: string; kcal: number; meal: string }[] };
}

export interface DaySummary {
  /** YYYY-MM-DD */
  day: string;
  steps: number | null;
  heart: { avg: number; min: number; max: number } | null;
  oxygen: { avg: number; min: number } | null;
  weight: WeighIn | null;
  workouts: Workout[];
  /** The night before this day (sleep that ended on it). */
  sleep: SleepSummary | null;
  energy: Energy | null;
  extra?: Extras;
}

const num = (v: string | undefined) => {
  const n = Number(String(v ?? '').replace(/"/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** "2026-11-08" → "2026.11.08", the date format in Health Sync file names. */
const hsDate = (day: string) => day.replace(/-/g, '.');

export function weighIn(row: Row): WeighIn | null {
  const kg = num(row.Weight);
  if (!(kg > 0)) return null;
  const opt = (k: string) => (num(row[k]) > 0 ? num(row[k]) : undefined);
  const [date, time] = (row.Date ?? '').split(' ');
  return {
    day: date.replace(/\./g, '-'),
    time: time ?? row.Time ?? '',
    kg: Math.round(kg * 10) / 10,
    bodyFatPct: opt('Body fat percentage'),
    skeletalMuscleKg: opt('Skeletal muscle mass'),
    waterKg: opt('Total body water'),
    bmr: opt('Base metabolic rate'),
  };
}

/** Naive local timestamp ("2026.11.08 02:18:00") as milliseconds, for arithmetic only. */
function localMs(s: string): number {
  const m = /(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * Sleep for the night before `day`: stage segments that end between 18:00 the day before and 18:00 on the day.
 * Health Connect files repeat segments (a second copy starting a second earlier); overlapping segments are dropped.
 */
export function sleepNight(rows: Row[], day: string): SleepSummary | null {
  const end = Date.parse(`${day}T18:00:00Z`);
  const start = end - 864e5;
  const segs = rows
    .map((r) => {
      const s = localMs(r.Date ?? '');
      const dur = num(r['Duration in seconds']) * 1000;
      return { s, e: s + dur, stage: String(r['Sleep stage'] ?? '').toLowerCase() };
    })
    .filter((x) => x.e > x.s && x.e > start && x.e <= end)
    .sort((a, b) => a.s - b.s);
  let lastEnd = -Infinity;
  const kept = segs.filter((x) => {
    if (x.s < lastEnd - 2000) return false;
    lastEnd = Math.max(lastEnd, x.e);
    return true;
  });
  if (!kept.length) return null;
  const mins = (stage: string) => Math.round(kept.filter((x) => x.stage === stage).reduce((n, x) => n + (x.e - x.s), 0) / 60_000);
  const lightMin = mins('light') + mins('sleeping') + mins('asleep');
  const deepMin = mins('deep');
  const remMin = mins('rem');
  return {
    asleepMin: lightMin + deepMin + remMin,
    awakeMin: mins('awake') + mins('out_of_bed'),
    lightMin,
    deepMin,
    remMin,
    bedtime: hhmm(kept[0].s),
    wake: hhmm(Math.max(...kept.map((x) => x.e))),
  };
}

export function energy(row: Row | undefined): Energy | null {
  if (!row) return null;
  const active = Math.round(num(row['Active calories']) || 0);
  const resting = Math.round(num(row['Resting calories']) || 0);
  const total = Math.round(num(row['Total calories']) || 0) || active + resting;
  return active || resting || total ? { active, resting, total } : null;
}

export function workout(row: Row): Workout {
  const minutes = Math.round((num(row['Active time']) || num(row['Elapsed time']) || 0) / 60);
  return {
    type: (row['Activity name'] || row['Activity type'] || 'Workout').replace(/_/g, ' ').toLowerCase(),
    start: row.Date ?? '',
    minutes,
    km: Math.round((num(row['Distance (miles)']) || 0) * 1.609344 * 100) / 100,
    kcal: Math.round(num(row['Calories (kcal)']) || 0),
    steps: Math.round(num(row.Steps) || 0),
    avgHr: Math.round(num(row['Average heart rate']) || 0),
    maxHr: Math.round(num(row['Max heart rate']) || 0),
  };
}

export class HealthSync {
  private folders: { at: number; ids: Partial<Record<Kind, string>> } | null = null;

  constructor(private readonly google: Google) {}

  /** Finds the Health Sync folders (cached for an hour). */
  private async folderIds(): Promise<Partial<Record<Kind, string>>> {
    if (this.folders && Date.now() - this.folders.at < 3_600_000) return this.folders.ids;
    const found = await this.google.listFiles("name contains 'Health Sync' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", 'name', 50);
    const ids: Partial<Record<Kind, string>> = {};
    for (const [kind, label] of Object.entries(FOLDERS) as [Kind, string][]) {
      const f = found.find((x) => x.name.trim().toLowerCase() === `health sync ${label}`.toLowerCase());
      if (f) ids[kind] = f.id;
    }
    this.folders = { at: Date.now(), ids };
    return ids;
  }

  /** True when at least one Health Sync folder exists in Drive. */
  async available(): Promise<boolean> {
    return Object.keys(await this.folderIds()).length > 0;
  }

  /**
   * Rows of the daily file for `kind` on `day` (YYYY-MM-DD), or null if there is none. Daily files are named
   * "<Type> 2026.11.08[ 00:00:00] Samsung Health.csv" or "… Health Connect.csv" (Samsung Health is preferred);
   * weekly ("45-2026") and range ("2026.10.09-2026.11.08") files are skipped.
   */
  private async daily(kind: Kind, day: string): Promise<Row[] | null> {
    const folder = (await this.folderIds())[kind];
    if (!folder) return null;
    const prefix = `${FOLDERS[kind]} ${hsDate(day)}`;
    const files = (await this.google.listFiles(`'${folder}' in parents and name contains '${prefix}' and trashed = false`, 'modifiedTime desc', 10)).filter(
      (f) => f.name.startsWith(prefix) && f.name.endsWith('.csv') && !f.name.startsWith(`${prefix}-`),
    );
    const file = files.find((f) => f.name.includes('Samsung Health')) ?? files[0];
    if (!file) return null;
    return parseCsv(await this.google.downloadText(file.id));
  }

  private async workouts(day: string): Promise<Workout[]> {
    const folder = (await this.folderIds()).activities;
    if (!folder) return [];
    const files = await this.google.listFiles(`'${folder}' in parents and name contains '${hsDate(day)}' and trashed = false`, 'name', 20);
    const csvs = files.filter((f) => f.name.endsWith('Samsung Health.csv'));
    const rows = await Promise.all(csvs.map(async (f) => parseCsv(await this.google.downloadText(f.id))));
    return rows.flat().map(workout);
  }

  async day(day: string): Promise<DaySummary> {
    const dayBefore = new Date(Date.parse(`${day}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
    const [steps, heart, oxygen, weight, workouts, sleepToday, sleepBefore, energyRows] = await Promise.all([
      this.daily('steps', day),
      this.daily('heart', day),
      this.daily('oxygen', day),
      this.daily('weight', day),
      this.workouts(day),
      this.daily('sleep', day),
      this.daily('sleep', dayBefore),
      this.daily('energy', day),
    ]);
    const values = (rows: Row[] | null, col: string) => (rows ?? []).map((r) => num(r[col])).filter((n) => n > 0);
    const hr = values(heart, 'Heart rate').filter((n) => n >= 30 && n <= 230);
    const o2 = values(oxygen, 'Oxygen saturation');
    const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const weighIns = (weight ?? []).map(weighIn).filter((w): w is WeighIn => !!w);
    return {
      day,
      steps: steps ? values(steps, 'Steps').reduce((a, b) => a + b, 0) : null,
      heart: hr.length ? { avg: avg(hr), min: Math.min(...hr), max: Math.max(...hr) } : null,
      oxygen: o2.length ? { avg: avg(o2), min: Math.min(...o2) } : null,
      weight: weighIns.at(-1) ?? null,
      workouts,
      sleep: sleepToday || sleepBefore ? sleepNight([...(sleepBefore ?? []), ...(sleepToday ?? [])], day) : null,
      energy: energy(energyRows?.at(-1)),
    };
  }

  /** The most recent scale reading in the Weight folder. */
  async latestWeighIn(): Promise<WeighIn | null> {
    const folder = (await this.folderIds()).weight;
    if (!folder) return null;
    const files = await this.google.listFiles(`'${folder}' in parents and name contains '.csv' and trashed = false`, 'modifiedTime desc', 5);
    // Daily files ("Weight 2026.11.08 …") rather than weekly/monthly summaries.
    const dailyFile = files.find((f) => /\d{4}\.\d{2}\.\d{2}/.test(f.name)) ?? files[0];
    if (!dailyFile) return null;
    const rows = parseCsv(await this.google.downloadText(dailyFile.id)).map(weighIn).filter((w): w is WeighIn => !!w);
    return rows.at(-1) ?? null;
  }
}

const dur = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

export function formatDay(s: DaySummary): string {
  const parts: string[] = [];
  if (s.sleep) {
    const z = s.sleep;
    parts.push(
      `slept ${dur(z.asleepMin)} (${z.bedtime}–${z.wake}${z.deepMin || z.remMin ? `; deep ${dur(z.deepMin)}, REM ${dur(z.remMin)}, light ${dur(z.lightMin)}` : ''}; awake ${z.awakeMin} min${z.score ? `; score ${z.score}` : ''})`,
    );
  }
  if (s.steps !== null) parts.push(`${s.steps.toLocaleString('en-US')} steps`);
  if (s.heart) parts.push(`heart rate avg ${s.heart.avg} (lowest ${s.heart.min}, highest ${s.heart.max}) bpm`);
  if (s.oxygen) parts.push(`SpO2 avg ${s.oxygen.avg}% (lowest ${s.oxygen.min}%)`);
  if (s.weight) {
    const w = s.weight;
    parts.push(
      `weighed ${w.kg} kg${w.bodyFatPct ? `, body fat ${w.bodyFatPct.toFixed(1)}%` : ''}${w.skeletalMuscleKg ? `, skeletal muscle ${w.skeletalMuscleKg.toFixed(1)} kg` : ''}${w.bmr ? `, scale BMR ${w.bmr} kcal` : ''}`,
    );
  }
  for (const w of s.workouts) {
    parts.push(`workout: ${w.type} ${w.minutes} min${w.km ? `, ${w.km} km` : ''}${w.kcal ? `, ${w.kcal} kcal` : ''}${w.avgHr ? `, avg HR ${w.avgHr}` : ''}`);
  }
  if (s.energy) parts.push(`burned ${s.energy.total} kcal (${s.energy.active} active${s.energy.resting ? `, ${s.energy.resting} resting` : ''})`);
  const x = s.extra;
  if (x) {
    if (x.hrv) parts.push(`HRV ${x.hrv} ms`);
    if (x.respiratory) parts.push(`breathing ${x.respiratory}/min`);
    if (x.stress) parts.push(`stress ${x.stress}`);
    if (x.floors) parts.push(`${x.floors} floors`);
    if (x.waterMl) parts.push(`water ${x.waterMl} ml`);
    if (x.bloodPressure) parts.push(`blood pressure ${x.bloodPressure.systolic}/${x.bloodPressure.diastolic}`);
    if (x.food?.kcal) parts.push(`ate ${x.food.kcal} kcal (Samsung Health food log: ${x.food.items.slice(0, 6).map((i) => i.name).join(', ')}${x.food.items.length > 6 ? ', …' : ''})`);
  }
  return `${s.day}: ${parts.length ? parts.join('; ') : 'no watch data'}`;
}
