import { describe, expect, it } from 'vitest';
import { readWav, synthesize } from '../audio';
import { fakeGemini, geminiRes } from './helpers';

/** A WAV file like Gemini 3.8 sends: fmt, the sound, then a C2PA content-credentials section. */
function geminiWav(samples: number[], extra = Buffer.alloc(6065, 0x7f)): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const chunk = (id: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(24000, 4);
  fmt.writeUInt32LE(48000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmt), chunk('data', data), chunk('C2PA', extra)]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** One second of speech-like sound: a voice-pitched tone whose loudness rises and falls like syllables. */
const tone = Array.from({ length: 24000 }, (_, i) => Math.round(8000 * Math.abs(Math.sin((Math.PI * 4 * i) / 24000)) * Math.sin((2 * Math.PI * 200 * i) / 24000)));

describe('Gemini WAV speech', () => {
  it('reads only the sound of a WAV file, not the C2PA section after it', () => {
    const w = readWav(geminiWav(tone))!;
    expect(w.rate).toBe(24000);
    expect(w.pcm.length).toBe(tone.length * 2);
    expect(w.pcm.readInt16LE(200)).toBe(tone[100]);
    expect(readWav(Buffer.from('not a wav file at all'))).toBeNull();
  });

  it('turns an audio/wav reply into clean speech (no static from the C2PA bytes)', async () => {
    const { generate } = fakeGemini([geminiRes([{ inlineData: { mimeType: 'audio/wav', data: geminiWav(tone).toString('base64') } }])]);
    const speech = (await synthesize(generate, 'gemini-3.8-flash-tts', 'Leda', 'Hi', () => undefined))!;
    expect(speech.rate).toBe(24000);
    expect(speech.durationMs).toBe(1000);
    // The last samples are the faded-out tone, not the 0x7f7f "static" of the C2PA section.
    const last = speech.pcm.readInt16LE(speech.pcm.length - 2);
    expect(Math.abs(last)).toBeLessThan(500);
    expect(speech.pcm.includes(Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]))).toBe(false);
  });

  it('still accepts raw 16-bit PCM from older speech models', async () => {
    const raw = Buffer.alloc(4800);
    const { generate } = fakeGemini([geminiRes([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: raw.toString('base64') } }])]);
    const speech = (await synthesize(generate, 'gemini-2.5-flash-preview-tts', 'Kore', 'Hi', () => undefined))!;
    expect(speech.pcm.length).toBe(4800);
    expect(speech.durationMs).toBe(100);
  });
});
