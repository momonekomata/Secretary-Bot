import type { Button } from './commands';
import { t } from './i18n';
import type { Reminder, Store } from './store';
import { formatTime, localClock, nextOccurrence, zonedTime } from './time';

/**
 * Reminders that keep coming back ("remind me every hour until I've taken my vitamins"): after the first time of
 * the day they repeat every few minutes until the user marks them done or the day's stop time passes, then start
 * again at the first time of the next day. Every day marked done is kept, so "did I take them?" has a real answer.
 */

/** Days marked done are kept this long. */
const KEEP_DONE_DAYS = 120;

export const DEFAULT_NAG_MINUTES = 60;
export const DEFAULT_STOP_AT = '21:00';

/** The local wall-clock time `hhmm` on `day` (YYYY-MM-DD). */
function at(day: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return zonedTime(y, mo, d, h, m, timeZone);
}

export const isDoneOn = (r: Reminder, day: string) => !!r.doneDays?.includes(day);

/**
 * When a reminder that just fired (or was just marked done) comes back next, or null when it's finished.
 * Plain reminders follow their repeat. Until-done reminders follow up every `everyMin` until done or the stop time,
 * then move to the next day's first time ("none" ends instead).
 */
export function nextTime(r: Reminder, now: Date, timeZone: string): Date | null {
  if (!r.untilDone) return r.repeat ? nextOccurrence(new Date(r.dueAt), r.repeat, timeZone, now) : null;
  const today = localClock(now, timeZone).day;
  if (!isDoneOn(r, today)) {
    const step = r.untilDone.everyMin * 60_000;
    let follow = Date.parse(r.dueAt) + step;
    if (follow <= now.getTime()) follow = now.getTime() + step;
    if (follow <= at(today, r.untilDone.stopAt, timeZone).getTime()) return new Date(follow);
  }
  // Done (or past the stop time): the next day's first time, if it repeats.
  if (!r.repeat) return null;
  const first = new Date(r.firstAt ?? r.dueAt);
  return nextOccurrence(first, r.repeat, timeZone, now);
}

/**
 * Which of `days` (YYYY-MM-DD) can be recorded: real dates, not in the future, within the kept period.
 * Returns the accepted days and the rejected ones.
 */
export function checkDays(days: string[], now: Date, timeZone: string): { ok: string[]; bad: string[] } {
  const today = localClock(now, timeZone).day;
  const cutoff = localClock(new Date(now.getTime() - KEEP_DONE_DAYS * 864e5), timeZone).day;
  const ok: string[] = [];
  const bad: string[] = [];
  for (const d of days.map((x) => x.trim())) {
    const real = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
    (real && d <= today && d >= cutoff ? ok : bad).push(d);
  }
  return { ok, bad };
}

/**
 * Marks the reminder done on `days` (default: today; give checked days from checkDays). If today is among them,
 * an until-done reminder skips the rest of today's follow-ups.
 */
export function markDone(store: Store, chatKey: string, id: number, now: Date, timeZone: string, days?: string[]): Reminder | null {
  const r = store.reminders(chatKey).find((x) => x.id === id);
  if (!r) return null;
  const day = localClock(now, timeZone).day;
  const marking = days?.length ? days : [day];
  const cutoff = localClock(new Date(now.getTime() - KEEP_DONE_DAYS * 864e5), timeZone).day;
  const doneDays = [...new Set([...(r.doneDays ?? []), ...marking])].filter((d) => d >= cutoff).sort();
  const updated: Reminder = { ...r, doneDays };
  // An until-done reminder still waiting to follow up today jumps to its next day (or ends if it doesn't repeat).
  if (r.untilDone && marking.includes(day) && localClock(new Date(r.dueAt), timeZone).day <= day) {
    const next = nextTime(updated, now, timeZone);
    if (!next) {
      store.removeReminder(chatKey, id);
      return updated;
    }
    updated.dueAt = next.toISOString();
    if (r.repeat) updated.firstAt = next.toISOString();
  }
  store.updateReminder(updated);
  return updated;
}

/** The message sent when a reminder is due. */
export function reminderText(text: string): string {
  return t(`⏰ ${text}`, `⏰ แจ้งเตือน: ${text}`);
}

/** The reminder's message, with a "done" button for until-done reminders. */
export function reminderMessage(r: Reminder): { text: string; buttons?: Button[][] } {
  const text = reminderText(r.text);
  if (!r.untilDone) return { text };
  return { text, buttons: [[{ label: t('✅ Done', '✅ ทำแล้ว'), command: `/rdone ${r.id}` }]] };
}

/** A cancelled or finished reminder kept for its record, for the AI. */
export function endedLine(r: Reminder, now: Date, timeZone: string): string {
  const done = r.doneDays ?? [];
  const since = localClock(new Date(now.getTime() - 14 * 864e5), timeZone).day;
  const recent = done.filter((d) => d > since);
  return `#${r.id} (ended ${(r.endedAt ?? '').slice(0, 10)}): ${r.text}; done on ${recent.length} of the last 14 days${recent.length ? ` (${recent.map((d) => d.slice(5)).join(', ')})` : ''}; all days done: ${done.join(', ')}`;
}

