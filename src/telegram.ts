import type { IncomingImage } from './agent';
import { friendlyError, type Channel, type IncomingMessage, type Secretary } from './channel';
import { chunkText } from './chunk';
import type { Button, CommandReply } from './commands';
import type { Config } from './config';
import { hasFfmpeg, toOggOpus } from './audio';
import { MAX_FILE_BYTES, UserFacingError } from './documents';
import type { AudioInput } from './voice';

interface TgUser {
  id: number;
  first_name?: string;
}
interface TgFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  voice?: TgFile;
  audio?: TgFile;
  document?: TgFile;
  location?: { latitude: number; longitude: number };
}
interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Inline audio sent to Gemini must stay well under its 20 MB request limit. */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function inlineKeyboard(buttons?: Button[][]) {
  if (!buttons?.length) return undefined;
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.command.slice(0, 64) }))) };
}

export class Telegram implements Channel {
  readonly prefix = 'telegram';
  private readonly api: string;
  private readonly fileApi: string;
  private stopped = false;

  constructor(
    private readonly cfg: Config['telegram'],
    private readonly secretary: Secretary,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {
    this.api = `https://api.telegram.org/bot${cfg.token}`;
    this.fileApi = `https://api.telegram.org/file/bot${cfg.token}`;
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async send(chatId: string, text: string, buttons?: Button[][]) {
    const parts = chunkText(text, 4000);
    for (const [i, part] of parts.entries()) {
      const markup = i === parts.length - 1 ? inlineKeyboard(buttons) : undefined;
      await this.call('sendMessage', { chat_id: chatId, text: part, ...(markup ? { reply_markup: markup } : {}) });
    }
  }

  async sendFile(chatId: string, name: string, data: Buffer, caption: string) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([data]), name);
    const res = await fetch(`${this.api}/sendDocument`, { method: 'POST', body: form });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`Telegram sendDocument: ${json.description ?? res.status}`);
  }

  /** Sends an Ogg/Opus voice bubble. */
  async sendVoice(chatId: string, ogg: Buffer, durationMs: number) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('duration', String(Math.max(1, Math.round(durationMs / 1000))));
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'reply.ogg');
    const res = await fetch(`${this.api}/sendVoice`, { method: 'POST', body: form });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`Telegram sendVoice: ${json.description ?? res.status}`);
  }

  private async sendReply(chatId: string, reply: CommandReply) {
    if (reply.file) await this.sendFile(chatId, reply.file.name, reply.file.data, reply.text);
    else if (reply.text) await this.send(chatId, reply.text, reply.buttons);
    if (!reply.speak) return;
    try {
      if (!hasFfmpeg()) throw new Error('ffmpeg is not installed');
      await this.call('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => undefined);
      const speech = await this.secretary.speech(reply.speak);
      if (!speech) throw new Error('no audio returned');
      await this.sendVoice(chatId, await toOggOpus(speech), speech.durationMs);
    } catch (e) {
      this.log('Spoken reply failed:', (e as Error).message);
      if (!reply.text) await this.send(chatId, reply.speak);
    }
  }

  /** Long polling: no public URL needed. Runs until stop(). */
  async poll() {
    await this.call('deleteWebhook', { drop_pending_updates: false });
    const me = await this.call<{ username: string }>('getMe', {});
    this.log(`Telegram: polling as @${me.username}`);
    await this.registerCommands().catch((e) => this.log('Telegram setMyCommands failed:', (e as Error).message));
    let offset = 0;
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
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

  /** Fills Telegram's "/" command menu. */
  private registerCommands() {
    const commands: [string, string][] = [
      ['brief', 'Morning briefing now'],
      ['news', 'News digest (optionally: /news topic)'],
      ['weather', "Today's weather and air quality"],
      ['forecast', '7-day forecast'],
      ['weekend', 'Weekend weather planner'],
      ['kanji', 'Kanji of the day'],
      ['word', 'Japanese word of the day'],
      ['food', "Today's food and calories"],
      ['bmi', 'BMI, BMR and calorie target'],
      ['roleplay', 'Start a roleplay or Japanese practice scene'],
      ['todo', 'Show to-do list'],
      ['add', 'Add a to-do'],
      ['calendar', 'Upcoming Google Calendar events'],
      ['inbox', 'Unread Gmail'],
      ['gtask', 'Google Tasks (list, or add with text)'],
      ['topics', 'News watchlist'],
      ['persona', 'Choose my personality'],
      ['settings', 'AI model, effort, voice translation'],
      ['stats', 'AI usage and cost'],
      ['status', 'Check connections'],
      ['help', 'Everything I can do'],
    ];
    return this.call('setMyCommands', { commands: commands.map(([command, description]) => ({ command, description })) });
  }

  /** Registers `url` as the webhook (webhook mode). */
  async setWebhook(url: string) {
    await this.call('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      ...(this.cfg.webhookSecret ? { secret_token: this.cfg.webhookSecret } : {}),
    });
    this.log(`Telegram: webhook set to ${url}`);
    await this.registerCommands().catch(() => undefined);
  }

  /** Checks the secret header Telegram sends with every webhook call. */
  verifyWebhook(headerValue: string | undefined): boolean {
    return !this.cfg.webhookSecret || headerValue === this.cfg.webhookSecret;
  }

  async handleUpdate(u: TgUpdate) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.from) return;
    const chatId = String(msg.chat.id);
    const incoming: IncomingMessage = {
      platform: 'telegram',
      chatKey: `telegram:${chatId}`,
      userId: String(msg.from.id),
      userName: msg.from.first_name,
      text: (msg.text ?? msg.caption ?? '').trim(),
    };
    const voice = msg.voice ?? msg.audio;
    if (msg.location) incoming.location = { lat: msg.location.latitude, lon: msg.location.longitude };
    if (!incoming.text && !msg.photo && !voice && !msg.document && !msg.location) return;

    let typing: NodeJS.Timeout | undefined;
    try {
      if (this.secretary.isSlow(incoming) && this.cfg.allowedUsers.includes(incoming.userId)) typing = this.keepTyping(chatId);
      if (this.cfg.allowedUsers.includes(incoming.userId)) {
        if (msg.photo) incoming.images = await this.downloadPhoto(msg.photo);
        if (voice) incoming.audio = await this.downloadAudio(voice);
        if (msg.document) incoming.file = await this.downloadDocument(msg.document);
      }
      const reply = await this.secretary.handle(incoming);
      if (reply) await this.sendReply(chatId, reply);
    } catch (e) {
      this.log('Telegram handler error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    } finally {
      clearInterval(typing);
    }
  }

  /** A tap on an inline button: run its command and update the message in place. */
  private async handleCallback(q: TgCallback) {
    await this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
    const msg = q.message;
    if (!msg || !q.data) return;
    const chatId = String(msg.chat.id);
    try {
      const reply = await this.secretary.handle({ platform: 'telegram', chatKey: `telegram:${chatId}`, userId: String(q.from.id), text: q.data });
      if (!reply) return;
      const markup = inlineKeyboard(reply.buttons);
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: msg.message_id,
        text: reply.text.slice(0, 4000),
        ...(markup ? { reply_markup: markup } : {}),
      }).catch(() => this.sendReply(chatId, reply));
    } catch (e) {
      this.log('Telegram callback error:', e);
      await this.send(chatId, friendlyError(e)).catch(() => undefined);
    }
  }

  private keepTyping(chatId: string) {
    const ping = () => this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    void ping();
    return setInterval(ping, 4500);
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path: string }>('getFile', { file_id: fileId });
    const res = await fetch(`${this.fileApi}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async downloadPhoto(sizes: TgFile[]): Promise<IncomingImage[]> {
    // Sizes are smallest-first; take the largest that fits the per-image limit.
    const best = [...sizes].reverse().find((s) => (s.file_size ?? 0) <= MAX_IMAGE_BYTES);
    if (!best) return [];
    return [{ mediaType: 'image/jpeg', data: (await this.download(best.file_id)).toString('base64') }];
  }

  private async downloadDocument(f: TgFile): Promise<IncomingMessage['file']> {
    const name = f.file_name ?? 'file';
    // Bots can only download files up to 20 MB from Telegram.
    if ((f.file_size ?? 0) > MAX_FILE_BYTES) throw new UserFacingError(`${name} is too big for me (max about 15 MB).`);
    return { name, mime: f.mime_type ?? 'application/octet-stream', data: await this.download(f.file_id) };
  }

  private async downloadAudio(f: TgFile): Promise<AudioInput | undefined> {
    if ((f.file_size ?? 0) > MAX_AUDIO_BYTES) throw new UserFacingError('That voice note is too long for me (max about 15 MB).');
    // Telegram voice notes are Ogg/Opus, which Gemini reads directly.
    return { mimeType: f.mime_type ?? 'audio/ogg', data: (await this.download(f.file_id)).toString('base64') };
  }
}
