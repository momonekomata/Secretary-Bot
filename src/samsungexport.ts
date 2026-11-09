import { spawn } from 'node:child_process';
import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Google } from './google';
import type { DayRecord, HealthDb } from './healthdb';
import { splitCsvLine, type Workout } from './healthsync';
import { localDay } from './time';

/**
 * Imports a Samsung Health "Download personal data" export (a folder of CSVs such as
 * com.samsung.shealth.tracker.pedometer_day_summary.<time>.csv, usually zipped or RAR'd and uploaded to Drive)
 * into the health history database. Files are read line by line, so even years of data fit in little memory.
 */

/** Data type of an export file: "tracker.pedometer_day_summary", "weight", "sleep", ... */
export function exportType(file: string): string | null {
  const m = /^com\.samsung\.(?:shealth|health)\.(.+?)\.\d{6,}\.csv$/.exec(basename(file));
  return m ? m[1] : null;
}

/** Column name without its "com.samsung.health.weight." prefix. */
const shortName = (c: string) => c.split('.').pop()!.trim();

/** "UTC+0700" → minutes. */
function offsetMinutes(s: string | undefined): number | null {
  const m = /UTC([+-])(\d{2}):?(\d{2})/.exec(s ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
}

/** A Samsung timestamp ("2024-04-17 05:13:22.291", UTC) or epoch ms, as epoch ms. */
function toMs(v: string | undefined): number {
  if (!v) return NaN;
  if (/^\d{12,}$/.test(v)) return Number(v);
  return Date.parse(`${v.trim().replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z'}`);
}

type R = Record<string, string>;

const EXERCISE_TYPES: Record<string, string> = {
  '1001': 'walking',
  '1002': 'running',
  '11007': 'cycling',
  '13001': 'hiking',
  '14001': 'swimming',
  '15005': 'treadmill',
  '15006': 'elliptical',
  '10007': 'weight training',
  '0': 'custom workout',
};

const STAGES: Record<string, 'awake' | 'light' | 'deep' | 'rem'> = { '40001': 'awake', '40002': 'light', '40003': 'deep', '40004': 'rem' };

export interface ImportReport {
  file: string;
  types: Record<string, { rows: number; days: number }>;
  skipped: string[];
  days: number;
  from: string;
  to: string;
}

/** Per-day accumulator while reading. */
class Days {
  map = new Map<string, DayRecord & { _hr?: { sum: number; n: number }; _o2?: { sum: number; n: number }; _stages?: Record<string, number> }>();
  get(day: string) {
    let d = this.map.get(day);
    if (!d) this.map.set(day, (d = {}));
    return d;
  }
}

export class SamsungImporter {
  constructor(
    private readonly timeZone: string,
    private readonly log: (...a: unknown[]) => void = () => undefined,
  ) {}

  /** Local day of a row: time offset column when present, else the bot's time zone. */
  private day(ms: number, row: R): string {
    const off = offsetMinutes(row.time_offset);
    if (!Number.isFinite(ms)) return '';
    return off === null ? localDay(new Date(ms), this.timeZone) : new Date(ms + off * 60_000).toISOString().slice(0, 10);
  }

  private hhmm(ms: number, row: R): string {
    const off = offsetMinutes(row.time_offset) ?? 0;
    return new Date(ms + off * 60_000).toISOString().slice(11, 16);
  }

  /** Reads one export CSV (first line is a "com.samsung…,version,count" banner, then the header). */
  async readFile(path: string, onRow: (row: R) => void): Promise<number> {
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    let header: string[] | null = null;
    let n = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!header) {
        if (/^com\.samsung\.[\w.]+,\d+,\d+\s*$/.test(line)) continue; // banner
        header = splitCsvLine(line).map(shortName);
        continue;
      }
      const cells = splitCsvLine(line);
      const row: R = {};
      header.forEach((h, i) => {
        if (h && cells[i] !== undefined && cells[i] !== '') row[h] = cells[i];
      });
      onRow(row);
      n++;
    }
    return n;
  }

  /** Reads every recognised CSV under `dir` into per-day records. */
  async importDir(
    dir: string,
    onFile?: (index: number, count: number, type: string) => void,
  ): Promise<{ records: Record<string, DayRecord>; report: Omit<ImportReport, 'file'> }> {
    const days = new Days();
    const types: ImportReport['types'] = {};
    const skipped: string[] = [];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.csv')) files.push(p);
      }
    };
    walk(dir);

    const usable = files.filter((f) => {
      const t = exportType(f);
      return t && this.handler(t, new Days());
    }).length;
    let index = 0;
    for (const file of files) {
      const type = exportType(file);
      const handler = type ? this.handler(type, days) : null;
      if (!type || !handler) {
        skipped.push(basename(file));
        continue;
      }
      onFile?.(++index, usable, type);
      const seen = new Set<string>();
      const rows = await this.readFile(file, (row) => {
        const d = handler(row);
        if (d) seen.add(d);
      });
      types[type] = { rows: (types[type]?.rows ?? 0) + rows, days: (types[type]?.days ?? 0) + seen.size };
      this.log(`Imported ${rows} rows from ${basename(file)}`);
    }

    // Finish averages and sleep stages.
    const records: Record<string, DayRecord> = {};
    for (const [day, d] of days.map) {
      const { _hr, _o2, _stages, ...rec } = d;
      if (_hr?.n) rec.heart = { ...(rec.heart ?? { min: 0, max: 0 }), avg: Math.round(_hr.sum / _hr.n) };
      if (_o2?.n) rec.oxygen = { avg: Math.round(_o2.sum / _o2.n), min: rec.oxygen?.min ?? 0 };
      if (_stages && rec.sleep) {
        rec.sleep.lightMin = Math.round(_stages.light ?? 0);
        rec.sleep.deepMin = Math.round(_stages.deep ?? 0);
        rec.sleep.remMin = Math.round(_stages.rem ?? 0);
        rec.sleep.awakeMin = Math.round(_stages.awake ?? rec.sleep.awakeMin);
        const staged = rec.sleep.lightMin + rec.sleep.deepMin + rec.sleep.remMin;
        if (staged > 0) rec.sleep.asleepMin = staged;
      }
      rec.source = 'samsung-export';
      records[day] = rec;
    }
    const sorted = Object.keys(records).sort();
    return { records, report: { types, skipped, days: sorted.length, from: sorted[0] ?? '', to: sorted.at(-1) ?? '' } };
  }

  /** Returns a row handler for a data type (returning the day it touched), or null when the type isn't used. */
  private handler(type: string, days: Days): ((row: R) => string | null) | null {
    const n = (v: string | undefined) => (v === undefined ? NaN : Number(v));
    const dayOf = (row: R, ...cols: string[]) => {
      for (const c of cols) {
        const ms = toMs(row[c]);
        if (Number.isFinite(ms)) return c === 'day_time' ? new Date(ms).toISOString().slice(0, 10) : this.day(ms, row);
      }
      return '';
    };

    if (/step_daily_trend|pedometer_day_summary/.test(type)) {
      return (row) => {
        const day = dayOf(row, 'day_time', 'create_time');
        const steps = n(row.step_count ?? row.count);
        if (!day || !(steps >= 0)) return null;
        const d = days.get(day);
        d.steps = Math.max(d.steps ?? 0, Math.round(steps)); // several sources per day: keep the combined (largest)
        return day;
      };
    }
    if (/calories_burned\.details/.test(type)) {
      return (row) => {
        const day = dayOf(row, 'day_time', 'create_time');
        const active = n(row.active_calorie);
        const resting = n(row.rest_calorie);
        if (!day || !(active >= 0)) return null;
        const d = days.get(day);
        const total = Math.round((active || 0) + (resting || 0) + (n(row.tef_calorie) || 0));
        if (!d.energy || total > d.energy.total) d.energy = { active: Math.round(active || 0), resting: Math.round(resting || 0), total };
        return day;
      };
    }
    if (type === 'weight' || type.endsWith('.weight')) {
      return (row) => {
        const ms = toMs(row.start_time ?? row.create_time);
        const day = this.day(ms, row);
        const kg = n(row.weight);
        if (!day || !(kg > 0)) return null;
        const opt = (v: string | undefined) => (n(v) > 0 ? Math.round(n(v) * 10) / 10 : undefined);
        days.get(day).weight = {
          day,
          time: this.hhmm(ms, row),
          kg: Math.round(kg * 10) / 10,
          bodyFatPct: opt(row.body_fat),
          skeletalMuscleKg: opt(row.skeletal_muscle_mass),
          waterKg: opt(row.total_body_water),
          bmr: opt(row.basal_metabolic_rate),
        };
        return day;
      };
    }
    if (/(^|\.)heart_rate$/.test(type)) {
      return (row) => {
        const day = dayOf(row, 'start_time', 'create_time');
        const hr = n(row.heart_rate);
        if (!day || !(hr >= 30 && hr <= 230)) return null;
        const d = days.get(day);
        d._hr = { sum: (d._hr?.sum ?? 0) + hr, n: (d._hr?.n ?? 0) + 1 };
        const lo = n(row.min) >= 30 ? n(row.min) : hr;
        const hi = n(row.max) >= 30 ? n(row.max) : hr;
        d.heart = { avg: 0, min: Math.min(d.heart?.min || Infinity, lo), max: Math.max(d.heart?.max ?? 0, hi) };
        return day;
      };
    }
    if (/oxygen_saturation|spo2/.test(type)) {
      return (row) => {
        const day = dayOf(row, 'start_time', 'create_time');
        const v = n(row.spo2 ?? row.oxygen_saturation);
        if (!day || !(v > 50 && v <= 100)) return null;
        const d = days.get(day);
        d._o2 = { sum: (d._o2?.sum ?? 0) + v, n: (d._o2?.n ?? 0) + 1 };
        d.oxygen = { avg: 0, min: Math.min(d.oxygen?.min || Infinity, v) };
        return day;
      };
    }
    if (type === 'sleep') {
      return (row) => {
        const s = toMs(row.start_time);
        const e = toMs(row.end_time);
        if (!(e > s)) return null;
        const day = this.day(e, row); // the night belongs to the morning you woke up
        const d = days.get(day);
        const min = Math.round((e - s) / 60_000);
        const prev = d.sleep;
        d.sleep = {
          asleepMin: (prev?.asleepMin ?? 0) + min,
          awakeMin: prev?.awakeMin ?? 0,
          lightMin: 0,
          deepMin: 0,
          remMin: 0,
          bedtime: prev?.bedtime ?? this.hhmm(s, row),
          wake: this.hhmm(e, row),
          score: n(row.sleep_score) > 0 ? Math.round(n(row.sleep_score)) : prev?.score,
        };
        return day;
      };
    }
    if (type === 'sleep_stage') {
      return (row) => {
        const s = toMs(row.start_time);
        const e = toMs(row.end_time);
        const stage = STAGES[row.stage ?? ''];
        if (!(e > s) || !stage) return null;
        const day = this.day(e, row);
        const d = days.get(day);
        d._stages = { ...(d._stages ?? {}), [stage]: (d._stages?.[stage] ?? 0) + (e - s) / 60_000 };
        return day;
      };
    }
    if (type === 'exercise') {
      return (row) => {
        const ms = toMs(row.start_time);
        const day = this.day(ms, row);
        if (!day) return null;
        const w: Workout = {
          type: EXERCISE_TYPES[row.exercise_type ?? ''] ?? (row.exercise_custom_type || `exercise ${row.exercise_type ?? ''}`.trim()),
          start: `${day} ${this.hhmm(ms, row)}`,
          minutes: Math.round((n(row.duration) || 0) / 60_000),
          km: Math.round((n(row.distance) || 0) / 10) / 100,
          kcal: Math.round(n(row.calorie) || 0),
          steps: Math.round(n(row.count) || 0),
          avgHr: Math.round(n(row.mean_heart_rate) || 0),
          maxHr: Math.round(n(row.max_heart_rate) || 0),
        };
        if (w.minutes <= 0) return null;
        const d = days.get(day);
        d.workouts = [...(d.workouts ?? []), w];
        return day;
      };
    }
    return null;
  }
}

