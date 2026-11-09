import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Secretary } from '../channel';
import { personaView, runCommand } from '../commands';
import { PERSONAS } from '../personas';
import { Store } from '../store';
import { NOW, echoProvider, fakeGemini, geminiRes, testConfig } from './helpers';

function setup() {
  const store = new Store(null);
  const cfg = testConfig();
  const echo = echoProvider('สวัสดีค่ะ');
  const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
  return { store, cfg, agent, briefings, ctx, echo };
}

describe('personality', () => {
  it('picks a ready-made personality, with its voice, and puts it in the system prompt', async () => {
    const { ctx, store, agent, echo } = setup();
    const view = personaView(ctx);
    expect(view.buttons!.flat().map((b) => b.command)).toEqual([...PERSONAS.map((p) => `/persona ${p.key}`), '/persona off']);

    const r = await runCommand('/persona butler', ctx);
    expect(r!.text).toMatch(/^✅ I'm now: 🎩 Butler/);
    expect(store.settings()).toMatchObject({ personaKey: 'butler', ttsVoice: 'Charon' });
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[0].system).toContain('Your personality: A refined butler');
    expect(echo.requests[0].system).toContain('Stay in character');

    await runCommand('/persona off', ctx);
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[1].system).not.toContain('Your personality');
    expect(store.settings().ttsVoice).toBeUndefined();
  });

  it('accepts a personality described in the user’s own words, and a new name', async () => {
    const { ctx, store, agent, echo } = setup();
    await runCommand('/persona a witty pirate captain who loves spreadsheets and calls me captain', ctx);
    expect(store.settings()).toMatchObject({ personaKey: 'custom', persona: 'a witty pirate captain who loves spreadsheets and calls me captain' });
    expect((await runCommand('/persona xyz', ctx))!.text).toMatch(/isn't one of my personalities/);

    expect((await runCommand('/name Mali', ctx))!.text).toMatch(/^✅ From now on I'm Mali/);
    await agent.reply({ chatKey: 'telegram:1', text: 'who are you?' });
    expect(echo.requests[0].system).toMatch(/^You are Mali, /);
    expect(echo.requests[0].system).toContain('a witty pirate captain');
    expect((await runCommand('/settings', ctx))!.text).toContain('Name: Mali\nPersonality: your own description');
  });

  it('speaks with the personality’s voice and style', async () => {
    const { cfg, store, agent, briefings, ctx } = setup();
    await runCommand('/persona cheerful', ctx);
    const pcm = Buffer.alloc(4800).toString('base64');
    const { generate, calls } = fakeGemini([geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm } }])]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    expect(await s.speech('🎉 Great job today!')).toMatchObject({ rate: 24000 });
    expect(calls[0].config).toMatchObject({ speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } });
    expect(JSON.stringify(calls[0].contents)).toContain('Say cheerfully and with energy: Great job today!');

    expect((await runCommand('/ttsvoice Zephyr', ctx))!.speak).toBeTruthy();
    expect(store.settings().ttsVoice).toBe('Zephyr');
    expect((await runCommand('/ttsvoice ???', ctx))!.text).toMatch(/Which voice/);
  });
});
