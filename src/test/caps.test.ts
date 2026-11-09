import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings, usageStats } from '../briefings';
import { Secretary } from '../channel';
import type { Provider } from '../llm/types';
import { Store } from '../store';
import { NOW, fakeGemini, geminiRes, testConfig } from './helpers';

/** A provider whose every call costs $1 on the given model (1M input tokens priced at $1). */
function dollarProvider(text: string): Provider {
  return {
    async run(req) {
      req.onUsage({ model: req.model, input: 1_000_000, output: 0 });
      return { text };
    },
  };
}

const PRICES = '{"gemini-3.8-flash":{"input":1,"output":0},"claude-sonnet-5-5":{"input":1,"output":0}}';

function setup(providers: { gemini?: { warnUsd: number | null; capUsd: number | null }; claude?: { warnUsd: number | null; capUsd: number | null } }) {
  const base = testConfig().billing;
  const cfg = testConfig({
    billing: { ...base, priceOverrides: PRICES, providers: { gemini: providers.gemini ?? base.providers.gemini, claude: providers.claude ?? base.providers.claude } },
  });
  const store = new Store(null);
  const agent = new Agent(cfg, store, { gemini: dollarProvider('from gemini'), claude: dollarProvider('from claude') }, null, () => NOW);
  return { cfg, store, agent };
}

describe('separate daily caps per provider', () => {
  it("pauses only the capped provider, and suggests switching", async () => {
    const { store, agent } = setup({ gemini: { warnUsd: null, capUsd: 1 }, claude: { warnUsd: null, capUsd: 3 } });
    expect(await agent.reply({ chatKey: 'c', text: '1' })).toBe('from gemini');
    const blocked = await agent.reply({ chatKey: 'c', text: '2' });
    expect(blocked).toMatch(/^🛑 Gemini's daily cap reached: \$1\.0000 of \$1\.00\. Gemini is paused until midnight\.\nYou can switch to Claude in \/settings meanwhile\./);

    store.updateSettings({ model: 'claude-sonnet-5-5' });
    expect(await agent.reply({ chatKey: 'c', text: '3' })).toBe('from claude'); // Claude still has room
    expect(agent.spentToday('gemini')).toBe(1);
    expect(agent.spentToday('claude')).toBe(1);
    expect(agent.spentToday()).toBe(2);
  });

  it('keeps voice notes on the Gemini cap even when chatting with Claude', async () => {
    const { cfg, store, agent } = setup({ gemini: { warnUsd: null, capUsd: 0.5 } });
    store.updateSettings({ model: 'claude-sonnet-5-5' });
    store.addUsage({ ts: NOW.toISOString(), kind: 'voice', model: 'gemini-3.8-flash', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost: 0.6 });
    const { generate } = fakeGemini([geminiRes([{ text: '{}' }])]);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent), generate, async () => '');
    const r = await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '', audio: { mimeType: 'audio/ogg', data: 'AA' } });
    expect(r!.text).toMatch(/Gemini's daily cap reached/);
    expect(r!.text).toContain('Voice notes and spoken replies always use Gemini');
    expect(r!.text).not.toContain('switch to Claude'); // already on Claude
    expect(await agent.reply({ chatKey: 'c', text: 'hi' })).toBe('from claude');
  });

  it('warns once per provider per day', async () => {
    const { agent } = setup({ gemini: { warnUsd: 1, capUsd: null } });
    expect(await agent.reply({ chatKey: 'c', text: '1' })).toBe('from gemini\n\n⚠️ Billing warning: Gemini today is $1.0000 (warning at $1.00).');
    expect(await agent.reply({ chatKey: 'c', text: '2' })).toBe('from gemini');
  });

  it('splits /stats by provider', () => {
    const store = new Store(null);
    const row = (model: string, cost: number) => ({ ts: NOW.toISOString(), kind: 'chat', model, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost });
    store.addUsage(row('gemini-3.8-flash', 0.25));
    store.addUsage(row('claude-opus-5-5', 1.5));
    expect(usageStats(store.usage(), 'Asia/Bangkok', NOW)).toContain('Today: $1.7500 (2 calls) · Gemini $0.2500, Claude $1.5000');
  });
});

describe('/limit: daily limits changed in chat', () => {
  async function ctxFor() {
    const { runCommand } = await import('../commands');
    const s = setup({ gemini: { warnUsd: null, capUsd: 5 } });
    const briefings = new Briefings(s.cfg, s.store, s.agent, () => NOW);
    const ctx = { chatKey: 'c', userId: '1', agent: s.agent, store: s.store, cfg: s.cfg, briefings, status: async () => '', now: () => NOW };
    return { ...s, ctx, run: (t: string) => runCommand(t, ctx) };
  }

  it('shows the limits with their source, and overrides .env until reset', async () => {
    const { run, agent, store } = await ctxFor();
    const view = (await run('/limit'))!;
    expect(view.text).toContain('Gemini: spent $0.0000 today · warn off · cap $5.00');
    expect(view.text).toContain('All values come from the .env file.');
    expect(view.buttons!.flat().map((b) => b.command)).toContain('/limit gemini 2');

    expect((await run('/limit gemini 1'))!.text).toMatch(/^✅ Gemini cap: \$1\.00 a day\./);
    expect((await run('/limit gemini'))!.text).toContain('cap $1.00✏️');
    expect(await agent.reply({ chatKey: 'c', text: 'hi' })).toBe('from gemini');
    expect(await agent.reply({ chatKey: 'c', text: 'again' })).toMatch(/^🛑 Gemini's daily cap reached: \$1\.0000 of \$1\.00\.[\s\S]*Change the limit with \/limit\.$/);

    // Raise it in chat and carry on, the same day.
    await run('/limit gemini $3');
    expect(await agent.reply({ chatKey: 'c', text: 'more' })).toBe('from gemini');

    await run('/limit claude warn 0.5');
    await run('/limit all 10');
    expect(store.settings().limits).toEqual({ gemini: { capUsd: 3 }, claude: { warnUsd: 0.5 }, all: { capUsd: 10 } });
    expect(agent.limits().claude).toMatchObject({ warnUsd: 0.5, capUsd: null });

    await run('/limit gemini off');
    expect(agent.limits().gemini).toMatchObject({ warnUsd: null, capUsd: null });
    await run('/limit gemini reset');
    expect(agent.limits().gemini).toMatchObject({ capUsd: 5, from: { capUsd: 'env' } });
    expect((await run('/limit reset'))!.text).toMatch(/^✅ Back to the limits in the \.env file\./);
    expect(store.settings().limits).toBeUndefined();
  });

  it('rejects bad amounts and scopes, and notes a warning above the cap', async () => {
    const { run, store } = await ctxFor();
    expect((await run('/limit gemini lots'))!.text).toMatch(/^Give an amount in USD/);
    expect((await run('/limit gemini 5000'))!.text).toMatch(/^Give an amount in USD/);
    expect((await run('/limit openai 3'))!.text).toMatch(/^"openai" isn't gemini, claude or all\./);
    expect(store.settings().limits).toBeUndefined();
    expect((await run('/limit gemini warn 9'))!.text).toContain("the warning $9.00 is not below the cap, so it won't show");
  });
});
