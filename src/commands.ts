import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceeded, type Agent } from './agent';
import { archiveUsage, usageStats, type Briefings } from './briefings';
import { EFFORTS, type Config, type Effort } from './config';
import { formatEmails, formatEvents, formatTasks } from './google';
import { formatPlaces } from './maps';
import { MODELS, modelInfo } from './models';
import { findPersona, PERSONAS } from './personas';
import { bodyNumbers, formatBody, formatFoodDay } from './health';
import { JLPT_LEVELS, type JapaneseDaily } from './japanese';
import type { Reviews } from './review';
import { localDay } from './time';
import { weatherText } from './tools';
import { formatDay as formatWatchDay } from './healthsync';
import { buildExport } from './export';
import { budgetAlerts, CATEGORY_KEYS, findCategory, report, scanEmail, scanSummary, txnLine } from './money';
import { formatReport, healthImport, importFromDrive } from './samsungexport';
import type { LimitScope, Store } from './store';
import { geocode } from './weather';

export interface Button {
  label: string;
  /** The command a tap runs, e.g. "/model gemini-3.8-flash". */
  command: string;
}

export interface CommandReply {
  text: string;
  buttons?: Button[][];
  file?: { name: string; data: Buffer };
  /** Text to also send as a spoken voice message. */
  speak?: string;
}

export interface CommandContext {
  chatKey: string;
  userId: string;
  agent: Agent;
  store: Store;
  cfg: Config;
  briefings: Briefings;
  /** Health check for /status. */
  status: () => Promise<string>;
  japanese?: JapaneseDaily;
  reviews?: Reviews;
  /** Sends a message to this chat later (for background jobs). */
  notify?: (text: string) => Promise<void>;
  now?: () => Date;
}

/** Commands that call an AI or an outside API: channels show "typing…" while they run. */
export const SLOW_COMMANDS = new Set(['/review', '/health', '/healthimport', '/kanji', '/word', '/forecast', '/roleplay', '/news', '/brief', '/weather', '/weekend', '/status', '/calendar', '/inbox', '/mail', '/drive', '/gtask', '/gdone', '/setcity', '/places', '/say', '/budget', '/money']);

export const HELP = [
  'Hi! I am your personal secretary and news curator. Just talk to me, send a photo, or send a voice note.',
  '',
  '🗓️ Secretary: /todo, /add <task>, /done <id>, /clear',
  '📰 News: /news [topic], /topics, /addtopic <topic>, /removetopic <topic>',
  '🌅 Briefings: /brief (morning briefing now), /weather [city], /weekend, /setcity <city>',
  '📧 Google: /calendar [days], /inbox, /mail <search>, /gtask [title], /gdone <number>, /drive [search]',
  '📍 Places: share your location, /places <what>, /setcity <city>',
  '🔊 Voice: send a voice note; /voice off|notes|always, /say <text>',
  '🇯🇵 Japanese: /review (your WaniKani reviews, right here), /kanji, /word (of the day, daily at 12:00; they count as reviews when due), /jlpt N4',
  '🍽️ Health: tell me or send a photo of what you ate; /food, /bmi, /profile, /weight 65.5, /health (watch data), /healthimport (Samsung Health export from Drive)',
  '🎬 Roleplay: /roleplay (scenes, stories, Japanese conversation practice), /roleplay end',
  '🌦️ Weather: /weather, /forecast (7 days), /weekend',
  '🎭 Personality: /persona (pick one or describe your own), /name <new name>, /ttsvoice <voice>',
  '💰 Money: send payment slips or tell me what you spent; /budget shows the month, /budget set 20000 sets a budget, /budget scan reads your email',
  '📌 Preferences: /prefs (e.g. /prefs add Always reply in Thai), kept across personalities and updates',
  '💾 Your data: /export (food, weight, health history, memories and settings as a .zip)',
  '⚙️ Settings: /settings (AI model, thinking effort, voice translation), /limit (daily spending caps in USD), /stats, /status, /cleanup',
  '💬 Chat: /reset (forget this conversation, keep memories), /id',
  '',
  'Try: "Remind me at 9pm to do my reviews", "Do I have time for the dentist tomorrow afternoon?", or "Draft an email to sarah@example.com about the Q4 deck".',
].join('\n');

const VOICE_MODES: [string, 'off' | 'voice-notes' | 'always'][] = [
  ['🔇 text only', 'off'],
  ['🔊 to voice notes', 'voice-notes'],
  ['🔊 always', 'always'],
];

const LANGUAGES: [string, string][] = [
  ['English', 'English'],
  ['ไทย', 'Thai'],
  ['日本語', 'Japanese'],
];