/** One line per reminder for the AI and /reminders: when it's next, how it repeats, and the days it was done. */
export function reminderLine(r: Reminder, now: Date, timeZone: string): string {
  const today = localClock(now, timeZone).day;
  const how = [
    r.repeat ? `repeats ${r.repeat}` : '',
    r.untilDone ? `follows up every ${r.untilDone.everyMin} min until marked done (stops at ${r.untilDone.stopAt})` : '',
  ].filter(Boolean);
  const done = r.doneDays ?? [];
  const last14 = done.filter((d) => d > localClock(new Date(now.getTime() - 14 * 864e5), timeZone).day);
  const doneText = r.untilDone || done.length
    ? `; done today: ${isDoneOn(r, today) ? 'yes' : 'no'}; done on ${last14.length} of the last 14 days${last14.length ? ` (${last14.map((d) => d.slice(5)).join(', ')})` : ''}${done.length ? `; last done ${done.at(-1)}` : '; never marked done yet'}`
    : '';
  return `#${r.id} next at ${formatTime(new Date(r.dueAt), timeZone)}${how.length ? ` (${how.join('; ')})` : ''}: ${r.text}${doneText}`;
}

/** /reminders: every reminder, when it's next, and for until-done ones what's been done; buttons to tick off today. */
export function formatReminders(rs: Reminder[], now: Date, timeZone: string, ended: Reminder[] = []): { text: string; buttons?: Button[][] } {
  const since14 = localClock(new Date(now.getTime() - 14 * 864e5), timeZone).day;
  const endedBlock = ended
    .filter((r) => (r.doneDays ?? []).some((d) => d > since14))
    .map((r) => {
      const recent = (r.doneDays ?? []).filter((d) => d > since14);
      return t(
        `#${r.id} ${r.text} (ended): done ${recent.length} of the last 14 days (${recent.map((d) => d.slice(5)).join(', ')})`,
        `#${r.id} ${r.text} (สิ้นสุดแล้ว): ทำแล้ว ${recent.length} จาก 14 วันที่ผ่านมา (${recent.map((d) => d.slice(5)).join(', ')})`,
      );
    });
  if (!rs.length && endedBlock.length) return { text: [t('⏰ No reminders now. Earlier records:', '⏰ ตอนนี้ไม่มีการแจ้งเตือน บันทึกก่อนหน้า:'), ...endedBlock].join('\n\n') };
  if (!rs.length) {
    return {
      text: t(
        '⏰ No reminders. Ask me, e.g. "remind me to take my vitamins every day at 9, every hour until I\'ve taken them".',
        '⏰ ยังไม่มีการแจ้งเตือน บอกฉันได้เลย เช่น "เตือนให้กินวิตามินทุกวันตอน 9 โมง เตือนทุกชั่วโมงจนกว่าจะกินแล้ว"',
      ),
    };
  }
  const today = localClock(now, timeZone).day;
  const since = localClock(new Date(now.getTime() - 14 * 864e5), timeZone).day;
  const repeats: Record<string, [string, string]> = {
    daily: ['every day', 'ทุกวัน'],
    weekdays: ['weekdays', 'วันจันทร์-ศุกร์'],
    weekly: ['every week', 'ทุกสัปดาห์'],
    monthly: ['every month', 'ทุกเดือน'],
  };
  const buttons: Button[][] = [];
  const blocks = rs.map((r) => {
    const how = [r.repeat ? t(...repeats[r.repeat]) : ''];
    if (r.untilDone) how.push(t(`every ${r.untilDone.everyMin} min until done (until ${r.untilDone.stopAt})`, `ทุก ${r.untilDone.everyMin} นาทีจนกว่าจะทำ (ถึง ${r.untilDone.stopAt})`));
    const lines = [`#${r.id} ${r.text}`, t(`   next: ${formatTime(new Date(r.dueAt), timeZone)}`, `   ครั้งถัดไป: ${formatTime(new Date(r.dueAt), timeZone)}`) + (how.filter(Boolean).length ? ` · ${how.filter(Boolean).join(' · ')}` : '')];
    if (r.untilDone) {
      const recent = (r.doneDays ?? []).filter((d) => d > since);
      const list = recent.length ? ` (${recent.map((d) => d.slice(5)).join(', ')})` : '';
      lines.push(
        (isDoneOn(r, today) ? t('   ✅ done today', '   ✅ วันนี้ทำแล้ว') : t('   ⬜ not done today', '   ⬜ วันนี้ยังไม่ได้ทำ')) +
          t(` · done ${recent.length} of the last 14 days${list}`, ` · ทำแล้ว ${recent.length} จาก 14 วันที่ผ่านมา${list}`),
      );
      if (!isDoneOn(r, today)) buttons.push([{ label: t(`✅ #${r.id} done today`, `✅ #${r.id} วันนี้ทำแล้ว`), command: `/rdone ${r.id}` }]);
    }
    return lines.join('\n');
  });
  return {
    text: [t('⏰ Reminders:', '⏰ การแจ้งเตือน:'), ...blocks, ...(endedBlock.length ? [t('Earlier records:', 'บันทึกก่อนหน้า:'), ...endedBlock] : []), t('To cancel or change one, just tell me (e.g. "cancel #12").', 'ถ้าจะยกเลิกหรือเปลี่ยน บอกฉันได้เลย (เช่น "ยกเลิก #12")')].join('\n\n'),
    ...(buttons.length ? { buttons } : {}),
  };
}
