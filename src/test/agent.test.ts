import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { ClaudeProvider } from '../llm/claude';
import { GeminiProvider } from '../llm/gemini';
import { costOf, modelInfo } from '../models';
import { Store } from '../store';
import { NOW, claudeMsg, echoProvider, fakeClaude, fakeGemini, geminiRes, testConfig } from './helpers';

describe('Claude provider', () => {
  it('runs a tool call, then replies, and stores only text history', async () => {
    const store = new Store(null);
    store.updateSettings({ model: 'claude-opus-5-5' });
    const { create, calls } = fakeClaude([
      claudeMsg('tool_use', [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'set_reminder', input: { at: '2026-11-07T21:00:00+07:00', text: 'Do your reviews!' } },
      ]),
      claudeMsg('end_turn', [{ type: 'text', text: 'Done, I will ping you at 9pm.' }]),
    ]);
    const agent = new Agent(testConfig(), store, { claude: new ClaudeProvider(create) }, null, () => NOW);

    expect(await agent.reply({ chatKey: 'telegram:1', text: 'remind me at 9pm to do reviews' })).toBe('Done, I will ping you at 9pm.');
    expect(store.reminders('telegram:1')).toMatchObject([{ text: 'Do your reviews!', dueAt: '2026-11-07T14:00:00.000Z' }]);

    const [first, second] = calls;
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.fallbacks).toBe('default');
    expect(first.betas).toContain('server-side-fallback-2026-07-01');
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(JSON.stringify(first.messages[1].content)).toContain('17:00');
    // Append-only within the turn.
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(second.messages[3].content).toMatchObject([{ type: 'tool_result', tool_use_id: 't1' }]);
    expect(second.system).toBe(first.system);

    expect(store.history('telegram:1')).toEqual([
      { role: 'user', text: 'remind me at 9pm to do reviews' },
      { role: 'assistant', text: 'Done, I will ping you at 9pm.' },
    ]);
    // Two calls of 1000 in / 100 out on Opus 5.5 = 2 * (1000*4 + 100*20) / 1e6.
    expect(store.usage()).toHaveLength(2);
    expect(store.usage().reduce((s, u) => s + u.cost, 0)).toBeCloseTo(0.012, 6);
  });

  it('answers a refusal politely and continues a paused turn', async () => {
    const store = new Store(null);
    store.updateSettings({ model: 'claude-sonnet-5-5' });
    const refused = fakeClaude([claudeMsg('refusal', [])]);
    expect(await new Agent(testConfig(), store, { claude: new ClaudeProvider(refused.create) }).reply({ chatKey: 'c:2', text: 'x' })).toMatch(/can't help/);

    const paused = fakeClaude([
      claudeMsg('pause_turn', [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }]),
      claudeMsg('end_turn', [{ type: 'text', text: 'Found it.' }]),
    ]);
    expect(await new Agent(testConfig(), store, { claude: new ClaudeProvider(paused.create) }).reply({ chatKey: 'c:3', text: 's' })).toBe('Found it.');
    expect(paused.calls[1].messages.at(-1)?.role).toBe('assistant');
  });
});

describe('Gemini provider', () => {
  it('calls functions, sends the model turn back unchanged, and replies', async () => {
    const store = new Store(null);
    const modelTurn = [{ functionCall: { id: 'f1', name: 'todo_add', args: { title: 'Buy milk' } }, thoughtSignature: 'abc' }];
    const { generate, calls } = fakeGemini([geminiRes(modelTurn), geminiRes([{ text: 'Added it.' }])]);
    const agent = new Agent(testConfig(), store, { gemini: new GeminiProvider(generate) }, null, () => NOW);

    expect(await agent.reply({ chatKey: 'telegram:1', text: 'add buy milk' })).toBe('Added it.');
    expect(store.todos('telegram:1').map((t) => t.title)).toEqual(['Buy milk']);

    const [first, second] = calls;
    expect(first.model).toBe('gemini-3.8-flash');
    expect(first.config?.thinkingConfig?.thinkingLevel).toBe('MEDIUM');
    const userParts = (first.contents as { parts: { text?: string }[] }[])[0].parts;
    expect(userParts[0].text).toBe('add buy milk');
    expect(userParts[1].text).toContain('17:00'); // the per-turn note rides at the end of the user turn
    const contents = second.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]).toEqual({ role: 'model', parts: modelTurn });
    expect(contents[2].parts[0]).toMatchObject({ functionResponse: { id: 'f1', name: 'todo_add' } });
    // Thinking tokens count as output: 2 * (1000 * 0.75 + 150 * 3.75) / 1e6
    expect(store.usage().reduce((s, u) => s + u.cost, 0)).toBeCloseTo(0.002625, 6);
  });

  it('searches the web with Google Search grounding in a separate request', async () => {
    const store = new Store(null);
    const grounded = {
      ...geminiRes([{ text: 'The SET index closed at 1,420 today.' }]),
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'The SET index closed at 1,420 today.' }] },
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['SET index today'], groundingChunks: [{ web: { uri: 'https://example.com/set', title: 'example.com' } }] },
        },
      ],
    } as unknown as ReturnType<typeof geminiRes>;
    const { generate, calls } = fakeGemini([
      geminiRes([{ functionCall: { id: 'w1', name: 'web_search', args: { query: 'SET index today' } } }]),
      grounded,
      geminiRes([{ text: 'It closed at 1,420.' }]),
    ]);
    const agent = new Agent(testConfig(), store, { gemini: new GeminiProvider(generate) }, null, () => NOW);
    expect(await agent.reply({ chatKey: 'c', text: 'How did the Thai stock market do today?' })).toBe('It closed at 1,420.');

    const decls = (calls[0].config?.tools?.[0] as { functionDeclarations: { name: string }[] }).functionDeclarations.map((d) => d.name);
    expect(decls).toEqual(expect.arrayContaining(['web_search', 'read_webpage', 'get_news']));
    expect(calls[1].config?.tools).toEqual([{ googleSearch: {} }]); // the search sub-request uses only the built-in tool
    const result = (calls[2].contents as { parts: { functionResponse?: { response: { output: string } } }[] }[]).at(-1)!.parts[0].functionResponse!;
    expect(result.response.output).toContain('Sources:\n• example.com: https://example.com/set');
    expect(store.usage().find((u) => u.webSearches === 1)).toBeTruthy();
  });

  it('leaves web tools out when BOT_WEB_TOOLS is off', async () => {
    const { generate, calls } = fakeGemini([geminiRes([{ text: 'ok' }])]);
    await new Agent(testConfig({ webTools: false }), new Store(null), { gemini: new GeminiProvider(generate) }).reply({ chatKey: 'c', text: 'x' });
    expect(JSON.stringify(calls[0].config?.tools)).not.toContain('web_search');
  });

  it('retries without a thinking level when the model rejects it', async () => {
    const err = Object.assign(new Error('thinking_level is not supported for this model'), { status: 400 });
    const { generate, calls } = fakeGemini([err, geminiRes([{ text: 'hi' }])]);
    const agent = new Agent(testConfig(), new Store(null), { gemini: new GeminiProvider(generate) });
    expect(await agent.reply({ chatKey: 'c', text: 'hello' })).toBe('hi');
    expect(calls[1].config?.thinkingConfig).toBeUndefined();
  });

  it('treats a safety block as a refusal', async () => {
    const { generate } = fakeGemini([geminiRes([], 'SAFETY')]);
    const agent = new Agent(testConfig(), new Store(null), { gemini: new GeminiProvider(generate) });
    expect(await agent.reply({ chatKey: 'c', text: 'x' })).toMatch(/can't help/);
  });
});

