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
    expect(tries).toBe(hasFfmpeg() ? 2 : 0); // the first batch (two samples) only
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

describe('/voicestyle', () => {
  it('shows the style with ready-made choices, and sets a preset, your own words, or none', async () => {
    const { ctx, store } = setup();
    const view = (await runCommand('/voicestyle', ctx))!;
    expect(view.text).toMatch(/^🎙️ Speaking style: none/);
    expect(view.buttons!.flat().map((b) => b.command)).toEqual(['/voicestyle cute', '/voicestyle anime', '/voicestyle gentle', '/voicestyle energetic', '/voicestyle calm', '/voicestyle off']);
    expect(view.buttons!.flat().every((b) => Buffer.byteLength(b.command) <= 64)).toBe(true); // Telegram button limit

    const anime = (await runCommand('/voicestyle anime', ctx))!;
    expect(store.settings().speakingStyle).toMatch(/^affectionate, loving and cheerful, yet a little shy; a high-pitched, sweet and melodic voice/);
    expect(anime.speak).toBe(SAMPLE_LINE);
    expect(anime.buttons!.flat().find((b) => b.label.startsWith('✅'))!.command).toBe('/voicestyle anime');

    await runCommand('/style whispering softly, very shy', ctx);
    expect(store.settings().speakingStyle).toBe('whispering softly, very shy');
    expect((await runCommand('/voicestyle x', ctx))!.text).toMatch(/^Describe the style/);
    await runCommand('/voicestyle off', ctx);
    expect(store.settings().speakingStyle).toBeUndefined();
  });

  it('can be changed by asking in chat', async () => {
    const { runTool } = await import('../tools');
    const store = new Store(null);
    const tctx = { chatKey: 'c', store, cfg: testConfig(), google: null, now: () => NOW };
    expect((await runTool('voice_style_set', { style: 'shy and sweet, high-pitched' }, tctx)).content).toMatch(/^Spoken replies will now sound: shy and sweet/);
    expect(store.settings().speakingStyle).toBe('shy and sweet, high-pitched');
    await runTool('voice_style_set', { style: '' }, tctx);
    expect(store.settings().speakingStyle).toBeUndefined();
  });
});

describe('reading a message aloud', () => {
  it('replying to a message with /say or 🔊 reads that message', async () => {
    const { sayQuoted } = await import('../telegram');
    const msg = (text: string, quoted?: string) => ({ message_id: 2, chat: { id: 1, type: 'private' }, text, ...(quoted ? { reply_to_message: { message_id: 1, chat: { id: 1, type: 'private' }, text: quoted } } : {}) });
    expect(sayQuoted(msg('/say', 'คำว่า ありがとう แปลว่าขอบคุณ'))).toBe('/say คำว่า ありがとう แปลว่าขอบคุณ');
    expect(sayQuoted(msg('🔊', 'Hello'))).toBe('/say Hello');
    expect(sayQuoted(msg('/say@Runa_secretary_bot', 'Hi'))).toBe('/say Hi');
    expect(sayQuoted(msg('what does this mean?', 'Hello'))).toBe('what does this mean?'); // a normal reply stays a normal message
    expect(sayQuoted(msg('/say'))).toBe('/say');
  });

  it('/say on its own reads my last reply', async () => {
    const { ctx, store } = setup();
    store.appendExchange('telegram:1', 'hi', 'สวัสดีค่ะ วันนี้เรียนคำว่า 勉強 กันนะ', 10);
    expect((await runCommand('/say', ctx))!.speak).toBe('สวัสดีค่ะ วันนี้เรียนคำว่า 勉強 กันนะ');
    const fresh = setup();
    expect((await runCommand('/say', fresh.ctx))!.text).toMatch(/reply to any message with \/say/);
  });

  it('works end to end on Telegram', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async () => Response.json({ ok: true, result: {} }));
    const secretary = { isSlow: () => false, handle: async (m: IncomingMessage) => (seen.push(m.text), null) } as unknown as Secretary;
    const tg = new Telegram({ ...testConfig().telegram, token: 't' }, secretary, () => undefined);
    await tg.handleUpdate({
      update_id: 1,
      message: { message_id: 5, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/say', reply_to_message: { message_id: 4, chat: { id: 1, type: 'private' }, text: 'おはよう' } },
    } as never);
    expect(seen).toEqual(['/say おはよう']);
  });
});

describe('Gemini speech rate limit', () => {
  const clip = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(9600, 1).toString('base64') } }]);

  it('waits as long as Google suggests after a 429, then retries, and pauses other requests too', async () => {
    const { store, cfg, agent, briefings } = setup();
    const limited = new Error('[429 Too Many Requests] Resource has been exhausted. {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}');
    const { generate, calls } = fakeGemini([limited, clip()]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    let clock = 1_000_000;
    const waits: number[] = [];
    s.now = () => clock;
    s.wait = async (ms) => {
      waits.push(ms);
      clock += ms;
    };
    expect(await s.speech('Hello')).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([12_500]);
  });

  it('runs at most two speech requests at once', async () => {
    const { store, cfg, agent, briefings } = setup();
    let active = 0;
    let most = 0;
    const generate = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return clip();
    };
    const s = new Secretary(cfg, store, agent, briefings, generate as never, async () => '');
    // Mixed Thai and Japanese: several pieces at once.
    await Promise.all([s.speech('คำว่า ありがとう แปลว่า ขอบคุณ'), s.speech('สวัสดี こんにちは')]);
    expect(most).toBe(2);
  });

  it('does not retry a daily quota or empty credit', async () => {
    const { store, cfg, agent, briefings } = setup();
    const { generate, calls } = fakeGemini([new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for metric: requests per day')]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    s.wait = async () => undefined;
    await expect(s.speech('Hello')).rejects.toThrow(/per day/);
    expect(calls).toHaveLength(1);
  });
});

