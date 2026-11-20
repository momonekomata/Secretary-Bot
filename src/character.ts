import { t } from './i18n';
import { localClock } from './time';

/**
 * The bot's character sheet: looks, birthday, likes, dislikes, quirks and so on. It sits on top of whichever
 * personality is chosen (/persona), so switching personalities keeps the character. Each section is a list of
 * short items, so one detail can be added or removed without retyping the rest.
 */

export const CHARACTER_SECTIONS = ['looks', 'birthday', 'likes', 'dislikes', 'quirks', 'habits', 'speech', 'backstory', 'other'] as const;
export type CharacterSection = (typeof CHARACTER_SECTIONS)[number];
export type Character = Partial<Record<CharacterSection, string[]>>;

/** Whole sheet, item and section limits (characters / items), to keep the prompt reasonable. */
export const MAX_TOTAL = 4000;
export const MAX_ITEM = 400;
export const MAX_ITEMS = 30;

const LABELS: Record<CharacterSection, [string, string, string]> = {
  // [emoji, English, Thai]
  looks: ['👀', 'Looks', 'รูปลักษณ์'],
  birthday: ['🎂', 'Birthday', 'วันเกิด'],
  likes: ['💖', 'Likes', 'สิ่งที่ชอบ'],
  dislikes: ['💢', 'Dislikes', 'สิ่งที่ไม่ชอบ'],
  quirks: ['✨', 'Quirks', 'นิสัยแปลกๆ'],
  habits: ['🔁', 'Habits', 'กิจวัตร'],
  speech: ['💬', 'How I talk', 'วิธีพูด'],
  backstory: ['📖', 'Backstory', 'ภูมิหลัง'],
  other: ['📝', 'Other', 'อื่นๆ'],
};

/** Other words for sections, in commands. */
const ALIASES: Record<string, CharacterSection> = {
  look: 'looks', appearance: 'looks', body: 'looks', รูปลักษณ์: 'looks', หน้าตา: 'looks',
  bday: 'birthday', born: 'birthday', วันเกิด: 'birthday',
  like: 'likes', ชอบ: 'likes',
  dislike: 'dislikes', hate: 'dislikes', hates: 'dislikes', ไม่ชอบ: 'dislikes',
  quirk: 'quirks', นิสัย: 'quirks',
  habit: 'habits', routine: 'habits', กิจวัตร: 'habits',
  voice: 'speech', talk: 'speech', 'catchphrase': 'speech', catchphrases: 'speech', คำพูด: 'speech',
  story: 'backstory', history: 'backstory', background: 'backstory', ภูมิหลัง: 'backstory',
  note: 'other', notes: 'other', misc: 'other', อื่นๆ: 'other',
};

export function findSection(word: string): CharacterSection | null {
  const w = word.trim().toLowerCase();
  return (CHARACTER_SECTIONS as readonly string[]).includes(w) ? (w as CharacterSection) : (ALIASES[w] ?? null);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_ABBR = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiMonth = (w: string) => {
  const abbr = THAI_ABBR.findIndex((a) => w === a || w === a.slice(0, -1));
  return abbr >= 0 ? abbr + 1 : THAI_MONTHS.findIndex((n) => w.startsWith(n.slice(0, 3))) + 1;
};
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A birthday as MM-DD, from "03-03", "2007-03-03", "3 March", "March 3rd" or "3 มีนาคม"; null if it isn't one. */
export function parseBirthday(s: string): string | null {
  const x = s.trim().toLowerCase();
  let m: number | undefined;
  let d: number | undefined;
  let r: RegExpExecArray | null;
  if ((r = /^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/.exec(x))) [m, d] = [Number(r[1]), Number(r[2])];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+\d{4})?$/.exec(x))) [d, m] = [Number(r[1]), MONTHS.indexOf(r[2].slice(0, 3)) + 1];
  else if ((r = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+\d{4})?$/.exec(x))) [m, d] = [MONTHS.indexOf(r[1].slice(0, 3)) + 1, Number(r[2])];
  else if ((r = /^(\d{1,2})\s*(\S+)/.exec(x)) && thaiMonth(r[2]) > 0) [d, m] = [Number(r[1]), thaiMonth(r[2])];
  if (!m || !d || m < 1 || m > 12 || d < 1 || d > DAYS_IN[m - 1]) return null;
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "3 March" (or "3 มีนาคม") for an MM-DD birthday. */
export function birthdayLabel(mmdd: string): string {
  const [m, d] = mmdd.split('-').map(Number);
  const en = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
  return t(`${d} ${en}`, `${d} ${THAI_MONTHS[m - 1]}`);
}

const size = (c: Character) => Object.values(c).reduce((n, items) => n + (items ?? []).reduce((k, i) => k + i.length + 1, 0), 0);

export type CharacterEdit =
  | { action: 'add'; section: CharacterSection; text: string }
  | { action: 'set'; section: CharacterSection; text: string }
  | { action: 'remove'; section: CharacterSection; number: number }
  | { action: 'clear'; section: CharacterSection | 'all' };

