import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Secretary } from '../channel';
import { runCommand } from '../commands';
import { JapaneseDaily } from '../japanese';
import { readingCandidates, toHiragana } from '../kana';
import { gradeMeaning, gradeReading, Reviews, type WaniKaniApi } from '../review';
import { Store } from '../store';
import { ApiError, type WkSubject } from '../wanikani';
import { NOW, echoProvider, testConfig } from './helpers';

const subject = (over: Partial<WkSubject>): WkSubject => ({
  id: 1,
  object: 'kanji',
  characters: '語',
  level: 5,
  meanings: ['Language'],
  acceptedMeanings: ['Language', 'Word'],
  blacklist: ['Lang'],
  readings: [
    { reading: 'ご', type: 'onyomi', primary: true, accepted: true },
    { reading: 'かた', type: 'kunyomi', primary: false, accepted: false },
  ],
  meaningMnemonic: 'Five mouths speaking a language.',
  ...over,
});

const GENGO = subject({
  id: 2,
  object: 'vocabulary',
  characters: '言語',
  meanings: ['Language'],
  acceptedMeanings: ['Language'],
  blacklist: [],
  readings: [{ reading: 'げんご', primary: true, accepted: true }],
});

function fakeApi(subjects: WkSubject[], opts: { blockSubmit?: boolean } = {}) {
  const submitted: { id: number; wm: number; wr: number }[] = [];
  const api: WaniKaniApi = {
    due: async () => subjects.map((s, i) => ({ id: 100 + i, subjectId: s.id, subjectType: s.object, srsStage: 2 + i })),
    subjects: async (_t, ids) => subjects.filter((s) => ids.includes(s.id)),
    submit: async (_t, id, wm, wr) => {
      if (opts.blockSubmit) throw new ApiError('WaniKani did not let me submit reviews.', 403);
      submitted.push({ id, wm, wr });
      return 5;
    },
  };
  return { api, submitted };
}

describe('kana', () => {
  it('converts romaji and katakana to hiragana', () => {
    expect(['gengo', 'gakkou', 'shinbun', 'chotto', 'onna', "kin'youbi", 'ジャンプ', 'hon'].map(toHiragana)).toEqual([
      'げんご',
      'がっこう',
      'しんぶん',
      'ちょっと',
      'おんな',
      'きんようび',
      'じゃんぷ',
      'ほん',
    ]);
    expect(readingCandidates('kinyoubi')).toEqual(['きにょうび', 'きんようび']);
  });
});

describe('grading', () => {
  it('accepts meanings with small typos and rejects blacklisted ones', () => {
    const s = subject({});
    expect(gradeMeaning('language', s)).toBe('correct');
    expect(gradeMeaning(' Word! ', s)).toBe('correct');
    expect(gradeMeaning('langauge', s)).toBe('close');
    expect(gradeMeaning('lang', s)).toBe('wrong');
    expect(gradeMeaning('speech', s)).toBe('wrong');
  });

  it('grades readings in kana or romaji and spots the other reading', () => {
    const s = subject({});
    expect(gradeReading('go', s)).toBe('correct');
    expect(gradeReading('ゴ', s)).toBe('correct');
    expect(gradeReading('kata', s)).toBe('other-reading');
    expect(gradeReading('ka', s)).toBe('wrong');
    expect(gradeReading('xyz', s)).toBe('not-kana');
  });
});

