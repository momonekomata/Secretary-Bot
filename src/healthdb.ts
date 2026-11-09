import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaySummary, HealthSync } from './healthsync';
import { localDay } from './time';

/** One day of health data as stored in data/healthdb.json. */
export type DayRecord = Partial<Omit<DaySummary, 'day'>> & { source?: string };

interface Db {
  version: 1;
  days: Record<string, DayRecord>;
  imports: { file: string; at: string; days: number; from: string; to: string }[];
}

const hasData = (r: DayRecord) =>
  r.steps != null || !!r.heart || !!r.oxygen || !!r.weight || !!r.workouts?.length || !!r.sleep || !!r.energy;

/**
 * Long-term health history: every day the bot has seen from Health Sync, plus everything imported from a
 * Samsung Health export. Kept separate from store.json because it can grow to years of days.
 */
export class HealthDb {
  private db: Db = { version: 1, days: {}, imports: [] };
  private file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'healthdb.json') : null;
    if (dir && this.file) {
      mkdirSync(dir, { recursive: true });
      try {
        this.db = { ...this.db, ...JSON.parse(readFileSync(this.file, 'utf8')) };
      } catch {
        // No history yet.
      }
    }
  }

  private save() {
    if (!this.file) return;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.db));
    renameSync(`${this.file}.tmp`, this.file);
  }

  get(day: string): DayRecord | undefined {
    return this.db.days[day];
  }

  /**
   * Merges data for days. `overwrite` replaces fields that are already there (live Health Sync data);
   * otherwise only missing fields are filled (imports never overwrite what the bot saw itself).
   */
  merge(records: Record<string, DayRecord>, overwrite: boolean) {
    for (const [day, rec] of Object.entries(records)) {
      if (!hasData(rec)) continue;
      const old = this.db.days[day] ?? {};
      const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
      this.db.days[day] = overwrite ? { ...old, ...clean } : { ...clean, ...Object.fromEntries(Object.entries(old).filter(([, v]) => v != null)) };
    }
    this.save();
  }

  noteImport(file: string, days: string[]) {
    const sorted = [...days].sort();
    this.db.imports.push({ file, at: new Date().toISOString(), days: days.length, from: sorted[0] ?? '', to: sorted.at(-1) ?? '' });
    this.save();
  }

  imports() {
    return this.db.imports;
  }

  /** Days with data between `from` and `to` (inclusive, YYYY-MM-DD), oldest first. */
  range(from: string, to: string): [string, DayRecord][] {
    return Object.entries(this.db.days)
      .filter(([d]) => d >= from && d <= to)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  get size(): number {
    return Object.keys(this.db.days).length;
  }
}

export function toSummary(day: string, r: DayRecord | undefined): DaySummary {
  return {
    day,
    steps: r?.steps ?? null,
    heart: r?.heart ?? null,
    oxygen: r?.oxygen ?? null,
    weight: r?.weight ?? null,
    workouts: r?.workouts ?? [],
    sleep: r?.sleep ?? null,
    energy: r?.energy ?? null,
  };
}

/** Live Health Sync data when there is some, else the stored history; recent days are saved as they are seen. */
export class HealthData {
  constructor(
    readonly db: HealthDb,
    readonly sync: HealthSync | null,
  ) {}

  async day(day: string): Promise<DaySummary> {
    if (this.sync) {
      const live = await this.sync.day(day);
      const { day: _d, ...rec } = live;
      if (hasData(rec)) {
        this.db.merge({ [day]: { ...rec, source: 'healthsync' } }, true);
        return live;
      }
    }
    return toSummary(day, this.db.get(day));
  }

  /** The last `n` days including today, oldest first. */
  async lastDays(n: number, now: Date, timeZone: string): Promise<DaySummary[]> {
    const days = Array.from({ length: n }, (_, i) => localDay(new Date(now.getTime() - (n - 1 - i) * 864e5), timeZone));
    return Promise.all(days.map((d) => this.day(d)));
  }
}

export type Group = 'week' | 'month';

/** ISO-ish week key (Monday start) or month key for a day. */
export function groupKey(day: string, group: Group): string {
  if (group === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T12:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5);
  return `week of ${monday.toISOString().slice(0, 10)}`;
}

/** Averages and totals per week or month, for long-term trends. */
export function history(rows: [string, DayRecord][], group: Group): string {
  if (!rows.length) return 'No health history for that period.';
  const buckets = new Map<string, DayRecord[]>();
  for (const [day, r] of rows) {
    const k = groupKey(day, group);
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const lines = [...buckets].map(([k, rs]) => {
    const steps = avg(rs.map((r) => r.steps).filter((x): x is number => x != null && x > 0));
    const sleep = avg(rs.map((r) => r.sleep?.asleepMin).filter((x): x is number => !!x));
    const lowHr = avg(rs.map((r) => r.heart?.min).filter((x): x is number => !!x));
    const kcal = avg(rs.map((r) => r.energy?.total).filter((x): x is number => !!x && x > 800));
    const weights = rs.map((r) => r.weight?.kg).filter((x): x is number => !!x);
    const workouts = rs.flatMap((r) => r.workouts ?? []);
    const parts = [
      steps != null ? `avg ${steps.toLocaleString('en-US')} steps/day` : '',
      sleep != null ? `avg sleep ${Math.floor(sleep / 60)}h ${String(sleep % 60).padStart(2, '0')}m` : '',
      lowHr != null ? `avg lowest heart rate ${lowHr} bpm` : '',
      kcal != null ? `avg ${kcal} kcal burned/day` : '',
      weights.length ? `weight ${weights[0]}→${weights.at(-1)} kg` : '',
      workouts.length ? `${workouts.length} workouts, ${workouts.reduce((n, w) => n + w.minutes, 0)} min, ${workouts.reduce((n, w) => n + w.kcal, 0)} kcal` : '',
    ].filter(Boolean);
    return `${k} (${rs.length} days): ${parts.join('; ') || 'no data'}`;
  });
  return lines.join('\n');
}
