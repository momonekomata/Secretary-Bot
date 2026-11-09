import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Channels, Secretary, type IncomingMessage } from '../channel';
import { chunkText } from '../chunk';
import { runCommand, settingsView } from '../commands';
import type { Config } from '../config';
import { quickReply, verifyLineSignature } from '../line';
import { isDue, nudgeText, Scheduler } from '../scheduler';
import { Store } from '../store';
import { inlineKeyboard } from '../telegram';
import { localClock } from '../time';
import { NOW, echoProvider, fakeGemini, geminiRes, testConfig } from './helpers';

function setup(cfg: Config = testConfig()) {
  const store = new Store(null);
  const echo = echoProvider('agent reply');
  const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => 'all good', now: () => NOW };
  return { store, agent, briefings, ctx, echo, cfg };
}

describe('commands', () => {
  it('switches model, effort and translation language from /settings buttons', async () => {
    const { ctx, store, agent } = setup();
    const view = settingsView(ctx);
    expect(view.text).toContain('Gemini 3.8 Flash');
    const claudeButton = view.buttons!.flat().find((b) => b.command === '/model claude-sonnet-5-5')!;
    expect(claudeButton.label).toContain('(no key)');

    const r = await runCommand(claudeButton.command, ctx);
    expect(r!.text).toMatch(/Model set to ✍️ Claude Sonnet 5.5\. ⚠️ No ANTHROPIC_API_KEY/);
    expect(agent.model).toBe('claude-sonnet-5-5');
    await runCommand('/effort high', ctx);
    await runCommand('/translate Thai', ctx);
    expect(store.settings()).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', translateTo: 'Thai' });
    expect((await runCommand('/effort extreme', ctx))!.text).toMatch(/Use \/effort/);
  });

  it('manages to-dos and news topics', async () => {
    const { ctx, store } = setup();
    const added = await runCommand('/add Call the dentist', ctx);
    const id = store.todos('telegram:1')[0].id;
    expect(added!.text).toBe(`➕ Added #${id}: Call the dentist`);
    expect((await runCommand('/todo', ctx))!.text).toContain(`#${id} Call the dentist`);
    expect((await runCommand(`/done ${id}`, ctx))!.text).toBe('✅ Done: Call the dentist');

    await runCommand('/addtopic Renewable Energy', ctx);
    expect((await runCommand('/topics', ctx))!.text).toContain('4. Renewable Energy');
    await runCommand('/remotopic 1', ctx); // Gemini's spelling works too
    expect(store.settings().newsTopics).toEqual(['Global Economy', 'Thailand', 'Renewable Energy']);
  });

  it('says how to connect Google when it is not connected, and ignores non-commands', async () => {
    const { ctx } = setup();
    expect((await runCommand('/calendar', ctx))!.text).toMatch(/google-auth/);
    expect(await runCommand('hello', ctx)).toBeNull();
    expect(await runCommand('/unknown', ctx)).toBeNull();
  });

  it('archives usage with /cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-'));
    const { ctx, store } = setup(testConfig({ dataDir: dir }));
    store.addUsage({ ts: '2026-01-01T00:00:00Z', kind: 'chat', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost: 0.1 });
    const r = await runCommand('/cleanup', ctx);
    expect(r!.text).toMatch(/Archived 1 usage log rows/);
    expect(r!.file!.name).toMatch(/^usage_before_2026-11-07_\d+\.csv\.gz$/);
  });
});

