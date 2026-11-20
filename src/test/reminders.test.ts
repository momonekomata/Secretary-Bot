import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Channels } from '../channel';
import { runCommand, type Button } from '../commands';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { runTool } from '../tools';
import { echoProvider, testConfig } from './helpers';

/** Bangkok is UTC+7: 09:00 local on 18 Nov is 02:00Z. */
const local = (day: string, hhmm: string) => new Date(`2026-11-${day}T${hhmm}:00+07:00`);

function setup(now: { at: Date }) {
  const store = new Store(null);
  const cfg = testConfig({ schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '', japanese: '' } });
  const sent: { text: string; buttons?: Button[][] }[] = [];
  const channels = new Channels();
  channels.add({ prefix: 'telegram', send: async (_id, text, buttons) => void sent.push({ text, buttons }) });
  const scheduler = new Scheduler(cfg, store, channels, null, () => undefined);
  const tool = (name: string, input: unknown) => runTool(name, input, { chatKey: 'telegram:1', store, cfg, google: null, now: () => now.at });
  const agent = new Agent(cfg, store, { gemini: echoProvider('x').provider }, null, () => now.at);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings: new Briefings(cfg, store, agent, () => now.at), status: async () => '', now: () => now.at };
  const tick = async (at: Date) => {
    now.at = at;
    await scheduler.tick(at);
  };
  return { store, sent, tool, tick, command: (text: string) => runCommand(text, ctx) };
}

