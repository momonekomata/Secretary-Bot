import { mkdirSync, writeFileSync } from 'node:fs';
import { findVoice, TTS_VOICES, voiceName } from './audio';
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
import { t } from './i18n';

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
  /** Voice samples to send one after another (one voice message each), then `footer` with its buttons. */
  samples?: { line: string; style: string; items: { voice: string; caption: string }[]; footer: { text: string; buttons: Button[][] } };
}

/** How the bot speaks after picking a voice in /voices. */
export const CUTE_STYLE = "in a cute, bright and cheerful young woman's voice, sweet and playful";
/** "Voice: Leda (Thai: Leda, Japanese: Autonoe)" for the voice menus. */
export function voicesSummary(store: Store): string {
  const s = store.settings();
  const all = s.ttsVoice ?? 'Kore';
  const th = s.ttsVoiceByLang?.th;
  const ja = s.ttsVoiceByLang?.ja;
  if (!th && !ja) return t(`Voice: ${all} for all languages.`, `เสียง: ${all} สำหรับทุกภาษา`);
  return t(`Thai voice: ${th ?? all} · Japanese voice: ${ja ?? all} · other languages: ${all}.`, `เสียงภาษาไทย: ${th ?? all} · เสียงภาษาญี่ปุ่น: ${ja ?? all} · ภาษาอื่น: ${all}`);
}

/** Ready-made speaking styles for /voicestyle: [key, English label, Thai label, the style itself]. */
export const VOICE_STYLES: [string, string, string, string][] = [
  ['cute', '🍬 Cute', '🍬 น่ารัก', CUTE_STYLE],
  [
    'anime',
    '🌸 Anime heroine',
    '🌸 นางเอกอนิเมะ',
    'affectionate, loving and cheerful, yet a little shy; a high-pitched, sweet and melodic voice like an anime heroine',
  ],
  ['gentle', '🌙 Soft & gentle', '🌙 นุ่มนวล', 'softly and gently, warm and soothing, at a relaxed pace'],
  ['energetic', '⚡ Energetic', '⚡ กระฉับกระเฉง', 'bright, bubbly and full of energy, with a quick, lively pace'],
  ['calm', '☕ Calm & clear', '☕ สงบชัดเจน', 'calm, clear and friendly, like a helpful assistant'],
];

/** The sample line: Japanese and Thai, the user's main languages. */
export const SAMPLE_LINE = 'こんにちは！今日も一緒にがんばろうね。 สวัสดีค่ะ วันนี้ก็สู้ๆ ไปด้วยกันนะคะ';
/** Female-sounding Gemini voices: the cute-leaning ones first, more with /voices more. [voice, English, Thai] */
const CUTE_VOICES: [string, string, string][] = [
  ['Leda', 'youthful', 'อ่อนวัย'],
  ['Laomedeia', 'upbeat', 'ร่าเริง'],
  ['Autonoe', 'bright', 'สดใส'],
  ['Zephyr', 'bright', 'สว่างใส'],
  ['Achernar', 'soft', 'นุ่มนวล'],
  ['Aoede', 'breezy', 'สบายๆ'],
  ['Despina', 'smooth', 'ลื่นไหล'],
  ['Vindemiatrix', 'gentle', 'อ่อนโยน'],
];
const MORE_VOICES: [string, string, string][] = [
  ['Kore', 'firm', 'หนักแน่น'],
  ['Callirrhoe', 'easy-going', 'เป็นกันเอง'],
  ['Erinome', 'clear', 'ชัดเจน'],
  ['Sulafat', 'warm', 'อบอุ่น'],
  ['Pulcherrima', 'forward', 'มั่นใจ'],
  ['Gacrux', 'mature', 'เป็นผู้ใหญ่'],
];

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
export const SLOW_COMMANDS = new Set(['/review', '/health', '/healthimport', '/kanji', '/word', '/forecast', '/roleplay', '/news', '/brief', '/weather', '/weekend', '/status', '/calendar', '/inbox', '/mail', '/drive', '/gtask', '/gdone', '/setcity', '/places', '/say', '/budget', '/money', '/voices', '/voicestyle', '/style']);

/** The /help text, in the current language. */
export function helpText(): string {
  return [
    t('Hi! I am your personal secretary and news curator. Just talk to me, send a photo, or send a voice note.', 'สวัสดี! ฉันเป็นเลขาส่วนตัวและผู้คัดสรรข่าวของคุณ คุยกับฉันได้เลย ส่งรูป หรือส่งข้อความเสียงก็ได้'),
    '',
    t('🗓️ Secretary: /todo, /add <task>, /done <id>, /clear', '🗓️ เลขา: /todo, /add <งาน>, /done <id>, /clear'),
    t('📰 News: /news [topic], /topics, /addtopic <topic>, /removetopic <topic>', '📰 ข่าว: /news [หัวข้อ], /topics, /addtopic <หัวข้อ>, /removetopic <หัวข้อ>'),
    t('🌅 Briefings: /brief (morning briefing now), /weather [city], /weekend, /setcity <city>', '🌅 สรุปประจำวัน: /brief (สรุปข่าวเช้าตอนนี้), /weather [เมือง], /weekend, /setcity <เมือง>'),
    t('📧 Google: /calendar [days], /inbox, /mail <search>, /gtask [title], /gdone <number>, /drive [search]', '📧 Google: /calendar [จำนวนวัน], /inbox, /mail <คำค้น>, /gtask [ชื่องาน], /gdone <หมายเลข>, /drive [คำค้น]'),
    t('📍 Places: share your location, /places <what>, /setcity <city>', '📍 สถานที่: แชร์ตำแหน่งของคุณ, /places <สิ่งที่หา>, /setcity <เมือง>'),
    t('🔊 Voice: send a voice note; /voice off|notes|always, /say <text>', '🔊 เสียง: ส่งข้อความเสียงมาได้เลย; /voice off|notes|always, /say <ข้อความ>'),
    t(
      '🇯🇵 Japanese: /review (your WaniKani reviews, right here), /kanji, /word (of the day, daily at 12:00; they count as reviews when due), /jlpt N4',
      '🇯🇵 ภาษาญี่ปุ่น: /review (ทำรีวิว WaniKani ที่นี่เลย), /kanji, /word (คันจิและคำศัพท์ประจำวัน ส่งทุกวันตอน 12:00 และนับเป็นรีวิวเมื่อถึงกำหนด), /jlpt N4',
    ),
    t(
      '🍽️ Health: tell me or send a photo of what you ate; /food, /bmi, /profile, /weight 65.5, /health (watch data), /healthimport (Samsung Health export from Drive)',
      '🍽️ สุขภาพ: บอกหรือส่งรูปอาหารที่กินมาได้เลย; /food, /bmi, /profile, /weight 65.5, /health (ข้อมูลนาฬิกา), /healthimport (นำเข้าข้อมูล Samsung Health จาก Drive)',
    ),
    t('🎬 Roleplay: /roleplay (scenes, stories, Japanese conversation practice), /roleplay end', '🎬 บทบาทสมมติ: /roleplay (ฉาก เรื่องราว ฝึกสนทนาภาษาญี่ปุ่น), /roleplay end'),
    t('🌦️ Weather: /weather, /forecast (7 days), /weekend', '🌦️ อากาศ: /weather, /forecast (7 วัน), /weekend'),
    t('🎭 Personality: /persona (pick one or describe your own), /name <new name>, /ttsvoice <voice>', '🎭 บุคลิก: /persona (เลือกหรือบรรยายเอง), /name <ชื่อใหม่>, /ttsvoice <เสียง>'),
    t(
      '💰 Money: send payment slips or tell me what you spent; /budget shows the month, /budget set 20000 sets a budget, /budget scan reads your email',
      '💰 การเงิน: ส่งสลิปหรือบอกว่าใช้เงินไปกับอะไร; /budget ดูยอดเดือนนี้, /budget set 20000 ตั้งงบประมาณ, /budget scan อ่านจากอีเมล',
    ),
    t('📌 Preferences: /prefs (e.g. /prefs add Always reply in Thai), kept across personalities and updates', '📌 สิ่งที่ให้ทำเสมอ: /prefs (เช่น /prefs add Always reply in Thai) ยังอยู่แม้เปลี่ยนบุคลิกหรืออัปเดต'),
    t('💾 Your data: /export (food, weight, health history, memories and settings as a .zip)', '💾 ข้อมูลของคุณ: /export (อาหาร น้ำหนัก ประวัติสุขภาพ ความจำ และการตั้งค่า เป็นไฟล์ .zip)'),
    t(
      '⚙️ Settings: /settings (AI model, thinking effort, voice translation), /limit (daily spending caps in USD), /stats, /status, /cleanup',
      '⚙️ ตั้งค่า: /settings (โมเดล AI ความพยายามในการคิด การแปลเสียง), /limit (วงเงินค่า AI ต่อวัน หน่วย USD), /stats, /status, /cleanup',
    ),
    t('💬 Chat: /reset (forget this conversation, keep memories), /id', '💬 แชท: /reset (ลืมบทสนทนานี้ แต่ยังจำความจำที่บันทึกไว้), /id'),
    '',
    t(
      'Try: "Remind me at 9pm to do my reviews", "Do I have time for the dentist tomorrow afternoon?", or "Draft an email to sarah@example.com about the Q4 deck".',
      'ลองพิมพ์: "เตือนฉันตอนสามทุ่มให้ทำรีวิว", "พรุ่งนี้บ่ายว่างไปหาหมอฟันไหม?" หรือ "ร่างอีเมลถึง sarah@example.com เรื่องสไลด์ Q4"',
    ),
  ].join('\n');
}