describe('Secretary (shared message handling)', () => {
  const msg = (over: Partial<IncomingMessage>): IncomingMessage => ({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '', ...over });

  it('enforces the allowlist and helps first-time setup', async () => {
    const { cfg, store, agent, briefings } = setup();
    const s = new Secretary(cfg, store, agent, briefings, null, async () => '');
    expect(await s.handle(msg({ userId: '2', text: 'hi' }))).toBeNull();
    expect((await s.handle(msg({ userId: '2', text: '/id' })))!.text).toContain('Your user id: 2');
    const open = new Secretary({ ...cfg, telegram: { ...cfg.telegram, allowedUsers: [] } }, store, agent, briefings, null, async () => '');
    expect((await open.handle(msg({ userId: '7', text: 'hi' })))!.text).toMatch(/user id is 7/);
    expect((await s.handle(msg({ text: 'hi' })))!.text).toBe('agent reply');
  });

  it('transcribes voice notes with Gemini and hands them to the agent', async () => {
    const { cfg, store, agent, briefings, echo } = setup();
    const { generate } = fakeGemini([geminiRes([{ text: JSON.stringify({ language: 'Thai', transcript: 'ซื้อนม', translation: 'Buy milk' }) }])]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    const r = await s.handle(msg({ audio: { mimeType: 'audio/ogg', data: 'AAAA' } }));
    expect(r!.text).toBe('🎙️ Voice note (Thai)\n📝 ซื้อนม\n🌐 English: Buy milk\n\nagent reply');
    expect(echo.requests[0].userText).toContain('Transcript: ซื้อนม');
    expect(store.usage().map((u) => u.kind)).toEqual(['voice', 'voice']);

    const noKey = new Secretary(cfg, store, agent, briefings, null, async () => '');
    expect((await noKey.handle(msg({ audio: { mimeType: 'audio/ogg', data: 'A' } })))!.text).toMatch(/GEMINI_API_KEY/);
  });
});

describe('scheduler', () => {
  it('fires daily jobs once, within a grace window, on the right weekday', () => {
    const tz = 'Asia/Bangkok';
    const job = { key: 'x', at: '17:00', run: async () => undefined };
    expect(isDue(job, NOW, tz, undefined)).toBe(true); // Sat 17:00 local
    expect(isDue(job, NOW, tz, '2026-11-07')).toBe(false); // already ran today
    expect(isDue({ ...job, at: '08:00' }, NOW, tz, undefined)).toBe(false); // too late
    expect(isDue({ ...job, weekday: 'fri' }, NOW, tz, undefined)).toBe(false);
    expect(isDue({ ...job, weekday: 'sat' }, NOW, tz, undefined)).toBe(true);
    expect(isDue({ ...job, at: '' }, NOW, tz, undefined)).toBe(false);
  });

  it('delivers due reminders and scheduled briefings to notify chats', async () => {
    const cfg = testConfig({ notifyChats: ['test:42'], schedule: { ...testConfig().schedule, weather: '17:00', briefing: '', weekend: '', cleanup: '' } });
    const { store, briefings } = setup(cfg);
    store.addReminder('test:42', 'Stretch!', new Date(NOW.getTime() - 1000));
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'test', send: async (id, text) => void sent.push(`${id}:${text}`) });
    const weatherCalls: string[] = [];
    briefings.weatherReport = async () => (weatherCalls.push('w'), 'Sunny');
    const s = new Scheduler(cfg, store, channels, briefings, () => undefined);
    await s.tick(NOW);
    await new Promise((r) => setTimeout(r, 5));
    await s.tick(NOW);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual(['42:⏰ Stretch!', '42:Sunny']);
    expect(weatherCalls).toHaveLength(1);
  });

  it('only nudges when there is work', () => {
    expect(nudgeText(0, 0, 5)).toBeNull();
    expect(nudgeText(3, 1, 5)).toContain('1 review and 3 lessons');
  });

  it('computes local clock parts', () => {
    expect(localClock(NOW, 'Asia/Bangkok')).toEqual({ hour: 17, minute: 0, day: '2026-11-07', weekday: 'sat' });
    expect(localClock(new Date('2026-11-07T20:30:00Z'), 'Asia/Tokyo')).toMatchObject({ hour: 5, minute: 30, day: '2026-11-08', weekday: 'sun' });
  });
});

describe('platform helpers', () => {
  it('verifies LINE signatures', () => {
    const body = '{"events":[]}';
    const sig = createHmac('sha256', 'secret').update(body).digest('base64');
    expect(verifyLineSignature('secret', body, sig)).toBe(true);
    expect(verifyLineSignature('secret', body + ' ', sig)).toBe(false);
    expect(verifyLineSignature('secret', body, undefined)).toBe(false);
  });

  it('turns buttons into Telegram keyboards and LINE quick replies', () => {
    const buttons = [[{ label: '⚡ Gemini 3.8 Flash and a very long label', command: '/model gemini-3.8-flash' }]];
    expect(inlineKeyboard(buttons)).toEqual({ inline_keyboard: [[{ text: buttons[0][0].label, callback_data: '/model gemini-3.8-flash' }]] });
    expect(quickReply(buttons)!.items[0].action).toEqual({ type: 'message', label: '⚡ Gemini 3.8 Flash a', text: '/model gemini-3.8-flash' });
    expect(Array.from(quickReply([[{ label: '✍️'.repeat(15), command: '/x' }]])!.items[0].action.label)).toHaveLength(20);
    expect(inlineKeyboard([])).toBeUndefined();
  });

  it('chunks long text under the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'あ'.repeat(30)}`).join('\n');
    const parts = chunkText(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join('\n')).toBe(text);
    expect(chunkText('あ'.repeat(450), 200).map((p) => p.length)).toEqual([200, 200, 50]);
  });
});

describe('store', () => {
  it('trims history from the front and keeps it starting with a user turn', () => {
    const s = new Store(null);
    for (let i = 0; i < 5; i++) s.appendExchange('k', `u${i}`, `a${i}`, 5);
    const h = s.history('k');
    expect(h[0].role).toBe('user');
    expect(h.length).toBeLessThanOrEqual(5);
    expect(h.at(-1)).toEqual({ role: 'assistant', text: 'a4' });
  });
});
