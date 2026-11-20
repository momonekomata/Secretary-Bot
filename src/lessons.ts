import { t } from './i18n';
import { localClock } from './time';

/**
 * Lessons the bot has taught (e.g. "how to use 我慢する in real sentences"): what was asked, the key points and
 * examples, and a spaced-repetition quiz schedule. Kept so the bot builds on what it taught instead of teaching
 * it again, and can quiz the user later.
 */

export interface Lesson {
  id: number;
  /** Short title, e.g. "我慢する (gaman suru): to endure / hold back". */
  topic: string;
  /** e.g. "Japanese grammar", "Japanese vocabulary", "Thai cooking". */
  subject: string;
  /** What the user asked for, in their words. */
  asked: string;
  /** What was taught, in a few sentences. */
  summary: string;
  points: string[];
  examples: string[];
  /** Local days it was taught (first, then any later additions). */
  taught: string[];
  /** Spaced repetition: stage 0..n, and the local day of the next quiz. */
  stage: number;
  due: string;
  quizzes: { day: string; correct: boolean; note?: string }[];
}

/** Days until the next quiz at each stage (after a correct answer the stage goes up). */
export const INTERVALS = [1, 3, 7, 14, 30, 60, 120];

const MAX_POINTS = 12;
const MAX_EXAMPLES = 10;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/[\s「」『』"'()（）.,、。:：\-–—/]+/g, '');
const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = norm(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** The lesson with the same topic (ignoring spacing, punctuation and case), if any. */
export function sameTopic(lessons: Lesson[], topic: string): Lesson | undefined {
  const k = norm(topic);
  return lessons.find((l) => norm(l.topic) === k);
}

/**
 * Lessons matching `query`: any word of the query (or the whole query, for Japanese without spaces) found in the
 * topic, subject, summary, points or examples. Best matches first.
 */
export function findLessons(lessons: Lesson[], query: string): Lesson[] {
  const q = norm(query);
  const words = query
    .toLowerCase()
    .split(/[\s,、。]+/)
    .map(norm)
    .filter((w) => w.length >= 2);
  if (!q) return [];
  const score = (l: Lesson) => {
    const topic = norm(l.topic);
    const rest = norm([l.subject, l.asked, l.summary, ...l.points, ...l.examples].join(' '));
    let s = 0;
    if (topic.includes(q) || q.includes(topic)) s += 10;
    if (rest.includes(q)) s += 4;
    for (const w of words) s += (topic.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0);
    return s;
  };
  return lessons
    .map((l) => ({ l, s: score(l) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.l);
}

/**
 * Saves a lesson: a new one is due for its first quiz tomorrow; the same topic again adds the new points and
 * examples to the existing lesson instead of making a second one.
 */
export function saveLesson(
  lessons: Lesson[],
  input: { topic: string; subject: string; asked: string; summary: string; points: string[]; examples: string[] },
  today: string,
  nextId: () => number,
): { lessons: Lesson[]; lesson: Lesson; updated: boolean } {
  const existing = sameTopic(lessons, input.topic);
  if (existing) {
    const lesson: Lesson = {
      ...existing,
      summary: input.summary || existing.summary,
      points: uniq([...existing.points, ...input.points]).slice(0, MAX_POINTS),
      examples: uniq([...existing.examples, ...input.examples]).slice(0, MAX_EXAMPLES),
      taught: [...new Set([...existing.taught, today])],
    };
    return { lessons: lessons.map((l) => (l.id === existing.id ? lesson : l)), lesson, updated: true };
  }
  const lesson: Lesson = {
    id: nextId(),
    topic: input.topic.trim().slice(0, 200),
    subject: input.subject.trim().slice(0, 60) || 'general',
    asked: input.asked.trim().slice(0, 300),
    summary: input.summary.trim().slice(0, 1200),
    points: uniq(input.points.map((p) => p.trim().slice(0, 300))).slice(0, MAX_POINTS),
    examples: uniq(input.examples.map((e) => e.trim().slice(0, 300))).slice(0, MAX_EXAMPLES),
    taught: [today],
    stage: 0,
    due: addDays(today, INTERVALS[0]),
    quizzes: [],
  };
  return { lessons: [...lessons, lesson], lesson, updated: false };
}

/** Records a quiz answer: right moves the next quiz further out, wrong brings it back to tomorrow. */
export function recordQuiz(lesson: Lesson, correct: boolean, today: string, note = ''): Lesson {
  const stage = correct ? Math.min(lesson.stage + 1, INTERVALS.length - 1) : 0;
  return {
    ...lesson,
    stage,
    due: addDays(today, INTERVALS[stage]),
    quizzes: [...lesson.quizzes, { day: today, correct, ...(note ? { note: note.slice(0, 200) } : {}) }].slice(-30),
  };
}

/** Lessons due for a quiz today or earlier, most overdue first. */
export function dueLessons(lessons: Lesson[], today: string): Lesson[] {
  return lessons.filter((l) => l.due <= today).sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

export const today = (now: Date, timeZone: string) => localClock(now, timeZone).day;

/** A lesson in full, for the AI (to quiz on it or build on it). */
export function lessonDetail(l: Lesson): string {
  const right = l.quizzes.filter((q) => q.correct).length;
  return [
    `#${l.id} ${l.topic} [${l.subject}] taught ${l.taught.join(', ')}; asked: "${l.asked}"`,
    `Summary: ${l.summary}`,
    l.points.length ? `Points:\n${l.points.map((p) => `- ${p}`).join('\n')}` : '',
    l.examples.length ? `Examples given:\n${l.examples.map((e) => `- ${e}`).join('\n')}` : '',
    `Quizzes: ${l.quizzes.length} (${right} right)${l.quizzes.length ? `, last ${l.quizzes.at(-1)!.day} ${l.quizzes.at(-1)!.correct ? 'right' : 'wrong'}${l.quizzes.at(-1)!.note ? ` (${l.quizzes.at(-1)!.note})` : ''}` : ''}; next quiz due ${l.due}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The short per-turn note: which topics were already taught, and how many are due for a quiz. */
export function lessonsNote(lessons: Lesson[], day: string): string {
  if (!lessons.length) return '';
  const recent = lessons.slice(-25).map((l) => `#${l.id} ${l.topic}`);
  const due = dueLessons(lessons, day).length;
  return (
    `Lessons you already taught this user (${lessons.length}${lessons.length > 25 ? ', latest 25' : ''}): ${recent.join('; ')}. ` +
    `Before teaching something, check with lesson_find; if it was taught, build on it or quiz instead of repeating it, unless the user asks to go over it again.` +
    (due ? ` ${due} lesson(s) are due for a quiz: you may offer one when the moment fits (not in the middle of other tasks).` : '')
  );
}

/** /lessons: the list, with what's due. */
export function formatLessons(lessons: Lesson[], day: string): string {
  if (!lessons.length) {
    return t(
      '📚 No lessons yet. Ask me to teach you something, e.g. "teach me how to use 我慢する in real sentences". I\'ll keep it here and quiz you on it later.',
      '📚 ยังไม่มีบทเรียน ลองขอให้ฉันสอนอะไรก็ได้ เช่น "สอนวิธีใช้ 我慢する ในประโยคจริงหน่อย" ฉันจะเก็บไว้ที่นี่และทดสอบคุณทีหลัง',
    );
  }
  const due = dueLessons(lessons, day);
  const lines = lessons
    .slice(-40)
    .reverse()
    .map((l) => {
      const right = l.quizzes.filter((q) => q.correct).length;
      const quiz = l.quizzes.length ? t(` · quizzed ${l.quizzes.length}× (${right} right)`, ` · ทดสอบ ${l.quizzes.length} ครั้ง (ถูก ${right})`) : '';
      const when = l.due <= day ? t(' · 🔔 quiz due', ' · 🔔 ถึงเวลาทดสอบ') : t(` · next quiz ${l.due}`, ` · ทดสอบครั้งถัดไป ${l.due}`);
      return `#${l.id} ${l.topic} (${l.taught[0]})${quiz}${when}`;
    });
  return [
    t(`📚 Lessons (${lessons.length}):`, `📚 บทเรียน (${lessons.length}):`),
    ...lines,
    '',
    due.length
      ? t(`🔔 ${due.length} due for a quiz. Send /quiz to start.`, `🔔 ถึงเวลาทดสอบ ${due.length} บท ส่ง /quiz เพื่อเริ่ม`)
      : t('Nothing due for a quiz today. /quiz still quizzes you on anything.', 'วันนี้ยังไม่มีบทที่ถึงเวลาทดสอบ แต่ส่ง /quiz เพื่อทดสอบเรื่องไหนก็ได้'),
    t('/lessons <word> finds a lesson; /lessons forget <id> deletes one.', '/lessons <คำ> ค้นหาบทเรียน; /lessons forget <id> ลบบทเรียน'),
  ].join('\n');
}

/** The instruction for a quiz turn (from /quiz or the daily quiz time). */
export function quizPrompt(due: Lesson[], all: Lesson[], topic = ''): string {
  const pick = topic ? findLessons(all, topic).slice(0, 3) : due.length ? due.slice(0, 3) : all.slice(-3);
  if (!pick.length) return '';
  return (
    `Quiz me on ${topic ? `"${topic}"` : 'lessons you taught me'}: ask ONE short question at a time about the lesson below (make me produce or use it, e.g. translate, ` +
    'fill in the blank, choose the right form, or make a sentence), wait for my answer, then say if it was right with a brief correction, ' +
    'record it with lesson_quiz_result, and ask the next one. Stop after 3 questions or when I say stop. Do not re-teach the lesson unless I get it wrong.\n\n' +
    pick.map(lessonDetail).join('\n\n')
  );
}
