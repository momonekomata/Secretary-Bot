import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, BudgetExceeded } from '../agent';
import { Briefings } from '../briefings';
import { Secretary, type IncomingMessage } from '../channel';
import { runCommand, type CommandReply } from '../commands';
import { UserFacingError } from '../documents';
import { GeminiProvider } from '../llm/gemini';
import { costOf, modelInfo } from '../models';
import { pickImageModel, picturePrompt, Pictures } from '../pictures';
import { Store } from '../store';
import { Telegram } from '../telegram';
import { fakeGemini, geminiRes, NOW, testConfig } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // a made-up image (just the PNG header)
const imageRes = (caption = '') =>
  geminiRes([...(caption ? [{ text: caption }] : []), { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }], 'STOP', { promptTokenCount: 300, candidatesTokenCount: 1290, thoughtsTokenCount: 0 });

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(responses: Parameters<typeof fakeGemini>[0], over: { dataDir?: string; guard?: () => void; store?: Store } = {}) {
  const store = over.store ?? new Store(null);
  const { generate, calls } = fakeGemini(responses);
  const usage: unknown[] = [];
  let listed = 0;
  const pics = new Pictures({
    generate,
    listModels: async () => {
      listed++;
      return [
        { name: 'models/gemini-9-flash-image', actions: ['generateContent'] },
        { name: 'models/imagen-9', actions: ['predict'] },
      ];
    },
    store,
    dataDir: over.dataDir ?? '',
    priceUsd: 0.04,
    guard: over.guard ?? (() => undefined),
    onUsage: (u) => void usage.push(u),
  });
  return { store, pics, calls, usage, listed: () => listed };
}

describe('pictures of the character', () => {
  it('picks a stable, newest, cheaper native image model (not Imagen or TTS)', () => {
    const ids = [
      'models/imagen-4.0-generate-001',
      'models/gemini-2.5-flash-image',
      'models/gemini-3-pro-image-preview',
      'models/gemini-3.1-flash-image-preview',
      'models/gemini-3.5-pro-image',
      'models/gemini-3.5-flash-image',
      'models/gemini-3.8-flash-tts',
    ].map((name) => ({ name, actions: ['generateContent'] }));
    expect(pickImageModel(ids)).toBe('gemini-3.5-flash-image');
    expect(pickImageModel([{ name: 'models/gemini-3-pro-image-preview', actions: [] }])).toBe('gemini-3-pro-image-preview');
    expect(pickImageModel([{ name: 'models/gemini-3.8-flash', actions: ['generateContent'] }])).toBeNull();
  });

  it('describes the character from the sheet, with the style and scene', () => {
    const p = picturePrompt('Runa', { looks: ['fluffy orange hair', 'curled tail'], quirks: ['says "woof!" when excited'] }, 'watercolour', 'at the beach', true);
    expect(p).toContain('The attached image is the reference portrait of Runa');
    expect(p).toContain('Draw Runa: fluffy orange hair; curled tail.');
    expect(p).toContain('Art style: watercolour.');
    expect(p).toContain('Scene: at the beach.');
    expect(p).toContain('Safe for work.');
    expect(picturePrompt('Runa', undefined, '', '', false)).toContain('Art style: clean, colourful anime illustration.');
  });

  it('draws, counts the cost, keeps the last picture and uses a reference portrait next time', async () => {
    const { pics, calls, usage, listed } = make([imageRes('Here I am!'), imageRes()]);
    const first = await pics.draw('a selfie', { botName: 'Runa', aspect: '3:4' });
    expect(first).toMatchObject({ mimeType: 'image/png', caption: 'Here I am!' });
    expect(first.data.equals(PNG)).toBe(true);
    expect(calls[0]).toMatchObject({ model: 'gemini-9-flash-image', config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4' } } });
    expect(usage[0]).toMatchObject({ model: 'gemini-9-flash-image', input: 300, output: 1290, fixedUsd: 0.04 });

    expect(pics.hasReference).toBe(false);
    expect(pics.setReference('last')).toBe(true);
    await pics.draw('at a summer festival', { botName: 'Runa' });
    const parts = calls[1].contents as { parts: { inlineData?: { data: string }; text?: string }[] }[];
    expect(parts[0].parts[0].inlineData!.data).toBe(PNG.toString('base64'));
    expect(parts[0].parts[1].text).toContain('reference portrait');
    expect(listed()).toBe(1); // the model is looked up once
  });

  it('says so when Google refuses, and respects the daily limit', async () => {
    const refused = geminiRes([], 'IMAGE_SAFETY');
    const { pics } = make([refused]);
    await expect(pics.draw('x', { botName: 'Runa' })).rejects.toThrow(UserFacingError);
    const blocked = make([], { guard: () => { throw new BudgetExceeded('Daily limit reached.'); } });
    await expect(blocked.pics.draw('x', { botName: 'Runa' })).rejects.toThrow('Daily limit reached.');
  });

  it('keeps the reference portrait on disk across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pics-'));
    dirs.push(dir);
    const a = make([imageRes()], { dataDir: dir });
    await a.pics.draw('portrait', { botName: 'Runa' });
    a.pics.setReference('last');
    const b = make([], { dataDir: dir });
    expect(b.pics.hasReference).toBe(true);
    b.pics.clearReference();
    expect(make([], { dataDir: dir }).pics.hasReference).toBe(false);
  });

  it('counts the fixed picture price in the cost', () => {
    expect(costOf({ model: 'x-image', input: 0, output: 0, fixedUsd: 0.04 }, modelInfo('x-image'))).toBeCloseTo(0.04);
  });
});

