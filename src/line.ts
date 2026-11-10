import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingImage } from './agent';
import { friendlyError, speechFailed, type Channel, type IncomingMessage, type Secretary } from './channel';
import { chunkText } from './chunk';
import type { Button } from './commands';
import type { Config } from './config';
import { hasFfmpeg, toM4a } from './audio';
import { fileTooBig, MAX_FILE_BYTES, UserFacingError, voiceTooLong } from './documents';
import { t } from './i18n';
import type { FileHost } from './files';
import type { AudioInput } from './voice';

/** Where to get a file the bot made: a download link, or where it was saved when there is no public address. */
function fileNote(name: string, link: string | null): string {
  return link
    ? `⬇️ ${link}\n${t('(link works for 7 days)', '(ลิงก์ใช้ได้ 7 วัน)')}`
    : t(`(Saved on the bot as backups/${name}.)`, `(บันทึกไว้ในบอทที่ backups/${name})`);
}

interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}
export interface LineEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source: LineSource;
  message?: {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    latitude?: number;
    longitude?: number;
    /** Set on each image of several sent together. */
    imageSet?: { id: string; index?: number; total?: number };
  };
}

const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/** LINE signs each webhook body with the channel secret: base64(HMAC-SHA256(secret, body)). */
export function verifyLineSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** LINE has no inline keyboards; buttons become quick-reply chips (max 13, labels max 20 characters, cut on whole characters). */
export function quickReply(buttons?: Button[][]) {
  const items = (buttons ?? []).flat().slice(0, 13);
  if (!items.length) return undefined;
  return { items: items.map((b) => ({ type: 'action', action: { type: 'message', label: Array.from(b.label).slice(0, 20).join(''), text: b.command } })) };
}

export function textMessages(text: string, buttons?: Button[][]) {
  // A reply/push carries at most 5 messages of at most 5000 chars.
  const parts = chunkText(text, 4900).slice(0, 5);
  const qr = quickReply(buttons);
  return parts.map((t, i) => ({ type: 'text', text: t, ...(qr && i === parts.length - 1 ? { quickReply: qr } : {}) }));
}

export class Line implements Channel {
  readonly prefix = 'line';
  private seen = new Set<string>();

  constructor(
    private readonly cfg: Config['line'],
    private readonly secretary: Secretary,
    private readonly files: FileHost | null = null,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {}

  /** Points the LINE channel's webhook at PUBLIC_URL/line, so it survives address changes without the console. */
  async setWebhook(publicUrl: string) {
    const res = await fetch(`${API}/channel/webhook/endpoint`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.accessToken}` },
      body: JSON.stringify({ endpoint: `${publicUrl}/line` }),
    });
    if (!res.ok) throw new Error(`LINE set webhook: ${res.status} ${await res.text()}`);
    this.log(`LINE: webhook set to ${publicUrl}/line`);
  }

  /** LINE can't take file uploads from bots: send a download link (needs PUBLIC_URL). */
  async sendFile(to: string, name: string, data: Buffer, caption: string) {
    const link = this.files?.enabled ? this.files.add(name, 'application/octet-stream', data, 7 * 24 * 3600_000) : null;
    await this.send(to, `${caption}\n${fileNote(name, link)}`);
  }

  /** A LINE audio message for `text`, when spoken replies are possible (Gemini key, ffmpeg, PUBLIC_URL). */
  /** The spoken reply as a LINE audio message, or the reason it couldn't be made. */
  private async audioMessage(text: string): Promise<{ audio: { type: string; originalContentUrl: string; duration: number } | null; error?: string }> {
    if (!this.files?.enabled) return { audio: null, error: `🔇 ${t('Voice replies on LINE need PUBLIC_URL (see SETUP-GUIDE.md).', 'การตอบเป็นเสียงใน LINE ต้องตั้ง PUBLIC_URL ก่อน (ดู SETUP-GUIDE.md)')}` };
    try {
      if (!hasFfmpeg()) throw new Error('ffmpeg is not installed');
      const speech = await this.secretary.speech(text);
      if (!speech) throw new Error('no audio returned');
      const url = this.files.add('reply.m4a', 'audio/mp4', await toM4a(speech), 3600_000);
      return { audio: { type: 'audio', originalContentUrl: url, duration: speech.durationMs } };
    } catch (e) {
      this.log('Spoken reply failed:', (e as Error).message);
      return { audio: null, error: speechFailed(e) };
    }
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LINE ${path}: ${res.status} ${await res.text()}`);
  }

  /** Push message (used for reminders and briefings, and when a reply token has expired). */
  async send(to: string, text: string, buttons?: Button[][]) {
    await this.post('/message/push', { to, messages: textMessages(text, buttons) });
  }

  /** Reply tokens are free but short-lived; fall back to a push if the work took too long. */
  private async respond(replyToken: string | undefined, to: string, text: string, buttons?: Button[][], extra: object[] = []) {
    const messages = [...(text ? textMessages(text, buttons) : []), ...extra].slice(-5);
    if (!messages.length) return;
    if (replyToken) {
      try {
        return await this.post('/message/reply', { replyToken, messages });
      } catch (e) {
        this.log('LINE reply failed, pushing instead:', (e as Error).message);
      }
    }
    await this.post('/message/push', { to, messages });
  }

  /** Call with the parsed request body after the signature has been verified. */
  async handleWebhook(body: { events?: LineEvent[] }) {
    await Promise.all((body.events ?? []).map((e) => this.handleEvent(e)));
  }

