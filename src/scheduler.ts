import { fetchWaniKani } from './wanikani';
import type { Channels } from './channel';
import type { Config } from './config';
import type { Store } from './store';

/** Hour (0-23) and calendar day (YYYY-MM-DD) of `d` in `timeZone`. */
export function localClock(d: Date, timeZone: string): { hour: number; day: string } {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(d));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { hour, day };
}

export function nudgeText(lessons: number, reviews: number, level: number): string | null {
  if (!lessons && !reviews) return null;
  const parts = [reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : '', lessons ? `${lessons} lesson${lessons === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' and ');
  return `🔥 Daily quest: you have ${parts} waiting on WaniKani (level ${level}). がんばって！`;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly channels: Channels,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {}

  start(everyMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    for (const r of this.store.takeDueReminders(now)) {
      await this.channels.send(r.chatKey, `⏰ ${r.text}`).catch((e) => this.log(`Reminder #${r.id} failed:`, (e as Error).message));
    }
    await this.dailyNudge(now).catch((e) => this.log('Daily nudge failed:', (e as Error).message));
  }

  private async dailyNudge(now: Date) {
    if (this.cfg.dailyNudgeHour === '' || !this.cfg.wanikaniToken || !this.cfg.dailyNudgeChats.length) return;
    const { hour, day } = localClock(now, this.cfg.timezone);
    if (hour !== Number(this.cfg.dailyNudgeHour)) return;
    const pending = this.cfg.dailyNudgeChats.filter((c) => this.store.nudgedOn(c) !== day);
    if (!pending.length) return;
    for (const c of pending) this.store.markNudged(c, day); // mark first so a failure can't cause a retry storm
    const wk = await fetchWaniKani(this.cfg.wanikaniToken);
    const text = nudgeText(wk.lessonsAvailable, wk.reviewsAvailable, wk.level);
    if (!text) return;
    for (const c of pending) await this.channels.send(c, text).catch((e) => this.log(`Nudge to ${c} failed:`, (e as Error).message));
  }
}
