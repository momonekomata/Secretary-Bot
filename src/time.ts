/** Human-readable time in `timeZone`, e.g. "Sat, 07 Nov 2026, 17:00 GMT+7". */
export function formatTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).format(d);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Local wall-clock parts of `d` in `timeZone`. */
export function localClock(d: Date, timeZone: string): { hour: number; minute: number; day: string; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: String(parts.weekday).toLowerCase().slice(0, 3),
  };
}

/** Local calendar day (YYYY-MM-DD) of `d`. */
export const localDay = (d: Date, timeZone: string) => localClock(d, timeZone).day;

/** Parses "HH:MM" into minutes after midnight, or null. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export const isWeekday = (s: string) => WEEKDAYS.includes(s);

/** Minutes `timeZone` is ahead of UTC at instant `d`. */
export function tzOffsetMinutes(d: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** The instant when the wall clock in `timeZone` shows the given local date and time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  const second = guess - tzOffsetMinutes(new Date(t), timeZone) * 60_000; // re-check across DST changes
  if (second !== t) t = second;
  return new Date(t);
}

export const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type Repeat = (typeof REPEATS)[number];

/** Next time a repeating reminder fires after `now`, keeping its local wall-clock time. */
export function nextOccurrence(due: Date, repeat: Repeat, timeZone: string, now: Date): Date | null {
  if (repeat === 'none') return null;
  const c = localClock(due, timeZone);
  let [y, mo, d] = c.day.split('-').map(Number);
  const startDay = d;
  for (let i = 0; i < 400; i++) {
    if (repeat === 'monthly') {
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
      d = Math.min(startDay, new Date(Date.UTC(y, mo, 0)).getUTCDate()); // clamp 31st to month length
    } else {
      const next = new Date(Date.UTC(y, mo - 1, d + (repeat === 'weekly' ? 7 : 1)));
      [y, mo, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
      const dow = next.getUTCDay();
      if (repeat === 'weekdays' && (dow === 0 || dow === 6)) continue;
    }
    const t = zonedTime(y, mo, d, c.hour, c.minute, timeZone);
    if (t.getTime() > now.getTime()) return t;
  }
  return null;
}
