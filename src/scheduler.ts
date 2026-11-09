import { BudgetExceeded } from './agent';
import { archiveUsage, type Briefings } from './briefings';
import type { Channels } from './channel';
import type { Config } from './config';
import type { Store } from './store';
import { localClock, parseHHMM } from './time';
import { resolveCity } from './tools';
import { airQuality, aqiCategory } from './weather';
import { fetchWaniKani } from './wanikani';

export function nudgeText(lessons: number, reviews: number, level: number): string | null {
  if (!lessons && !reviews) return null;
  const parts = [reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : '', lessons ? `${lessons} lesson${lessons === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' and ');
  return `🔥 Daily quest: you have ${parts} waiting on WaniKani (level ${level}). がんばって！`;
}

/** A job that runs once a day at a local time, optionally only on one weekday. */
export interface DailyJob {
  key: string;
  /** "HH:MM", or "" to disable. */
  at: string;
  /** "sun".."sat", or undefined for every day. */
  weekday?: string;
  run(): Promise<void>;
}

/** Jobs fire at most this long after their time, so a restart at 23:00 doesn't send the 08:00 briefing. */
const GRACE_MINUTES = 90;

export function isDue(job: DailyJob, now: Date, timeZone: string, lastRanOn: string | undefined): boolean {
  const at = parseHHMM(job.at);
  if (at === null) return false;
  const clock = localClock(now, timeZone);
  if (job.weekday && job.weekday !== clock.weekday) return false;
  if (lastRanOn === clock.day) return false;
  const mins = clock.hour * 60 + clock.minute;
  return mins >= at && mins < at + GRACE_MINUTES;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  readonly jobs: DailyJob[];

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly channels: Channels,
    private readonly briefings: Briefings | null,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {
    this.jobs = this.buildJobs();
  }

  private async broadcast(make: (chatKey: string) => Promise<string | null>) {
    for (const chat of this.cfg.notifyChats) {
      try {
        const text = await make(chat);
        if (text) await this.channels.send(chat, text);
      } catch (e) {
        const msg = e instanceof BudgetExceeded ? e.message : `Scheduled message failed: ${(e as Error).message}`;
        this.log(`Job for ${chat} failed:`, (e as Error).message);
        await this.channels.send(chat, msg).catch(() => undefined);
      }
    }
  }

  private buildJobs(): DailyJob[] {
    const s = this.cfg.schedule;
    const b = this.briefings;
    const jobs: DailyJob[] = [
      {
        key: 'cleanup',
        at: s.cleanup,
        run: async () => {
          const backup = archiveUsage(this.store, this.cfg.dataDir, this.cfg.billing.retentionDays, new Date());
          if (!backup) return;
          const caption = `🧹 Nightly cleanup: archived ${backup.rows} usage log rows older than ${this.cfg.billing.retentionDays} days.`;
          for (const chat of this.cfg.notifyChats) await this.channels.sendFile(chat, backup.name, backup.data, caption).catch(() => undefined);
        },
      },
    ];
    if (b) {
      jobs.push(
        { key: 'weather', at: s.weather, run: () => this.broadcast(() => b.weatherReport()) },
        { key: 'briefing', at: s.briefing, run: () => this.broadcast((chat) => b.morning(chat)) },
        { key: 'weekend', at: s.weekend, weekday: s.weekendDay, run: () => this.broadcast(() => b.weekendPlanner()) },
      );
    }
    if (s.nudgeHour !== '' && this.cfg.wanikaniToken) {
      jobs.push({
        key: 'nudge',
        at: `${s.nudgeHour.padStart(2, '0')}:00`,
        run: async () => {
          const wk = await fetchWaniKani(this.cfg.wanikaniToken);
          const text = nudgeText(wk.lessonsAvailable, wk.reviewsAvailable, wk.level);
          if (text) await this.broadcast(async () => text);
        },
      });
    }
    return jobs;
  }

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
    const day = localClock(now, this.cfg.timezone).day;
    for (const job of this.jobs) {
      if (this.running.has(job.key) || !isDue(job, now, this.cfg.timezone, this.store.ranOn(`job:${job.key}`))) continue;
      this.store.markRan(`job:${job.key}`, day); // mark first so a failure can't cause a retry storm
      this.running.add(job.key);
      job
        .run()
        .catch((e) => this.log(`Job ${job.key} failed:`, (e as Error).message))
        .finally(() => this.running.delete(job.key));
    }
    if (this.cfg.notifyChats.length && !this.running.has('aqi')) {
      this.running.add('aqi');
      await this.aqiAlert(now)
        .catch((e) => this.log('AQI check failed:', (e as Error).message))
        .finally(() => this.running.delete('aqi'));
    }
  }

  private lastAqiCheck = 0;

  /** Checks air quality hourly and alerts once a day when US AQI passes AQI_ALERT_THRESHOLD. */
  private async aqiAlert(now: Date) {
    const threshold = this.cfg.weather.aqiAlert;
    if (threshold === null || now.getTime() - this.lastAqiCheck < 3_600_000) return;
    const day = localClock(now, this.cfg.timezone).day;
    if (this.store.ranOn('aqi-alert') === day) return;
    this.lastAqiCheck = now.getTime();
    const city = await resolveCity(this.store, this.cfg.weather.defaultCity);
    const aq = await airQuality(city);
    if (aq.usAqi <= threshold) return;
    this.store.markRan('aqi-alert', day);
    const cat = aqiCategory(aq.usAqi);
    const text = `😷 Air quality alert for ${city.name}: US AQI ${aq.usAqi} (${cat.label}), PM2.5 ${aq.pm25.toFixed(1)} µg/m³.\n${cat.advice}`;
    for (const chat of this.cfg.notifyChats) await this.channels.send(chat, text).catch(() => undefined);
  }
}
