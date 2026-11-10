import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserFacingError } from './documents';
import { t } from './i18n';
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
    throw new UserFacingError(t(`I can't read ${mime} audio without ffmpeg installed on the bot.`, `อ่านไฟล์เสียง ${mime} ไม่ได้ เพราะบอทยังไม่ได้ติดตั้ง ffmpeg`));
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
  /** What Gemini sent, before cleaning (kept for diagnosis). */
  raw?: Buffer;
  mimeType?: string;
}

/** Turns text into speech with a Gemini TTS model (16-bit mono PCM). */
/**
 * Gemini speech models to try, in order. The first that works is remembered; TTS_MODEL (if set) is tried first.
 * Names change between Gemini releases, so a model that isn't available on the key just moves on to the next.
 */
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'];

/** Gemini's prebuilt voices (speech generation docs). */
export const TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina',
  'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia', 'Sadaltager', 'Sulafat',
];

/** The voice's proper name if it is one of Gemini's listed voices (any letter case), else null. */
export function findVoice(name: string): string | null {
  return TTS_VOICES.find((v) => v.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** A name that could be a voice: a listed one (properly capitalised), or any other plain name (newer models add voices). */
export function voiceName(name: string): string | null {
  return findVoice(name) ?? (/^[A-Za-z][\w-]{1,30}$/.test(name.trim()) ? name.trim() : null);
}

/** True when an error means the model itself isn't available (wrong name, retired, or no audio output). */
export function modelUnavailable(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /\b404\b|NOT_FOUND|not found|is not supported|not supported for|does not support|response modalit|AUDIO.*not/i.test(m);
}

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
  const raw = Buffer.from(part.inlineData.data, 'base64');
  const pcm = cleanTail(raw, rate);
  return { pcm, rate, durationMs: Math.round((pcm.length / 2 / rate) * 1000), raw, mimeType: part.inlineData.mimeType ?? '' };
}

/**
 * Removes a noise tail after the speech (Gemini speech sometimes ends with a burst of static) and fades out.
 * Works on 16-bit little-endian mono PCM. A tail counts as noise when it is
 * hiss for at least 260 ms (many zero crossings, like white noise), or a steady buzz for at least 400 ms.
 * Short sounds such as a final "s" are kept. Never removes more than half the clip.
 */
export function cleanTail(pcm: Buffer, rate: number): Buffer {
  const n = Math.floor(pcm.length / 2);
  const win = Math.max(1, Math.round(rate * 0.02)); // 20 ms windows
  const windows = Math.floor(n / win);
  if (windows < 10) return fadeOut(pcm.subarray(0, n * 2), rate);
  const rms: number[] = [];
  const zcr: number[] = [];
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    let crossings = 0;
    let prev = pcm.readInt16LE(w * win * 2);
    for (let i = 0; i < win; i++) {
      const v = pcm.readInt16LE((w * win + i) * 2);
      sum += v * v;
      if ((v >= 0) !== (prev >= 0)) crossings++;
      prev = v;
    }
    rms.push(Math.sqrt(sum / win));
    zcr.push(crossings / win);
  }
  const loudest = [...rms].sort((a, b) => a - b)[Math.floor(windows * 0.95)] || 1;
  const silent = (w: number) => rms[w] < loudest * 0.02;
  // Walk back over trailing silence, then over the noise run.
  let end = windows;
  while (end > 0 && silent(end - 1)) end--;
  let start = end;
  const hiss = (w: number) => zcr[w] > 0.3 && rms[w] > loudest * 0.02;
  while (start > 0 && hiss(start - 1)) start--;
  let cut = end - start >= 13 ? start : -1; // >= 260 ms of hiss
  if (cut < 0) {
    // Steady noise (a buzz): loudness within ±20% of the tail's median for >= 400 ms (longer and steadier than a held vowel).
    let s = end;
    while (s > 0 && end - s < windows / 2) {
      const run = rms.slice(s - 1, end).sort((a, b) => a - b);
      const median = run[Math.floor(run.length / 2)];
      if (median < loudest * 0.02 || run[0] < median * 0.8 || run[run.length - 1] > median * 1.2) break;
      s--;
    }
    if (end - s >= 20) cut = s;
  }
  if (cut < 0 || cut < windows / 2) return fadeOut(pcm.subarray(0, n * 2), rate);
  return fadeOut(pcm.subarray(0, cut * win * 2), rate);
}

/** A 30 ms fade at the end, so the clip never stops on a click. */
function fadeOut(pcm: Buffer, rate: number): Buffer {
  const out = Buffer.from(pcm);
  const n = Math.floor(out.length / 2);
  const len = Math.min(n, Math.round(rate * 0.03));
  for (let i = 0; i < len; i++) {
    const at = (n - len + i) * 2;
    out.writeInt16LE(Math.round(out.readInt16LE(at) * (1 - (i + 1) / len)), at);
  }
  return out;
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