describe('Agent settings and spending', () => {
  it('uses the model chosen in settings and explains a missing key', async () => {
    const store = new Store(null);
    const gemini = echoProvider('from gemini');
    const agent = new Agent(testConfig(), store, { gemini: gemini.provider });
    expect(await agent.reply({ chatKey: 'c', text: 'hi' })).toBe('from gemini');
    store.updateSettings({ model: 'claude-opus-5-5' });
    await expect(agent.reply({ chatKey: 'c', text: 'hi' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('warns once a day past the warning limit and blocks at the hard cap', async () => {
    const store = new Store(null);
    const { provider, requests } = echoProvider('answer'); // each call costs $0.75
    const cfg = testConfig({ billing: { ...testConfig().billing, warnUsd: 1, capUsd: 1.5 } });
    const agent = new Agent(cfg, store, { gemini: provider }, null, () => NOW);

    expect(await agent.reply({ chatKey: 'c', text: '1' })).toBe('answer');
    expect(await agent.reply({ chatKey: 'c', text: '2' })).toMatch(/^answer\n\n⚠️ Billing warning: today's AI spend is \$1\.5000/);
    expect(await agent.reply({ chatKey: 'c', text: '3' })).toMatch(/^🛑 Daily cap reached for all AI together/);
    expect(requests).toHaveLength(2); // the third never reached the provider
    await expect(agent.generate('x', 'y', 'briefing')).rejects.toThrow(/cap reached/);
  });

  it('handles messages from one chat one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const provider = {
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { text: 'ok' };
      },
    };
    const store = new Store(null);
    const agent = new Agent(testConfig(), store, { gemini: provider });
    await Promise.all([agent.reply({ chatKey: 'c:1', text: 'a' }), agent.reply({ chatKey: 'c:1', text: 'b' })]);
    expect(maxActive).toBe(1);
    expect(store.history('c:1').map((t) => t.text)).toEqual(['a', 'ok', 'b', 'ok']);
  });

  it('only offers Google tools when Google is connected', async () => {
    const { provider, requests } = echoProvider();
    await new Agent(testConfig(), new Store(null), { gemini: provider }).reply({ chatKey: 'c', text: 'x' });
    const names = requests[0].tools.map((t) => t.name);
    expect(names).toContain('get_news');
    expect(names).not.toContain('calendar_create_event');
  });
});

describe('models', () => {
  it('prices Gemini 4 Argon at the full rate from December 2026', () => {
    expect(modelInfo('gemini-4-argon', '', new Date('2026-11-30T00:00:00Z')).input).toBe(2);
    expect(modelInfo('gemini-4-argon', '', new Date('2026-12-01T00:00:00Z')).input).toBe(4);
  });

  it('applies MODEL_PRICES overrides and counts cache and web searches', () => {
    const info = modelInfo('claude-sonnet-5-5', '{"claude-sonnet-5-5":{"input":3}}');
    expect(info.input).toBe(3);
    expect(costOf({ model: 'x', input: 0, output: 0, cacheRead: 1_000_000, webSearches: 2 }, info)).toBeCloseTo(0.22, 6);
  });
});