const voiceModes = (): [string, 'off' | 'voice-notes' | 'always'][] => [
  [t('🔇 text only', '🔇 ข้อความอย่างเดียว'), 'off'],
  [t('🔊 to voice notes', '🔊 ตอบข้อความเสียง'), 'voice-notes'],
  [t('🔊 always', '🔊 ทุกครั้ง'), 'always'],
];

const LANGUAGES: [string, string][] = [
  ['English', 'English'],
  ['ไทย', 'Thai'],
  ['日本語', 'Japanese'],
];

const LIMIT_SCOPES: Record<string, LimitScope> = { gemini: 'gemini', g: 'gemini', claude: 'claude', c: 'claude', anthropic: 'claude', all: 'all', total: 'all', overall: 'all' };
const scopeName = (scope: LimitScope): string => (scope === 'gemini' ? 'Gemini' : scope === 'claude' ? 'Claude' : t('All AI together', 'AI ทั้งหมดรวมกัน'));
const usd = (n: number | null) => (n === null ? t('off', 'ปิด') : `$${n.toFixed(2)}`);

/** Parses "$3", "2.5", "off". Returns null for off, undefined when not a valid amount. */
function parseUsd(s: string | undefined): number | null | undefined {
  if (!s) return undefined;
  if (/^(off|none|no|0)$/i.test(s)) return null;
  const v = Number(s.replace(/[$,]/g, ''));
  return v > 0 && v <= 1000 ? Math.round(v * 100) / 100 : undefined;
}

/** Warns when the all-AI cap is lower than a provider's cap, since it then stops that provider first. */
function overallNote(l: Record<LimitScope, { capUsd: number | null }>): string {
  const all = l.all.capUsd;
  if (all === null) return '';
  const higher = (['gemini', 'claude'] as const).filter((p) => l[p].capUsd === null || l[p].capUsd! > all);
  if (!higher.length) return '';
  return t(
    `⚠️ The cap for all AI together (${usd(all)}) is lower than ${higher.map((p) => `${scopeName(p)}'s (${usd(l[p].capUsd)})`).join(' and ')}, so it applies first. Raise it with /limit all 5 or remove it with /limit all off.`,
    `⚠️ วงเงินของ AI ทั้งหมดรวมกัน (${usd(all)}) ต่ำกว่าของ ${higher.map((p) => `${scopeName(p)} (${usd(l[p].capUsd)})`).join(' และ ')} จึงมีผลก่อน เพิ่มได้ด้วย /limit all 5 หรือยกเลิกด้วย /limit all off`,
  );
}

/** The daily spending limits, with buttons for common caps. */
export function limitsView(ctx: CommandContext, notice = ''): CommandReply {
  const { agent, store } = ctx;
  const l = agent.limits();
  const mark = (scope: LimitScope, key: 'warnUsd' | 'capUsd') => (l[scope].from[key] === 'chat' ? '✏️' : '');
  const line = (scope: LimitScope) =>
    t(
      `${scopeName(scope)}: spent $${agent.spentToday(scope === 'all' ? undefined : scope).toFixed(4)} today · warn ${usd(l[scope].warnUsd)}${mark(scope, 'warnUsd')} · cap ${usd(l[scope].capUsd)}${mark(scope, 'capUsd')}`,
      `${scopeName(scope)}: วันนี้ใช้ไป $${agent.spentToday(scope === 'all' ? undefined : scope).toFixed(4)} · เตือนที่ ${usd(l[scope].warnUsd)}${mark(scope, 'warnUsd')} · จำกัดที่ ${usd(l[scope].capUsd)}${mark(scope, 'capUsd')}`,
    );
  const text = [
    notice,
    t('💵 Daily AI spending limits (USD, reset at midnight)', '💵 วงเงินค่า AI ต่อวัน (USD รีเซ็ตตอนเที่ยงคืน)'),
    line('gemini'),
    line('claude'),
    line('all'),
    store.settings().limits
      ? t('✏️ = set here in chat; the rest come from the .env file.', '✏️ = ตั้งไว้ในแชทนี้ ที่เหลือมาจากไฟล์ .env')
      : t('All values come from the .env file.', 'ทุกค่ามาจากไฟล์ .env'),
    ...(overallNote(l) ? [overallNote(l)] : []),
    '',
    t('At the cap, that AI pauses until midnight. At the warning, I add a one-time note to a reply.', 'เมื่อถึงวงเงิน AI ตัวนั้นจะหยุดจนถึงเที่ยงคืน เมื่อถึงจุดเตือน ฉันจะแจ้งในคำตอบหนึ่งครั้ง'),
    t(
      'Change: /limit gemini 3 (cap) · /limit claude warn 1 · /limit all 5 · /limit gemini off · /limit reset (back to .env)',
      'เปลี่ยนได้ด้วย: /limit gemini 3 (วงเงิน) · /limit claude warn 1 · /limit all 5 · /limit gemini off · /limit reset (กลับไปใช้ .env)',
    ),
  ]
    .filter((x, i) => x !== '' || i > 1)
    .join('\n');
  // Short labels: Telegram cuts long ones in a row of four. The chosen one shows just "✅ $5".
  const short: Record<LimitScope, string> = { gemini: 'Gemini', claude: 'Claude', all: t('All AI', 'AI ทั้งหมด') };
  const noCap = t('No cap', 'ไม่จำกัด');
  const capRow = (scope: LimitScope, amounts: number[]) => [
    ...amounts.map((a) => ({ label: l[scope].capUsd === a ? `✅ $${a}` : `${short[scope]} $${a}`, command: `/limit ${scope} ${a}` })),
    { label: l[scope].capUsd === null ? `✅ ${noCap}` : noCap, command: `/limit ${scope} cap off` },
  ];
  return {
    text,
    buttons: [capRow('gemini', [1, 2, 5]), capRow('claude', [1, 3, 5]), capRow('all', [1, 3, 5]), [{ label: t('↩️ Use .env values', '↩️ ใช้ค่าจาก .env'), command: '/limit reset' }]],
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
    t('⚙️ Settings', '⚙️ ตั้งค่า'),
    t(`Name: ${agent.botName}`, `ชื่อ: ${agent.botName}`),
    t(`Personality: ${personaName(s.personaKey)}`, `บุคลิก: ${personaName(s.personaKey)}`),
    t(`AI model: ${current.label} (${current.id})`, `โมเดล AI: ${current.label} (${current.id})`),
    t(`Thinking effort: ${agent.effort}`, `ความพยายามในการคิด: ${agent.effort}`),
    t(`Voice notes: transcribe and translate to ${translateTo}`, `ข้อความเสียง: ถอดความและแปลเป็น ${translateTo}`),
    t(
      `Spoken replies: ${voiceMode === 'off' ? 'off' : voiceMode === 'always' ? 'always' : 'when you send a voice note'}`,
      `ตอบเป็นเสียง: ${voiceMode === 'off' ? 'ปิด' : voiceMode === 'always' ? 'ทุกครั้ง' : 'เมื่อคุณส่งข้อความเสียง'}`,
    ),
    t(`Weather city: ${s.city?.name ?? cfg.weather.defaultCity}`, `เมืองสำหรับพยากรณ์อากาศ: ${s.city?.name ?? cfg.weather.defaultCity}`),
    t(`News topics: ${(s.newsTopics ?? cfg.news.defaultTopics).join(', ') || 'none'}`, `หัวข้อข่าว: ${(s.newsTopics ?? cfg.news.defaultTopics).join(', ') || 'ไม่มี'}`),
    t(
      `Daily caps: Gemini ${usd(agent.limits().gemini.capUsd)}, Claude ${usd(agent.limits().claude.capUsd)}, all ${usd(agent.limits().all.capUsd)} (/limit)`,
      `วงเงินต่อวัน: Gemini ${usd(agent.limits().gemini.capUsd)}, Claude ${usd(agent.limits().claude.capUsd)}, รวมทั้งหมด ${usd(agent.limits().all.capUsd)} (/limit)`,
    ),
    '',
    t('Tap to change. Models need their API key: Gemini GEMINI_API_KEY, Claude ANTHROPIC_API_KEY.', 'แตะเพื่อเปลี่ยน โมเดลต้องมี API key: Gemini ใช้ GEMINI_API_KEY, Claude ใช้ ANTHROPIC_API_KEY'),
  ]
    .filter((l, i) => l !== '' || i > 0)
    .join('\n');
  const mark = (on: boolean, label: string) => (on ? `✅ ${label}` : label);
  return {
    text,
    buttons: [
      ...MODELS.map((m) => [{ label: mark(m.id === current.id, `${m.label}${agent.hasProvider(m.provider) ? '' : t(' (no key)', ' (ไม่มี key)')}`), command: `/model ${m.id}` }]),
      EFFORTS.map((e) => ({ label: mark(e === agent.effort, `🧠 ${e}`), command: `/effort ${e}` })),
      LANGUAGES.map(([label, lang]) => ({ label: mark(lang === translateTo, `🎙️→${label}`), command: `/translate ${lang}` })),
      voiceModes().map(([label, mode]) => ({ label: mark(mode === voiceMode, label), command: `/voice ${mode}` })),
      [{ label: t('💵 Daily spending limits', '💵 วงเงินค่า AI ต่อวัน'), command: '/limit' }],
    ],
  };
}

