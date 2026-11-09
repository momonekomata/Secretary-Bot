import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserFacingError } from './documents';
import { geminiUsage, type GenerateContent } from './llm/gemini';
import type { Usage } from './models';
import type { AudioInput } from './voice';

let ffmpegChecked: boolean | null = null;

/** True when the ffmpeg program is installed (it is in the Docker image). */
export function hasFfmpeg(): boolean {
  if (ffmpegChecked === null) ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  return ffmpegChecked;
}

/** Runs ffmpeg with temp files (works for every container format, including .m4a). */
export function ffmpeg(input: Buffer, inExt: string, outExt: string, args: string[]): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'sb-audio-'));
  const inFile = join(dir, `in.${inExt}`);
  const outFile = join(dir, `out.${outExt}`);
  writeFileSync(inFile, input);
  return new Promise<Buffer>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, ...args, outFile]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      try {
        if (code === 0) resolve(readFileSync(outFile));
        else reject(new Error(`ffmpeg failed: ${err.slice(0, 200)}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

/** Formats Gemini reads directly. */
const GEMINI_AUDIO = new Set(['audio/ogg', 'audio/opus', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/aiff']);

/**
 * Makes a voice message readable by Gemini. Telegram's Ogg/Opus passes through; LINE's .m4a (and other
 * formats) are converted to Ogg/Opus with ffmpeg.
 */
export async function toGeminiAudio(a: AudioInput): Promise<AudioInput> {
  const mime = a.mimeType.split(';')[0].toLowerCase();
  if (GEMINI_AUDIO.has(mime)) return { ...a, mimeType: mime === 'audio/mpeg' ? 'audio/mp3' : mime };
  if (!hasFfmpeg()) {
    // Best effort: M4A holds AAC audio, which Gemini may accept.
    if (/m4a|mp4/.test(mime)) return { ...a, mimeType: 'audio/aac' };
    throw new UserFacingError(`I can't read ${mime} audio without ffmpeg installed on the bot.`);
  }
  const out = await ffmpeg(Buffer.from(a.data, 'base64'), mime.includes('m4a') || mime.includes('mp4') ? 'm4a' : 'bin', 'ogg', ['-ac', '1', '-c:a', 'libopus', '-b:a', '32k']);
  return { mimeType: 'audio/ogg', data: out.toString('base64') };
}

/** Text that reads well aloud: no emoji, bullets or links. */
export function speakable(text: string, max = 1500): string {
  const clean = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/^[\s•\-*]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), max / 2) + 1).trim();
}

export interface Speech {
  pcm: Buffer;
  rate: number;
  durationMs: number;
}

/** Turns text into speech with a Gemini TTS model (16-bit mono PCM). */
export async function synthesize(generate: GenerateContent, model: string, voice: string, text: string, onUsage: (u: Usage) => void): Promise<Speech | null> {
  const res = await generate({
    model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  onUsage(geminiUsage(model, res));
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) return null;
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000);
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  return { pcm, rate, durationMs: Math.round((pcm.length / 2 / rate) * 1000) };
}

/** Telegram voice bubble: Ogg/Opus. */
export const toOggOpus = (s: Speech) => ffmpeg(wav(s), 'wav', 'ogg', ['-c:a', 'libopus', '-b:a', '32k']);
/** LINE audio message: M4A (AAC). */
export const toM4a = (s: Speech) => ffmpeg(wav(s), 'wav', 'm4a', ['-c:a', 'aac', '-b:a', '64k']);

/** WAV container for raw PCM (no ffmpeg needed). */
export function wav(s: Speech): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + s.pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(s.rate, 24);
  h.writeUInt32LE(s.rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(s.pcm.length, 40);
  return Buffer.concat([h, s.pcm]);
}
