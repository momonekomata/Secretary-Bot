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
