import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Secretary, type IncomingMessage } from '../channel';
import { hasFfmpeg } from '../audio';
import { CUTE_STYLE, runCommand, SAMPLE_LINE, type CommandReply } from '../commands';
import { Store } from '../store';
import { Telegram } from '../telegram';
import { NOW, echoProvider, fakeGemini, geminiRes, testConfig } from './helpers';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const store = new Store(null);
  const cfg = testConfig();
  const agent = new Agent(cfg, store, { gemini: echoProvider().provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  return { store, cfg, agent, briefings, ctx: { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW } };
}

describe('/voices', () => {
  it('lists cute female voices to sample, with buttons to pick one', async () => {
    const { ctx } = setup();
    const r = (await runCommand('/voices', ctx))!;
    expect(r.samples!.items.map((i) => i.voice)).toEqual(['Leda', 'Laomedeia', 'Autonoe', 'Zephyr', 'Achernar', 'Aoede', 'Despina', 'Vindemiatrix']);
    expect(r.samples!.items[0].caption).toBe('1. Leda · youthful');
    expect(r.samples!.line).toBe(SAMPLE_LINE);
    expect(r.samples!.style).toBe(CUTE_STYLE);
    const commands = r.samples!.footer.buttons.flat().map((b) => b.command);
    expect(commands).toContain('/voices pick Leda');
    expect(commands.at(-1)).toBe('/voices more');
    expect((await runCommand('/voices more', ctx))!.samples!.items.map((i) => i.voice)).toEqual(['Kore', 'Callirrhoe', 'Erinome', 'Sulafat', 'Pulcherrima', 'Gacrux']);
  });

  it('picking a voice sets it with the cute style and plays it', async () => {
    const { ctx, store } = setup();
    const r = (await runCommand('/voices pick laomedeia', ctx))!;
    expect(store.settings()).toMatchObject({ ttsVoice: 'Laomedeia', speakingStyle: CUTE_STYLE });
    expect(r.speak).toBe(SAMPLE_LINE);
    expect((await runCommand('/voices pick ???', ctx))!.text).toMatch(/^Which voice\?/);
  });

  it('speaks a sample with the given voice and style', async () => {
    const { store, cfg, agent, briefings } = setup();
    const clip = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(9600, 1).toString('base64') } }]);
    const { generate, calls } = fakeGemini([clip(), clip()]);
    store.updateSettings({ ttsVoice: 'Kore', speakingStyle: 'calmly' });
    await new Secretary(cfg, store, agent, briefings, generate, async () => '').speech(SAMPLE_LINE, { voice: 'Leda', style: CUTE_STYLE });
    expect(JSON.stringify(calls[0].config)).toContain('"voiceName":"Leda"');
    // The sample line is Japanese then Thai: each part is spoken with its own pronunciation.
    expect(calls.map((c) => c.contents)).toEqual([
      [{ role: 'user', parts: [{ text: 'こんにちは！今日も一緒にがんばろうね。', speechMetadata: { style: `${CUTE_STYLE}; natural native Japanese pronunciation` } }] }],
      [{ role: 'user', parts: [{ text: 'สวัสดีค่ะ วันนี้ก็สู้ๆ ไปด้วยกันนะคะ', speechMetadata: { style: `${CUTE_STYLE}; natural Thai pronunciation` } }] }],
    ]);
    expect(JSON.stringify(calls)).not.toContain('Say ');
  });
});

describe('Telegram voice samples', () => {
  const samples: NonNullable<CommandReply['samples']> = {
    line: 'hi',
    style: 'cutely',
    items: ['A', 'B', 'C', 'D'].map((v, i) => ({ voice: v, caption: `${i + 1}. ${v}` })),
    footer: { text: 'Pick one:', buttons: [[{ label: 'A', command: '/voices pick A' }]] },
  };

  function telegram(speech: (text: string, opts: { voice?: string }) => Promise<unknown>) {
    const sent: { method: string; text?: string; caption?: string; buttons?: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = url.split('/').pop()!;
      if (init?.body instanceof FormData) sent.push({ method, caption: String(init.body.get('caption') ?? '') });
      else if (method === 'sendMessage') {
        const b = JSON.parse(String(init!.body));
        sent.push({ method, text: b.text, buttons: b.reply_markup });
      }
      return Response.json({ ok: true, result: {} });
    });
    const secretary = { isSlow: () => false, handle: async (_m: IncomingMessage) => ({ text: 'Samples coming', samples }), speech } as unknown as Secretary;
    return { tg: new Telegram({ ...testConfig().telegram, token: 't' }, secretary, () => undefined), sent };
  }
  const update = { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/voices' } };

  it.skipIf(!hasFfmpeg())('sends each sample in order with its caption, then the buttons', async () => {
    const asked: string[] = [];
    const { tg, sent } = telegram(async (_t, o) => (asked.push(o.voice!), { pcm: Buffer.alloc(9600), rate: 24000, durationMs: 200 }));
    await tg.handleUpdate(update);
    expect(asked.sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(sent.map((s) => s.caption ?? s.text)).toEqual(['Samples coming', '1. A', '2. B', '3. C', '4. D', 'Pick one:']);
    expect(sent[0].buttons).toBeUndefined();
    expect(sent.at(-1)!.buttons).toBeTruthy();
  });

  it('stops after the first batch when nothing works, and says why', async () => {
    let tries = 0;
    const { tg, sent } = telegram(async () => {
      tries++;
      throw new Error('429 RESOURCE_EXHAUSTED');
    });
    await tg.handleUpdate(update);
    expect(tries).toBe(hasFfmpeg() ? 3 : 0);
    expect(sent.at(-1)!.text).toMatch(/^Pick one:\n\n🔇 I couldn't make the voice reply: /);
  });
});

describe('speaking style', () => {
  it('goes in the text only for older speech models, and is dropped if the API rejects the style field', async () => {
    const { styleInText, synthesize } = await import('../audio');
    expect(styleInText('gemini-3.8-flash-tts')).toBe(false);
    expect(styleInText('gemini-3.1-flash-tts-preview')).toBe(true);
    expect(styleInText('gemini-2.5-flash-preview-tts')).toBe(true);
    const ok = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(9600).toString('base64') } }]);
    const old = fakeGemini([ok()]);
    await synthesize(old.generate, 'gemini-2.5-flash-preview-tts', 'Kore', 'Hello', () => undefined, 'warmly');
    expect(old.calls[0].contents).toEqual([{ role: 'user', parts: [{ text: 'Say warmly: Hello' }] }]);

    const { store, cfg, agent, briefings } = setup();
    store.updateSettings({ speakingStyle: CUTE_STYLE });
    const rejected = new Error('Invalid JSON payload received. Unknown name "speechMetadata" at \'contents[0].parts[0]\': Cannot find field.');
    const { generate, calls } = fakeGemini([rejected, ok(), ok()]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    expect(await s.speech('Hello')).toBeTruthy();
    expect(calls[1].contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
    await s.speech('Again'); // remembered: no more failed tries
    expect(calls[2].contents).toEqual([{ role: 'user', parts: [{ text: 'Again' }] }]);
  });
});
