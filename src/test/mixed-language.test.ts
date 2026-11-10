import { describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { joinSpeech, splitLanguages, trimSilence } from '../audio';
import { Briefings } from '../briefings';
import { Secretary } from '../channel';
import { Store } from '../store';
import { NOW, echoProvider, fakeGemini, geminiRes, testConfig } from './helpers';

describe('Thai with Japanese words', () => {
  it('splits text into Thai and Japanese runs, keeping spaces and punctuation with their run', () => {
    expect(splitLanguages('คำว่า ありがとう แปลว่า ขอบคุณ นะคะ')).toEqual([
      { lang: 'th', text: 'คำว่า' },
      { lang: 'ja', text: 'ありがとう' },
      { lang: 'th', text: 'แปลว่า ขอบคุณ นะคะ' },
    ]);
    expect(splitLanguages('วันนี้เรียนคันจิ「漢字」กับ カタカナ 5 ตัว!')).toEqual([
      { lang: 'th', text: 'วันนี้เรียนคันจิ' },
      { lang: 'ja', text: '「漢字」' },
      { lang: 'th', text: 'กับ' },
      { lang: 'ja', text: 'カタカナ 5' },
      { lang: 'th', text: 'ตัว!' },
    ]);
    // One language: a single run, as before.
    expect(splitLanguages('สวัสดีค่ะ วันนี้อากาศดี')).toHaveLength(1);
    expect(splitLanguages('Hello! 123')).toEqual([{ lang: null, text: 'Hello! 123' }]);
  });

  it('trims silence around clips and joins them with a short gap', () => {
    const rate = 24000;
    const clip = Buffer.alloc(rate * 2); // 1 s: silence, 0.2 s of sound in the middle, silence
    for (let i = 0.4 * rate; i < 0.6 * rate; i++) clip.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
    const trimmed = trimSilence(clip, rate);
    expect(trimmed.length / 2 / rate).toBeCloseTo(0.26, 2); // 0.2 s + 30 ms kept each side
    const joined = joinSpeech([{ pcm: trimmed, rate, durationMs: 0 }, { pcm: trimmed, rate, durationMs: 0 }]);
    expect(joined.durationMs).toBe(590); // 260 + 70 gap + 260
  });

  it('speaks each language with its own pronunciation and returns one voice message', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const agent = new Agent(cfg, store, { gemini: echoProvider().provider }, null, () => NOW);
    const sound = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i++) sound.writeInt16LE(i % 2 ? 5000 : -5000, i * 2);
    const clip = () => geminiRes([{ inlineData: { mimeType: 'audio/L16;rate=24000', data: sound.toString('base64') } }]);
    const { generate, calls } = fakeGemini([clip(), clip(), clip()]);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent, () => NOW), generate, async () => '');
    const speech = (await s.speech('คำว่า ありがとう แปลว่าขอบคุณ'))!;
    expect(calls.map((c) => (c.contents as { parts: { text: string; speechMetadata?: { style: string } }[] }[])[0].parts[0])).toEqual([
      { text: 'คำว่า', speechMetadata: { style: 'natural Thai pronunciation' } },
      { text: 'ありがとう', speechMetadata: { style: 'natural native Japanese pronunciation' } },
      { text: 'แปลว่าขอบคุณ', speechMetadata: { style: 'natural Thai pronunciation' } },
    ]);
    expect(speech.durationMs).toBe(3 * 200 + 2 * 70);

    // Thai only: still one request.
    const one = fakeGemini([clip()]);
    await new Secretary(cfg, store, agent, new Briefings(cfg, store, agent, () => NOW), one.generate, async () => '').speech('สวัสดีค่ะ');
    expect(one.calls).toHaveLength(1);
  });
});
