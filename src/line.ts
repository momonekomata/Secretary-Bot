import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingImage } from './agent';
import { friendlyError, type Channel, type IncomingMessage, type Secretary } from './channel';
import { chunkText } from './chunk';
import type { Button } from './commands';
import type { Config } from './config';
import type { AudioInput } from './voice';

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
  message?: { id: string; type: string; text?: string };
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
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {}

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
  private async respond(replyToken: string | undefined, to: string, text: string, buttons?: Button[][]) {
    if (replyToken) {
      try {
        return await this.post('/message/reply', { replyToken, messages: textMessages(text, buttons) });
      } catch (e) {
        this.log('LINE reply failed, pushing instead:', (e as Error).message);
      }
    }
    await this.send(to, text, buttons);
  }

  /** Call with the parsed request body after the signature has been verified. */
  async handleWebhook(body: { events?: LineEvent[] }) {
    await Promise.all((body.events ?? []).map((e) => this.handleEvent(e)));
  }

  async handleEvent(ev: LineEvent) {
    if (ev.webhookEventId) {
      if (this.seen.has(ev.webhookEventId)) return; // LINE redelivery
      this.seen.add(ev.webhookEventId);
      if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    }
    if (ev.type !== 'message' || !ev.message || !ev.source.userId) return;
    if (!['text', 'image', 'audio'].includes(ev.message.type)) return;
    const userId = ev.source.userId;
    const chatId = ev.source.groupId ?? ev.source.roomId ?? userId;
    const incoming: IncomingMessage = { platform: 'line', chatKey: `line:${chatId}`, userId, text: (ev.message.text ?? '').trim() };

    try {
      const allowed = this.cfg.allowedUsers.includes(userId);
      if (allowed && this.secretary.isSlow(incoming) && chatId === userId) {
        await this.post('/chat/loading/start', { chatId: userId, loadingSeconds: 60 }).catch(() => undefined);
      }
      if (allowed && ev.message.type === 'image') incoming.images = await this.downloadImage(ev.message.id);
      if (allowed && ev.message.type === 'audio') incoming.audio = await this.downloadAudio(ev.message.id);
      const reply = await this.secretary.handle(incoming);
      if (reply) {
        const text = reply.file ? `${reply.text}\n(Saved on the bot as backups/${reply.file.name}.)` : reply.text;
        await this.respond(ev.replyToken, chatId, text, reply.buttons);
      }
    } catch (e) {
      this.log('LINE handler error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    }
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
    if (buf.length > MAX_AUDIO_BYTES) throw new Error('That voice note is too long for me (max about 15 MB).');
    // LINE voice messages are M4A (AAC audio).
    return { mimeType: !type || type.includes('m4a') ? 'audio/aac' : type, data: buf.toString('base64') };
  }
}
