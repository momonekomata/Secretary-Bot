import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Load .env from the project folder, then from the data folder (handy on a NAS, where the data
// folder is the mounted volume). Variables already set in the environment win.
const dataDirEnv = process.env.BOT_DATA_DIR ?? './data';
for (const file of ['.env', join(dataDirEnv, '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

function list(name: string, fallback = ''): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';

export const config = {
  geminiKey,
  anthropicKey,
  /** Starting model; change it at runtime with /settings. Gemini is the default when its key is set. */
  defaultModel: process.env.BOT_MODEL ?? (geminiKey || !anthropicKey ? 'gemini-3.8-flash' : 'claude-opus-5-5'),
  defaultEffort: (EFFORTS as readonly string[]).includes(process.env.BOT_EFFORT ?? '') ? (process.env.BOT_EFFORT as Effort) : 'medium',
  /** Gemini model used to transcribe voice notes, whatever chat model is selected. */
  voiceModel: process.env.VOICE_MODEL ?? 'gemini-3.8-flash',
  defaultTranslateTo: process.env.VOICE_TRANSLATE_TO ?? 'English',
  /** Gemini text-to-speech model and voice for spoken replies. */
  /** Gemini speech model tried first; the others in audio.ts TTS_MODELS are fallbacks. */
  ttsModel: process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts',
  ttsVoice: process.env.TTS_VOICE ?? 'Kore',
  /** off | voice-notes (answer voice notes with voice) | always. Also /voice in chat. */
  defaultVoiceReplies: (['off', 'voice-notes', 'always'].includes(process.env.VOICE_REPLIES ?? '') ? process.env.VOICE_REPLIES : 'voice-notes') as 'off' | 'voice-notes' | 'always',
  /** Public https address of this bot (LINE webhook, audio and file links), e.g. https://bot.example.com */
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),

  botName: process.env.BOT_NAME ?? 'Tabi',
  timezone: process.env.BOT_TIMEZONE ?? process.env.TZ ?? 'Asia/Bangkok',
  persona: process.env.BOT_PERSONA ?? '',
  dataDir: dataDirEnv,
  port: Number(process.env.PORT ?? 8787),
  /** Messages (user + assistant) kept per chat for context. */
  historyLimit: Number(process.env.BOT_HISTORY_LIMIT ?? 40),
  webTools: (process.env.BOT_WEB_TOOLS ?? 'on') !== 'off',
  version: process.env.BOT_VERSION ?? 'dev',
  announceStartup: (process.env.BOT_ANNOUNCE_STARTUP ?? 'on') !== 'off',

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

  /** Chats that receive scheduled messages (briefings, weather, alerts), e.g. "telegram:12345,line:Uabc". */
  notifyChats: list('BOT_NOTIFY_CHATS', process.env.BOT_DAILY_NUDGE_CHATS ?? ''),
  schedule: {
    /** Local times (HH:MM in BOT_TIMEZONE). Empty disables a job. */
    briefing: process.env.BRIEFING_TIME ?? '08:00',
    weather: process.env.WEATHER_TIME ?? '07:00',
    weekend: process.env.WEEKEND_PLANNER_TIME ?? '16:00',
    /** Day for the weekend planner: sun, mon, ... sat. */
    weekendDay: (process.env.WEEKEND_PLANNER_DAY ?? 'fri').toLowerCase(),
    cleanup: process.env.CLEANUP_TIME ?? '03:00',
    /** Evening money check: new receipts and card alerts from Gmail, and budget warnings. */
    money: process.env.MONEY_CHECK_TIME ?? '21:00',
    /** Kanji and word of the day. */
    japanese: process.env.JAPANESE_TIME ?? '12:00',
    /** Legacy WaniKani nudge hour (0-23). */
    nudgeHour: process.env.BOT_DAILY_NUDGE_HOUR ?? '',
  },

  billing: {
    /** Daily spend (USD), all AI together: a warning, and a hard cap that pauses all AI until midnight. */
    warnUsd: num('DAILY_WARNING_LIMIT_USD'),
    capUsd: num('DAILY_HARD_LIMIT_USD'),
    /** The same per provider; a provider's cap pauses only its models (e.g. Gemini within AI Pro credit, Claude within Max credit). */
    providers: {
      gemini: { warnUsd: num('GEMINI_DAILY_WARNING_LIMIT_USD'), capUsd: num('GEMINI_DAILY_HARD_LIMIT_USD') },
      claude: { warnUsd: num('CLAUDE_DAILY_WARNING_LIMIT_USD'), capUsd: num('CLAUDE_DAILY_HARD_LIMIT_USD') },
    },
    /** Days of usage log kept before the nightly cleanup archives them. */
    retentionDays: num('LOG_RETENTION_DAYS') ?? 30,
    /** Optional JSON price overrides, USD per 1M tokens: {"model-id":{"input":1,"output":2}} */
    priceOverrides: process.env.MODEL_PRICES ?? '',
  },

  news: {
    language: process.env.NEWS_LANGUAGE ?? 'en-US',
    country: process.env.NEWS_COUNTRY ?? 'US',
    defaultTopics: list('NEWS_TOPICS', 'Artificial Intelligence,Global Economy,Thailand'),
  },
  weather: {
    defaultCity: process.env.WEATHER_CITY ?? 'Bangkok',
    /** Push an alert when US AQI goes above this (empty disables). */
    aqiAlert: num('AQI_ALERT_THRESHOLD'),
  },

  wanikaniToken: process.env.WANIKANI_TOKEN ?? '',
  /** Google Maps Platform key (Places API (New) + Routes API). */
  mapsKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  /** Folder (inside the container) where Android's daily Health Connect export (.zip) lands; see docker-compose.yml. */
  healthConnectDir: process.env.HEALTH_CONNECT_DIR ?? '/healthconnect',
  /** USDA FoodData Central key (free); empty uses USDA's shared DEMO_KEY, which has a low hourly limit. */
  usdaKey: process.env.USDA_API_KEY ?? '',

  /**
   * Gemini through Vertex AI (Google Cloud billing, so Cloud/trial credits apply): on when the service-account key
   * file exists. The Gemini API key, if set, stays as the backup for calls that fail on Vertex AI.
   */
  vertex: {
    enabled: (process.env.GEMINI_VIA_VERTEX ?? 'on') !== 'off',
    keyFile: process.env.VERTEX_KEY_FILE ?? join(dataDirEnv, 'vertex-key.json'),
    /** Optional: read from the key file when empty. */
    project: process.env.VERTEX_PROJECT ?? '',
    /** "global" serves the newest models. */
    location: process.env.VERTEX_LOCATION ?? 'global',
  },
};

export type Config = typeof config;
