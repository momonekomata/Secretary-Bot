import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Agent, IncomingImage } from './agent';
import { friendlyError, handleCommand, type Channel } from './channel';
import { chunkText } from './chunk';
import type { Config } from './config';

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
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/** LINE signs each webhook body with the channel secret: base64(HMAC-SHA256(secret, body)). */
export function verifyLineSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class Line implements Channel {
  readonly prefix = 'line';
  private seen = new Set<string>();

  constructor(
    private readonly cfg: Config['line'],
    private readonly agent: Agent,
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

  private textMessages(text: string) {
    // A reply/push carries at most 5 messages of at most 5000 chars.
    return chunkText(text, 4900)
      .slice(0, 5)
      .map((t) => ({ type: 'text', text: t }));
  }

  /** Push message (used for reminders, and when a reply token has expired). */
  async send(to: string, text: string) {
    await this.post('/message/push', { to, messages: this.textMessages(text) });
  }

  /** Reply tokens are free but short-lived; fall back to a push if the agent took too long. */
  private async respond(replyToken: string | undefined, to: string, text: string) {
    if (replyToken) {
      try {
        return await this.post('/message/reply', { replyToken, messages: this.textMessages(text) });
      } catch (e) {
        this.log('LINE reply failed, pushing instead:', (e as Error).message);
      }
    }
    await this.send(to, text);
  }

  /** Call with the raw request body after the signature has been verified. */
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
    const userId = ev.source.userId;
    const chatId = ev.source.groupId ?? ev.source.roomId ?? userId;
    const chatKey = `line:${chatId}`;
    const text = (ev.message.text ?? '').trim();

    try {
      if (text.startsWith('/id')) return await this.respond(ev.replyToken, chatId, handleCommand(text, chatKey, userId, this.agent)!);
      if (!this.cfg.allowedUsers.length) {
        return await this.respond(
          ev.replyToken,
          chatId,
          `This bot is not set up yet. Your LINE user id is ${userId}. Put it in LINE_ALLOWED_USERS and restart the bot.`,
        );
      }
      if (!this.cfg.allowedUsers.includes(userId)) return;

      const command = text.startsWith('/') ? handleCommand(text, chatKey, userId, this.agent) : null;
      if (command) return await this.respond(ev.replyToken, chatId, command);
      if (ev.message.type !== 'text' && ev.message.type !== 'image') return;

      if (chatId === userId) await this.post('/chat/loading/start', { chatId: userId, loadingSeconds: 60 }).catch(() => undefined);
      const images = ev.message.type === 'image' ? await this.downloadImage(ev.message.id) : [];
      const reply = await this.agent.reply({ chatKey, text, images });
      await this.respond(ev.replyToken, chatId, reply);
    } catch (e) {
      this.log('LINE handler error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    }
  }

  private async downloadImage(messageId: string): Promise<IncomingImage[]> {
    const res = await fetch(`${DATA_API}/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
    });
    if (!res.ok) throw new Error(`LINE content ${res.status}`);
    const type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0] as IncomingImage['mediaType'];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(type)) return [];
    return [{ mediaType: type, data: buf.toString('base64') }];
  }
}
