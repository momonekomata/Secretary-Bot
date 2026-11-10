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
    expect((await runCommand('/ttsvoice ???', ctx))!.text).toMatch(/isn't a voice name/);
  });
});

describe('spoken replies: model fallback and voice choice', () => {
  const pcm = Buffer.alloc(4800).toString('base64');
  const audio = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }]);

  it('moves past a speech model that is not available and remembers the one that works', async () => {
    const { Secretary } = await import('../channel');
    const notFound = new Error('[404 Not Found] models/gemini-3.8-flash-tts is not found for API version v1beta');
    const { generate, calls } = fakeGemini([notFound, audio(), audio()]);
    const { store, cfg, agent, briefings } = setup();
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    store.updateSettings({ ttsVoice: 'not a voice!' });
    expect((await s.speech('Hello'))?.rate).toBe(24000);
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview']);
    // A bad saved voice falls back to a real one.
    expect(JSON.stringify(calls[1].config)).toContain('"voiceName":"Kore"');
    await s.speech('Again');
    expect(calls[2].model).toBe('gemini-3.1-flash-tts-preview');
    expect(s.ttsModel).toBe('gemini-3.1-flash-tts-preview');
  });

  it('does not hide other errors, and explains failures in plain words', async () => {
    const { Secretary, speechFailed } = await import('../channel');
    const { generate } = fakeGemini([new Error('429 RESOURCE_EXHAUSTED: quota')]);
    const { store, cfg, agent, briefings } = setup();
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    const err = await s.speech('Hello').catch((e) => e);
    expect(speechFailed(err)).toBe("🔇 I couldn't make the voice reply: the Gemini quota or credit ran out.");
    expect(speechFailed(new Error('ffmpeg is not installed'))).toBe("🔇 I couldn't make the voice reply: ffmpeg is missing on the server.");
  });

  it('/ttsvoice offers voices as buttons and plays a sample', async () => {
    const { ctx, store } = setup();
    const menu = (await runCommand('/ttsvoice', ctx))!;
    expect(menu.text).toMatch(/^🔊 Voice for spoken replies: Kore/);
    expect(menu.buttons!.flat().map((b) => b.command)).toContain('/ttsvoice Puck');
    expect(menu.buttons!.flat()[0].label).toBe('✅ Kore · firm');
    const r = (await runCommand('/ttsvoice puck', ctx))!;
    expect(store.settings().ttsVoice).toBe('Puck');
    expect(r.speak).toBeTruthy();
    expect(r.buttons!.flat().find((b) => b.label.startsWith('✅'))!.command).toBe('/ttsvoice Puck');
    // A voice outside the list (newer models add voices) is tried, with a note.
    const custom = (await runCommand('/ttsvoice Nova', ctx))!;
    expect(store.settings().ttsVoice).toBe('Nova');
    expect(custom.text).toContain("Nova isn't in my list of Gemini voices");
  });
});
