import { BudgetExceeded, type Agent } from './agent';
import { archiveUsage, usageStats, type Briefings } from './briefings';
import { EFFORTS, type Config, type Effort } from './config';
import { formatEmails, formatEvents, formatTasks } from './google';
import { formatPlaces } from './maps';
import { MODELS, modelInfo } from './models';
import { findPersona, PERSONAS } from './personas';
import type { Store } from './store';
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
  now?: () => Date;
}

/** Commands that call an AI or an outside API: channels show "typing…" while they run. */
export const SLOW_COMMANDS = new Set(['/news', '/brief', '/weather', '/weekend', '/status', '/calendar', '/inbox', '/mail', '/drive', '/gtask', '/gdone', '/setcity', '/places', '/say']);

export const HELP = [
  'Hi! I am your personal secretary and news curator. Just talk to me, send a photo, or send a voice note.',
  '',
  '🗓️ Secretary: /todo, /add <task>, /done <id>, /clear',
  '📰 News: /news [topic], /topics, /addtopic <topic>, /removetopic <topic>',
  '🌅 Briefings: /brief (morning briefing now), /weather [city], /weekend, /setcity <city>',
  '📧 Google: /calendar [days], /inbox, /mail <search>, /gtask [title], /gdone <number>, /drive [search]',
  '📍 Places: share your location, /places <what>, /setcity <city>',
  '🔊 Voice: send a voice note; /voice off|notes|always, /say <text>',
  '🎭 Personality: /persona (pick one or describe your own), /name <new name>, /ttsvoice <voice>',
  '⚙️ Settings: /settings (AI model, thinking effort, voice translation), /stats, /status, /cleanup',
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