describe('review session', () => {
  const cfg = testConfig({ wanikaniToken: 'wk' });

  it('asks meaning then reading, requeues mistakes, and submits with the mistake counts', async () => {
    const store = new Store(null);
    const { api, submitted } = fakeApi([subject({}), GENGO]);
    const r = new Reviews(cfg, store, api, () => 0.99); // keep order
    const first = await r.start('telegram:1');
    expect(first).toMatch(/^🈁 WaniKani review: 2 of 2 due/);
    expect(first).toContain('1/2 · Kanji: 語\nKanji meaning?');

    expect(await r.answer('telegram:1', 'ご')).toMatch(/^That's the reading 🙂/); // no penalty
    expect(await r.answer('telegram:1', 'langauge')).toMatch(/^✅ Close enough: “Language”\.\n\n1\/2 · Kanji: 語\nKanji reading\? \(kana or romaji; WaniKani wants the on'yomi\)/);
    expect(await r.answer('telegram:1', 'kata')).toMatch(/WaniKani wants the on'yomi here/); // no penalty
    const wrong = await r.answer('telegram:1', 'ka');
    expect(wrong).toMatch(/^❌ 語 is read “ご”\./);
    expect(wrong).toContain('1/2 · Vocabulary: 言語\nVocabulary meaning?'); // the kanji comes back later

    await r.answer('telegram:1', 'language');
    const done1 = await r.answer('telegram:1', 'gengo');
    expect(done1).toContain('📤 WaniKani: Apprentice 3 → Guru 1');
    expect(done1).toContain('2/2 · Kanji: 語\nKanji reading?');

    const end = await r.answer('telegram:1', 'go');
    expect(end).toContain('🎉 Done! 2 item(s) reviewed, 1 right first time. WaniKani is up to date.');
    expect(submitted).toEqual([
      { id: 101, wm: 0, wr: 0 },
      { id: 100, wm: 0, wr: 1 },
    ]);
    expect(r.active('telegram:1')).toBe(false);
  });

  it('keeps quizzing when the token cannot submit, and can be stopped', async () => {
    const store = new Store(null);
    const { api } = fakeApi([subject({ object: 'radical', characters: '口', meanings: ['Mouth'], acceptedMeanings: ['Mouth'], readings: [] }), GENGO], { blockSubmit: true });
    const r = new Reviews(cfg, store, api, () => 0.99);
    await r.start('c');
    const reply = await r.answer('c', 'mouth');
    expect(reply).toMatch(/⚠️ WaniKani did not let me submit reviews/);
    expect(r.stop('c')).toMatch(/^⏸️ Review stopped\. 1 item\(s\)/);
  });

  it('routes plain messages to the review and leaves commands alone', async () => {
    const store = new Store(null);
    const { api } = fakeApi([GENGO]);
    const r = new Reviews(cfg, store, api);
    const agent = new Agent(cfg, store, { gemini: echoProvider('chat reply').provider }, null, () => NOW);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent), null, async () => '', undefined, r);
    expect((await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '/review' }))!.text).toContain('Vocabulary meaning?');
    expect((await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'language' }))!.text).toMatch(/^✅ Correct!/);
    expect((await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '/review stop' }))!.text).toMatch(/Review stopped/);
    expect((await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'hello' }))!.text).toBe('chat reply');
  });

  it('says when nothing is due or WaniKani is not connected', async () => {
    const store = new Store(null);
    expect(await new Reviews(cfg, store, fakeApi([]).api).start('c')).toMatch(/No WaniKani reviews are due/);
    const agent = new Agent(testConfig(), store, { gemini: echoProvider().provider });
    const ctx = { chatKey: 'c', userId: '1', agent, store, cfg: testConfig(), briefings: new Briefings(testConfig(), store, agent), status: async () => '', reviews: new Reviews(testConfig(), store) };
    expect((await runCommand('/review', ctx))!.text).toMatch(/WaniKani is not connected/);
  });
});

describe('kanji and word of the day as reviews', () => {
  it('quizzes due items first, submits them, then shows the card', async () => {
    const cfg = testConfig({ wanikaniToken: 'wk' });
    const store = new Store(null);
    const { api, submitted } = fakeApi([subject({}), GENGO]);
    const reviews = new Reviews(cfg, store, api, () => 0.99);
    const echo = echoProvider('📘 Full card');
    const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
    const jp = new JapaneseDaily(cfg, store, agent, undefined, undefined, reviews);

    const msg = await jp.daily('telegram:1');
    expect(msg).toContain("Today's kanji and word: Both are due on WaniKani");
    expect(msg).toContain('1/2 · Kanji: 語');
    expect(msg).not.toContain('📘 Full card'); // held back until answered
    expect(echo.requests[0].system).toContain('Leave out the practice question');

    await reviews.answer('telegram:1', 'language');
    const after = await reviews.answer('telegram:1', 'go');
    expect(after).toContain('📤 WaniKani:');
    expect(after).toContain('📘 Full card');
    expect(submitted).toEqual([{ id: 100, wm: 0, wr: 0 }]);
    expect(store.japaneseHistory()).toEqual({ kanji: ['語'], words: ['言語'] });
  });
});
