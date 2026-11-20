import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Channels } from '../channel';
import { runCommand } from '../commands';
import { dueLessons, findLessons, INTERVALS, recordQuiz, saveLesson, type Lesson } from '../lessons';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { runTool } from '../tools';
import { echoProvider, testConfig } from './helpers';

const GAMAN = {
  topic: '我慢する (がまんする, gaman suru): to endure / hold back',
  subject: 'Japanese vocabulary',
  asked: 'please teach me how to use gaman suru in a real sentence',
  summary: 'We covered 我慢する for putting up with something unpleasant and for holding back a want.',
  points: ['〜を我慢する: put up with ~', 'Negative 我慢できない: can\'t stand it'],
  examples: ['痛みを我慢した。(いたみをがまんした) I put up with the pain.'],
};

function lessonsFrom(...inputs: (typeof GAMAN)[]): Lesson[] {
  let id = 100;
  let list: Lesson[] = [];
  for (const i of inputs) list = saveLesson(list, i, '2026-11-20', () => id++).lessons;
  return list;
}

describe('lessons', () => {
  it('saves a lesson, and the same topic again adds to it instead of a second copy', () => {
    const first = saveLesson([], GAMAN, '2026-11-20', () => 1);
    expect(first.lesson).toMatchObject({ id: 1, stage: 0, due: '2026-11-21', taught: ['2026-11-20'] });
    const again = saveLesson(
      first.lessons,
      { ...GAMAN, topic: '我慢する（がまんする, gaman suru）: to endure / hold back', points: ['Negative 我慢できない: can\'t stand it', 'Polite request: 我慢してください'], examples: [] },
      '2026-11-25',
      () => 2,
    );
    expect(again.updated).toBe(true);
    expect(again.lessons).toHaveLength(1);
    expect(again.lesson.points).toEqual(['〜を我慢する: put up with ~', "Negative 我慢できない: can't stand it", 'Polite request: 我慢してください']);
    expect(again.lesson.taught).toEqual(['2026-11-20', '2026-11-25']);
    expect(again.lesson.due).toBe('2026-11-21'); // the quiz schedule isn't reset
  });

  it('finds lessons by kanji, kana, romaji or a word in them', () => {
    const list = lessonsFrom(GAMAN, { ...GAMAN, topic: '〜てしまう: finishing / regret', summary: 'te-shimau for regret', points: [], examples: [] });
    expect(findLessons(list, '我慢')[0].topic).toMatch(/^我慢する/);
    expect(findLessons(list, 'gaman suru')[0].topic).toMatch(/^我慢する/);
    expect(findLessons(list, 'がまん')[0].topic).toMatch(/^我慢する/);
    expect(findLessons(list, 'regret')[0].topic).toMatch(/てしまう/);
    expect(findLessons(list, 'keigo')).toEqual([]);
  });

  it('quizzes with spaced repetition: right pushes it out, wrong brings it back tomorrow', () => {
    let l = lessonsFrom(GAMAN)[0];
    expect(dueLessons([l], '2026-11-20')).toEqual([]);
    expect(dueLessons([l], '2026-11-21')).toHaveLength(1);
    l = recordQuiz(l, true, '2026-11-21');
    expect(l).toMatchObject({ stage: 1, due: '2026-11-24' }); // 3 days
    l = recordQuiz(l, true, '2026-11-24');
    expect(l.due).toBe(`2026-12-01`); // 7 days
    l = recordQuiz(l, false, '2026-12-01', 'used を instead of が');
    expect(l).toMatchObject({ stage: 0, due: '2026-12-02' });
    expect(l.quizzes.at(-1)).toEqual({ day: '2026-12-01', correct: false, note: 'used を instead of が' });
    for (let i = 0; i < 20; i++) l = recordQuiz(l, true, '2026-12-02');
    expect(l.stage).toBe(INTERVALS.length - 1);
  });
});