describe('reminders that follow up until done', () => {
  it('keeps reminding every hour until marked done, then starts again the next morning', async () => {
    const now = { at: local('18', '08:00') };
    const { store, sent, tool, tick } = setup(now);
    const set = await tool('set_reminder', { at: '2026-11-18T09:00:00+07:00', text: 'Take your vitamins 💊', repeat: 'daily', until_done: true });
    expect(set.content).toMatch(/following up every 60 min until marked done \(not after 21:00\)/);

    await tick(local('18', '09:00'));
    await tick(local('18', '09:30')); // nothing due
    await tick(local('18', '10:00'));
    expect(sent.map((m) => m.text)).toEqual(['⏰ Take your vitamins 💊', '⏰ Take your vitamins 💊']);
    expect(sent[0].buttons).toEqual([[{ label: '✅ Done', command: '/rdone 1' }]]);

    now.at = local('18', '10:20');
    const done = await tool('reminder_done', { id: 1 });
    expect(done.content).toMatch(/Marked #1 done for today/);
    expect(store.reminders()[0]).toMatchObject({ dueAt: local('19', '09:00').toISOString(), doneDays: ['2026-11-18'] });

    await tick(local('18', '11:00'));
    await tick(local('18', '15:00'));
    expect(sent).toHaveLength(2); // no more today
    await tick(local('19', '09:00'));
    expect(sent).toHaveLength(3); // tomorrow it starts again
    expect(store.reminders()[0].dueAt).toBe(local('19', '10:00').toISOString());
  });

  it('stops for the day at the stop time and moves to the next morning', async () => {
    const now = { at: local('18', '18:00') };
    const { store, sent, tool, tick } = setup(now);
    await tool('set_reminder', { at: '2026-11-18T19:00:00+07:00', text: 'Vitamins', repeat: 'daily', until_done: true, every_minutes: 90, stop_at: '21:00' });
    await tick(local('18', '19:00'));
    await tick(local('18', '20:30'));
    expect(sent).toHaveLength(2);
    expect(store.reminders()[0].dueAt).toBe(local('19', '19:00').toISOString()); // 22:00 would be past 21:00
  });

  it('a once-only until-done reminder ends when done', async () => {
    const now = { at: local('18', '08:00') };
    const { store, tool, tick } = setup(now);
    await tool('set_reminder', { at: '2026-11-18T09:00:00+07:00', text: 'Call the bank', repeat: 'none', until_done: true });
    await tick(local('18', '09:00'));
    now.at = local('18', '09:15');
    await tool('reminder_done', { id: 1 });
    expect(store.reminders()).toEqual([]);
  });

  it('the Done button and /reminders record it, and the AI sees the record', async () => {
    const now = { at: local('16', '08:00') };
    const { tool, tick, command } = setup(now);
    await tool('set_reminder', { at: '2026-11-16T09:00:00+07:00', text: 'Take your vitamins', repeat: 'daily', until_done: true });
    for (const day of ['16', '17']) {
      await tick(local(day, '09:00'));
      now.at = local(day, '09:05');
      expect((await command('/rdone 1'))!.text).toMatch(/^✅ Noted: Take your vitamins — done today\. No more reminders about it today; next: /);
    }
    await tick(local('18', '09:00'));

    const list = (await command('/reminders'))!;
    expect(list.text).toContain('#1 Take your vitamins');
    expect(list.text).toContain('⬜ not done today · done 2 of the last 14 days (11-16, 11-17)');
    expect(list.buttons).toEqual([[{ label: '✅ #1 done today', command: '/rdone 1' }]]);

    const seen = (await tool('list_reminders', {})).content;
    expect(seen).toMatch(/done today: no; done on 2 of the last 14 days \(11-16, 11-17\); last done 2026-11-17/);
    expect((await command('/rdone 99'))!.text).toMatch(/No reminder #99/);
  });

  it('records earlier days the user mentions, but not future or impossible ones', async () => {
    const now = { at: local('20', '10:00') };
    const { store, tool } = setup(now);
    await tool('set_reminder', { at: '2026-11-21T09:00:00+07:00', text: 'Vitamins', repeat: 'daily', until_done: true });
    const r = await tool('reminder_done', { id: 1, days: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-21', '2026-02-30'] });
    expect(r.content).toMatch(/^Marked #1 done for 2026-11-16, 2026-11-17, 2026-11-18\. Not recorded \(future, too old or not a date\): 2026-11-21, 2026-02-30\./);
    expect(store.reminders()[0]).toMatchObject({ doneDays: ['2026-11-16', '2026-11-17', '2026-11-18'], dueAt: local('21', '09:00').toISOString() });
    expect((await tool('reminder_done', { id: 1, days: ['2026-12-01'] })).isError).toBe(true);
  });

  it('keeps the record when a reminder is changed or cancelled', async () => {
    const now = { at: local('18', '08:00') };
    const { store, tool, command } = setup(now);
    await tool('set_reminder', { at: '2026-11-18T09:00:00+07:00', text: 'Vitamins', repeat: 'daily', until_done: true });
    await tool('reminder_done', { id: 1 });
    now.at = local('19', '08:00');
    await tool('reminder_done', { id: 1 });

    // Changing the time: the new reminder carries the record over.
    now.at = local('20', '07:00');
    const changed = await tool('set_reminder', { at: '2026-11-20T08:00:00+07:00', text: 'Vitamins', repeat: 'daily', until_done: true, replaces: 1 });
    expect(changed.content).toMatch(/It replaces #1; its 2 recorded day\(s\) done carried over\./);
    expect(store.reminders()).toMatchObject([{ id: 2, doneDays: ['2026-11-18', '2026-11-19'] }]);

    // Cancelling keeps it too, and the AI and /reminders still see it.
    expect((await tool('cancel_reminder', { id: 2 })).content).toBe('Cancelled reminder #2.');
    expect(store.reminders()).toEqual([]);
    expect((await tool('list_reminders', {})).content).toMatch(/Ended reminders, kept for their record:\n#2 \(ended .*\): Vitamins; done on 2 of the last 14 days \(11-18, 11-19\)/);
    expect((await command('/reminders'))!.text).toContain('#2 Vitamins (ended): done 2 of the last 14 days (11-18, 11-19)');
  });

  it('plain reminders still have no button', async () => {
    const now = { at: local('18', '08:00') };
    const { sent, tool, tick } = setup(now);
    await tool('set_reminder', { at: '2026-11-18T09:00:00+07:00', text: 'Stand-up', repeat: 'none' });
    await tick(local('18', '09:00'));
    expect(sent).toEqual([{ text: '⏰ Stand-up', buttons: undefined }]);
  });
});
