import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { Agent, type CreateMessage } from './agent';
import { Channels, handleCommand } from './channel';
import { chunkText } from './chunk';
import { config } from './config';
import { verifyLineSignature } from './line';
import { localClock, nudgeText, Scheduler } from './scheduler';
import { Store } from './store';
import { runTool } from './tools';

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;

const NOW = new Date('2026-11-07T10:00:00Z'); // 17:00 in Bangkok
const cfg = { ...config, timezone: 'Asia/Bangkok', wanikaniToken: '', historyLimit: 6 };

function msg(stop: Message['stop_reason'], content: unknown[]): Message {
  return { id: 'm', type: 'message', role: 'assistant', model: cfg.model, stop_reason: stop, content } as unknown as Message;
}

/** A fake Claude that replays scripted responses and records each request (deep-copied). */
function fakeClaude(responses: Message[]) {
  const calls: Params[] = [];
  const create: CreateMessage = async (p) => {
    calls.push(structuredClone(p));
    const r = responses.shift();
    if (!r) throw new Error('no more scripted responses');
    return r;
  };
  return { create, calls };
}

describe('Agent', () => {
  it('runs a tool call, then replies, and stores only text history', async () => {
    const store = new Store(null);
    const { create, calls } = fakeClaude([
      msg('tool_use', [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'set_reminder', input: { at: '2026-11-07T21:00:00+07:00', text: 'Do your reviews!' } },
      ]),
      msg('end_turn', [{ type: 'text', text: 'Done, I will ping you at 9pm.' }]),
    ]);
    const agent = new Agent(cfg, store, create, () => NOW);

    const reply = await agent.reply({ chatKey: 'telegram:1', text: 'remind me at 9pm to do reviews' });

    expect(reply).toBe('Done, I will ping you at 9pm.');
    expect(store.reminders('telegram:1')).toMatchObject([{ text: 'Do your reviews!', dueAt: '2026-11-07T14:00:00.000Z' }]);

    // Request shape: new user turn followed by the per-turn system note; fallbacks opted in.
    const first = calls[0];
    expect(first.model).toBe(cfg.model);
    expect(first.fallbacks).toBe('default');
    expect(first.betas).toContain('server-side-fallback-2026-07-01');
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(JSON.stringify(first.messages[1].content)).toContain('17:00');

    // Second request appends to the first: same prefix, then assistant turn and tool result.
    const second = calls[1];
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(second.messages[3].content).toMatchObject([{ type: 'tool_result', tool_use_id: 't1' }]);
    expect(second.system).toBe(first.system);

    expect(store.history('telegram:1')).toEqual([
      { role: 'user', text: 'remind me at 9pm to do reviews' },
      { role: 'assistant', text: 'Done, I will ping you at 9pm.' },
    ]);
  });

  it('replays earlier turns as text and includes memories in the note', async () => {
    const store = new Store(null);
    store.addMemory('line:U1', 'JLPT N4 exam on 6 December');
    store.appendExchange('line:U1', 'hi', 'hello!', 10);
    const { create, calls } = fakeClaude([msg('end_turn', [{ type: 'text', text: 'おはよう' }])]);
    await new Agent(cfg, store, create, () => NOW).reply({ chatKey: 'line:U1', text: 'good morning in Japanese?' });

    const m = calls[0].messages;
    expect(m.slice(0, 2)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ]);
    expect(JSON.stringify(m.at(-1))).toContain('JLPT N4');
  });

  it('answers a refusal politely and continues a paused turn', async () => {
    const store = new Store(null);
    const refused = fakeClaude([msg('refusal', [])]);
    expect(await new Agent(cfg, store, refused.create).reply({ chatKey: 'telegram:2', text: 'x' })).toMatch(/can't help/);

    const paused = fakeClaude([
      msg('pause_turn', [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }]),
      msg('end_turn', [{ type: 'text', text: 'Found it.' }]),
    ]);
    expect(await new Agent(cfg, store, paused.create).reply({ chatKey: 'telegram:3', text: 'search' })).toBe('Found it.');
    expect(paused.calls[1].messages.at(-1)?.role).toBe('assistant');
  });

  it('handles messages from one chat one at a time', async () => {
    const store = new Store(null);
    let active = 0;
    let maxActive = 0;
    const create: CreateMessage = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return msg('end_turn', [{ type: 'text', text: 'ok' }]);
    };
    const agent = new Agent(cfg, store, create);
    await Promise.all([agent.reply({ chatKey: 'c:1', text: 'a' }), agent.reply({ chatKey: 'c:1', text: 'b' })]);
    expect(maxActive).toBe(1);
    expect(store.history('c:1').map((t) => t.text)).toEqual(['a', 'ok', 'b', 'ok']);
  });
});