const LIMIT_SCOPES: Record<string, LimitScope> = { gemini: 'gemini', g: 'gemini', claude: 'claude', c: 'claude', anthropic: 'claude', all: 'all', total: 'all', overall: 'all' };
const SCOPE_NAMES: Record<LimitScope, string> = { gemini: 'Gemini', claude: 'Claude', all: 'All AI together' };
const usd = (n: number | null) => (n === null ? 'off' : `$${n.toFixed(2)}`);

/** Parses "$3", "2.5", "off". Returns null for off, undefined when not a valid amount. */
function parseUsd(s: string | undefined): number | null | undefined {
  if (!s) return undefined;
  if (/^(off|none|no|0)$/i.test(s)) return null;
  const v = Number(s.replace(/[$,]/g, ''));
  return v > 0 && v <= 1000 ? Math.round(v * 100) / 100 : undefined;
}

/** The daily spending limits, with buttons for common caps. */
export function limitsView(ctx: CommandContext, notice = ''): CommandReply {
  const { agent, store } = ctx;
  const l = agent.limits();
  const mark = (scope: LimitScope, key: 'warnUsd' | 'capUsd') => (l[scope].from[key] === 'chat' ? '✏️' : '');
  const line = (scope: LimitScope) =>
    `${SCOPE_NAMES[scope]}: spent $${agent.spentToday(scope === 'all' ? undefined : scope).toFixed(4)} today · warn ${usd(l[scope].warnUsd)}${mark(scope, 'warnUsd')} · cap ${usd(l[scope].capUsd)}${mark(scope, 'capUsd')}`;
  const text = [
    notice,
    '💵 Daily AI spending limits (USD, reset at midnight)',
    line('gemini'),
    line('claude'),
    line('all'),
    store.settings().limits ? '✏️ = set here in chat; the rest come from the .env file.' : 'All values come from the .env file.',
    '',
    'At the cap, that AI pauses until midnight. At the warning, I add a one-time note to a reply.',
    'Change: /limit gemini 3 (cap) · /limit claude warn 1 · /limit all 5 · /limit gemini off · /limit reset (back to .env)',
  ]
    .filter((x, i) => x !== '' || i > 1)
    .join('\n');
  const capRow = (scope: 'gemini' | 'claude', amounts: number[]) => [
    ...amounts.map((a) => ({ label: `${l[scope].capUsd === a ? '✅ ' : ''}${SCOPE_NAMES[scope]} $${a}`, command: `/limit ${scope} ${a}` })),
    { label: `${l[scope].capUsd === null ? '✅ ' : ''}No cap`, command: `/limit ${scope} cap off` },
  ];
  return {
    text,
    buttons: [capRow('gemini', [1, 2, 5]), capRow('claude', [1, 3, 5]), [{ label: '↩️ Use .env values', command: '/limit reset' }]],
  };
}

export function settingsView(ctx: CommandContext, notice = ''): CommandReply {
  const { agent, store, cfg } = ctx;
  const s = store.settings();
  const current = modelInfo(agent.model);
  const translateTo = s.translateTo ?? cfg.defaultTranslateTo;
  const voiceMode = s.voiceReplies ?? cfg.defaultVoiceReplies;
  const text = [
    notice,
    '⚙️ Settings',
    `Name: ${agent.botName}`,
    `Personality: ${personaName(s.personaKey)}`,
    `AI model: ${current.label} (${current.id})`,
    `Thinking effort: ${agent.effort}`,
    `Voice notes: transcribe and translate to ${translateTo}`,
    `Spoken replies: ${voiceMode === 'off' ? 'off' : voiceMode === 'always' ? 'always' : 'when you send a voice note'}`,
    `Weather city: ${s.city?.name ?? cfg.weather.defaultCity}`,
    `News topics: ${(s.newsTopics ?? cfg.news.defaultTopics).join(', ') || 'none'}`,
    `Daily caps: Gemini ${usd(agent.limits().gemini.capUsd)}, Claude ${usd(agent.limits().claude.capUsd)}, all ${usd(agent.limits().all.capUsd)} (/limit)`,
    '',
    'Tap to change. Models need their API key: Gemini GEMINI_API_KEY, Claude ANTHROPIC_API_KEY.',
  ]
    .filter((l, i) => l !== '' || i > 0)
    .join('\n');
  const mark = (on: boolean, label: string) => (on ? `✅ ${label}` : label);
  return {
    text,
    buttons: [
      ...MODELS.map((m) => [{ label: mark(m.id === current.id, `${m.label}${agent.hasProvider(m.provider) ? '' : ' (no key)'}`), command: `/model ${m.id}` }]),
      EFFORTS.map((e) => ({ label: mark(e === agent.effort, `🧠 ${e}`), command: `/effort ${e}` })),
      LANGUAGES.map(([label, lang]) => ({ label: mark(lang === translateTo, `🎙️→${label}`), command: `/translate ${lang}` })),
      VOICE_MODES.map(([label, mode]) => ({ label: mark(mode === voiceMode, label), command: `/voice ${mode}` })),
      [{ label: '💵 Daily spending limits', command: '/limit' }],
    ],
  };
}

