import { describe, expect, it } from 'vitest';
import { cleanTail } from '../audio';

const RATE = 24000;

/** Speech-like sound: a voice-pitched tone whose loudness rises and falls like syllables. */
function speech(seconds: number): number[] {
  return Array.from({ length: Math.round(RATE * seconds) }, (_, i) => {
    const syllable = Math.abs(Math.sin((Math.PI * 4 * i) / RATE)); // 4 syllables a second
    return 12000 * syllable * Math.sin((2 * Math.PI * 180 * i) / RATE) + 1500 * Math.sin((2 * Math.PI * 900 * i) / RATE) * syllable;
  });
}
let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const hiss = (seconds: number, level = 9000) => Array.from({ length: Math.round(RATE * seconds) }, () => level * random());
const buzz = (seconds: number) => Array.from({ length: Math.round(RATE * seconds) }, (_, i) => 9000 * Math.sin((2 * Math.PI * 50 * i) / RATE));
const pcm = (samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2));
  return b;
};
const seconds = (b: Buffer) => b.length / 2 / RATE;

describe('cleaning the end of a speech clip', () => {
  it('cuts a burst of static after the speech', () => {
    const out = cleanTail(pcm([...speech(2), ...hiss(0.6)]), RATE);
    expect(seconds(out)).toBeGreaterThan(1.9);
    expect(seconds(out)).toBeLessThan(2.05);
  });

  it('cuts a steady buzz after the speech, and static that follows a pause', () => {
    expect(seconds(cleanTail(pcm([...speech(2), ...buzz(0.6)]), RATE))).toBeLessThan(2.05);
    const paused = cleanTail(pcm([...speech(2), ...new Array(RATE * 0.2).fill(0), ...hiss(0.5)]), RATE);
    expect(seconds(paused)).toBeLessThan(2.25);
  });

  it('keeps clean speech and a short final "s", and fades out to silence', () => {
    const clean = cleanTail(pcm(speech(2)), RATE);
    expect(seconds(clean)).toBeCloseTo(2, 2);
    expect(Math.abs(clean.readInt16LE(clean.length - 2))).toBeLessThan(50);
    const withS = cleanTail(pcm([...speech(2), ...hiss(0.12, 4000)]), RATE);
    expect(seconds(withS)).toBeCloseTo(2.12, 2);
  });

  it('never removes more than half a clip', () => {
    const mostlyNoise = cleanTail(pcm([...speech(0.5), ...hiss(1.5)]), RATE);
    expect(seconds(mostlyNoise)).toBeCloseTo(2, 2);
  });
});
