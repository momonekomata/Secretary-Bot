import type { Agent, IncomingImage } from './agent';
import { friendlyError, handleCommand, type Channel } from './channel';
import { chunkText } from './chunk';
import type { Config } from './config';

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class Telegram implements Channel {
  readonly prefix = 'telegram';
  private readonly api: string;
  private readonly fileApi: string;
  private stopped = false;

  constructor(
    private readonly cfg: Config['telegram'],
    private readonly agent: Agent,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {
    this.api = `https://api.telegram.org/bot${cfg.token}`;
    this.fileApi = `https://api.telegram.org/file/bot${cfg.token}`;
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async send(chatId: string, text: string) {
    for (const part of chunkText(text, 4000)) {
      await this.call('sendMessage', { chat_id: chatId, text: part });
    }
  }

  /** Long polling: no public URL needed. Runs until stop(). */
  async poll() {
    await this.call('deleteWebhook', { drop_pending_updates: false });
    const me = await this.call<{ username: string }>('getMe', {});
    this.log(`Telegram: polling as @${me.username}`);
    let offset = 0;
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          void this.handleUpdate(u);
        }
      } catch (e) {
        this.log('Telegram poll error:', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  /** Registers `url` as the webhook (webhook mode). */
  async setWebhook(url: string) {
    await this.call('setWebhook', {
      url,
      allowed_updates: ['message'],
      ...(this.cfg.webhookSecret ? { secret_token: this.cfg.webhookSecret } : {}),
    });
    this.log(`Telegram: webhook set to ${url}`);
  }

  /** Checks the secret header Telegram sends with every webhook call. */
  verifyWebhook(headerValue: string | undefined): boolean {
    return !this.cfg.webhookSecret || headerValue === this.cfg.webhookSecret;
  }

  async handleUpdate(u: TgUpdate) {
    const msg = u.message;
    if (!msg?.from) return;
    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const chatKey = `telegram:${chatId}`;
    const text = (msg.text ?? msg.caption ?? '').trim();

    try {
      if (text.startsWith('/id')) return await this.send(chatId, handleCommand(text, chatKey, userId, this.agent)!);
      if (!this.cfg.allowedUsers.length) {
        return await this.send(
          chatId,
          `This bot is not set up yet. Your Telegram user id is ${userId}. Put it in TELEGRAM_ALLOWED_USERS and restart the bot.`,
        );
      }
      if (!this.cfg.allowedUsers.includes(userId)) return; // a stranger: stay silent

      const command = text.startsWith('/') ? handleCommand(text, chatKey, userId, this.agent) : null;
      if (command) return await this.send(chatId, command);
      if (!text && !msg.photo) return;

      const typing = this.keepTyping(chatId);
      try {
        const images = msg.photo ? await this.downloadPhoto(msg.photo) : [];
        const reply = await this.agent.reply({ chatKey, text, images, userName: msg.from.first_name });
        await this.send(chatId, reply);
      } finally {
        clearInterval(typing);
      }
    } catch (e) {
      this.log('Telegram handler error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    }
  }

  private keepTyping(chatId: string) {
    const ping = () => this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    void ping();
    return setInterval(ping, 4500);
  }

  private async downloadPhoto(sizes: TgPhotoSize[]): Promise<IncomingImage[]> {
    // Sizes are smallest-first; take the largest that fits the API's per-image limit.
    const best = [...sizes].reverse().find((s) => (s.file_size ?? 0) <= MAX_IMAGE_BYTES);
    if (!best) return [];
    const file = await this.call<{ file_path: string }>('getFile', { file_id: best.file_id });
    const res = await fetch(`${this.fileApi}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return [{ mediaType: 'image/jpeg', data }];
  }
}