function personaName(key?: string): string {
  if (!key) return 'default secretary';
  return key === 'custom' ? 'your own description' : (findPersona(key)?.label ?? key);
}

export function personaView(ctx: CommandContext, notice = ''): CommandReply {
  const s = ctx.store.settings();
  return {
    text: [
      notice,
      `🎭 ${ctx.agent.botName}'s personality: ${personaName(s.personaKey)}`,
      s.persona ? `“${s.persona}”` : '',
      `Voice for spoken replies: ${s.ttsVoice ?? ctx.cfg.ttsVoice}`,
      '',
      'Tap one below, or describe your own, e.g.',
      '/persona a witty pirate captain who loves spreadsheets and calls me captain',
      'Rename me with /name <name>. /persona off goes back to the default.',
    ]
      .filter((l, i) => l !== '' || i > 0)
      .join('\n'),
    buttons: [
      ...PERSONAS.map((p) => [{ label: `${p.key === s.personaKey ? '✅ ' : ''}${p.label}`, command: `/persona ${p.key}` }]),
      [{ label: `${s.personaKey ? '' : '✅ '}↩️ Default`, command: '/persona off' }],
    ],
  };
}

export const ROLEPLAYS: { key: string; label: string; scenario: string }[] = [
  {
    key: 'ramen',
    label: '🍜 Ramen shop in Tokyo',
    scenario:
      'Japanese practice: you are the friendly owner of a small ramen shop in Tokyo and the user is a customer. Speak simple, natural Japanese (add romaji and a short English hint in brackets), and after each user reply gently correct any mistakes in one line.',
  },
  {
    key: 'directions',
    label: '🚉 Lost in Kyoto',
    scenario:
      'Japanese practice: the user is a tourist lost near Kyoto Station and asks you, a helpful local, for directions to Kiyomizu-dera. Simple polite Japanese with romaji, and gentle one-line corrections after each user reply.',
  },
  {
    key: 'interview',
    label: '💼 Job interview in Japanese',
    scenario:
      'Japanese practice: you interview the user for an office job at a Tokyo company. Polite keigo, one question at a time, romaji for hard words, and brief feedback on their Japanese after each answer.',
  },
  {
    key: 'cafe',
    label: '☕ Café chat',
    scenario: 'You are an old friend meeting the user at a cosy café in Bangkok to catch up on life. Relaxed, warm, curious, in the language the user writes in.',
  },
  {
    key: 'adventure',
    label: '🐉 Fantasy adventure',
    scenario:
      'An interactive fantasy adventure: you are the narrator and every other character; the user is the hero. Describe scenes vividly but briefly, and end each turn with a choice or a question.',
  },
  {
    key: 'mystery',
    label: '🕵️ Detective mystery',
    scenario:
      'An interactive detective mystery set in old Bangkok: you are the narrator and the suspects, the user is the detective. Hide clues fairly so the case can be solved, and end each turn with what the detective notices.',
  },
];

const parseCommand = (text: string) => {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  return { cmd: head.toLowerCase().replace(/@.*$/, ''), arg: rest.join(' ').trim() };
};