function personaName(key?: string): string {
  if (!key) return t('default secretary', 'เลขา (ค่าเริ่มต้น)');
  return key === 'custom' ? t('your own description', 'แบบที่คุณบรรยายเอง') : (findPersona(key)?.label ?? key);
}

export function personaView(ctx: CommandContext, notice = ''): CommandReply {
  const s = ctx.store.settings();
  return {
    text: [
      notice,
      t(`🎭 ${ctx.agent.botName}'s personality: ${personaName(s.personaKey)}`, `🎭 บุคลิกของ${ctx.agent.botName}: ${personaName(s.personaKey)}`),
      s.persona ? `“${s.persona}”` : '',
      t(`Voice for spoken replies: ${s.ttsVoice ?? ctx.cfg.ttsVoice}`, `เสียงที่ใช้ตอบ: ${s.ttsVoice ?? ctx.cfg.ttsVoice}`),
      '',
      t('Tap one below, or describe your own, e.g.', 'แตะเลือกด้านล่าง หรือบรรยายบุคลิกเอง เช่น'),
      t('/persona a witty pirate captain who loves spreadsheets and calls me captain', '/persona กัปตันโจรสลัดอารมณ์ขันที่รักสเปรดชีตและเรียกฉันว่ากัปตัน'),
      t('Rename me with /name <name>. /persona off goes back to the default.', 'เปลี่ยนชื่อฉันได้ด้วย /name <ชื่อ> และ /persona off เพื่อกลับไปเป็นแบบเริ่มต้น'),
    ]
      .filter((l, i) => l !== '' || i > 0)
      .join('\n'),
    buttons: [
      ...PERSONAS.map((p) => [{ label: `${p.key === s.personaKey ? '✅ ' : ''}${p.label}`, command: `/persona ${p.key}` }]),
      [{ label: `${s.personaKey ? '' : '✅ '}${t('↩️ Default', '↩️ ค่าเริ่มต้น')}`, command: '/persona off' }],
    ],
  };
}