describe('tools', () => {
  const ctx = (store: Store) => ({ chatKey: 'telegram:1', store, timezone: 'Asia/Bangkok', wanikaniToken: '', now: () => NOW });

  it('rejects past or unparseable reminder times', async () => {
    const store = new Store(null);
    expect((await runTool('set_reminder', { at: '2026-11-07T09:00:00Z', text: 'x' }, ctx(store))).isError).toBe(true);
    expect((await runTool('set_reminder', { at: 'tomorrow', text: 'x' }, ctx(store))).isError).toBe(true);
    expect(store.reminders()).toEqual([]);
  });

  it('remembers, lists via the store, and forgets', async () => {
    const store = new Store(null);
    await runTool('remember', { text: 'Likes matcha' }, ctx(store));
    const [m] = store.memories('telegram:1');
    expect(m.text).toBe('Likes matcha');
    expect((await runTool('forget', { id: m.id }, ctx(store))).isError).toBeUndefined();
    expect(store.memories('telegram:1')).toEqual([]);
  });

  it('reports a missing WaniKani token as a tool error', async () => {
    expect((await runTool('get_wanikani_status', {}, ctx(new Store(null)))).isError).toBe(true);
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

describe('scheduler', () => {
  it('delivers due reminders once', async () => {
    const store = new Store(null);
    store.addReminder('test:42', 'Stretch!', new Date(NOW.getTime() - 1000));
    store.addReminder('test:42', 'Later', new Date(NOW.getTime() + 3_600_000));
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'test', send: async (id, text) => void sent.push(`${id}:${text}`) });
    const s = new Scheduler(cfg, store, channels, () => undefined);
    await s.tick(NOW);
    await s.tick(NOW);
    expect(sent).toEqual(['42:⏰ Stretch!']);
    expect(store.reminders().map((r) => r.text)).toEqual(['Later']);
  });

  it('computes local hour and day', () => {
    expect(localClock(NOW, 'Asia/Bangkok')).toEqual({ hour: 17, day: '2026-11-07' });
    expect(localClock(new Date('2026-11-07T20:00:00Z'), 'Asia/Tokyo')).toEqual({ hour: 5, day: '2026-11-08' });
  });

  it('only nudges when there is work', () => {
    expect(nudgeText(0, 0, 5)).toBeNull();
    expect(nudgeText(3, 1, 5)).toContain('1 review and 3 lessons');
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

  it('chunks long text under the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'あ'.repeat(30)}`).join('\n');
    const parts = chunkText(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join('\n')).toBe(text);
    expect(chunkText('あ'.repeat(450), 200).map((p) => p.length)).toEqual([200, 200, 50]);
  });

  it('handles shared commands', () => {
    const store = new Store(null);
    store.appendExchange('telegram:1', 'a', 'b', 10);
    const agent = new Agent(cfg, store, async () => msg('end_turn', []));
    expect(handleCommand('/reset', 'telegram:1', '1', agent)).toMatch(/cleared/);
    expect(store.history('telegram:1')).toEqual([]);
    expect(handleCommand('/id@MyBot', 'telegram:1', '99', agent)).toContain('99');
    expect(handleCommand('hello', 'telegram:1', '1', agent)).toBeNull();
  });
});