/** Handles a slash command. Returns null when `text` is not a known command. */
export async function runCommand(text: string, ctx: CommandContext): Promise<CommandReply | null> {
  if (!text.trim().startsWith('/')) return null;
  const { cmd, arg } = parseCommand(text);
  const { agent, store, cfg, briefings, chatKey } = ctx;
  const now = (ctx.now ?? (() => new Date()))();
  const google = agent.google;
  const needGoogle = (): CommandReply => ({ text: 'Google is not connected yet. See "Connect Google" in SETUP-GUIDE.md (run `npm run google-auth`).' });

  try {
    switch (cmd) {
      case '/start':
      case '/help':
        return { text: HELP };
      case '/reset':
        agent.resetConversation(chatKey);
        return { text: 'Conversation cleared. I still keep your saved memories, to-dos and reminders.' };
      case '/id':
        return { text: `Your user id: ${ctx.userId}\nThis chat: ${chatKey}` };

      // --- settings ---
      case '/settings':
        return settingsView(ctx);
      case '/model': {
        if (!arg) return settingsView(ctx);
        if (!/^(gemini|claude)-[\w.-]+$/.test(arg)) return { text: `"${arg}" is not a Gemini or Claude model id.` };
        const info = modelInfo(arg);
        store.updateSettings({ model: arg });
        const warning = agent.hasProvider(info.provider)
          ? ''
          : ` ⚠️ No ${info.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} is set, so this model will not work until you add it.`;
        return settingsView(ctx, `✅ Model set to ${info.label}.${warning}\n`);
      }
      case '/effort': {
        if (!(EFFORTS as readonly string[]).includes(arg)) return { text: `Use /effort ${EFFORTS.join(', /effort ')}.` };
        store.updateSettings({ effort: arg as Effort });
        return settingsView(ctx, `✅ Thinking effort set to ${arg}.\n`);
      }
      case '/translate': {
        if (!arg) return { text: 'Which language should voice notes be translated into? e.g. /translate Thai' };
        store.updateSettings({ translateTo: arg.slice(0, 40) });
        return settingsView(ctx, `✅ Voice notes will be translated into ${arg}.\n`);
      }

      case '/limit':
      case '/limits':
      case '/cap': {
        const [first = '', second, third] = arg.toLowerCase().split(/\s+/).filter(Boolean);
        const limits = { ...(store.settings().limits ?? {}) };
        if (!first) return limitsView(ctx);
        if (first === 'reset') {
          store.updateSettings({ limits: undefined });
          return limitsView(ctx, '✅ Back to the limits in the .env file.\n');
        }
        const scope = LIMIT_SCOPES[first];
        if (!scope) return limitsView(ctx, `"${first}" isn't gemini, claude or all.\n`);
        const name = SCOPE_NAMES[scope];
        const set = (patch: { warnUsd?: number | null; capUsd?: number | null }, msg: string) => {
          store.updateSettings({ limits: { ...limits, [scope]: { ...(limits[scope] ?? {}), ...patch } } });
          const l = agent.limits()[scope];
          const note = l.warnUsd !== null && l.capUsd !== null && l.warnUsd >= l.capUsd ? ` (the warning ${usd(l.warnUsd)} is not below the cap, so it won't show)` : '';
          return limitsView(ctx, `✅ ${msg}${note}\n`);
        };
        if (!second) return limitsView(ctx);
        if (second === 'reset') {
          delete limits[scope];
          store.updateSettings({ limits: Object.keys(limits).length ? limits : undefined });
          return limitsView(ctx, `✅ ${name} is back to the .env values.\n`);
        }
        if (second === 'off' && !third) return set({ warnUsd: null, capUsd: null }, `${name}: no warning and no cap.`);
        const kind = second === 'warn' || second === 'warning' ? 'warnUsd' : second === 'cap' || second === 'limit' ? 'capUsd' : null;
        const amount = parseUsd(kind ? third : second);
        if (amount === undefined) return limitsView(ctx, 'Give an amount in USD from 0.01 to 1000, or "off", e.g. /limit gemini 3\n');
        if (kind === 'warnUsd') return set({ warnUsd: amount }, `${name} warning: ${usd(amount)} a day.`);
        return set({ capUsd: amount }, `${name} cap: ${usd(amount)} a day.`);
      }
      case '/export': {
        const exp = buildExport(store, agent.health.db, chatKey, cfg.timezone, now);
        // Also keep a copy on the NAS (data/backups), for chats that can't receive files directly.
        if (cfg.dataDir) {
          mkdirSync(join(cfg.dataDir, 'backups'), { recursive: true });
          writeFileSync(join(cfg.dataDir, 'backups', exp.name), exp.data);
        }
        return { text: exp.summary, file: { name: exp.name, data: exp.data } };
      }
      case '/budget':
      case '/money': {
        const tz = cfg.timezone;
        const [sub = '', ...rest] = arg.split(/\s+/).filter(Boolean);
        const word = sub.toLowerCase();
        const hasGmail = !!google?.has('gmail');
        const view = (text: string): CommandReply => ({
          text,
          buttons: [
            [
              { label: '📅 Last month', command: '/budget last' },
              { label: '🧾 Recent', command: '/budget list' },
            ],
            ...(hasGmail ? [[{ label: '📧 Check my email', command: '/budget scan' }]] : []),
          ],
        });
        const usage = [
          '💰 Budget and spending',
          'Send me payment slips (several at once is fine) or tell me what you spent, e.g. "haircut 350".',
          '/budget: this month · /budget last: last month · /budget list: recent transactions',
          '/budget set 20000: monthly budget · /budget set food 6000: a category (0 removes it)',
          '/budget start 25: the budget month starts on payday',
          '/budget edit 12 food · /budget remove 12',
          hasGmail ? '/budget scan: read receipts, card alerts, bills and salary from your email (/budget scan 90 for 90 days)' : '',
          `Categories: ${CATEGORY_KEYS.join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n');
        if (!word) return view(report(store, chatKey, now, tz));
        if (word === 'last') return view(report(store, chatKey, now, tz, { back: 1 }));
        if (word === 'list') {
          const recent = [...store.money(chatKey)].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 25);
          return { text: recent.length ? `🧾 Recent transactions:\n${recent.map(txnLine).join('\n')}` : 'Nothing logged yet.' };
        }
        if (word === 'set') {
          const amount = Number((rest[rest.length - 1] ?? '').replace(/[,฿]/g, ''));
          if (!rest.length || !Number.isFinite(amount) || amount < 0) return { text: usage };
          const what = rest.slice(0, -1).join(' ');
          if (!what || /^(total|all|month|ทั้งหมด)$/i.test(what)) {
            store.updateBudget(chatKey, { monthly: amount ? Math.round(amount) : undefined });
          } else {
            const key = findCategory(what);
            if (!key) return { text: `I don't know the category "${what}".\nCategories: ${CATEGORY_KEYS.join(', ')}` };
            const categories = { ...(store.budget(chatKey).categories ?? {}) };
            if (amount) categories[key] = Math.round(amount);
            else delete categories[key];
            store.updateBudget(chatKey, { categories });
          }
          return view(`✅ Budget saved.\n\n${report(store, chatKey, now, tz)}`);
        }
        if (word === 'start') {
          const day = Number(rest[0]);
          if (!(day >= 1 && day <= 28)) return { text: 'Give a day from 1 to 28, e.g. /budget start 25' };
          store.updateBudget(chatKey, { startDay: day === 1 ? undefined : day });
          return view(`✅ Your budget month now starts on day ${day}.\n\n${report(store, chatKey, now, tz)}`);
        }
        if (word === 'remove' || word === 'delete') {
          const t = store.removeMoney(chatKey, Number(rest[0]?.replace('#', '')));
          return { text: t ? `🗑️ Removed ${txnLine(t)}` : `No transaction #${rest[0] ?? ''}. See /budget list.` };
        }
        if (word === 'edit') {
          const key = findCategory(rest.slice(1).join(' '));
          if (!key) return { text: `Usage: /budget edit 12 food\nCategories: ${CATEGORY_KEYS.join(', ')}` };
          const t = store.updateMoney(chatKey, Number(rest[0]?.replace('#', '')), { category: key });
          return { text: t ? `✅ ${txnLine(t)}` : `No transaction #${rest[0] ?? ''}. See /budget list.` };
        }
        if (word === 'scan') {
          if (!google?.has('gmail')) return needGoogle();
          const days = Math.min(365, Math.max(1, Number(rest[0]) || 30));
          const r = await scanEmail({ google, store, extract: (i, d) => agent.extract(i, d, 'money') }, chatKey, { days, now, timeZone: tz });
          return view([scanSummary(r), ...budgetAlerts(store, chatKey, now, tz)].join('\n\n'));
        }
        return { text: usage };
      }
      case '/prefs':
      case '/pref': {
        const prefs = store.settings().preferences ?? [];
        const [sub, ...rest] = arg.split(/\s+/);
        const value = rest.join(' ').trim();
        if (sub === 'add' && value) {
          store.updateSettings({ preferences: [...prefs, value.slice(0, 200)].slice(-20) });
          return { text: `📌 Saved: ${value}` };
        }
        if ((sub === 'remove' || sub === 'delete') && /^\d+$/.test(value)) {
          const i = Number(value) - 1;
          if (!prefs[i]) return { text: `No preference #${value}. See /prefs.` };
          store.updateSettings({ preferences: prefs.filter((_, j) => j !== i) });
          return { text: `🗑️ Removed: ${prefs[i]}` };
        }
        if (sub === 'clear') {
          store.updateSettings({ preferences: [] });
          return { text: '🗑️ All preferences cleared.' };
        }
        return {
          text: [
            prefs.length ? `📌 Your standing preferences:\n${prefs.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '📌 No standing preferences yet.',
            '',
            'Add one: /prefs add Always reply in Thai',
            'Remove one: /prefs remove 2   ·   Remove all: /prefs clear',
            'You can also just tell me, e.g. "from now on use emoji in your replies".',
          ].join('\n'),
        };
      }
      case '/persona': {
        if (!arg) return personaView(ctx);
        if (['off', 'default', 'reset', 'none'].includes(arg.toLowerCase())) {
          store.updateSettings({ personaKey: undefined, persona: undefined, ttsVoice: undefined, speakingStyle: undefined });
          return personaView(ctx, '↩️ Back to my default personality.\n');
        }
        const preset = findPersona(arg);
        if (preset) {
          store.updateSettings({ personaKey: preset.key, persona: preset.description, ttsVoice: preset.voice, speakingStyle: preset.speakingStyle });
          return personaView(ctx, `✅ I'm now: ${preset.label}\n`);
        }
        if (arg.length < 10) return { text: `"${arg}" isn't one of my personalities. Tap one in /persona, or describe your own in a sentence.` };
        store.updateSettings({ personaKey: 'custom', persona: arg.slice(0, 1000), speakingStyle: undefined });
        return personaView(ctx, '✅ Got it, that is who I am now. Say hi!\n');
      }
      case '/name': {
        if (!arg) return { text: `I'm ${agent.botName}. Rename me with /name <name>, e.g. /name Mali` };
        store.updateSettings({ botName: arg.slice(0, 40) });
        return {
          text: `✅ From now on I'm ${arg.slice(0, 40)}.\n(The name at the top of the Telegram chat is set separately: send /setname to @BotFather.)`,
        };
      }
      case '/ttsvoice': {
        if (!/^[A-Za-z][\w-]{1,30}$/.test(arg)) {
          return { text: 'Which voice? e.g. /ttsvoice Puck. Some Gemini voices: Kore, Puck, Charon, Fenrir, Leda, Aoede, Zephyr, Orus. Try one with /say hello.' };
        }
        store.updateSettings({ ttsVoice: arg });
        return { text: `✅ Spoken replies will use the ${arg} voice.`, speak: `Hello! This is how I sound now.` };
      }
      // --- Japanese ---
      case '/kanji':
      case '/word': {
        if (!ctx.japanese) return { text: 'Japanese of the day is not available.' };
        return { text: await (cmd === '/kanji' ? ctx.japanese.kanji(chatKey) : ctx.japanese.word(chatKey)) };
      }
      case '/review': {
        const r = ctx.reviews;
        if (!r?.enabled) return { text: 'WaniKani is not connected. Add WANIKANI_TOKEN to the bot (see SETUP-GUIDE.md).' };
        if (['stop', 'pause', 'end', 'quit'].includes(arg.toLowerCase())) return { text: r.stop(chatKey) };
        return { text: await r.start(chatKey, Number(arg) || 10) };
      }
      case '/jlpt': {
        const lvl = arg.toUpperCase();
        if (!(JLPT_LEVELS as readonly string[]).includes(lvl)) {
          return { text: `Kanji and words of the day are at JLPT ${store.settings().jlptLevel ?? 'N4'} (when WaniKani isn't connected; with WaniKani they follow your level). Change it with /jlpt N5 … /jlpt N1.` };
        }
        store.updateSettings({ jlptLevel: lvl as (typeof JLPT_LEVELS)[number] });
        return { text: `✅ Kanji and words of the day will be JLPT ${lvl} level.` };
      }

      // --- roleplay ---
      case '/roleplay': {
        const rp = store.settings().roleplay;
        if (['end', 'stop', 'off', 'exit'].includes(arg.toLowerCase())) {
          store.updateSettings({ roleplay: undefined });
          return { text: rp ? '🎬 Scene ended. I am back to my normal self.' : 'No roleplay is running.' };
        }
        if (!arg) {
          return {
            text: [
              rp ? `🎬 Current scene: ${rp.scenario}\nEnd it with /roleplay end.\n` : '',
              '🎬 Pick a scene, or describe your own, e.g.',
              '/roleplay you are a barista in Osaka and I order coffee in Japanese',
            ]
              .filter(Boolean)
              .join('\n'),
            buttons: ROLEPLAYS.map((r) => [{ label: r.label, command: `/roleplay ${r.key}` }]),
          };
        }
        const preset = ROLEPLAYS.find((r) => r.key === arg.toLowerCase());
        const scenario = preset?.scenario ?? arg.slice(0, 1500);
        store.updateSettings({ roleplay: { scenario, startedAt: now.toISOString() } });
        const opening = await agent.reply({ chatKey, text: '(The roleplay starts now. Open the scene in character.)', kind: 'roleplay' });
        return { text: `🎬 ${preset?.label ?? 'Scene'} — say /roleplay end to stop.\n\n${opening}` };
      }

      // --- food and body ---
      case '/food': {
        const today = localDay(now, cfg.timezone);
        const [sub, id] = arg.split(/\s+/);
        if (sub === 'remove' || sub === 'delete') {
          const f = store.removeFood(chatKey, Number(String(id).replace('#', '')));
          return { text: f ? `🗑️ Removed ${f.name} (${f.kcal} kcal).` : `No food entry ${id ?? ''}. See /food.` };
        }
        const day = sub === 'yesterday' ? localDay(new Date(now.getTime() - 864e5), cfg.timezone) : /^\d{4}-\d{2}-\d{2}$/.test(sub ?? '') ? sub : today;
        const nums = bodyNumbers(store.body(chatKey), Number(day.slice(0, 4)));
        return { text: formatFoodDay(store.food(chatKey, day), 'missing' in nums ? null : nums.target, day === today ? 'Today' : day) };
      }
      case '/bmi':
      case '/profile': {
        const year = Number(localDay(now, cfg.timezone).slice(0, 4));
        const tip = cmd === '/profile' ? '\n\nTo change it, just tell me, e.g. "I\'m 31, female, 158 cm, 52 kg, I work out twice a week and want to keep my weight".' : '';
        return { text: formatBody(store.body(chatKey), year) + tip };
      }
      case '/weight': {
        const kg = Number(arg.replace(/kg/i, '').trim());
        if (!(kg > 20 && kg < 400)) {
          const w = store.weights(chatKey).slice(-10);
          return { text: w.length ? `⚖️ Recent weights:\n${w.map((x) => `• ${x.day}: ${x.kg} kg`).join('\n')}\n\nLog today with /weight 65.5` : 'Log your weight with /weight 65.5' };
        }
        const day = localDay(now, cfg.timezone);
        const before = store.weights(chatKey).filter((x) => x.day !== day).at(-1);
        store.logWeight(chatKey, day, Math.round(kg * 10) / 10);
        const change = before ? ` (${kg - before.kg >= 0 ? '+' : ''}${(kg - before.kg).toFixed(1)} kg since ${before.day})` : '';
        return { text: `⚖️ Logged ${kg} kg${change}.\n\n${formatBody(store.body(chatKey), Number(day.slice(0, 4)))}` };
      }

      case '/health': {
        const h = agent.health;
        if (!h.sync && !h.db.size) return needGoogle();
        if (h.sync && !(await h.sync.available()) && !h.db.size) {
          return { text: 'I can\'t find any "Health Sync …" folders in your Google Drive. In the Health Sync app, check that syncing to Google Drive is on.' };
        }
        const days = Math.min(14, Math.max(1, Number(arg) || 2));
        const summaries = await h.lastDays(days, now, cfg.timezone);
        return {
          text: `⌚ Watch data\n${summaries.map((s) => `• ${formatWatchDay(s)}`).join('\n')}\n\nToday fills in as Health Sync uploads. History: ${h.db.size} days stored. Ask me about trends, e.g. "how has my sleep changed this year?"`,
        };
      }
      case '/healthimport': {
        if (!google?.has('drive')) return needGoogle();
        if (arg === 'status' || healthImport.running) return { text: healthImport.status() };
        const db = agent.health.db;
        const run = async (progress: (m: string) => void) => {
          const report = await importFromDrive(google, db, cfg.timezone, { progress });
          if (report.latestHeightCm && !store.body(chatKey).heightCm) store.updateBody(chatKey, { heightCm: report.latestHeightCm });
          return formatReport(report, db.size);
        };
        if (!ctx.notify) return { text: await run(() => undefined) };
        healthImport.start(run, ctx.notify);
        return {
          text: "📦 Started importing your Samsung Health export. It takes a few minutes; I'll post progress here, and you can keep chatting meanwhile. Check on it any time with /healthimport status.",
        };
      }

      // --- weather ---
      case '/forecast':
        return { text: `🌦️ 7-day forecast\n${await weatherText(store, cfg.weather.defaultCity, arg, 7)}` };

      case '/voice': {
        const mode = arg === 'notes' ? 'voice-notes' : arg;
        if (!['off', 'voice-notes', 'always'].includes(mode)) return { text: 'Use /voice off, /voice notes (reply to voice notes with voice) or /voice always.' };
        store.updateSettings({ voiceReplies: mode as 'off' | 'voice-notes' | 'always' });
        return settingsView(ctx, `✅ Spoken replies: ${mode}.\n`);
      }
      case '/say':
        if (!arg) return { text: 'What should I say? e.g. /say おはようございます' };
        return { text: '', speak: arg };

      // --- usage ---
      case '/stats':
        return { text: usageStats(store.usage(), cfg.timezone, now) };
      case '/cleanup': {
        const backup = archiveUsage(store, cfg.dataDir, cfg.billing.retentionDays, now);
        if (!backup) return { text: `🧹 Nothing to clean up: no usage logs older than ${cfg.billing.retentionDays} days.` };
        return { text: `🧹 Archived ${backup.rows} usage log rows older than ${cfg.billing.retentionDays} days to backups/${backup.name}.`, file: backup };
      }
      case '/status':
        return { text: await ctx.status() };

      // --- to-dos ---
      case '/todo': {
        const ts = store.todos(chatKey);
        return { text: ts.length ? `📋 To-do list:\n${ts.map((t) => `#${t.id} ${t.title}`).join('\n')}\n\nMark one done with /done <id>.` : '📋 Your to-do list is empty. Add one with /add <task>.' };
      }
      case '/add':
        if (!arg) return { text: 'What should I add? e.g. /add Call the dentist' };
        return { text: `➕ Added #${store.addTodo(chatKey, arg.slice(0, 300)).id}: ${arg}` };
      case '/done': {
        const t = store.completeTodo(chatKey, Number(arg.replace('#', '')));
        return { text: t ? `✅ Done: ${t.title}` : `No to-do #${arg}. See /todo.` };
      }
      case '/clear':
        return { text: `🗑️ Cleared ${store.clearTodos(chatKey)} to-do item(s).` };

      // --- news ---
      case '/news':
        return { text: await briefings.newsDigest(arg || null) };
      case '/topics': {
        const ts = briefings.topics();
        return { text: ts.length ? `📋 Your news watchlist:\n${ts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nChange it with /addtopic and /removetopic.` : 'Your news watchlist is empty. Add one with /addtopic <topic>.' };
      }
      case '/addtopic': {
        if (!arg) return { text: 'Which topic? e.g. /addtopic Renewable Energy' };
        const ts = briefings.topics();
        if (ts.some((t) => t.toLowerCase() === arg.toLowerCase())) return { text: `"${arg}" is already on your watchlist.` };
        store.updateSettings({ newsTopics: [...ts, arg.slice(0, 80)] });
        return { text: `➕ Added "${arg}" to your news watchlist.` };
      }
      case '/removetopic':
      case '/remotopic':
      case '/deltopic': {
        const ts = briefings.topics();
        const byNumber = /^\d+$/.test(arg) ? ts[Number(arg) - 1] : undefined;
        const target = byNumber ?? ts.find((t) => t.toLowerCase() === arg.toLowerCase());
        if (!target) return { text: `"${arg}" is not on your watchlist. See /topics.` };
        store.updateSettings({ newsTopics: ts.filter((t) => t !== target) });
        return { text: `➖ Removed "${target}" from your news watchlist.` };
      }

      // --- briefings and weather ---
      case '/brief':
        return { text: await briefings.morning(chatKey) };
      case '/weather':
        return { text: await briefings.weatherReport(arg) };
      case '/weekend':
        return { text: await briefings.weekendPlanner(arg) };
      case '/setcity': {
        if (!arg) return { text: 'Which city? e.g. /setcity Chiang Mai' };
        const city = await geocode(arg);
        if (!city) return { text: `I couldn't find "${arg}". Try adding the country, e.g. /setcity Paris, France` };
        store.updateSettings({ city });
        return { text: `📍 Weather city set to ${city.name}${city.country ? `, ${city.country}` : ''} (${city.lat.toFixed(2)}, ${city.lon.toFixed(2)}).` };
      }

      // --- Google ---
      case '/calendar': {
        if (!google) return needGoogle();
        const days = Math.min(31, Math.max(1, Number(arg) || 1));
        return { text: `📅 Next ${days} day(s):\n${formatEvents(await google.events(now, new Date(now.getTime() + days * 864e5)), cfg.timezone)}` };
      }
      case '/inbox':
        if (!google) return needGoogle();
        return { text: `📥 Unread (Primary):\n${formatEmails(await google.unreadEmails(10))}` };
      case '/mail': {
        if (!google) return needGoogle();
        if (!arg) return { text: 'What should I search for? e.g. /mail from:ken contract newer_than:14d' };
        return { text: `🔎 Gmail results for "${arg}":\n${formatEmails(await google.searchEmails(arg, 10))}\n\nAsk me about any of them to read it in full.` };
      }
      case '/gtask':
        if (!google) return needGoogle();
        if (arg) {
          await google.addTask(arg);
          return { text: `☑️ Added to Google Tasks: ${arg}` };
        }
        return { text: `☑️ Google Tasks:\n${formatTasks(await google.tasks(), true)}\n\nTick one off with /gdone <number>.` };
      case '/gdone': {
        if (!google) return needGoogle();
        const tasks = await google.tasks();
        const t = /^\d+$/.test(arg) ? tasks[Number(arg) - 1] : tasks.find((x) => arg && x.title.toLowerCase().includes(arg.toLowerCase()));
        if (!t) return { text: `No open Google Task "${arg}". See /gtask.` };
        await google.completeTask(t.id);
        return { text: `✅ Done in Google Tasks: ${t.title}` };
      }
      case '/places': {
        if (!agent.maps) return { text: 'Google Maps is not connected. Add GOOGLE_MAPS_API_KEY (see SETUP-GUIDE.md, Part 3).' };
        if (!arg) return { text: 'What are you looking for? e.g. /places ramen near Asok' };
        return { text: `📍 ${formatPlaces(await agent.maps.searchPlaces(arg, store.settings().city))}` };
      }
      case '/drive': {
        if (!google) return needGoogle();
        const files = await google.driveSearch(arg);
        return { text: files.length ? `📁 ${arg ? `Drive results for "${arg}"` : 'Recent Drive files'}:\n${files.map((f) => `• ${f.name}\n  ${f.link}`).join('\n')}` : 'No matching files.' };
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) return { text: e.message };
    throw e;
  }
}