  async handleEvent(ev: LineEvent, prepared?: IncomingMessage) {
    if (ev.webhookEventId) {
      if (this.seen.has(ev.webhookEventId)) return; // LINE redelivery
      this.seen.add(ev.webhookEventId);
      if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    }
    if (ev.type !== 'message' || !ev.message || !ev.source.userId) return;
    if (!['text', 'image', 'audio', 'file', 'location'].includes(ev.message.type)) return;
    const userId = ev.source.userId;
    const chatId = ev.source.groupId ?? ev.source.roomId ?? userId;
    const incoming: IncomingMessage = prepared ?? { platform: 'line', chatKey: `line:${chatId}`, userId, text: (ev.message.text ?? '').trim() };
    if (ev.message.type === 'location' && ev.message.latitude !== undefined && ev.message.longitude !== undefined) {
      incoming.location = { lat: ev.message.latitude, lon: ev.message.longitude };
    }

    const set = ev.message.type === 'image' ? ev.message.imageSet : undefined;
    if (set?.id && (set.total ?? 0) > 1 && this.cfg.allowedUsers.includes(userId)) return this.collectImageSet(ev, { id: set.id, index: set.index ?? 0, total: set.total ?? 1 }, incoming);

    try {
      const allowed = this.cfg.allowedUsers.includes(userId);
      if (allowed && this.secretary.isSlow(incoming) && chatId === userId) {
        await this.post('/chat/loading/start', { chatId: userId, loadingSeconds: 60 }).catch(() => undefined);
      }
      if (allowed && ev.message.type === 'image' && !incoming.images) incoming.images = await this.downloadImage(ev.message.id);
      if (allowed && ev.message.type === 'audio') incoming.audio = await this.downloadAudio(ev.message.id);
      if (allowed && ev.message.type === 'file') {
        const name = ev.message.fileName ?? 'file';
        if ((ev.message.fileSize ?? 0) > MAX_FILE_BYTES) throw new UserFacingError(fileTooBig(name));
        const { type, buf } = await this.content(ev.message.id);
        incoming.file = { name, mime: type || 'application/octet-stream', data: buf };
      }
      let reply = await this.secretary.handle(incoming);
      if (reply) {
        let text = reply.text;
        if (reply.file) {
          const link = this.files?.enabled ? this.files.add(reply.file.name, 'application/octet-stream', reply.file.data, 7 * 24 * 3600_000) : null;
          text += `\n${fileNote(reply.file.name, link)}`;
        }
        if (reply.samples) {
          text = `${t('🎧 Voice samples play on Telegram. You can still pick a voice here:', '🎧 ตัวอย่างเสียงเล่นได้ใน Telegram แต่เลือกเสียงที่นี่ได้:')}`;
          reply = { ...reply, buttons: reply.samples.footer.buttons };
        }
        const spoken = reply.speak ? await this.audioMessage(reply.speak) : null;
        if (spoken?.error) text = [text || reply.speak, spoken.error].filter(Boolean).join('\n\n');
        await this.respond(ev.replyToken, chatId, text, reply.buttons, spoken?.audio ? [spoken.audio] : []);
      }
    } catch (e) {
      this.log('LINE handler error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    }
  }

  private imageSets = new Map<string, { images: { index: number; img: IncomingImage[] }[]; first: LineEvent; timer?: NodeJS.Timeout; done: Promise<void>; resolve: () => void }>();
  /** How long to wait for the rest of a set of images. */
  imageSetWaitMs = 3000;

  /** Several images sent together arrive as separate events: gather them and answer once (e.g. a batch of payment slips). */
  private async collectImageSet(ev: LineEvent, set: { id: string; index: number; total: number }, incoming: IncomingMessage): Promise<void> {
    let entry = this.imageSets.get(set.id);
    if (!entry) {
      let resolve = () => {};
      const done = new Promise<void>((r) => (resolve = r));
      entry = { images: [], first: ev, done, resolve };
      this.imageSets.set(set.id, entry);
    }
    const e = entry;
    const finish = () => {
      clearTimeout(e.timer);
      if (this.imageSets.get(set.id) !== e) return;
      this.imageSets.delete(set.id);
      const images = [...e.images].sort((a, b) => a.index - b.index).flatMap((x) => x.img).slice(0, 10);
      void this.handleEvent({ ...e.first, webhookEventId: undefined, message: { ...e.first.message!, imageSet: undefined } }, { ...incoming, images }).finally(e.resolve);
    };
    clearTimeout(e.timer);
    e.timer = setTimeout(finish, this.imageSetWaitMs);
    try {
      e.images.push({ index: set.index, img: await this.downloadImage(ev.message!.id) });
    } catch (err) {
      this.log('LINE image download failed:', (err as Error).message);
      e.images.push({ index: set.index, img: [] });
    }
    if (e.images.length >= set.total) finish();
    return e.done;
  }

  private async content(messageId: string): Promise<{ type: string; buf: Buffer }> {
    const res = await fetch(`${DATA_API}/message/${messageId}/content`, { headers: { Authorization: `Bearer ${this.cfg.accessToken}` } });
    if (!res.ok) throw new Error(`LINE content ${res.status}`);
    return { type: (res.headers.get('content-type') ?? '').split(';')[0], buf: Buffer.from(await res.arrayBuffer()) };
  }

  private async downloadImage(messageId: string): Promise<IncomingImage[]> {
    const { type, buf } = await this.content(messageId);
    const mediaType = (type || 'image/jpeg') as IncomingImage['mediaType'];
    if (buf.length > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(mediaType)) return [];
    return [{ mediaType, data: buf.toString('base64') }];
  }

  private async downloadAudio(messageId: string): Promise<AudioInput> {
    const { type, buf } = await this.content(messageId);
    if (buf.length > MAX_AUDIO_BYTES) throw new UserFacingError(voiceTooLong());
    // LINE voice messages are M4A; toGeminiAudio converts them with ffmpeg.
    return { mimeType: !type || type === 'application/octet-stream' ? 'audio/m4a' : type, data: buf.toString('base64') };
  }
}