/** Applies an edit; returns the new sheet, or an error message (English, for the AI and as a fallback). */
export function editCharacter(c: Character, e: CharacterEdit): { character: Character } | { error: string } {
  const next: Character = { ...c };
  if (e.action === 'clear') {
    if (e.section === 'all') return { character: {} };
    delete next[e.section];
    return { character: next };
  }
  const items = [...(next[e.section] ?? [])];
  if (e.action === 'remove') {
    if (!(e.number >= 1 && e.number <= items.length)) return { error: `There is no item ${e.number} under ${e.section} (it has ${items.length}).` };
    items.splice(e.number - 1, 1);
    if (items.length) next[e.section] = items;
    else delete next[e.section];
    return { character: next };
  }
  let text = e.text.trim().replace(/\s+/g, ' ');
  if (!text) return { error: 'Nothing to save.' };
  if (text.length > MAX_ITEM) return { error: `That is too long for one item (${text.length} characters, at most ${MAX_ITEM}). Split it into a few shorter ones.` };
  if (e.section === 'birthday') {
    const b = parseBirthday(text);
    if (!b) return { error: `"${text}" isn't a date I can use for a birthday. Use e.g. 03-03 or 3 March.` };
    text = b;
    next.birthday = [b]; // one birthday
  } else if (e.action === 'set') {
    next[e.section] = [text];
  } else {
    if (items.some((i) => i.toLowerCase() === text.toLowerCase())) return { character: next };
    if (items.length >= MAX_ITEMS) return { error: `${e.section} already has ${MAX_ITEMS} items; remove one first.` };
    next[e.section] = [...items, text];
  }
  if (size(next) > MAX_TOTAL) return { error: `The character sheet would be over ${MAX_TOTAL} characters; remove or shorten something first.` };
  return { character: next };
}

/** The sheet for the system prompt (English labels; the items are as written). */
export function characterPrompt(c: Character | undefined): string {
  if (!c || !CHARACTER_SECTIONS.some((s) => c[s]?.length)) return '';
  const lines = CHARACTER_SECTIONS.filter((s) => c[s]?.length).map((s) => {
    const items = c[s]!;
    if (s === 'birthday') return `Birthday: ${birthdayLabelEn(items[0])}`;
    return `${LABELS[s][1]}:\n${items.map((i) => `- ${i}`).join('\n')}`;
  });
  return (
    'Your character sheet: these facts about you are true in every personality, scene and language. Stay consistent with them, bring them up naturally when they fit ' +
    '(not in every reply), and never contradict them. When you make up a new lasting detail about yourself, or the user gives you one, save it with character_update.\n' +
    lines.join('\n')
  );
}

const birthdayLabelEn = (mmdd: string) => {
  const [m, d] = mmdd.split('-').map(Number);
  return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]}`;
};

/** True when today (local) is the character's birthday. 29 February is celebrated on 28 February in other years. */
export function isBirthday(c: Character | undefined, now: Date, timeZone: string): boolean {
  const b = c?.birthday?.[0];
  if (!b) return false;
  const day = localClock(now, timeZone).day;
  const mmdd = day.slice(5);
  if (b === mmdd) return true;
  const year = Number(day.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return b === '02-29' && !leap && mmdd === '02-28';
}

/** /character: the whole sheet, numbered, in the user's language. */
export function formatCharacter(c: Character | undefined, name: string): string {
  const filled = CHARACTER_SECTIONS.filter((s) => c?.[s]?.length);
  const help = t(
    'Change it by just telling me ("add that you\'re scared of thunder"), or:\n/character add likes sweet potatoes\n/character remove likes 2\n/character set birthday 3 March\n/character clear quirks (or /character clear all)\n' +
      `Sections: ${CHARACTER_SECTIONS.join(', ')}`,
    'เปลี่ยนได้โดยบอกฉันตรงๆ ("เพิ่มว่าเธอกลัวฟ้าร้อง") หรือ:\n/character add likes มันหวาน\n/character remove likes 2\n/character set birthday 3 March\n/character clear quirks (หรือ /character clear all)\n' +
      `หมวด: ${CHARACTER_SECTIONS.join(', ')}`,
  );
  if (!filled.length) {
    return [t(`🎭 ${name} has no character sheet yet.`, `🎭 ${name}ยังไม่มีโปรไฟล์ตัวละคร`), help].join('\n\n');
  }
  const blocks = filled.map((s) => {
    const [emoji, en, th] = LABELS[s];
    const items = c![s]!;
    if (s === 'birthday') return `${emoji} ${t(en, th)}: ${birthdayLabel(items[0])}`;
    return `${emoji} ${t(en, th)} (${s}):\n${items.map((i, n) => `${n + 1}. ${i}`).join('\n')}`;
  });
  return [t(`🎭 ${name}'s character sheet`, `🎭 โปรไฟล์ตัวละครของ${name}`), ...blocks, `${size(c!)}/${MAX_TOTAL}`, help].join('\n\n');
}