describe('a voice per language', () => {
  const ANIME = 'affectionate, loving and cheerful, yet a little shy; a high-pitched, sweet and melodic voice like an anime heroine';
  const clip = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(9600, 1).toString('base64') } }]);
  const partOf = (c: { contents?: unknown; config?: unknown }) => ({
    voice: /"voiceName":"(\w+)"/.exec(JSON.stringify(c.config))![1],
    ...(c.contents as { parts: { text: string; speechMetadata?: { style: string } }[] }[])[0].parts[0],
  });

  it('speaks Thai with the Thai voice and Japanese with the Japanese voice, in the same style', async () => {
    const { ctx, store, cfg, agent, briefings } = setup();
    await runCommand('/voicestyle anime', ctx);
    await runCommand('/ttsvoice th Leda', ctx);
    const r = (await runCommand('/ttsvoice ja autonoe', ctx))!;
    expect(store.settings().ttsVoiceByLang).toEqual({ th: 'Leda', ja: 'Autonoe' });
    expect(r.text).toContain('Thai voice: Leda · Japanese voice: Autonoe');

    const { generate, calls } = fakeGemini([clip(), clip(), clip(), clip()]);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    await s.speech('คำว่า ありがとう แปลว่าขอบคุณ');
    expect(calls.map(partOf)).toEqual([
      { voice: 'Leda', text: 'คำว่า', speechMetadata: { style: `${ANIME}; natural Thai pronunciation` } },
      { voice: 'Autonoe', text: 'ありがとう', speechMetadata: { style: `${ANIME}; natural native Japanese pronunciation` } },
      { voice: 'Leda', text: 'แปลว่าขอบคุณ', speechMetadata: { style: `${ANIME}; natural Thai pronunciation` } },
    ]);
    // A Japanese-only reply is one clip with the Japanese voice.
    await s.speech('おはようございます');
    expect(partOf(calls[3]).voice).toBe('Autonoe');
  });

  it('/voices keeps your style, plays samples in it, and has 🇹🇭 / 🇯🇵 buttons', async () => {
    const { ctx, store } = setup();
    await runCommand('/voicestyle anime', ctx);
    const r = (await runCommand('/voices', ctx))!;
    expect(r.samples!.style).toBe(ANIME);
    expect(r.samples!.footer.buttons[0].map((b) => b.command)).toEqual(['/voices pick Leda', '/voices pick Leda th', '/voices pick Leda ja']);
    await runCommand('/voices pick Autonoe ja', ctx);
    expect(store.settings()).toMatchObject({ speakingStyle: ANIME, ttsVoiceByLang: { ja: 'Autonoe' } });
    // Picking one voice for everything clears the per-language ones.
    await runCommand('/voices pick Leda', ctx);
    expect(store.settings()).toMatchObject({ ttsVoice: 'Leda', speakingStyle: ANIME });
    expect(store.settings().ttsVoiceByLang).toBeUndefined();
    await runCommand('/ttsvoice ja Autonoe', ctx);
    await runCommand('/ttsvoice ja off', ctx);
    expect(store.settings().ttsVoiceByLang).toBeUndefined();
  });
});

describe('voice sample buttons', () => {
  it('tapping "Hear female voice samples" (or "6 more voices") sends the samples, like typing /voices', async () => {
    const sent: { method: string; text?: string; caption?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = url.split('/').pop()!;
      if (init?.body instanceof FormData) sent.push({ method, caption: String(init.body.get('caption') ?? '') });
      else if (method === 'sendMessage' || method === 'editMessageText') sent.push({ method, text: JSON.parse(String(init!.body)).text });
      return Response.json({ ok: true, result: {} });
    });
    const { ctx } = setup();
    const secretary = {
      isSlow: () => false,
      handle: async (m: IncomingMessage) => runCommand(m.text, ctx),
      speech: async () => ({ pcm: Buffer.alloc(9600), rate: 24000, durationMs: 200 }),
    } as unknown as Secretary;
    const tg = new Telegram({ ...testConfig().telegram, token: 't' }, secretary, () => undefined);
    await tg.handleUpdate({ update_id: 1, callback_query: { id: 'q', from: { id: 1 }, data: '/voices more', message: { message_id: 9, chat: { id: 1, type: 'private' } } } } as never);
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false); // the tapped menu stays
    expect(sent[0].text).toMatch(/^🎧 6 voice samples are on the way/);
    expect(sent.at(-1)!.text).toMatch(/^Which one do you like\?/);
    if (hasFfmpeg()) expect(sent.filter((s) => s.method === 'sendVoice').map((s) => s.caption)).toEqual(['1. Kore · firm', '2. Callirrhoe · easy-going', '3. Erinome · clear', '4. Sulafat · warm', '5. Pulcherrima · forward', '6. Gacrux · mature']);
  });
});
