import type { Agent } from './agent';
import { STYLE } from './briefings';
import type { Config } from './config';
import type { Store } from './store';
import { fetchSubjects, wanikaniLevel, type WkSubject } from './wanikani';

export const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'] as const;

const KANJI_CARD =
  'Write a "Kanji of the day" card for a Japanese learner: the kanji on its own line, its meaning, on\'yomi and kun\'yomi readings ' +
  '(kana plus romaji), 2-3 common words that use it (word, reading, meaning), an easy, vivid memory trick linking its shape to the ' +
  'meaning and the sound, and one tiny practice question with its answer at the very end after "Answer:". Keep it short and fun.';

const WORD_CARD =
  'Write a "Japanese word of the day" card for a learner: the word, its reading (kana plus romaji), meaning, part of speech, one natural ' +
  'example sentence (Japanese, reading, translation), an easy memory trick (a sound-alike or a picture), and a one-line tip on when to use it.';

/** Kanji and vocabulary of the day: from WaniKani levels when connected (real readings), otherwise chosen by the AI for a JLPT level. */
export class JapaneseDaily {
  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly agent: Agent,
    private readonly wk = { subjects: fetchSubjects, level: wanikaniLevel },
    private readonly random: () => number = Math.random,
  ) {}

  jlpt(): string {
    return this.store.settings().jlptLevel ?? 'N4';
  }

  private language(): string {
    return this.store.settings().translateTo ?? this.cfg.defaultTranslateTo;
  }

  /** A WaniKani item from the user's current level (or the two before) that hasn't been sent yet. */
  private async fromWaniKani(type: 'kanji' | 'vocabulary'): Promise<WkSubject | null> {
    if (!this.cfg.wanikaniToken) return null;
    const level = await this.wk.level(this.cfg.wanikaniToken);
    const levels = [level, level - 1, level - 2].filter((l) => l >= 1);
    const items = await this.wk.subjects(this.cfg.wanikaniToken, type, levels);
    const seen = new Set(this.store.japaneseHistory()[type === 'kanji' ? 'kanji' : 'words']);
    for (const l of levels) {
      const fresh = items.filter((s) => s.level === l && !seen.has(s.characters));
      if (fresh.length) return fresh[Math.floor(this.random() * fresh.length)];
    }
    return items.length ? items[Math.floor(this.random() * items.length)] : null;
  }

  private facts(s: WkSubject): string {
    const readings = s.readings.map((r) => `${r.type ? `${r.type} ` : ''}${r.reading}${r.primary ? ' (main)' : ''}`).join(', ');
    return [
      `${s.object === 'kanji' ? 'Kanji' : 'Word'}: ${s.characters} (WaniKani level ${s.level})`,
      `Meanings: ${s.meanings.join(', ')}`,
      `Readings: ${readings}`,
      s.partsOfSpeech?.length ? `Part of speech: ${s.partsOfSpeech.join(', ')}` : '',
      s.meaningMnemonic ? `WaniKani meaning mnemonic: ${s.meaningMnemonic}` : '',
      s.readingMnemonic ? `WaniKani reading mnemonic: ${s.readingMnemonic}` : '',
      s.sentences?.length ? `Example: ${s.sentences[0].ja} — ${s.sentences[0].en}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async card(kind: 'kanji' | 'words'): Promise<string> {
    const isKanji = kind === 'kanji';
    const lang = `Write the explanations in ${this.language()}.`;
    const subject = await this.fromWaniKani(isKanji ? 'kanji' : 'vocabulary').catch(() => null);
    if (subject) {
      const text = await this.agent.generate(
        `${isKanji ? KANJI_CARD : WORD_CARD} Use exactly the meanings and readings given; don't add others. You may adapt the WaniKani mnemonics, but make them your own. ${lang} ${STYLE}`,
        this.facts(subject),
        isKanji ? 'kanji' : 'word',
      );
      this.store.addJapanese(kind, subject.characters);
      return text;
    }
    // No WaniKani: the AI picks a common item for the JLPT level, avoiding recent ones.
    const recent = this.store.japaneseHistory()[kind].slice(-80);
    const marker = isKanji ? 'KANJI' : 'WORD';
    const raw = await this.agent.generate(
      `${isKanji ? KANJI_CARD : WORD_CARD} Choose one common ${isKanji ? 'kanji' : 'word'} at JLPT ${this.jlpt()} level` +
        (recent.length ? `, not one of these: ${recent.join(' ')}` : '') +
        `. Begin your reply with a line "${marker}: <the ${isKanji ? 'kanji' : 'word'}>", then the card. Be careful that every reading is correct. ${lang} ${STYLE}`,
      `Today's ${isKanji ? 'kanji' : 'word'} of the day, please.`,
      isKanji ? 'kanji' : 'word',
    );
    const m = new RegExp(`^\\s*${marker}:\\s*(\\S+)\\s*$`, 'm').exec(raw);
    if (m) this.store.addJapanese(kind, m[1]);
    return raw.replace(new RegExp(`^\\s*${marker}:.*\\n?`, 'm'), '').trim();
  }

  kanji(): Promise<string> {
    return this.card('kanji');
  }

  word(): Promise<string> {
    return this.card('words');
  }

  /** The daily message: kanji and word together. */
  async daily(): Promise<string> {
    const [k, w] = await Promise.all([this.kanji(), this.word()]);
    return `🇯🇵 Today's Japanese\n\n${k}\n\n— — —\n\n${w}`;
  }
}
