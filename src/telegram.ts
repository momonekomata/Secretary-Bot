import type { IncomingImage } from './agent';
import { friendlyError, speechFailed, type Channel, type IncomingMessage, type Secretary } from './channel';
import { chunkText } from './chunk';
import type { Button, CommandReply } from './commands';
import type { Config } from './config';
import { hasFfmpeg, toOggOpus } from './audio';
import { fileTooBig, MAX_FILE_BYTES, UserFacingError, voiceTooLong } from './documents';
import { lang, type Lang } from './i18n';
import { menuFor } from './menu';
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
  /** Set on each photo of an album sent together. */
  media_group_id?: string;
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
  /** Albums being collected: Telegram delivers each photo of an album as its own message. */
  private albums = new Map<string, { msgs: TgMessage[]; timer?: NodeJS.Timeout; done: Promise<void>; resolve: () => void }>();
  /** How long to wait for the rest of an album. */
  albumWaitMs = 1500;

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
    await this.sendSpeech(chatId, reply);
  }

  /** Sends the spoken part of a reply as a voice bubble; on failure says why (and gives the text). */
  private async sendSpeech(chatId: string, reply: CommandReply) {
    if (!reply.speak) return;
    try {
      if (!hasFfmpeg()) throw new Error('ffmpeg is not installed');
      await this.call('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => undefined);
      const speech = await this.secretary.speech(reply.speak);
      if (!speech) throw new Error('no audio returned');
      await this.sendVoice(chatId, await toOggOpus(speech), speech.durationMs);
    } catch (e) {
      this.log('Spoken reply failed:', (e as Error).message);
      await this.send(chatId, reply.text ? speechFailed(e) : `${reply.speak}\n\n${speechFailed(e)}`).catch(() => undefined);
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

  /** Language the "/" menu was last registered in. */
  private menuLang: Lang | null = null;

  /** Fills Telegram's "/" command menu with every command, described in the user's language. */
  private registerCommands() {
    const language = lang();
    return this.call('setMyCommands', { commands: menuFor(language) }).then(() => {
      this.menuLang = language;
    });
  }

  /** Re-registers the menu after the language changed (e.g. a preference for Thai was added). */
  private syncMenu() {
    if (this.menuLang !== null && this.menuLang !== lang()) {
      void this.registerCommands().catch((e) => this.log('Telegram setMyCommands failed:', (e as Error).message));
    }
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
    if (msg.media_group_id && msg.photo) return this.collectAlbum(msg);
    return this.handleMessage(msg);
  }

  /** Waits for the rest of an album, then handles all its photos as one message (e.g. several payment slips). */
  private collectAlbum(msg: TgMessage): Promise<void> {
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    let album = this.albums.get(key);
    if (!album) {
      let resolve = () => {};
      const done = new Promise<void>((r) => (resolve = r));
      album = { msgs: [], done, resolve };
      this.albums.set(key, album);
    }
    const a = album;
    a.msgs.push(msg);
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      this.albums.delete(key);
      const first = a.msgs.find((m) => m.caption) ?? a.msgs[0];
      void this.handleMessage(first, a.msgs.filter((m) => m !== first).map((m) => m.photo!)).finally(a.resolve);
    }, this.albumWaitMs);
    return a.done;
  }

  private async handleMessage(msg: TgMessage & { from?: TgUser }, morePhotos: TgFile[][] = []) {
    if (!msg.from) return;
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
        if (msg.photo) {
          const all = await Promise.all([msg.photo, ...morePhotos].slice(0, 10).map((p) => this.downloadPhoto(p)));
          incoming.images = all.flat();
        }
        if (voice) incoming.audio = await this.downloadAudio(voice);
        if (msg.document) incoming.file = await this.downloadDocument(msg.document);
      }
      const reply = await this.secretary.handle(incoming);
      this.syncMenu();
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
      this.syncMenu();
      if (!reply) return;
      const markup = inlineKeyboard(reply.buttons);
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: msg.message_id,
        text: reply.text.slice(0, 4000),
        ...(markup ? { reply_markup: markup } : {}),
      })
        .then(() => this.sendSpeech(chatId, reply))
        .catch(() => this.sendReply(chatId, reply));
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
    if ((f.file_size ?? 0) > MAX_FILE_BYTES) throw new UserFacingError(fileTooBig(name));
    return { name, mime: f.mime_type ?? 'application/octet-stream', data: await this.download(f.file_id) };
  }

  private async downloadAudio(f: TgFile): Promise<AudioInput | undefined> {
    if ((f.file_size ?? 0) > MAX_AUDIO_BYTES) throw new UserFacingError(voiceTooLong());
    // Telegram voice notes are Ogg/Opus, which Gemini reads directly.
    return { mimeType: f.mime_type ?? 'audio/ogg', data: (await this.download(f.file_id)).toString('base64') };
  }
}
