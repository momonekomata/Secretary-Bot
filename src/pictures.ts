import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerateContentResponse } from '@google/genai';
import type { Character } from './character';
import { UserFacingError } from './documents';
import { t } from './i18n';
import { geminiUsage, type GenerateContent } from './llm/gemini';
import type { ImageInput } from './llm/types';
import type { Usage } from './models';
import type { Store } from './store';

/**
 * Pictures of the bot's character, drawn by a Gemini image model from its character sheet. A saved reference
 * portrait goes with every request so the character keeps the same face. Google's safety filters apply: requests
 * they refuse come back as a polite refusal, never as a workaround.
 */

export interface Picture {
  data: Buffer;
  mimeType: string;
  /** Anything the model said alongside the image. */
  caption: string;
}

export const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Lists model ids the key can use (e.g. "gemini-x-flash-image"), with the methods each supports. */
export type ListModels = () => Promise<{ name: string; actions: string[] }[]>;

const REFUSED = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|IMAGE_OTHER/;

/** Picks the image model: native Gemini image models (generateContent with image output), not Imagen. */
export function pickImageModel(models: { name: string; actions: string[] }[]): string | null {
  const candidates = models
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, '') }))
    .filter((m) => /image/i.test(m.id) && !/imagen|tts|embed/i.test(m.id) && (m.actions.length === 0 || m.actions.includes('generateContent')));
  const version = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  candidates.sort(
    (a, b) =>
      Number(/preview|exp/.test(a.id)) - Number(/preview|exp/.test(b.id)) || // stable first
      version(b.id) - version(a.id) || // newest first
      Number(!/flash/.test(a.id)) - Number(!/flash/.test(b.id)) || // flash (cheaper) before pro
      a.id.length - b.id.length,
  );
  return candidates[0]?.id ?? null;
}