describe('/draw and drawing from chat', () => {
  function bot(responses: Parameters<typeof fakeGemini>[0]) {
    const store = new Store(null);
    const cfg = testConfig();
    const chat = fakeGemini(responses);
    const agent = new Agent(cfg, store, { gemini: new GeminiProvider(chat.generate) }, null, () => NOW);
    const images = make([imageRes('ta-da'), imageRes(), imageRes()], { store });
    const pics = images.pics;
    agent.setPictures(pics);
    const briefings = new Briefings(cfg, store, agent, () => NOW);
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
    const secretary = new Secretary(cfg, store, agent, briefings, null, async () => '');
    return { store, agent, pics, imageCalls: images.calls, chat, command: (text: string) => runCommand(text, ctx), secretary };
  }

  it('/draw sends a picture with a "use as my look" button, and sets the style and look', async () => {
    const { store, command, imageCalls, pics } = bot([]);
    expect((await command('/draw'))!.text).toMatch(/I can draw pictures of myself/);
    expect((await command('/draw look'))!.text).toMatch(/There is no picture yet/);
    expect((await command('/draw style soft pastel watercolour'))!.text).toBe('🎨 Pictures will be drawn as: soft pastel watercolour');
    store.updateSettings({ character: { looks: ['fluffy orange hair'] } });
    const r = (await command('/draw a selfie at the beach'))!;
    expect(r).toMatchObject({ text: 'ta-da', buttons: [[{ label: '⭐ Use as my look', command: '/draw look' }]] });
    expect(r.pictures).toHaveLength(1);
    const prompt = JSON.stringify(imageCalls[0].contents);
    expect(prompt).toContain('fluffy orange hair');
    expect(prompt).toContain('soft pastel watercolour');
    expect(prompt).toContain('a selfie at the beach');
    expect((await command('/draw look'))!.text).toMatch(/^⭐ Saved/);
    expect(pics.hasReference).toBe(true);
    expect((await command('/draw look clear'))!.text).toMatch(/Reference portrait removed/);
  });

  it('the AI can draw during a chat reply, and the picture goes out with the reply', async () => {
    const { secretary } = bot([
      geminiRes([{ functionCall: { id: 'd', name: 'draw_picture', args: { scene: 'in a raincoat, jumping in puddles', aspect: '3:4' } } }]),
      geminiRes([{ text: 'Splash! Here I am 🐾' }]),
    ]);
    const m: IncomingMessage = { platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'send me a picture of you in a raincoat' };
    const reply = (await secretary.handle(m))!;
    expect(reply.text).toBe('Splash! Here I am 🐾');
    expect(reply.pictures).toHaveLength(1);
    expect(reply.buttons).toEqual([[{ label: '⭐ Use as my look', command: '/draw look' }]]);
  });

  it('a photo the user sends can become the reference portrait', async () => {
    const { secretary, pics } = bot([
      geminiRes([{ functionCall: { id: 'r', name: 'picture_reference_set', args: { source: 'user_photo' } } }]),
      geminiRes([{ text: 'Saved! That is me now.' }]),
    ]);
    const m: IncomingMessage = { platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'use this as your look', images: [{ mediaType: 'image/png', data: PNG.toString('base64') }] };
    expect((await secretary.handle(m))!.text).toBe('Saved! That is me now.');
    expect(pics.hasReference).toBe(true);
  });
});

describe('sending pictures', () => {
  it('Telegram sends the picture with the text as its caption and the buttons under it', async () => {
    const sent: { method: string; caption?: string; markup?: string; text?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = url.split('/').pop()!;
      if (init?.body instanceof FormData) sent.push({ method, caption: String(init.body.get('caption') ?? ''), markup: String(init.body.get('reply_markup') ?? '') });
      else if (init?.body) sent.push({ method, text: JSON.parse(String(init.body)).text });
      return Response.json({ ok: true, result: {} });
    });
    const reply: CommandReply = { text: 'Here I am!', pictures: [{ data: PNG, mimeType: 'image/png', caption: '' }], buttons: [[{ label: '⭐ Use as my look', command: '/draw look' }]] };
    const secretary = { isSlow: () => false, handle: async () => reply } as unknown as Secretary;
    const tg = new Telegram({ ...testConfig().telegram, token: 't' }, secretary, () => undefined);
    await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/draw me' } } as never);
    const photo = sent.find((s) => s.method === 'sendPhoto')!;
    expect(photo.caption).toBe('Here I am!');
    expect(JSON.parse(photo.markup!)).toEqual({ inline_keyboard: [[{ text: '⭐ Use as my look', callback_data: '/draw look' }]] });
    expect(sent.some((s) => s.method === 'sendMessage' && s.text === 'Here I am!')).toBe(false);
  });
});
