import type { Config } from './config';
import { langFromPreferences } from './i18n';
import { isKana, katakanaToHiragana, readingCandidates } from './kana';
import type { Store } from './store';
import { ApiError, dueAssignments, fetchSubjectsByIds, SRS_NAMES, submitReview, type WkSubject } from './wanikani';

/** One WaniKani item being reviewed in chat. */
export interface ReviewItem {
  assignmentId: number;
  srsStage: number;
  subject: WkSubject;
  needMeaning: boolean;
  needReading: boolean;
  /** Which part is asked next. */
  ask: 'meaning' | 'reading';
  wrongMeaning: number;
  wrongReading: number;
  /** Shown after the item is answered (e.g. the kanji-of-the-day card). */
  card?: string;
}

export interface ReviewSession {
  queue: ReviewItem[];
  total: number;
  /** Items finished, and how many were right first time. */
  done: number;
  firstTry: number;
  /** Set when WaniKani refuses submissions, so the quiz goes on without retrying every item. */
  submitBlocked?: string;
  startedAt: string;
}

export interface WaniKaniApi {
  due: typeof dueAssignments;
  subjects: typeof fetchSubjectsByIds;
  submit: typeof submitReview;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Typos allowed for an answer this long (close to WaniKani's own leniency). */
const tolerance = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : len <= 7 ? 2 : 2 + Math.floor((len - 7) / 7));

export type Grade = 'correct' | 'close' | 'wrong';

export function gradeMeaning(answer: string, s: WkSubject): Grade {
  const a = normalize(answer);
  if (!a || s.blacklist.some((b) => normalize(b) === a)) return 'wrong';
  const accepted = s.acceptedMeanings.map(normalize);
  if (accepted.includes(a)) return 'correct';
  return accepted.some((m) => levenshtein(a, m) <= tolerance(m.length)) ? 'close' : 'wrong';
}

export type ReadingGrade = 'correct' | 'wrong' | 'other-reading' | 'not-kana';

export function gradeReading(answer: string, s: WkSubject): ReadingGrade {
  const candidates = readingCandidates(answer);
  if (candidates.every((c) => /[a-z]/i.test(c))) return 'not-kana';
  const norm = (r: string) => katakanaToHiragana(r);
  const accepted = s.readings.filter((r) => r.accepted !== false).map((r) => norm(r.reading));
  if (candidates.some((c) => accepted.includes(c))) return 'correct';
  const others = s.readings.filter((r) => r.accepted === false).map((r) => norm(r.reading));
  return candidates.some((c) => others.includes(c)) ? 'other-reading' : 'wrong';
}

/** Review messages are fixed text (no AI, so reviews stay free), in English or Thai. */
export type ReviewLang = 'en' | 'th';

/** Thai when a standing preference asks for it (e.g. "Always reply in Thai", "ตอบเป็นภาษาไทย"). */
export function reviewLang(preferences: string[] = []): ReviewLang {
  return langFromPreferences(preferences);
}

const TEXT = {
  en: {
    kind: { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary', kana_vocabulary: 'Vocabulary' } as Record<WkSubject['object'], string>,
    notConnected: 'WaniKani is not connected. Add WANIKANI_TOKEN to the bot (see SETUP-GUIDE.md).',
    inProgress: "You're in the middle of a review.",
    noneDue: '🎉 No WaniKani reviews are due right now.',
    started: (n: number, due: number) => `🈁 WaniKani review: ${n} of ${due} due. Answers count on WaniKani. /review stop to pause.`,
    noReview: 'No review is running.',
    noReviewStart: 'No review is running. Start one with /review.',
    stopped: (done: number, left: number) => `⏸️ Review stopped. ${done} item(s) were sent to WaniKani; the ${left} unfinished one(s) stay due there.`,
    askMeaning: (kind: string) => `${kind} meaning? (English)`,
    askReading: (kind: string, want: string) => `${kind} reading? (kana or romaji${want ? `; WaniKani wants the ${want}` : ''})`,
    reading: 'reading',
    gaveReading: "That's the reading 🙂 I asked for the meaning.",
    gaveMeaning: "That's the meaning 🙂 I asked for the reading.",
    typeKana: 'Type the reading in kana or romaji, e.g. "gengo" or "げんご".',
    otherReading: (chars: string, want: string) => `That's a reading of ${chars}, but WaniKani wants the ${want} here. Try again.`,
    wrongMeaning: (chars: string, ans: string) => `❌ ${chars} means “${ans}”.`,
    wrongReading: (chars: string, ans: string) => `❌ ${chars} is read “${ans}”.`,
    close: (m: string) => `✅ Close enough: “${m}”.`,
    correct: '✅ Correct!',
    notSent: '(Not sent to WaniKani: the token cannot submit reviews.)',
    done: (done: number, first: number, synced: boolean) => `🎉 Done! ${done} item(s) reviewed, ${first} right first time.${synced ? ' WaniKani is up to date.' : ''}`,
  },
  th: {
    kind: { radical: 'ราก (radical)', kanji: 'คันจิ', vocabulary: 'คำศัพท์', kana_vocabulary: 'คำศัพท์' } as Record<WkSubject['object'], string>,
    notConnected: 'ยังไม่ได้เชื่อมต่อ WaniKani ต้องใส่ WANIKANI_TOKEN ให้บอทก่อนนะ (ดู SETUP-GUIDE.md)',
    inProgress: 'ตอนนี้กำลังรีวิวค้างอยู่นะ',
    noneDue: '🎉 ตอนนี้ไม่มีรีวิว WaniKani ค้างอยู่เลย',
    started: (n: number, due: number) => `🈁 รีวิว WaniKani: ${n} จาก ${due} ข้อที่ถึงกำหนด คำตอบจะนับใน WaniKani ด้วย พิมพ์ /review stop เพื่อพัก`,
    noReview: 'ไม่มีรีวิวที่กำลังทำอยู่',
    noReviewStart: 'ไม่มีรีวิวที่กำลังทำอยู่ เริ่มได้ด้วย /review',
    stopped: (done: number, left: number) => `⏸️ หยุดรีวิวแล้ว ส่งไป WaniKani แล้ว ${done} ข้อ อีก ${left} ข้อที่ยังไม่เสร็จจะยังค้างอยู่ใน WaniKani`,
    askMeaning: (kind: string) => `${kind}นี้แปลว่าอะไร? (ตอบเป็นภาษาอังกฤษ)`,
    askReading: (kind: string, want: string) => `${kind}นี้อ่านว่าอะไร? (พิมพ์คานะหรือโรมาจิ${want ? ` · WaniKani ต้องการ ${want}` : ''})`,
    reading: 'คำอ่าน',
    gaveReading: 'นั่นคือคำอ่านนะ 🙂 ข้อนี้ถามความหมาย',
    gaveMeaning: 'นั่นคือความหมายนะ 🙂 ข้อนี้ถามคำอ่าน',
    typeKana: 'พิมพ์คำอ่านเป็นคานะหรือโรมาจิ เช่น "gengo" หรือ "げんご"',
    otherReading: (chars: string, want: string) => `นั่นเป็นคำอ่านหนึ่งของ ${chars} แต่ข้อนี้ WaniKani ต้องการ ${want} ลองอีกครั้งนะ`,
    wrongMeaning: (chars: string, ans: string) => `❌ ${chars} แปลว่า “${ans}”`,
    wrongReading: (chars: string, ans: string) => `❌ ${chars} อ่านว่า “${ans}”`,
    close: (m: string) => `✅ ใกล้เคียงพอ: “${m}”`,
    correct: '✅ ถูกต้อง!',
    notSent: '(ไม่ได้ส่งไป WaniKani: token นี้ส่งผลรีวิวไม่ได้)',
    done: (done: number, first: number, synced: boolean) => `🎉 เสร็จแล้ว! รีวิวไป ${done} ข้อ ถูกตั้งแต่ครั้งแรก ${first} ข้อ${synced ? ' อัปเดต WaniKani เรียบร้อย' : ''}`,
  },
};

export function toReviewItem(assignmentId: number, srsStage: number, subject: WkSubject, card?: string): ReviewItem {
  const reads = subject.object === 'kanji' || subject.object === 'vocabulary';
  return { assignmentId, srsStage, subject, needMeaning: true, needReading: reads && subject.readings.length > 0, ask: 'meaning', wrongMeaning: 0, wrongReading: 0, ...(card ? { card } : {}) };
}

/** WaniKani reviews done in chat; finished items are submitted to WaniKani. */
export class Reviews {
  constructor(
    private readonly cfg: Pick<Config, 'wanikaniToken'>,
    private readonly store: Store,
    private readonly api: WaniKaniApi = { due: dueAssignments, subjects: fetchSubjectsByIds, submit: submitReview },
    private readonly random: () => number = Math.random,
  ) {}

  /** Message texts in the language the user's standing preferences ask for. */
  private get t() {
    return TEXT[reviewLang(this.store.settings().preferences)];
  }

  get enabled(): boolean {
    return !!this.cfg.wanikaniToken;
  }

  active(chatKey: string): boolean {
    return !!this.store.review(chatKey)?.queue.length;
  }

  /** Everything due on WaniKani now, as review items. */
  async dueItems(): Promise<ReviewItem[]> {
    const due = await this.api.due(this.cfg.wanikaniToken);
    if (!due.length) return [];
    const subjects = new Map((await this.api.subjects(this.cfg.wanikaniToken, due.map((a) => a.subjectId))).map((s) => [s.id, s]));
    return due.filter((a) => subjects.has(a.subjectId)).map((a) => toReviewItem(a.id, a.srsStage, subjects.get(a.subjectId)!));
  }

  private shuffle<T>(xs: T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Starts (or adds to) a review session with these items; returns the first question. */
  begin(chatKey: string, items: ReviewItem[]): string {
    const old = this.store.review(chatKey);
    const known = new Set(old?.queue.map((i) => i.assignmentId));
    const fresh = items.filter((i) => !known.has(i.assignmentId));
    const session: ReviewSession = old?.queue.length
      ? { ...old, queue: [...old.queue, ...fresh], total: old.total + fresh.length }
      : { queue: fresh, total: fresh.length, done: 0, firstTry: 0, startedAt: new Date().toISOString() };
    this.store.setReview(chatKey, session);
    return this.question(session);
  }

  /** /review: pulls due reviews (up to `limit`) and asks the first one. */
  async start(chatKey: string, limit = 10): Promise<string> {
    const t = this.t;
    if (!this.enabled) return t.notConnected;
    if (this.active(chatKey)) return `${t.inProgress}\n\n${this.question(this.store.review(chatKey)!)}`;
    const due = await this.dueItems();
    if (!due.length) return t.noneDue;
    // Lower SRS stages first (they matter most), shuffled within the batch.
    const batch = this.shuffle(due.sort((a, b) => a.srsStage - b.srsStage).slice(0, Math.min(50, Math.max(1, limit))));
    return `${t.started(batch.length, due.length)}\n\n${this.begin(chatKey, batch)}`;
  }

  stop(chatKey: string): string {
    const s = this.store.review(chatKey);
    this.store.setReview(chatKey, null);
    if (!s?.queue.length) return this.t.noReview;
    return this.t.stopped(s.done, s.queue.length);
  }

  private question(s: ReviewSession): string {
    const item = s.queue[0];
    if (!item) return '';
    const t = this.t;
    const kind = t.kind[item.subject.object];
    const what = item.ask === 'meaning' ? t.askMeaning(kind) : t.askReading(kind, item.subject.object === 'kanji' ? this.readingType(item.subject) : '');
    return `${s.done + 1}/${s.total} · ${kind}: ${item.subject.characters}\n${what}`;
  }

  private readingType(s: WkSubject): string {
    const t = s.readings.find((r) => r.primary)?.type;
    return t === 'onyomi' ? "on'yomi" : t === 'kunyomi' ? "kun'yomi" : t === 'nanori' ? 'nanori' : this.t.reading;
  }

  private answerText(item: ReviewItem, part: 'meaning' | 'reading'): string {
    const s = item.subject;
    if (part === 'meaning') return s.meanings.join(', ');
    return s.readings
      .filter((r) => r.accepted !== false)
      .map((r) => r.reading)
      .join(', ');
  }

  /** Grades one answer and returns feedback plus the next question (or the summary). */
  async answer(chatKey: string, text: string): Promise<string> {
    const s = this.store.review(chatKey);
    const item = s?.queue[0];
    const t = this.t;
    if (!s || !item) return t.noReviewStart;
    const part = item.ask;
    const lines: string[] = [];

    if (part === 'meaning') {
      if (isKana(text) && gradeReading(text, item.subject) === 'correct') {
        return `${t.gaveReading}\n\n${this.question(s)}`;
      }
      const g = gradeMeaning(text, item.subject);
      if (g === 'wrong') {
        item.wrongMeaning++;
        lines.push(`${t.wrongMeaning(item.subject.characters, this.answerText(item, 'meaning'))}${item.subject.meaningMnemonic ? `\n💡 ${shorten(item.subject.meaningMnemonic)}` : ''}`);
      } else {
        lines.push(g === 'close' ? t.close(item.subject.meanings[0]) : t.correct);
        item.needMeaning = false;
      }
    } else {
      const g = gradeReading(text, item.subject);
      if (g === 'not-kana') {
        if (gradeMeaning(text, item.subject) !== 'wrong') return `${t.gaveMeaning}\n\n${this.question(s)}`;
        return `${t.typeKana}\n\n${this.question(s)}`;
      }
      if (g === 'other-reading') return t.otherReading(item.subject.characters, this.readingType(item.subject));
      if (g === 'wrong') {
        item.wrongReading++;
        lines.push(`${t.wrongReading(item.subject.characters, this.answerText(item, 'reading'))}${item.subject.readingMnemonic ? `\n💡 ${shorten(item.subject.readingMnemonic)}` : ''}`);
      } else {
        lines.push(`✅ ${this.answerText(item, 'reading')}`);
        item.needReading = false;
      }
    }

    s.queue.shift();
    if (!item.needMeaning && !item.needReading) {
      // Finished: send it to WaniKani.
      s.done++;
      if (!item.wrongMeaning && !item.wrongReading) s.firstTry++;
      if (s.submitBlocked) lines.push(t.notSent);
      else {
        try {
          const stage = await this.api.submit(this.cfg.wanikaniToken, item.assignmentId, item.wrongMeaning, item.wrongReading);
          if (stage !== null) lines.push(`📤 WaniKani: ${SRS_NAMES[item.srsStage] ?? item.srsStage} → ${SRS_NAMES[stage] ?? stage}`);
        } catch (e) {
          const msg = (e as Error).message;
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) s.submitBlocked = msg;
          lines.push(`⚠️ ${msg}`);
        }
      }
      if (item.card) lines.push('', item.card);
    } else {
      item.ask = item.needMeaning ? 'meaning' : 'reading';
      // Right answers move on to the item's other part; wrong ones come back later, like on WaniKani.
      if (lines[0].startsWith('❌') && s.queue.length) s.queue.push(item);
      else s.queue.unshift(item);
    }

    if (!s.queue.length) {
      this.store.setReview(chatKey, null);
      lines.push('', t.done(s.done, s.firstTry, !s.submitBlocked));
    } else {
      this.store.setReview(chatKey, s);
      lines.push('', this.question(s));
    }
    return lines.join('\n');
  }
}

/** First sentence or two of a mnemonic. */
function shorten(m: string): string {
  const parts = m.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > 220) break;
    out += (out ? ' ' : '') + p;
  }
  return out || m.slice(0, 220);
}
