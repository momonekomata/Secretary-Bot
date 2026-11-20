import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Channels } from '../channel';
import { characterPrompt, editCharacter, isBirthday, MAX_ITEM, parseBirthday, type Character } from '../character';
import { runCommand } from '../commands';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { runTool } from '../tools';
import { echoProvider, testConfig } from './helpers';

/** Made-up character details only. */
function setup(now = new Date('2026-11-20T03:00:00Z')) {
  const store = new Store(null);
  const cfg = testConfig({ notifyChats: ['telegram:1'], schedule: { ...testConfig().schedule, briefing: '09:00', weather: '', weekend: '', cleanup: '', japanese: '', money: '' } });
  const echo = echoProvider('Happy birthday to me! 🎂');
  const clock = { now };
  const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => clock.now);
  const briefings = new Briefings(cfg, store, agent, () => clock.now);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => clock.now };
  const tool = (name: string, input: unknown) => runTool(name, input, { chatKey: 'telegram:1', store, cfg, google: null, now: () => clock.now });
  return { store, cfg, echo, clock, agent, briefings, tool, command: async (text: string) => (await runCommand(text, ctx))!.text };
}

describe('character sheet', () => {
  it('reads birthdays written in different ways', () => {
    expect(['03-03', '2007-03-03', '3 March', 'March 3rd', 'mar 3', '3 มีนาคม', '3 มี.ค.'].map(parseBirthday)).toEqual(Array(7).fill('03-03'));
    expect(parseBirthday('29 Feb')).toBe('02-29');
    expect(['31 February', '13-01', 'someday', ''].map(parseBirthday)).toEqual([null, null, null, null]);
  });

  it('adds, replaces, removes and clears items within the limits', () => {
    let c: Character = {};
    const apply = (e: Parameters<typeof editCharacter>[1]) => {
      const r = editCharacter(c, e);
      if ('error' in r) return r.error;
      c = r.character;
      return 'ok';
    };
    apply({ action: 'add', section: 'likes', text: 'sweet potatoes' });
    apply({ action: 'add', section: 'likes', text: 'rainy  days' });
    apply({ action: 'add', section: 'likes', text: 'Sweet potatoes' }); // already there
    expect(c.likes).toEqual(['sweet potatoes', 'rainy days']);
    apply({ action: 'remove', section: 'likes', number: 1 });
    expect(c.likes).toEqual(['rainy days']);
    expect(apply({ action: 'remove', section: 'likes', number: 5 })).toMatch(/no item 5 under likes/);
    apply({ action: 'set', section: 'looks', text: 'fluffy orange hair and a curled tail' });
    apply({ action: 'add', section: 'birthday', text: 'March 3' });
    apply({ action: 'add', section: 'birthday', text: '5 May' }); // one birthday only
    expect(c.birthday).toEqual(['05-05']);
    expect(apply({ action: 'add', section: 'birthday', text: 'soon' })).toMatch(/isn't a date/);
    expect(apply({ action: 'add', section: 'quirks', text: 'x'.repeat(MAX_ITEM + 1) })).toMatch(/too long/);
    for (let i = 0; i < 10; i++) apply({ action: 'add', section: 'backstory', text: `${i} ${'y'.repeat(380)}` });
    expect(apply({ action: 'add', section: 'backstory', text: 'z'.repeat(390) })).toMatch(/over 4000 characters/);
    apply({ action: 'clear', section: 'backstory' });
    expect(c.backstory).toBeUndefined();
    apply({ action: 'clear', section: 'all' });
    expect(c).toEqual({});
  });

  it('is edited with /character, and kept when the personality changes', async () => {
    const { store, command } = setup();
    expect(await command('/character')).toMatch(/has no character sheet yet/);
    await command('/character add likes sweet potatoes');
    await command('/character add dislike thunder');
    await command('/character set birthday 3 March');
    expect(await command('/character add quirks says "woof!" when excited')).toMatch(/^✅ Saved\./);
    const sheet = await command('/character');
    expect(sheet).toContain('🎂 Birthday: 3 March');
    expect(sheet).toContain('💖 Likes (likes):\n1. sweet potatoes');
    expect(sheet).toContain('💢 Dislikes (dislikes):\n1. thunder');
    expect(await command('/character remove likes 1')).not.toContain('1. sweet potatoes');
    expect(await command('/character add wings big ones')).toMatch(/"wings" isn't a section/);
    expect(await command('/character paint likes x')).toMatch(/Use add, set, remove or clear/);

    await command('/persona butler');
    await command('/persona a cheerful shiba-inu girl who calls me master');
    expect(store.settings().character).toEqual({ dislikes: ['thunder'], birthday: ['03-03'], quirks: ['says "woof!" when excited'] });
  });

  it('goes into the AI instructions, and the AI can edit it', async () => {
    const { store, tool, agent, echo } = setup();
    expect(characterPrompt({})).toBe('');
    const r = await tool('character_update', { section: 'looks', action: 'add', text: 'cat ears that twitch when curious' });
    expect(r.content).toBe('Character sheet updated. looks: 1. cat ears that twitch when curious');
    expect((await tool('character_update', { section: 'feet', action: 'add', text: 'x' })).isError).toBe(true);
    expect(store.settings().character).toEqual({ looks: ['cat ears that twitch when curious'] });

    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests.at(-1)!.system).toContain('Your character sheet: these facts about you are true in every personality');
    expect(echo.requests.at(-1)!.system).toContain('Looks:\n- cat ears that twitch when curious');
    // The prompt is rebuilt when the sheet changes.
    await tool('character_update', { section: 'birthday', action: 'set', text: '2026-11-20' });
    await agent.reply({ chatKey: 'telegram:1', text: 'hi again' });
    expect(echo.requests.at(-1)!.system).toContain('Birthday: 20 November');
    expect(echo.requests.at(-1)!.note).toContain('Today is your birthday');
  });

  it('knows its birthday, including 29 February in other years', () => {
    expect(isBirthday({ birthday: ['11-20'] }, new Date('2026-11-20T03:00:00Z'), 'Asia/Bangkok')).toBe(true);
    expect(isBirthday({ birthday: ['11-20'] }, new Date('2026-11-19T18:00:00Z'), 'Asia/Bangkok')).toBe(true); // 01:00 local on the 20th
    expect(isBirthday({ birthday: ['11-20'] }, new Date('2026-11-19T03:00:00Z'), 'Asia/Bangkok')).toBe(false);
    expect(isBirthday({ birthday: ['02-29'] }, new Date('2027-02-28T03:00:00Z'), 'Asia/Bangkok')).toBe(true);
    expect(isBirthday({ birthday: ['02-29'] }, new Date('2028-02-28T03:00:00Z'), 'Asia/Bangkok')).toBe(false);
    expect(isBirthday(undefined, new Date(), 'Asia/Bangkok')).toBe(false);
  });

  it('sends a birthday message in character on its birthday, and nothing on other days', async () => {
    const { store, cfg, briefings, clock } = setup(new Date('2026-11-20T02:00:00Z')); // 09:00 local
    store.updateSettings({ character: { birthday: ['11-20'] } });
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'telegram', send: async (_id, text) => void sent.push(text) });
    const s = new Scheduler(cfg, store, channels, briefings, () => undefined);
    briefings.morning = async () => 'briefing';
    await s.tick(clock.now);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.filter((x) => x.startsWith('Happy birthday to me!'))).toHaveLength(1);

    sent.length = 0;
    store.updateSettings({ character: { birthday: ['11-21'] } });
    clock.now = new Date('2026-11-21T02:00:00Z');
    store.updateSettings({ character: { birthday: ['12-01'] } });
    await s.tick(clock.now);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.filter((x) => x.startsWith('Happy birthday'))).toEqual([]);
  });
});