/** The text the image model gets: who to draw (from the character sheet), the style and the scene. */
export function picturePrompt(name: string, c: Character | undefined, style: string, scene: string, hasReference: boolean): string {
  const looks = c?.looks ?? [];
  return [
    hasReference
      ? `The attached image is the reference portrait of ${name}. Draw the same character: keep the face, hair, colours and distinctive features, changing only what the scene asks for.`
      : '',
    `Draw ${name}${looks.length ? `: ${looks.join('; ')}` : ''}.`,
    c?.quirks?.length ? `Personality hints for expression and pose: ${c.quirks.slice(0, 3).join('; ')}.` : '',
    `Art style: ${style || 'clean, colourful anime illustration'}.`,
    `Scene: ${scene || 'a friendly portrait, looking at the viewer and smiling'}.`,
    'One image. Safe for work. No text, captions or watermarks in the image unless the scene asks for them.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class Pictures {
  private model: string | null = null;
  private memory: { last?: Picture; reference?: Picture } = {};
  private outbox = new Map<string, Picture[]>();

  constructor(
    private readonly opts: {
      /** v1beta Gemini client (null without a Gemini key). */
      generate: GenerateContent | null;
      listModels: ListModels;
      store: Store;
      /** data/ folder, or '' to keep pictures in memory (tests). */
      dataDir: string;
      /** IMAGE_MODEL: use this model instead of picking one. */
      model?: string;
      /** Estimated cost of one picture (USD), counted in the daily limits. */
      priceUsd: number;
      /** Throws when the daily limit is reached. */
      guard: () => void;
      onUsage: (u: Usage) => void;
    },
  ) {}

  get available(): boolean {
    return !!this.opts.generate;
  }

  private get dir() {
    return this.opts.dataDir ? join(this.opts.dataDir, 'pictures') : '';
  }

  private save(kind: 'last' | 'reference', p: Picture) {
    this.memory[kind] = p;
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${kind}.img`), p.data);
    writeFileSync(join(this.dir, `${kind}.json`), JSON.stringify({ mimeType: p.mimeType }));
  }

  private load(kind: 'last' | 'reference'): Picture | null {
    if (this.memory[kind]) return this.memory[kind]!;
    if (!this.dir || !existsSync(join(this.dir, `${kind}.img`))) return null;
    try {
      const { mimeType } = JSON.parse(readFileSync(join(this.dir, `${kind}.json`), 'utf8')) as { mimeType: string };
      return (this.memory[kind] = { data: readFileSync(join(this.dir, `${kind}.img`)), mimeType, caption: '' });
    } catch {
      return null;
    }
  }

  get hasReference(): boolean {
    return !!this.load('reference');
  }

  /** The model in use: IMAGE_MODEL, else the best image model the key can use. */
  async modelId(): Promise<string> {
    if (this.opts.model) return this.opts.model;
    if (this.model) return this.model;
    const picked = pickImageModel(await this.opts.listModels());
    if (!picked) throw new UserFacingError(t('No image model is available for this Gemini key. Set IMAGE_MODEL in .env to one that is.', 'คีย์ Gemini นี้ไม่มีโมเดลสร้างภาพให้ใช้ ตั้ง IMAGE_MODEL ใน .env เป็นโมเดลที่ใช้ได้'));
    return (this.model = picked);
  }

  /** Draws the character in `scene`. Throws UserFacingError when it can't (refused, no key, limit). */
  async draw(scene: string, opts: { aspect?: Aspect; botName: string; character?: Character; style?: string } = { botName: 'me' }): Promise<Picture> {
    const generate = this.opts.generate;
    if (!generate) throw new UserFacingError(t('🎨 Pictures need a Gemini API key (GEMINI_API_KEY).', '🎨 การวาดภาพต้องใช้คีย์ API ของ Gemini (GEMINI_API_KEY)'));
    this.opts.guard();
    const model = await this.modelId();
    const ref = this.load('reference');
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
    if (ref) parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data.toString('base64') } });
    parts.push({ text: picturePrompt(opts.botName, opts.character, opts.style ?? '', scene, !!ref) });
    let res: GenerateContentResponse;
    try {
      res = await generate({
        model,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['TEXT', 'IMAGE'], ...(opts.aspect ? { imageConfig: { aspectRatio: opts.aspect } } : {}) },
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found|is not supported|404/i.test(msg)) this.model = null; // pick again next time
      throw e;
    }
    this.opts.onUsage({ ...geminiUsage(model, res), fixedUsd: this.opts.priceUsd });
    const cand = res.candidates?.[0];
    const reason = String(cand?.finishReason ?? '');
    const img = cand?.content?.parts?.find((p) => p.inlineData?.data && (p.inlineData.mimeType ?? '').startsWith('image/'));
    if (!img?.inlineData?.data) {
      if (res.promptFeedback?.blockReason || REFUSED.test(reason)) {
        throw new UserFacingError(t("🎨 Google's image filter refused that picture. Try a different scene.", '🎨 ตัวกรองภาพของ Google ไม่ยอมวาดภาพนี้ ลองฉากอื่นดูนะ'));
      }
      throw new UserFacingError(t("🎨 The image model didn't send a picture back. Try again, or describe the scene differently.", '🎨 โมเดลไม่ได้ส่งภาพกลับมา ลองอีกครั้ง หรือบรรยายฉากใหม่'));
    }
    const caption = (cand?.content?.parts ?? [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join(' ')
      .trim();
    const pic = { data: Buffer.from(img.inlineData.data, 'base64'), mimeType: img.inlineData.mimeType ?? 'image/png', caption };
    this.save('last', pic);
    return pic;
  }

  /** Makes the last picture (or a photo the user sent) the reference portrait. Returns false if there is none. */
  setReference(from: 'last' | ImageInput): boolean {
    const p = from === 'last' ? this.load('last') : { data: Buffer.from(from.data, 'base64'), mimeType: from.mediaType, caption: '' };
    if (!p) return false;
    this.save('reference', p);
    return true;
  }

  clearReference() {
    delete this.memory.reference;
    if (this.dir) for (const f of ['reference.img', 'reference.json']) rmSync(join(this.dir, f), { force: true });
  }

  /** Queues a picture to go out with the current reply in `chatKey` (from the AI tool). */
  queue(chatKey: string, p: Picture) {
    this.outbox.set(chatKey, [...(this.outbox.get(chatKey) ?? []), p].slice(-4));
  }

  /** Takes the pictures queued for `chatKey`. */
  take(chatKey: string): Picture[] {
    const out = this.outbox.get(chatKey) ?? [];
    this.outbox.delete(chatKey);
    return out;
  }
}