describe('lessons in the bot', () => {
  function setup(at = new Date('2026-11-20T05:00:00Z')) {
    const store = new Store(null);
    const cfg = testConfig({ notifyChats: ['telegram:1'], schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '', japanese: '', money: '' } });
    const echo = echoProvider('Question 1: how would you say "I put up with the noise"?');
    const clock = { now: at };
    const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => clock.now);
    const briefings = new Briefings(cfg, store, agent, () => clock.now);
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => clock.now };
    const tool = (name: string, input: unknown) => runTool(name, input, { chatKey: 'telegram:1', store, cfg, google: null, now: () => clock.now });
    return { store, cfg, echo, clock, agent, briefings, tool, command: async (text: string) => (await runCommand(text, ctx))! };
  }

  it('the AI saves, finds and grades lessons, and is told what it already taught', async () => {
    const { tool, agent, echo } = setup();
    expect((await tool('lesson_find', { query: 'gaman' })).content).toMatch(/No saved lesson about "gaman" yet/);
    const saved = await tool('lesson_save', GAMAN);
    expect(saved.content).toMatch(/^Saved lesson #\d+; first quiz due 2026-11-21\./);
    const id = Number(/#(\d+)/.exec(saved.content)![1]);
    const found = (await tool('lesson_find', { query: '我慢' })).content;
    expect(found).toContain(`#${id} 我慢する`);
    expect(found).toContain('Examples given:\n- 痛みを我慢した。');
    expect((await tool('lesson_quiz_result', { id, correct: true })).content).toBe(`Recorded (right); next quiz on #${id} due 2026-11-23.`);

    await agent.reply({ chatKey: 'telegram:1', text: 'teach me gaman suru' });
    const req = echo.requests.at(-1)!;
    expect(req.system).toContain('first check lesson_find; if you taught it before, build on it');
    expect(req.note).toContain(`Lessons you already taught this user (1): #${id} 我慢する`);
  });

  it('/lessons lists, shows and forgets lessons; /quiz quizzes without filling the history', async () => {
    const { tool, command, echo, store } = setup();
    expect((await command('/lessons')).text).toMatch(/^📚 No lessons yet/);
    await tool('lesson_save', GAMAN);
    const id = store.lessons('telegram:1')[0].id;
    expect((await command('/lessons')).text).toContain(`#${id} 我慢する (がまんする, gaman suru): to endure / hold back (2026-11-20) · next quiz 2026-11-21`);
    const shown = await command('/lessons gaman');
    expect(shown.text).toContain('• 〜を我慢する: put up with ~');
    expect(shown.buttons).toEqual([[{ label: `📝 Quiz #${id}`, command: `/quiz #${id}` }]]);

    const quiz = await command(`/quiz #${id}`);
    expect(quiz.text).toBe('Question 1: how would you say "I put up with the noise"?');
    expect(echo.requests.at(-1)!.userText).toContain('Quiz me on lessons you taught me: ask ONE short question at a time');
    expect(echo.requests.at(-1)!.userText).toContain('痛みを我慢した。');
    expect(store.history('telegram:1').map((m) => m.text)).toContain(`/quiz #${id}`);
    expect(store.history('telegram:1').map((m) => m.text)).not.toContainEqual(expect.stringContaining('ask ONE short question'));

    expect((await command(`/lessons forget ${id}`)).text).toBe(`🗑️ Deleted lesson #${id}.`);
    expect(store.lessons('telegram:1')).toEqual([]);
  });

  it('quizzes every day at the time set with /quiz daily, only when lessons are due', async () => {
    const { tool, command, cfg, store, briefings, clock, echo } = setup(new Date('2026-11-20T05:00:00Z'));
    expect((await command('/quiz daily 8pm')).text).toMatch(/Use a time like/);
    expect((await command('/quiz daily 20:00')).text).toMatch(/Every day at 20:00/);
    await tool('lesson_save', GAMAN); // first quiz due tomorrow
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'telegram', send: async (_id, text) => void sent.push(text) });
    const s = new Scheduler(cfg, store, channels, briefings, () => undefined);
    const tick = async (iso: string) => {
      clock.now = new Date(iso);
      await s.tick(clock.now);
      await new Promise((r) => setTimeout(r, 5));
    };
    await tick('2026-11-20T13:00:00Z'); // 20:00 local, nothing due yet
    expect(sent).toEqual([]);
    await tick('2026-11-21T13:00:00Z'); // the next day it's due
    expect(sent).toEqual(['Question 1: how would you say "I put up with the noise"?']);
    expect(echo.requests.at(-1)!.userText).toContain("It's the user's daily quiz time");
    expect((await command('/quiz daily off')).text).toBe('📝 Daily quiz off.');
    await tick('2026-11-22T13:00:00Z');
    expect(sent).toHaveLength(1);
  });
});
