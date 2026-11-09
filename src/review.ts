import type { Config } from './config';
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

const KIND: Record<WkSubject['object'], string> = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary', kana_vocabulary: 'Vocabulary' };

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
    if (!this.enabled) return 'WaniKani is not connected. Add WANIKANI_TOKEN to the bot (see SETUP-GUIDE.md).';
    if (this.active(chatKey)) return `You're in the middle of a review.\n\n${this.question(this.store.review(chatKey)!)}`;
    const due = await this.dueItems();
    if (!due.length) return '🎉 No WaniKani reviews are due right now.';
    // Lower SRS stages first (they matter most), shuffled within the batch.
    const batch = this.shuffle(due.sort((a, b) => a.srsStage - b.srsStage).slice(0, Math.min(50, Math.max(1, limit))));
    return `🈁 WaniKani review: ${batch.length} of ${due.length} due. Answers count on WaniKani. /review stop to pause.\n\n${this.begin(chatKey, batch)}`;
  }

  stop(chatKey: string): string {
    const s = this.store.review(chatKey);
    this.store.setReview(chatKey, null);
    if (!s?.queue.length) return 'No review is running.';
    return `⏸️ Review stopped. ${s.done} item(s) were sent to WaniKani; the ${s.queue.length} unfinished one(s) stay due there.`;
  }

  private question(s: ReviewSession): string {
    const item = s.queue[0];
    if (!item) return '';
    const kind = KIND[item.subject.object];
    const what =
      item.ask === 'meaning'
        ? 'meaning? (English)'
        : `reading? (kana or romaji${item.subject.object === 'kanji' ? `; WaniKani wants the ${this.readingType(item.subject)}` : ''})`;
    return `${s.done + 1}/${s.total} · ${kind}: ${item.subject.characters}\n${kind} ${what}`;
  }

  private readingType(s: WkSubject): string {
    const t = s.readings.find((r) => r.primary)?.type;
    return t === 'onyomi' ? "on'yomi" : t === 'kunyomi' ? "kun'yomi" : t === 'nanori' ? 'nanori' : 'reading';
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
    if (!s || !item) return 'No review is running. Start one with /review.';
    const part = item.ask;
    const lines: string[] = [];

    if (part === 'meaning') {
      if (isKana(text) && gradeReading(text, item.subject) === 'correct') {
        return `That's the reading 🙂 I asked for the meaning.\n\n${this.question(s)}`;
      }
      const g = gradeMeaning(text, item.subject);
      if (g === 'wrong') {
        item.wrongMeaning++;
        lines.push(`❌ ${item.subject.characters} means “${this.answerText(item, 'meaning')}”.${item.subject.meaningMnemonic ? `\n💡 ${shorten(item.subject.meaningMnemonic)}` : ''}`);
      } else {
        lines.push(g === 'close' ? `✅ Close enough: “${item.subject.meanings[0]}”.` : '✅ Correct!');
        item.needMeaning = false;
      }
    } else {
      const g = gradeReading(text, item.subject);
      if (g === 'not-kana') {
        if (gradeMeaning(text, item.subject) !== 'wrong') return `That's the meaning 🙂 I asked for the reading.\n\n${this.question(s)}`;
        return `Type the reading in kana or romaji, e.g. "gengo" or "げんご".\n\n${this.question(s)}`;
      }
      if (g === 'other-reading') return `That's a reading of ${item.subject.characters}, but WaniKani wants the ${this.readingType(item.subject)} here. Try again.`;
      if (g === 'wrong') {
        item.wrongReading++;
        lines.push(`❌ ${item.subject.characters} is read “${this.answerText(item, 'reading')}”.${item.subject.readingMnemonic ? `\n💡 ${shorten(item.subject.readingMnemonic)}` : ''}`);
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
      if (s.submitBlocked) lines.push('(Not sent to WaniKani: the token cannot submit reviews.)');
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
      lines.push('', `🎉 Done! ${s.done} item(s) reviewed, ${s.firstTry} right first time.${s.submitBlocked ? '' : ' WaniKani is up to date.'}`);
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
