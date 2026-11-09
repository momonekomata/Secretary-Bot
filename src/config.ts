import { existsSync } from 'node:fs';

// Load .env when present (Node 20.12+ / 21.7+). Real env vars win.
if (existsSync('.env')) process.loadEnvFile('.env');

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

function effort(): Effort {
  const v = (process.env.BOT_EFFORT ?? 'medium') as Effort;
  return EFFORTS.includes(v) ? v : 'medium';
}

export const config = {
  model: process.env.BOT_MODEL ?? 'claude-opus-5-5',
  effort: effort(),
  botName: process.env.BOT_NAME ?? 'Tabi',
  timezone: process.env.BOT_TIMEZONE ?? 'Asia/Bangkok',
  persona: process.env.BOT_PERSONA ?? '',
  dataDir: process.env.BOT_DATA_DIR ?? './data',
  port: Number(process.env.PORT ?? 8787),
  /** Messages (user + assistant) kept per chat for context. */
  historyLimit: Number(process.env.BOT_HISTORY_LIMIT ?? 40),
  webTools: (process.env.BOT_WEB_TOOLS ?? 'on') !== 'off',

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    /** "polling" (no public URL needed) or "webhook". */
    mode: (process.env.TELEGRAM_MODE ?? 'polling') as 'polling' | 'webhook',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    allowedUsers: list('TELEGRAM_ALLOWED_USERS'),
  },
  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? '',
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    allowedUsers: list('LINE_ALLOWED_USERS'),
  },
  wanikaniToken: process.env.WANIKANI_TOKEN ?? '',
  /** Hour (0-23, BOT_TIMEZONE) for the daily study nudge; empty disables it. */
  dailyNudgeHour: process.env.BOT_DAILY_NUDGE_HOUR ?? '',
  /** Chats that get the daily nudge, e.g. "telegram:12345,line:Uabc...". */
  dailyNudgeChats: list('BOT_DAILY_NUDGE_CHATS'),
};

export type Config = typeof config;