export const ROLEPLAYS: { key: string; label: string; scenario: string }[] = [
  {
    key: 'ramen',
    get label() {
      return t('🍜 Ramen shop in Tokyo', '🍜 ร้านราเมงในโตเกียว');
    },
    scenario:
      'Japanese practice: you are the friendly owner of a small ramen shop in Tokyo and the user is a customer. Speak simple, natural Japanese (add romaji and a short English hint in brackets), and after each user reply gently correct any mistakes in one line.',
  },
  {
    key: 'directions',
    get label() {
      return t('🚉 Lost in Kyoto', '🚉 หลงทางในเกียวโต');
    },
    scenario:
      'Japanese practice: the user is a tourist lost near Kyoto Station and asks you, a helpful local, for directions to Kiyomizu-dera. Simple polite Japanese with romaji, and gentle one-line corrections after each user reply.',
  },
  {
    key: 'interview',
    get label() {
      return t('💼 Job interview in Japanese', '💼 สัมภาษณ์งานเป็นภาษาญี่ปุ่น');
    },
    scenario:
      'Japanese practice: you interview the user for an office job at a Tokyo company. Polite keigo, one question at a time, romaji for hard words, and brief feedback on their Japanese after each answer.',
  },
  {
    key: 'cafe',
    get label() {
      return t('☕ Café chat', '☕ นั่งคุยในคาเฟ่');
    },
    scenario: 'You are an old friend meeting the user at a cosy café in Bangkok to catch up on life. Relaxed, warm, curious, in the language the user writes in.',
  },
  {
    key: 'adventure',
    get label() {
      return t('🐉 Fantasy adventure', '🐉 ผจญภัยแฟนตาซี');
    },
    scenario:
      'An interactive fantasy adventure: you are the narrator and every other character; the user is the hero. Describe scenes vividly but briefly, and end each turn with a choice or a question.',
  },
  {
    key: 'mystery',
    get label() {
      return t('🕵️ Detective mystery', '🕵️ ไขคดีนักสืบ');
    },
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
  const needGoogle = (): CommandReply => ({
    text: t(
      'Google is not connected yet. See "Connect Google" in SETUP-GUIDE.md (run `npm run google-auth`).',
      'ยังไม่ได้เชื่อมต่อ Google ดูหัวข้อ "Connect Google" ใน SETUP-GUIDE.md (รัน `npm run google-auth`)',
    ),
  });

  try {
    switch (cmd) {
      case '/start':
      case '/help':
        return { text: helpText() };
      case '/reset':
        agent.resetConversation(chatKey);
        return { text: t('Conversation cleared. I still keep your saved memories, to-dos and reminders.', 'ล้างบทสนทนาแล้ว ความจำที่บันทึกไว้ สิ่งที่ต้องทำ และการแจ้งเตือนยังอยู่ครบ') };
      case '/id':
        return { text: t(`Your user id: ${ctx.userId}\nThis chat: ${chatKey}`, `ไอดีผู้ใช้ของคุณ: ${ctx.userId}\nแชทนี้: ${chatKey}`) };

      // --- settings ---
      case '/settings':
        return settingsView(ctx);
      case '/model': {
        if (!arg) return settingsView(ctx);
        if (!/^(gemini|claude)-[\w.-]+$/.test(arg)) return { text: t(`"${arg}" is not a Gemini or Claude model id.`, `"${arg}" ไม่ใช่ไอดีโมเดลของ Gemini หรือ Claude`) };
        const info = modelInfo(arg);
        store.updateSettings({ model: arg });
        const keyName = info.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
        const warning = agent.hasProvider(info.provider)
          ? ''
          : t(` ⚠️ No ${keyName} is set, so this model will not work until you add it.`, ` ⚠️ ยังไม่ได้ตั้ง ${keyName} โมเดลนี้จะยังใช้ไม่ได้จนกว่าจะเพิ่ม`);
        return settingsView(ctx, t(`✅ Model set to ${info.label}.${warning}\n`, `✅ เปลี่ยนโมเดลเป็น ${info.label} แล้ว${warning}\n`));
      }
      case '/effort': {
        if (!(EFFORTS as readonly string[]).includes(arg)) return { text: t(`Use /effort ${EFFORTS.join(', /effort ')}.`, `ใช้ /effort ${EFFORTS.join(', /effort ')}`) };
        store.updateSettings({ effort: arg as Effort });
        return settingsView(ctx, t(`✅ Thinking effort set to ${arg}.\n`, `✅ ตั้งความพยายามในการคิดเป็น ${arg} แล้ว\n`));
      }
      case '/translate': {
        if (!arg) return { text: t('Which language should voice notes be translated into? e.g. /translate Thai', 'ให้แปลข้อความเสียงเป็นภาษาอะไร? เช่น /translate Thai') };
        store.updateSettings({ translateTo: arg.slice(0, 40) });
        return settingsView(ctx, t(`✅ Voice notes will be translated into ${arg}.\n`, `✅ ข้อความเสียงจะแปลเป็น ${arg}\n`));
      }

      case '/limit':
      case '/limits':
      case '/cap': {
        const [first = '', second, third] = arg.toLowerCase().split(/\s+/).filter(Boolean);
        const limits = { ...(store.settings().limits ?? {}) };
        if (!first) return limitsView(ctx);
        if (first === 'reset') {
          store.updateSettings({ limits: undefined });
          return limitsView(ctx, t('✅ Back to the limits in the .env file.\n', '✅ กลับไปใช้วงเงินจากไฟล์ .env แล้ว\n'));
        }
        const scope = LIMIT_SCOPES[first];
        if (!scope) return limitsView(ctx, t(`"${first}" isn't gemini, claude or all.\n`, `"${first}" ไม่ใช่ gemini, claude หรือ all\n`));
        const name = scopeName(scope);
        const set = (patch: { warnUsd?: number | null; capUsd?: number | null }, msg: string) => {
          store.updateSettings({ limits: { ...limits, [scope]: { ...(limits[scope] ?? {}), ...patch } } });
          const l = agent.limits()[scope];
          const note =
            l.warnUsd !== null && l.capUsd !== null && l.warnUsd >= l.capUsd
              ? t(` (the warning ${usd(l.warnUsd)} is not below the cap, so it won't show)`, ` (จุดเตือน ${usd(l.warnUsd)} ไม่ได้ต่ำกว่าวงเงิน จึงจะไม่แสดง)`)
              : '';
          const all = agent.limits().all.capUsd;
          const blocked =
            scope !== 'all' && all !== null && agent.spentToday() >= all
              ? t(
                  `\n⚠️ The cap for all AI together (${usd(all)}) is already reached today, so AI stays paused until you raise it: /limit all 5 or /limit all off.`,
                  `\n⚠️ วันนี้ใช้ถึงวงเงินของ AI ทั้งหมดรวมกัน (${usd(all)}) แล้ว AI จะหยุดจนกว่าจะเพิ่มวงเงิน: /limit all 5 หรือ /limit all off`,
                )
              : '';
          return limitsView(ctx, `✅ ${msg}${note}${blocked}\n`);
        };
        if (!second) return limitsView(ctx);
        if (second === 'reset') {
          delete limits[scope];
          store.updateSettings({ limits: Object.keys(limits).length ? limits : undefined });
          return limitsView(ctx, t(`✅ ${name} is back to the .env values.\n`, `✅ ${name} กลับไปใช้ค่าจาก .env แล้ว\n`));
        }
        if (second === 'off' && !third) return set({ warnUsd: null, capUsd: null }, t(`${name}: no warning and no cap.`, `${name}: ไม่มีการเตือนและไม่จำกัดวงเงิน`));
        const kind = second === 'warn' || second === 'warning' ? 'warnUsd' : second === 'cap' || second === 'limit' ? 'capUsd' : null;
        const amount = parseUsd(kind ? third : second);
        if (amount === undefined) return limitsView(ctx, t('Give an amount in USD from 0.01 to 1000, or "off", e.g. /limit gemini 3\n', 'ใส่จำนวนเงิน USD ตั้งแต่ 0.01 ถึง 1000 หรือ "off" เช่น /limit gemini 3\n'));
        if (kind === 'warnUsd') return set({ warnUsd: amount }, t(`${name} warning: ${usd(amount)} a day.`, `${name} เตือนที่ ${usd(amount)} ต่อวัน`));
        return set({ capUsd: amount }, t(`${name} cap: ${usd(amount)} a day.`, `${name} จำกัดที่ ${usd(amount)} ต่อวัน`));
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
              { label: t('📅 Last month', '📅 เดือนที่แล้ว'), command: '/budget last' },
              { label: t('🧾 Recent', '🧾 ล่าสุด'), command: '/budget list' },
            ],
            ...(hasGmail ? [[{ label: t('📧 Check my email', '📧 ตรวจอีเมลของฉัน'), command: '/budget scan' }]] : []),
          ],
        });
        const usage = [
          t('💰 Budget and spending', '💰 งบประมาณและรายจ่าย'),
          t(
            'Send me payment slips (several at once is fine) or tell me what you spent, e.g. "haircut 350".',
            'ส่งสลิปมาได้เลย (ส่งหลายใบพร้อมกันก็ได้) หรือบอกว่าใช้เงินไปกับอะไร เช่น "ตัดผม 350"',
          ),
          t('/budget: this month · /budget last: last month · /budget list: recent transactions', '/budget: เดือนนี้ · /budget last: เดือนที่แล้ว · /budget list: รายการล่าสุด'),
          t(
            '/budget set 20000: monthly budget · /budget set food 6000: a category (0 removes it)',
            '/budget set 20000: งบประมาณต่อเดือน · /budget set food 6000: งบของหมวดหมู่ (ใส่ 0 เพื่อลบ)',
          ),
          t('/budget start 25: the budget month starts on payday', '/budget start 25: ให้เดือนงบประมาณเริ่มวันเงินเดือนออก'),
          t('/budget edit 12 food · /budget remove 12', '/budget edit 12 food (เปลี่ยนหมวดหมู่) · /budget remove 12 (ลบรายการ)'),
          hasGmail
            ? t(
                '/budget scan: read receipts, card alerts, bills and salary from your email (/budget scan 90 for 90 days)',
                '/budget scan: อ่านใบเสร็จ แจ้งเตือนบัตร บิล และเงินเดือนจากอีเมล (/budget scan 90 สำหรับ 90 วัน)',
              )
            : '',
          t(`Categories: ${CATEGORY_KEYS.join(', ')}`, `หมวดหมู่: ${CATEGORY_KEYS.join(', ')}`),
        ]
          .filter(Boolean)
          .join('\n');
        if (!word) return view(report(store, chatKey, now, tz));
        if (word === 'last') return view(report(store, chatKey, now, tz, { back: 1 }));
        if (word === 'list') {
          const recent = [...store.money(chatKey)].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 25);
          return { text: recent.length ? t(`🧾 Recent transactions:\n${recent.map(txnLine).join('\n')}`, `🧾 รายการล่าสุด:\n${recent.map(txnLine).join('\n')}`) : t('Nothing logged yet.', 'ยังไม่มีรายการที่บันทึกไว้') };
        }
        if (word === 'set') {
          const amount = Number((rest[rest.length - 1] ?? '').replace(/[,฿]/g, ''));
          if (!rest.length || !Number.isFinite(amount) || amount < 0) return { text: usage };
          const what = rest.slice(0, -1).join(' ');
          if (!what || /^(total|all|month|ทั้งหมด)$/i.test(what)) {
            store.updateBudget(chatKey, { monthly: amount ? Math.round(amount) : undefined });
          } else {
            const key = findCategory(what);
            if (!key) return { text: t(`I don't know the category "${what}".\nCategories: ${CATEGORY_KEYS.join(', ')}`, `ไม่รู้จักหมวดหมู่ "${what}"\nหมวดหมู่: ${CATEGORY_KEYS.join(', ')}`) };
            const categories = { ...(store.budget(chatKey).categories ?? {}) };
            if (amount) categories[key] = Math.round(amount);
            else delete categories[key];
            store.updateBudget(chatKey, { categories });
          }
          return view(`${t('✅ Budget saved.', '✅ บันทึกงบประมาณแล้ว')}\n\n${report(store, chatKey, now, tz)}`);
        }
        if (word === 'start') {
          const day = Number(rest[0]);
          if (!(day >= 1 && day <= 28)) return { text: t('Give a day from 1 to 28, e.g. /budget start 25', 'ใส่วันที่ 1 ถึง 28 เช่น /budget start 25') };
          store.updateBudget(chatKey, { startDay: day === 1 ? undefined : day });
          return view(`${t(`✅ Your budget month now starts on day ${day}.`, `✅ เดือนงบประมาณของคุณจะเริ่มวันที่ ${day} แล้ว`)}\n\n${report(store, chatKey, now, tz)}`);
        }
        if (word === 'remove' || word === 'delete') {
          const txn = store.removeMoney(chatKey, Number(rest[0]?.replace('#', '')));
          return { text: txn ? t(`🗑️ Removed ${txnLine(txn)}`, `🗑️ ลบแล้ว ${txnLine(txn)}`) : t(`No transaction #${rest[0] ?? ''}. See /budget list.`, `ไม่มีรายการ #${rest[0] ?? ''} ดูได้ที่ /budget list`) };
        }
        if (word === 'edit') {
          const key = findCategory(rest.slice(1).join(' '));
          if (!key) return { text: t(`Usage: /budget edit 12 food\nCategories: ${CATEGORY_KEYS.join(', ')}`, `วิธีใช้: /budget edit 12 food\nหมวดหมู่: ${CATEGORY_KEYS.join(', ')}`) };
          const txn = store.updateMoney(chatKey, Number(rest[0]?.replace('#', '')), { category: key });
          return { text: txn ? `✅ ${txnLine(txn)}` : t(`No transaction #${rest[0] ?? ''}. See /budget list.`, `ไม่มีรายการ #${rest[0] ?? ''} ดูได้ที่ /budget list`) };
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
          return { text: t(`📌 Saved: ${value}`, `📌 บันทึกแล้ว: ${value}`) };
        }
        if ((sub === 'remove' || sub === 'delete') && /^\d+$/.test(value)) {
          const i = Number(value) - 1;
          if (!prefs[i]) return { text: t(`No preference #${value}. See /prefs.`, `ไม่มีรายการที่ #${value} ดูได้ที่ /prefs`) };
          store.updateSettings({ preferences: prefs.filter((_, j) => j !== i) });
          return { text: t(`🗑️ Removed: ${prefs[i]}`, `🗑️ ลบแล้ว: ${prefs[i]}`) };
        }
        if (sub === 'clear') {
          store.updateSettings({ preferences: [] });
          return { text: t('🗑️ All preferences cleared.', '🗑️ ล้างสิ่งที่ตั้งไว้ทั้งหมดแล้ว') };
        }
        return {
          text: [
            prefs.length
              ? `${t('📌 Your standing preferences:', '📌 สิ่งที่คุณตั้งค่าไว้ให้ฉันทำเสมอ:')}\n${prefs.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
              : t('📌 No standing preferences yet.', '📌 ยังไม่มีสิ่งที่ตั้งค่าไว้ให้ทำเสมอ'),
            '',
            t('Add one: /prefs add Always reply in Thai', 'เพิ่ม: /prefs add Always reply in Thai'),
            t('Remove one: /prefs remove 2   ·   Remove all: /prefs clear', 'ลบหนึ่งรายการ: /prefs remove 2   ·   ลบทั้งหมด: /prefs clear'),
            t('You can also just tell me, e.g. "from now on use emoji in your replies".', 'หรือบอกฉันตรงๆ ก็ได้ เช่น "ต่อจากนี้ใส่อีโมจิในคำตอบด้วย"'),
          ].join('\n'),
        };
      }
      case '/persona': {
        if (!arg) return personaView(ctx);
        if (['off', 'default', 'reset', 'none'].includes(arg.toLowerCase())) {
          store.updateSettings({ personaKey: undefined, persona: undefined, ttsVoice: undefined, speakingStyle: undefined });
          return personaView(ctx, t('↩️ Back to my default personality.\n', '↩️ กลับมาเป็นบุคลิกเริ่มต้นแล้ว\n'));
        }
        const preset = findPersona(arg);
        if (preset) {
          store.updateSettings({ personaKey: preset.key, persona: preset.description, ttsVoice: preset.voice, speakingStyle: preset.speakingStyle });
          return personaView(ctx, t(`✅ I'm now: ${preset.label}\n`, `✅ ตอนนี้ฉันเป็น: ${preset.label}\n`));
        }
        if (arg.length < 10) return { text: t(`"${arg}" isn't one of my personalities. Tap one in /persona, or describe your own in a sentence.`, `"${arg}" ไม่ใช่บุคลิกที่ฉันมี แตะเลือกใน /persona หรือบรรยายบุคลิกที่ต้องการเป็นประโยค`) };
        store.updateSettings({ personaKey: 'custom', persona: arg.slice(0, 1000), speakingStyle: undefined });
        return personaView(ctx, t('✅ Got it, that is who I am now. Say hi!\n', '✅ ได้เลย ตอนนี้ฉันเป็นแบบนั้นแล้ว ลองทักทายดูสิ!\n'));
      }
      case '/name': {
        if (!arg) return { text: t(`I'm ${agent.botName}. Rename me with /name <name>, e.g. /name Mali`, `ฉันชื่อ${agent.botName} เปลี่ยนชื่อได้ด้วย /name <ชื่อ> เช่น /name Mali`) };
        store.updateSettings({ botName: arg.slice(0, 40) });
        return {
          text: t(
            `✅ From now on I'm ${arg.slice(0, 40)}.\n(The name at the top of the Telegram chat is set separately: send /setname to @BotFather.)`,
            `✅ ต่อจากนี้ฉันชื่อ${arg.slice(0, 40)}\n(ชื่อด้านบนของแชท Telegram ต้องตั้งแยกต่างหาก: ส่ง /setname ไปที่ @BotFather)`,
          ),
        };
      }
      case '/voicestyle':
      case '/style': {
        const current = store.settings().speakingStyle;
        // Buttons with a ✅ on the style in use (built after any change below).
        const styleButtons = (): Button[][] => {
          const chosen = store.settings().speakingStyle;
          const rows: Button[][] = [];
          const presets = VOICE_STYLES.map(([key, en, th, style]) => ({ label: `${style === chosen ? '✅ ' : ''}${t(en, th)}`, command: `/voicestyle ${key}` }));
          for (let i = 0; i < presets.length; i += 2) rows.push(presets.slice(i, i + 2));
          rows.push([{ label: `${!chosen ? '✅ ' : ''}${t('🚫 No style', '🚫 ไม่ใส่สไตล์')}`, command: '/voicestyle off' }]);
          return rows;
        };
        const value = arg.trim();
        if (!value) {
          return {
            text: t(
              `🎙️ Speaking style: ${current ?? 'none (the voice speaks naturally)'}\n\nTap a ready-made style, or describe your own in plain words, e.g.\n/voicestyle shy and sweet, with a soft, high-pitched voice\n\nThe style is how the voice speaks; /voices picks the voice itself.`,
              `🎙️ สไตล์การพูด: ${current ?? 'ไม่มี (เสียงพูดตามธรรมชาติ)'}\n\nแตะเลือกสไตล์สำเร็จรูป หรือบรรยายเองได้เลย เช่น\n/voicestyle shy and sweet, with a soft, high-pitched voice\n\nสไตล์คือวิธีพูด ส่วน /voices ใช้เลือกเสียง`,
            ),
            buttons: styleButtons(),
          };
        }
        if (/^(off|none|clear|reset|ปิด)$/i.test(value)) {
          store.updateSettings({ speakingStyle: undefined });
          return { text: t('✅ No speaking style: the voice speaks naturally.', '✅ ไม่ใส่สไตล์: เสียงจะพูดตามธรรมชาติ'), speak: SAMPLE_LINE };
        }
        const preset = VOICE_STYLES.find(([key]) => key === value.toLowerCase());
        const style = preset?.[3] ?? value.slice(0, 300);
        if (!preset && style.length < 3) return { text: t('Describe the style in a few words, e.g. /voicestyle soft and shy', 'บรรยายสไตล์สั้นๆ เช่น /voicestyle soft and shy'), buttons: styleButtons() };
        store.updateSettings({ speakingStyle: style });
        return {
          text: t(`✅ I'll speak ${style}. Here's how it sounds.`, `✅ ต่อจากนี้จะพูดแบบ: ${style} ลองฟังได้เลย`),
          speak: SAMPLE_LINE,
          buttons: styleButtons(),
        };
      }
      case '/voices': {
        const [sub = '', name = '', which = ''] = arg.split(/\s+/);
        // Samples play in the user's own style (or cute when none is set), so what you hear is what you get.
        const sampleStyle = store.settings().speakingStyle ?? CUTE_STYLE;
        if (sub.toLowerCase() === 'pick') {
          const voice = voiceName(name);
          if (!voice) return { text: t('Which voice? Tap one under the samples, or send /voices to hear them.', 'เสียงไหนดี? แตะเลือกใต้ตัวอย่าง หรือส่ง /voices เพื่อฟังตัวอย่าง') };
          const lang = which === 'th' || which === 'ja' ? which : null;
          const byLang = { ...(store.settings().ttsVoiceByLang ?? {}) };
          if (lang) byLang[lang] = voice;
          store.updateSettings({
            ...(lang ? { ttsVoiceByLang: byLang } : { ttsVoice: voice, ttsVoiceByLang: undefined }),
            ...(store.settings().speakingStyle ? {} : { speakingStyle: CUTE_STYLE }),
          });
          const forWhat = lang === 'th' ? t(' for Thai', 'สำหรับภาษาไทย') : lang === 'ja' ? t(' for Japanese', 'สำหรับภาษาญี่ปุ่น') : '';
          return {
            text: t(`✅ I'll use the ${voice} voice${forWhat}. ${voicesSummary(store)}`, `✅ จะใช้เสียง ${voice}${forWhat ? ` ${forWhat}` : ''} ${voicesSummary(store)}`),
            speak: SAMPLE_LINE,
          };
        }
        const more = sub.toLowerCase() === 'more';
        const list = more ? MORE_VOICES : CUTE_VOICES;
        const cur = store.settings();
        // One row per voice: use it for everything, or only for Thai / only for Japanese.
        const rows: Button[][] = list.map(([v, en, th]) => [
          { label: `${v === cur.ttsVoice && !cur.ttsVoiceByLang ? '✅ ' : ''}${v} · ${t(en, th)}`, command: `/voices pick ${v}` },
          { label: `${cur.ttsVoiceByLang?.th === v ? '✅ ' : ''}🇹🇭`, command: `/voices pick ${v} th` },
          { label: `${cur.ttsVoiceByLang?.ja === v ? '✅ ' : ''}🇯🇵`, command: `/voices pick ${v} ja` },
        ]);
        rows.push([more ? { label: t('⬅️ The first 8', '⬅️ 8 เสียงแรก'), command: '/voices' } : { label: t('🎧 6 more voices', '🎧 ฟังอีก 6 เสียง'), command: '/voices more' }]);
        return {
          text: t(
            `🎧 ${list.length} voice samples are on the way (about a minute), each saying a Japanese and a Thai line in your speaking style. At the end, tap a voice for everything, or 🇹🇭 / 🇯🇵 to use it for one language. (About $0.01 of Gemini.)`,
            `🎧 กำลังส่งตัวอย่าง ${list.length} เสียง (ประมาณหนึ่งนาที) แต่ละเสียงพูดประโยคภาษาญี่ปุ่นและภาษาไทยตามสไตล์การพูดของคุณ ท้ายสุดแตะชื่อเสียงเพื่อใช้กับทุกภาษา หรือแตะ 🇹🇭 / 🇯🇵 เพื่อใช้กับภาษาเดียว (ค่า Gemini ประมาณ $0.01)`,
          ),
          samples: {
            line: SAMPLE_LINE,
            style: sampleStyle,
            items: list.map(([v, en, th], i) => ({ voice: v, caption: `${i + 1}. ${v} · ${t(en, th)}` })),
            footer: {
              text: t(`Which one do you like? Tap a name for all languages, or 🇹🇭 / 🇯🇵 for one.\n${voicesSummary(store)}`, `ชอบเสียงไหน? แตะชื่อเพื่อใช้ทุกภาษา หรือ 🇹🇭 / 🇯🇵 เพื่อใช้ภาษาเดียว\n${voicesSummary(store)}`),
              buttons: rows,
            },
          },
        };
      }
      case '/ttsvoice': {
        // Popular voices with their style (from Gemini's voice list); any of the 30 can be typed.
        const styles: [string, string, string][] = [
          ['Kore', 'firm', 'หนักแน่น'],
          ['Puck', 'upbeat', 'สดใส'],
          ['Charon', 'informative', 'ชัดเจน'],
          ['Fenrir', 'excitable', 'ตื่นเต้น'],
          ['Leda', 'youthful', 'อ่อนวัย'],
          ['Aoede', 'breezy', 'สบายๆ'],
          ['Zephyr', 'bright', 'สว่างใส'],
          ['Orus', 'firm', 'มั่นคง'],
        ];
        const current = voiceName(store.settings().ttsVoice ?? '') ?? voiceName(cfg.ttsVoice) ?? 'Kore';
        const buttons = (chosen: string): Button[][] => {
          const all = styles.map(([v, en, th]) => ({ label: `${v === chosen ? '✅ ' : ''}${v} · ${t(en, th)}`, command: `/ttsvoice ${v}` }));
          return [
            all.slice(0, 2),
            all.slice(2, 4),
            all.slice(4, 6),
            all.slice(6, 8),
            [
              { label: t('🎧 Hear female voice samples', '🎧 ฟังตัวอย่างเสียงผู้หญิง'), command: '/voices' },
              { label: t('🎙️ Speaking style', '🎙️ สไตล์การพูด'), command: '/voicestyle' },
            ],
          ];
        };
        const others = TTS_VOICES.filter((v) => !styles.some(([s]) => s === v)).join(', ');
        if (!arg) {
          return {
            text: t(
              `🔊 ${voicesSummary(store)}\nTap one to hear it and use it for everything. One language only: /ttsvoice th Leda, /ttsvoice ja Autonoe. Other voices: ${others}.`,
              `🔊 ${voicesSummary(store)}\nแตะเพื่อฟังและใช้กับทุกภาษา ใช้กับภาษาเดียว: /ttsvoice th Leda, /ttsvoice ja Autonoe เสียงอื่นๆ: ${others}`,
            ),
            buttons: buttons(current),
          };
        }
        const [first = '', second = ''] = arg.split(/\s+/);
        const langArg = /^(th|thai|ไทย)$/i.test(first) ? 'th' : /^(ja|jp|japanese|ญี่ปุ่น)$/i.test(first) ? 'ja' : null;
        if (langArg) {
          const byLang = { ...(store.settings().ttsVoiceByLang ?? {}) };
          if (/^(off|reset|none)$/i.test(second)) delete byLang[langArg];
          else {
            const v = voiceName(second);
            if (!v) return { text: t(`Which voice? e.g. /ttsvoice ${langArg} Leda`, `เสียงไหนดี? เช่น /ttsvoice ${langArg} Leda`), buttons: buttons(current) };
            byLang[langArg] = v;
          }
          store.updateSettings({ ttsVoiceByLang: Object.keys(byLang).length ? byLang : undefined });
          return { text: `✅ ${voicesSummary(store)}`, speak: langArg === 'th' ? 'สวัสดีค่ะ วันนี้ก็สู้ๆ ไปด้วยกันนะคะ' : 'こんにちは！今日も一緒にがんばろうね。', buttons: buttons(current) };
        }
        const voice = voiceName(arg);
        if (!voice) {
          return {
            text: t(`"${arg}" isn't a voice name. Pick one below, or one of: ${others}.`, `"${arg}" ไม่ใช่ชื่อเสียง เลือกด้านล่าง หรือหนึ่งในนี้: ${others}`),
            buttons: buttons(current),
          };
        }
        const unlisted = findVoice(voice)
          ? ''
          : t(` ${voice} isn't in my list of Gemini voices; if you hear nothing, pick one below.`, ` ${voice} ไม่อยู่ในรายชื่อเสียงของ Gemini ที่ฉันรู้จัก ถ้าไม่มีเสียง ให้เลือกจากด้านล่าง`);
        store.updateSettings({ ttsVoice: voice, ttsVoiceByLang: undefined });
        return {
          text: t(`✅ Spoken replies will use the ${voice} voice. Here's a sample.`, `✅ จะใช้เสียง ${voice} ในการตอบเป็นเสียง นี่คือตัวอย่าง`) + unlisted,
          speak: t(`Hello! This is how I sound now.`, 'สวัสดี! ตอนนี้เสียงของฉันเป็นแบบนี้นะ'),
          buttons: buttons(voice),
        };
      }
      // --- Japanese ---
      case '/kanji':
      case '/word': {
        if (!ctx.japanese) return { text: t('Japanese of the day is not available.', 'ยังไม่มีคันจิและคำศัพท์ญี่ปุ่นประจำวัน') };
        return { text: await (cmd === '/kanji' ? ctx.japanese.kanji(chatKey) : ctx.japanese.word(chatKey)) };
      }
      case '/review': {
        const r = ctx.reviews;
        if (!r?.enabled) return { text: t('WaniKani is not connected. Add WANIKANI_TOKEN to the bot (see SETUP-GUIDE.md).', 'ยังไม่ได้เชื่อมต่อ WaniKani ต้องใส่ WANIKANI_TOKEN ให้บอทก่อน (ดู SETUP-GUIDE.md)') };
        if (['stop', 'pause', 'end', 'quit'].includes(arg.toLowerCase())) return { text: r.stop(chatKey) };
        return { text: await r.start(chatKey, Number(arg) || 10) };
      }
      case '/jlpt': {
        const lvl = arg.toUpperCase();
        if (!(JLPT_LEVELS as readonly string[]).includes(lvl)) {
          const level = store.settings().jlptLevel ?? 'N4';
          return {
            text: t(
              `Kanji and words of the day are at JLPT ${level} (when WaniKani isn't connected; with WaniKani they follow your level). Change it with /jlpt N5 … /jlpt N1.`,
              `คันจิและคำศัพท์ประจำวันอยู่ที่ระดับ JLPT ${level} (เมื่อไม่ได้เชื่อมต่อ WaniKani ถ้าเชื่อมต่อแล้วจะตามเลเวลของคุณ) เปลี่ยนได้ด้วย /jlpt N5 … /jlpt N1`,
            ),
          };
        }
        store.updateSettings({ jlptLevel: lvl as (typeof JLPT_LEVELS)[number] });
        return { text: t(`✅ Kanji and words of the day will be JLPT ${lvl} level.`, `✅ คันจิและคำศัพท์ประจำวันจะเป็นระดับ JLPT ${lvl}`) };
      }

      // --- roleplay ---
      case '/roleplay': {
        const rp = store.settings().roleplay;
        if (['end', 'stop', 'off', 'exit'].includes(arg.toLowerCase())) {
          store.updateSettings({ roleplay: undefined });
          return { text: rp ? t('🎬 Scene ended. I am back to my normal self.', '🎬 จบฉากแล้ว ฉันกลับมาเป็นตัวเองตามปกติ') : t('No roleplay is running.', 'ไม่มีบทบาทสมมติที่กำลังเล่นอยู่') };
        }
        if (!arg) {
          return {
            text: [
              rp ? t(`🎬 Current scene: ${rp.scenario}\nEnd it with /roleplay end.\n`, `🎬 ฉากตอนนี้: ${rp.scenario}\nจบได้ด้วย /roleplay end\n`) : '',
              t('🎬 Pick a scene, or describe your own, e.g.', '🎬 เลือกฉาก หรือบรรยายฉากเอง เช่น'),
              t('/roleplay you are a barista in Osaka and I order coffee in Japanese', '/roleplay คุณเป็นบาริสต้าในโอซาก้า และฉันสั่งกาแฟเป็นภาษาญี่ปุ่น'),
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
        return { text: t(`🎬 ${preset?.label ?? 'Scene'} — say /roleplay end to stop.\n\n${opening}`, `🎬 ${preset?.label ?? 'ฉาก'} — พิมพ์ /roleplay end เพื่อหยุด\n\n${opening}`) };
      }

      // --- food and body ---
      case '/food': {
        const today = localDay(now, cfg.timezone);
        const [sub, id] = arg.split(/\s+/);
        if (sub === 'remove' || sub === 'delete') {
          const f = store.removeFood(chatKey, Number(String(id).replace('#', '')));
          return { text: f ? t(`🗑️ Removed ${f.name} (${f.kcal} kcal).`, `🗑️ ลบ ${f.name} (${f.kcal} kcal) แล้ว`) : t(`No food entry ${id ?? ''}. See /food.`, `ไม่มีรายการอาหาร ${id ?? ''} ดูได้ที่ /food`) };
        }
        const day = sub === 'yesterday' ? localDay(new Date(now.getTime() - 864e5), cfg.timezone) : /^\d{4}-\d{2}-\d{2}$/.test(sub ?? '') ? sub : today;
        const nums = bodyNumbers(store.body(chatKey), Number(day.slice(0, 4)));
        return { text: formatFoodDay(store.food(chatKey, day), 'missing' in nums ? null : nums.target, day === today ? t('Today', 'วันนี้') : day) };
      }
      case '/bmi':
      case '/profile': {
        const year = Number(localDay(now, cfg.timezone).slice(0, 4));
        const tip =
          cmd === '/profile'
            ? t(
                '\n\nTo change it, just tell me, e.g. "I\'m 31, female, 158 cm, 52 kg, I work out twice a week and want to keep my weight".',
                '\n\nถ้าจะเปลี่ยน บอกฉันได้เลย เช่น "อายุ 31 ผู้หญิง สูง 158 cm หนัก 52 kg ออกกำลังกายสัปดาห์ละ 2 ครั้ง อยากรักษาน้ำหนักไว้"',
              )
            : '';
        return { text: formatBody(store.body(chatKey), year) + tip };
      }
      case '/weight': {
        const kg = Number(arg.replace(/kg/i, '').trim());
        if (!(kg > 20 && kg < 400)) {
          const w = store.weights(chatKey).slice(-10);
          const list = w.map((x) => `• ${x.day}: ${x.kg} kg`).join('\n');
          return {
            text: w.length
              ? t(`⚖️ Recent weights:\n${list}\n\nLog today with /weight 65.5`, `⚖️ น้ำหนักล่าสุด:\n${list}\n\nบันทึกวันนี้ด้วย /weight 65.5`)
              : t('Log your weight with /weight 65.5', 'บันทึกน้ำหนักด้วย /weight 65.5'),
          };
        }
        const day = localDay(now, cfg.timezone);
        const before = store.weights(chatKey).filter((x) => x.day !== day).at(-1);
        store.logWeight(chatKey, day, Math.round(kg * 10) / 10);
        const diff = before ? `${kg - before.kg >= 0 ? '+' : ''}${(kg - before.kg).toFixed(1)}` : '';
        const change = before ? t(` (${diff} kg since ${before.day})`, ` (${diff} kg จาก ${before.day})`) : '';
        return { text: `${t(`⚖️ Logged ${kg} kg${change}.`, `⚖️ บันทึก ${kg} kg${change} แล้ว`)}\n\n${formatBody(store.body(chatKey), Number(day.slice(0, 4)))}` };
      }

      case '/health': {
        const h = agent.health;
        if (!h.sync && !h.db.size) return needGoogle();
        if (h.sync && !(await h.sync.available()) && !h.db.size) {
          return {
            text: t(
              'I can\'t find any "Health Sync …" folders in your Google Drive. In the Health Sync app, check that syncing to Google Drive is on.',
              'ไม่พบโฟลเดอร์ "Health Sync …" ใน Google Drive ของคุณ ลองเช็กในแอป Health Sync ว่าเปิดซิงก์ไป Google Drive แล้ว',
            ),
          };
        }
        const days = Math.min(14, Math.max(1, Number(arg) || 2));
        const summaries = await h.lastDays(days, now, cfg.timezone);
        return {
          text: t(
            `⌚ Watch data\n${summaries.map((s) => `• ${formatWatchDay(s)}`).join('\n')}\n\nToday fills in as Health Sync uploads. History: ${h.db.size} days stored. Ask me about trends, e.g. "how has my sleep changed this year?"`,
            `⌚ ข้อมูลนาฬิกา\n${summaries.map((s) => `• ${formatWatchDay(s)}`).join('\n')}\n\nข้อมูลวันนี้จะเพิ่มขึ้นเมื่อ Health Sync อัปโหลด ประวัติที่เก็บไว้: ${h.db.size} วัน ถามแนวโน้มได้ เช่น "ปีนี้การนอนของฉันเปลี่ยนไปยังไง?"`,
          ),
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
          text: t(
            "📦 Started importing your Samsung Health export. It takes a few minutes; I'll post progress here, and you can keep chatting meanwhile. Check on it any time with /healthimport status.",
            '📦 เริ่มนำเข้าข้อมูล Samsung Health แล้ว ใช้เวลาสักครู่ ฉันจะแจ้งความคืบหน้าที่นี่ ระหว่างนี้คุยต่อได้เลย เช็กสถานะได้ตลอดด้วย /healthimport status',
          ),
        };
      }

      // --- weather ---
      case '/forecast':
        return { text: `${t('🌦️ 7-day forecast', '🌦️ พยากรณ์อากาศ 7 วัน')}\n${await weatherText(store, cfg.weather.defaultCity, arg, 7)}` };

      case '/voice': {
        const mode = arg === 'notes' ? 'voice-notes' : arg;
        if (!['off', 'voice-notes', 'always'].includes(mode)) return { text: t('Use /voice off, /voice notes (reply to voice notes with voice) or /voice always.', 'ใช้ /voice off, /voice notes (ตอบข้อความเสียงด้วยเสียง) หรือ /voice always') };
        store.updateSettings({ voiceReplies: mode as 'off' | 'voice-notes' | 'always' });
        return settingsView(ctx, t(`✅ Spoken replies: ${mode}.\n`, `✅ ตอบเป็นเสียง: ${mode}\n`));
      }
      case '/say': {
        if (arg) return { text: '', speak: arg };
        // No text: read my last reply aloud.
        const last = [...store.history(chatKey)].reverse().find((turn) => turn.role === 'assistant');
        if (last) return { text: '', speak: last.text };
        return {
          text: t(
            'What should I say? e.g. /say おはようございます\nTip: reply to any message with /say (or 🔊) and I read it aloud; /say on its own reads my last reply.',
            'ให้พูดว่าอะไรดี? เช่น /say おはようございます\nเคล็ดลับ: ตอบกลับข้อความไหนก็ได้ด้วย /say (หรือ 🔊) แล้วฉันจะอ่านออกเสียงให้ ส่วน /say เฉยๆ จะอ่านคำตอบล่าสุดของฉัน',
          ),
        };
      }

      // --- usage ---
      case '/stats':
        return { text: usageStats(store.usage(), cfg.timezone, now) };
      case '/cleanup': {
        const backup = archiveUsage(store, cfg.dataDir, cfg.billing.retentionDays, now);
        if (!backup) return { text: t(`🧹 Nothing to clean up: no usage logs older than ${cfg.billing.retentionDays} days.`, `🧹 ไม่มีอะไรต้องเก็บกวาด: ไม่มีบันทึกการใช้งานที่เก่ากว่า ${cfg.billing.retentionDays} วัน`) };
        return {
          text: t(
            `🧹 Archived ${backup.rows} usage log rows older than ${cfg.billing.retentionDays} days to backups/${backup.name}.`,
            `🧹 เก็บบันทึกการใช้งาน ${backup.rows} แถวที่เก่ากว่า ${cfg.billing.retentionDays} วันไว้ที่ backups/${backup.name} แล้ว`,
          ),
          file: backup,
        };
      }
      case '/status':
        return { text: await ctx.status() };

      // --- to-dos ---
      case '/todo': {
        const ts = store.todos(chatKey);
        const list = ts.map((x) => `#${x.id} ${x.title}`).join('\n');
        return {
          text: ts.length
            ? t(`📋 To-do list:\n${list}\n\nMark one done with /done <id>.`, `📋 สิ่งที่ต้องทำ:\n${list}\n\nทำเครื่องหมายว่าเสร็จด้วย /done <id>`)
            : t('📋 Your to-do list is empty. Add one with /add <task>.', '📋 ยังไม่มีสิ่งที่ต้องทำ เพิ่มได้ด้วย /add <งาน>'),
        };
      }
      case '/add':
        if (!arg) return { text: t('What should I add? e.g. /add Call the dentist', 'จะเพิ่มอะไรดี? เช่น /add โทรหาหมอฟัน') };
        {
          const id = store.addTodo(chatKey, arg.slice(0, 300)).id;
          return { text: t(`➕ Added #${id}: ${arg}`, `➕ เพิ่มแล้ว #${id}: ${arg}`) };
        }
      case '/done': {
        const todo = store.completeTodo(chatKey, Number(arg.replace('#', '')));
        return { text: todo ? t(`✅ Done: ${todo.title}`, `✅ เสร็จแล้ว: ${todo.title}`) : t(`No to-do #${arg}. See /todo.`, `ไม่มีรายการที่ #${arg} ดูได้ที่ /todo`) };
      }
      case '/clear':
        {
          const n = store.clearTodos(chatKey);
          return { text: t(`🗑️ Cleared ${n} to-do item(s).`, `🗑️ ล้างสิ่งที่ต้องทำแล้ว ${n} รายการ`) };
        }

      // --- news ---
      case '/news':
        return { text: await briefings.newsDigest(arg || null) };
      case '/topics': {
        const ts = briefings.topics();
        const list = ts.map((x, i) => `${i + 1}. ${x}`).join('\n');
        return {
          text: ts.length
            ? t(`📋 Your news watchlist:\n${list}\n\nChange it with /addtopic and /removetopic.`, `📋 หัวข้อข่าวที่คุณติดตาม:\n${list}\n\nเปลี่ยนได้ด้วย /addtopic และ /removetopic`)
            : t('Your news watchlist is empty. Add one with /addtopic <topic>.', 'ยังไม่มีหัวข้อข่าวที่ติดตาม เพิ่มได้ด้วย /addtopic <หัวข้อ>'),
        };
      }
      case '/addtopic': {
        if (!arg) return { text: t('Which topic? e.g. /addtopic Renewable Energy', 'หัวข้ออะไรดี? เช่น /addtopic พลังงานหมุนเวียน') };
        const ts = briefings.topics();
        if (ts.some((x) => x.toLowerCase() === arg.toLowerCase())) return { text: t(`"${arg}" is already on your watchlist.`, `"${arg}" อยู่ในหัวข้อที่ติดตามแล้ว`) };
        store.updateSettings({ newsTopics: [...ts, arg.slice(0, 80)] });
        return { text: t(`➕ Added "${arg}" to your news watchlist.`, `➕ เพิ่ม "${arg}" ในหัวข้อข่าวที่ติดตามแล้ว`) };
      }
      case '/removetopic':
      case '/remotopic':
      case '/deltopic': {
        const ts = briefings.topics();
        const byNumber = /^\d+$/.test(arg) ? ts[Number(arg) - 1] : undefined;
        const target = byNumber ?? ts.find((x) => x.toLowerCase() === arg.toLowerCase());
        if (!target) return { text: t(`"${arg}" is not on your watchlist. See /topics.`, `"${arg}" ไม่ได้อยู่ในหัวข้อที่ติดตาม ดูได้ที่ /topics`) };
        store.updateSettings({ newsTopics: ts.filter((x) => x !== target) });
        return { text: t(`➖ Removed "${target}" from your news watchlist.`, `➖ ลบ "${target}" ออกจากหัวข้อข่าวที่ติดตามแล้ว`) };
      }

      // --- briefings and weather ---
      case '/brief':
        return { text: await briefings.morning(chatKey) };
      case '/weather':
        return { text: await briefings.weatherReport(arg) };
      case '/weekend':
        return { text: await briefings.weekendPlanner(arg) };
      case '/setcity': {
        if (!arg) return { text: t('Which city? e.g. /setcity Chiang Mai', 'เมืองไหนดี? เช่น /setcity Chiang Mai') };
        const city = await geocode(arg);
        if (!city) return { text: t(`I couldn't find "${arg}". Try adding the country, e.g. /setcity Paris, France`, `ไม่พบ "${arg}" ลองใส่ชื่อประเทศด้วย เช่น /setcity Paris, France`) };
        store.updateSettings({ city });
        const where = `${city.name}${city.country ? `, ${city.country}` : ''} (${city.lat.toFixed(2)}, ${city.lon.toFixed(2)})`;
        return { text: t(`📍 Weather city set to ${where}.`, `📍 ตั้งเมืองสำหรับพยากรณ์อากาศเป็น ${where} แล้ว`) };
      }

      // --- Google ---
      case '/calendar': {
        if (!google) return needGoogle();
        const days = Math.min(31, Math.max(1, Number(arg) || 1));
        return { text: `${t(`📅 Next ${days} day(s):`, `📅 ${days} วันข้างหน้า:`)}\n${formatEvents(await google.events(now, new Date(now.getTime() + days * 864e5)), cfg.timezone)}` };
      }
      case '/inbox':
        if (!google) return needGoogle();
        return { text: `${t('📥 Unread (Primary):', '📥 ยังไม่ได้อ่าน (หลัก):')}\n${formatEmails(await google.unreadEmails(10))}` };
      case '/mail': {
        if (!google) return needGoogle();
        if (!arg) return { text: t('What should I search for? e.g. /mail from:ken contract newer_than:14d', 'จะค้นหาอะไรดี? เช่น /mail from:ken contract newer_than:14d') };
        const found = formatEmails(await google.searchEmails(arg, 10));
        return {
          text: t(
            `🔎 Gmail results for "${arg}":\n${found}\n\nAsk me about any of them to read it in full.`,
            `🔎 ผลการค้นหา Gmail สำหรับ "${arg}":\n${found}\n\nถามฉันถึงฉบับไหนก็ได้ เพื่ออ่านแบบเต็ม`,
          ),
        };
      }
      case '/gtask':
        if (!google) return needGoogle();
        if (arg) {
          await google.addTask(arg);
          return { text: t(`☑️ Added to Google Tasks: ${arg}`, `☑️ เพิ่มใน Google Tasks แล้ว: ${arg}`) };
        }
        {
          const list = formatTasks(await google.tasks(), true);
          return { text: t(`☑️ Google Tasks:\n${list}\n\nTick one off with /gdone <number>.`, `☑️ Google Tasks:\n${list}\n\nทำเครื่องหมายว่าเสร็จด้วย /gdone <หมายเลข>`) };
        }
      case '/gdone': {
        if (!google) return needGoogle();
        const tasks = await google.tasks();
        const task = /^\d+$/.test(arg) ? tasks[Number(arg) - 1] : tasks.find((x) => arg && x.title.toLowerCase().includes(arg.toLowerCase()));
        if (!task) return { text: t(`No open Google Task "${arg}". See /gtask.`, `ไม่มีงานที่ยังเปิดอยู่ใน Google Tasks ชื่อ "${arg}" ดูได้ที่ /gtask`) };
        await google.completeTask(task.id);
        return { text: t(`✅ Done in Google Tasks: ${task.title}`, `✅ เสร็จแล้วใน Google Tasks: ${task.title}`) };
      }
      case '/places': {
        if (!agent.maps) return { text: t('Google Maps is not connected. Add GOOGLE_MAPS_API_KEY (see SETUP-GUIDE.md, Part 3).', 'ยังไม่ได้เชื่อมต่อ Google Maps ต้องเพิ่ม GOOGLE_MAPS_API_KEY (ดู SETUP-GUIDE.md ส่วนที่ 3)') };
        if (!arg) return { text: t('What are you looking for? e.g. /places ramen near Asok', 'กำลังหาอะไรอยู่? เช่น /places ราเมงแถวอโศก') };
        return { text: `📍 ${formatPlaces(await agent.maps.searchPlaces(arg, store.settings().city))}` };
      }
      case '/drive': {
        if (!google) return needGoogle();
        const files = await google.driveSearch(arg);
        const heading = arg ? t(`Drive results for "${arg}"`, `ผลการค้นหาใน Drive สำหรับ "${arg}"`) : t('Recent Drive files', 'ไฟล์ล่าสุดใน Drive');
        return { text: files.length ? `📁 ${heading}:\n${files.map((f) => `• ${f.name}\n  ${f.link}`).join('\n')}` : t('No matching files.', 'ไม่พบไฟล์ที่ตรงกัน') };
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) return { text: e.message };
    throw e;
  }
}