/** Unpacks a .zip or .rar with unar (or bsdtar), both in the Docker image; gives up after `timeoutMs`. */
export function extract(archive: string, outDir: string, timeoutMs = 20 * 60_000): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill('SIGKILL');
      }, timeoutMs);
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new TimeoutError(`Unpacking took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`));
        else if (code === 0) resolve();
        else reject(new Error(`${cmd} failed: ${err.slice(0, 200)}`));
      });
    });
  return run('unar', ['-q', '-f', '-o', outDir, archive]).catch((e) => {
    if (e instanceof TimeoutError) throw e;
    return run('bsdtar', ['-xf', archive, '-C', outDir]);
  });
}

class TimeoutError extends Error {}

export interface ImportOptions {
  log?: (...a: unknown[]) => void;
  /** Progress messages for the user (already throttled for the noisy steps). */
  progress?: (message: string) => void;
  /** Minimum gap between repeated progress messages of the same step. */
  progressEveryMs?: number;
}

/** Finds the newest Samsung Health export archive in Drive, imports it, and reports what was found. */
export async function importFromDrive(google: Google, db: HealthDb, timeZone: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const log = opts.log ?? console.log;
  const every = opts.progressEveryMs ?? 60_000;
  let lastProgress = 0;
  const step = (message: string, throttled = false) => {
    log(message);
    if (throttled && Date.now() - lastProgress < every) return;
    lastProgress = Date.now();
    opts.progress?.(message);
  };
  const mb = (b: number) => Math.round(b / 1e6);
  const files = await google.listFiles(
    "(name contains 'samsung_health' or name contains 'samsunghealth' or name contains 'Samsung Health') and (name contains '.rar' or name contains '.zip') and trashed = false",
    'modifiedTime desc',
    5,
  );
  const file = files[0];
  if (!file) throw new Error('No Samsung Health export (.zip or .rar with "samsung_health" in its name) found in Google Drive.');
  const work = mkdtempSync(join(tmpdir(), 'sb-shealth-'));
  try {
    step(`📦 Found ${file.name}. Downloading from Google Drive…`);
    const archive = join(work, file.name.endsWith('.zip') ? 'export.zip' : 'export.rar');
    const bytes = await google.downloadToFile(file.id, archive, {
      onProgress: (b, total) => step(`⬇️ Downloaded ${mb(b)}${total ? ` of ${mb(total)}` : ''} MB…`, true),
    });
    step(`📂 Downloaded ${mb(bytes)} MB. Unpacking…`);
    const out = join(work, 'out');
    await extract(archive, out);
    rmSync(archive, { force: true });
    step('📖 Unpacked. Reading your health data…');
    const label = (t: string) => t.replace(/^tracker\./, '').replace(/[._]/g, ' ');
    const { records, report } = await new SamsungImporter(timeZone, log).importDir(out, (i, n, type) => step(`📖 Reading ${i} of ${n}: ${label(type)}…`, true));
    db.merge(records, false);
    db.noteImport(file.name, Object.keys(records));
    return { file: file.name, ...report };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function formatReport(r: ImportReport, dbDays: number): string {
  const types = Object.entries(r.types)
    .sort(([, a], [, b]) => b.days - a.days)
    .map(([t, v]) => `• ${t}: ${v.rows.toLocaleString('en-US')} rows, ${v.days} days`);
  return [
    `📦 Imported ${r.file}`,
    r.days ? `${r.days} days of data, ${r.from} to ${r.to}. The history now covers ${dbDays} days.` : 'No usable data found.',
    ...types,
    r.skipped.length ? `Not used (${r.skipped.length} files): ${r.skipped.slice(0, 12).join(', ')}${r.skipped.length > 12 ? ', …' : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The one import that may run at a time, in the background. */
export class ImportJob {
  running: { startedAt: number; stage: string; done: Promise<void> } | null = null;

  /**
   * Starts `run` in the background. Progress and the final report go to `notify`.
   * Returns false when an import is already running.
   */
  start(run: (progress: (m: string) => void) => Promise<string>, notify: (text: string) => Promise<void>, timeoutMs = 45 * 60_000): boolean {
    if (this.running) return false;
    const state = { startedAt: Date.now(), stage: 'starting', done: Promise.resolve() };
    this.running = state;
    const progress = (m: string) => {
      state.stage = m;
      void notify(m).catch(() => undefined);
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The import took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`)), timeoutMs);
    });
    state.done = Promise.race([run(progress), timeout])
      .then((report) => notify(report))
      .catch((e) => notify(`❌ The health import failed: ${(e as Error).message}\nYou can try again with /healthimport.`))
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        this.running = null;
      });
    return true;
  }

  status(): string {
    if (!this.running) return 'No health import is running.';
    const min = Math.max(0, Math.round((Date.now() - this.running.startedAt) / 60_000));
    return `📦 A health import is running (started ${min} min ago). Last step: ${this.running.stage}`;
  }
}

export const healthImport = new ImportJob();
