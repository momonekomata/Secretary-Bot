import { BudgetExceeded, type Agent, type IncomingImage } from './agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Briefings } from './briefings';
import { runCommand, SLOW_COMMANDS, type Button, type CommandReply } from './commands';
import type { Config } from './config';
import type { GenerateContent } from './llm/gemini';
import type { Store } from './store';
import { wav, voiceName, modelUnavailable, speakable, synthesize, toGeminiAudio, TTS_MODELS, type Speech } from './audio';
import { fileToInput, UserFacingError } from './documents';
import type { JapaneseDaily } from './japanese';
import type { Reviews } from './review';
import { lang, t } from './i18n';
import { formatTime } from './time';
import { airQuality, forecast, formatWeather, reverseGeocode } from './weather';
import { transcribe, voicePrompt, type AudioInput } from './voice';

/** A chat platform the bot can push messages to (reminders, briefings, alerts). */
export interface Channel {
  /** Prefix of the chat keys this channel owns, e.g. "telegram". */
  readonly prefix: string;
  /** Sends `text` to the chat with id `chatId` (the part of the chat key after the prefix). */
  send(chatId: string, text: string, buttons?: Button[][]): Promise<void>;
  /** Sends a file, where the platform supports it. */
  sendFile?(chatId: string, name: string, data: Buffer, caption: string): Promise<void>;
}

export class Channels {
  private byPrefix = new Map<string, Channel>();

  add(c: Channel) {
    this.byPrefix.set(c.prefix, c);
  }

  private resolve(chatKey: string): [Channel, string] {
    const i = chatKey.indexOf(':');
    const channel = this.byPrefix.get(chatKey.slice(0, i));
    if (!channel) throw new Error(`No channel for chat ${chatKey}`);
    return [channel, chatKey.slice(i + 1)];
  }

  async send(chatKey: string, text: string) {
    const [channel, id] = this.resolve(chatKey);
    await channel.send(id, text);
  }

  /** Sends a file where supported, otherwise just the caption. */
  async sendFile(chatKey: string, name: string, data: Buffer, caption: string) {
    const [channel, id] = this.resolve(chatKey);
    if (channel.sendFile) await channel.sendFile(id, name, data, caption);
    else await channel.send(id, `${caption}\n${t(`(Saved on the bot as backups/${name}.)`, `(บันทึกไว้ในบอทที่ backups/${name})`)}`);
  }
}

export interface IncomingMessage {
  platform: 'telegram' | 'line';
  chatKey: string;
  userId: string;
  userName?: string;
  text: string;
  images?: IncomingImage[];
  audio?: AudioInput;
  /** A document the user sent (PDF, Word, text...). */
  file?: { name: string; mime: string; data: Buffer };
  /** A shared location. */
  location?: { lat: number; lon: number };
}

/** A short message for the user when handling their message failed. */
export function friendlyError(e: unknown): string {
  if (e instanceof UserFacingError || e instanceof BudgetExceeded) return e.message;
  const status = (e as { status?: number }).status;
  if (status === 429) return t('The AI service is rate limiting me right now. Try again in a minute.', 'บริการ AI จำกัดการใช้งานอยู่ตอนนี้ ลองใหม่อีกครั้งในอีกสักนาทีนะ');
  if (status === 401 || status === 403)
    return t('My AI API key was rejected. Check GEMINI_API_KEY / ANTHROPIC_API_KEY on the bot.', 'คีย์ API ของ AI ถูกปฏิเสธ ลองตรวจ GEMINI_API_KEY / ANTHROPIC_API_KEY ในบอทดูนะ');
  if (status && status >= 500) return t('The AI service is having trouble right now. Try again shortly.', 'บริการ AI มีปัญหาอยู่ตอนนี้ ลองใหม่อีกสักครู่นะ');
  const msg = (e as Error)?.message ?? '';
  if (/needs (GEMINI|ANTHROPIC)_API_KEY|Google sign-in|too long for me/.test(msg)) return lang() === 'th' ? thaiPassthrough(msg) : msg;
  return t('Something went wrong on my side. Try again, or check the bot logs.', 'เกิดข้อผิดพลาดฝั่งบอท ลองใหม่อีกครั้ง หรือดู log ของบอท');
}

/** Thai for the known error messages friendlyError shows as-is (they are thrown in English elsewhere). */
function thaiPassthrough(msg: string): string {
  const model = /^The selected model (\S+) needs ((?:GEMINI|ANTHROPIC)_API_KEY)\./.exec(msg);
  if (model) return `โมเดล ${model[1]} ที่เลือกไว้ต้องใช้ ${model[2]} ตั้งค่าคีย์นี้ หรือเลือกโมเดลอื่นใน /settings`;
  if (/^Google sign-in has expired or was revoked/.test(msg)) return 'การเชื่อมต่อ Google หมดอายุหรือถูกยกเลิก รัน `npm run google-auth` ใหม่อีกครั้ง';
  return msg;
}

/** One line telling the user why a voice reply couldn't be made. */
export function speechFailed(e: unknown): string {
  const raw = e instanceof BudgetExceeded ? e.message : String((e as Error)?.message ?? e);
  const reason = /ffmpeg/i.test(raw)
    ? t('ffmpeg is missing on the server.', 'เซิร์ฟเวอร์ไม่มี ffmpeg')
    : /no audio returned/i.test(raw)
      ? t('Gemini returned no audio.', 'Gemini ไม่ได้ส่งเสียงกลับมา')
      : /No Gemini speech model/i.test(raw)
        ? t('no Gemini speech model is available on your API key.', 'API key นี้ใช้โมเดลเสียงของ Gemini ไม่ได้เลย')
        : /\b429\b|quota|RESOURCE_EXHAUSTED/i.test(raw)
          ? t('the Gemini quota or credit ran out.', 'โควตาหรือเครดิต Gemini หมด')
          : raw.slice(0, 200);
  return `🔇 ${t("I couldn't make the voice reply", 'สร้างเสียงตอบกลับไม่ได้')}: ${reason}`;
}


/** Platform-independent message handling: access control, commands, voice notes, chat. */
export class Secretary {
  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    readonly agent: Agent,
    private readonly briefings: Briefings,
    /** Gemini, for voice transcription; null when GEMINI_API_KEY is missing. */
    private readonly gemini: GenerateContent | null,
    private readonly status: () => Promise<string>,
    private readonly japanese?: JapaneseDaily,
    private readonly reviews?: Reviews,
  ) {}

  private allowList(platform: IncomingMessage['platform']) {
    return platform === 'telegram' ? this.cfg.telegram.allowedUsers : this.cfg.line.allowedUsers;
  }

  /** True when handling may take a while (AI or outside APIs), so the channel shows "typing…". */
  isSlow(m: IncomingMessage): boolean {
    if (!m.text.startsWith('/')) return true;
    return SLOW_COMMANDS.has(m.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, ''));
  }

  /** Returns the reply to send, or null to stay silent. */
  async handle(m: IncomingMessage): Promise<CommandReply | null> {
    try {
      return await this.route(m);
    } catch (e) {
      // A spending cap is an answer, not an error.
      if (e instanceof BudgetExceeded) return { text: e.message };
      throw e;
    }
  }

  private notifier: ((chatKey: string, text: string) => Promise<void>) | null = null;

  /** Lets background jobs post to a chat (set once the channels exist). */
  setNotifier(fn: (chatKey: string, text: string) => Promise<void>) {
    this.notifier = fn;
  }

  private async route(m: IncomingMessage): Promise<CommandReply | null> {
    const notifier = this.notifier;
    const ctx = {
      notify: notifier ? (text: string) => notifier(m.chatKey, text) : undefined,
      chatKey: m.chatKey,
      userId: m.userId,
      agent: this.agent,
      store: this.store,
      cfg: this.cfg,
      briefings: this.briefings,
      status: this.status,
      japanese: this.japanese,
      reviews: this.reviews,
    };
    if (m.text.startsWith('/id')) return runCommand('/id', ctx);

    const allowed = this.allowList(m.platform);
    if (!allowed.length) {
      const name = m.platform === 'telegram' ? 'TELEGRAM_ALLOWED_USERS' : 'LINE_ALLOWED_USERS';
      const platform = m.platform === 'telegram' ? 'Telegram' : 'LINE';
      return {
        text: t(
          `This bot is not set up yet. Your ${platform} user id is ${m.userId}. Put it in ${name} (run \`npm run setup\`) and restart the bot.`,
          `บอทนี้ยังไม่ได้ตั้งค่า user id ${platform} ของคุณคือ ${m.userId} ใส่ไว้ใน ${name} (รัน \`npm run setup\`) แล้วรีสตาร์ตบอท`,
        ),
      };
    }
    if (!allowed.includes(m.userId)) return null; // a stranger: stay silent

    const command = await runCommand(m.text, ctx);
    if (command) return command;

    // During a WaniKani review, plain text messages are answers.
    if (this.reviews?.active(m.chatKey) && m.text && !m.audio && !m.file && !m.location && !m.images?.length) {
      return { text: await this.reviews.answer(m.chatKey, m.text) };
    }

    if (m.location) return { text: await this.location(m.location) };
    const mode = this.store.settings().voiceReplies ?? this.cfg.defaultVoiceReplies;
    if (m.audio) {
      const v = await this.voice(m);
      return { text: v.text, ...(v.reply && mode !== 'off' ? { speak: v.reply } : {}) };
    }
    if (m.file) {
      const f = fileToInput(m.file.name, m.file.mime, m.file.data);
      const ask = m.text || 'I sent you this file. Tell me briefly what it is and the key points, then ask what I want to do with it.';
      return {
        text: await this.agent.reply({
          chatKey: m.chatKey,
          text: ask,
          images: f.images,
          documents: f.documents,
          fileText: f.text,
          fileNames: [m.file.name],
          userName: m.userName,
        }),
      };
    }
    if (!m.text && !m.images?.length) return null;
    const reply = await this.agent.reply({ chatKey: m.chatKey, text: m.text, images: m.images, userName: m.userName });
    return { text: reply, ...(mode === 'always' ? { speak: reply } : {}) };
  }

  /** A shared location becomes the weather / nearby-places city. */
  private async location(loc: { lat: number; lon: number }): Promise<string> {
    const city = await reverseGeocode(loc.lat, loc.lon);
    this.store.updateSettings({ city });
    let weather = '';
    try {
      const [f, aq] = await Promise.all([forecast(city), airQuality(city).catch(() => null)]);
      weather = `\n\n${formatWeather(city, f, aq, 1)}`;
    } catch {
      // Weather is a bonus here; the location is saved either way.
    }
    const place = `${city.name}${city.country ? `, ${city.country}` : ''}`;
    const at = formatTime(new Date(), this.cfg.timezone);
    return t(
      `📍 Got it: ${place}. I'll use this for weather, briefings and nearby places (updated ${at}).${weather}`,
      `📍 รับทราบ: ${place} จะใช้ตำแหน่งนี้สำหรับอากาศ สรุปข่าวประจำวัน และสถานที่ใกล้เคียง (อัปเดต ${at})${weather}`,
    );
  }

  /** Spoken version of `text` (Gemini text-to-speech), or null when unavailable. */
  async speech(text: string): Promise<Speech | null> {
    if (!this.gemini) return null;
    const spoken = speakable(text);
    if (!spoken) return null;
    this.agent.checkBudget('gemini');
    const s = this.store.settings();
    const prompt = s.speakingStyle ? `Say ${s.speakingStyle}: ${spoken}` : spoken;
    const voice = voiceName(s.ttsVoice ?? '') ?? voiceName(this.cfg.ttsVoice) ?? 'Kore';
    const models = [...new Set([this.ttsModel, this.cfg.ttsModel, ...TTS_MODELS].filter((m): m is string => !!m))];
    let last: unknown = null;
    for (const model of models) {
      try {
        const speech = await synthesize(this.gemini, model, voice, prompt, (u) => this.agent.recordUsage(u, 'speech'));
        this.ttsModel = model;
        if (speech?.raw && this.cfg.dataDir) {
          // The last clip as Gemini sent it (before cleaning), to check audio problems: data/debug/last-speech.wav
          try {
            mkdirSync(join(this.cfg.dataDir, 'debug'), { recursive: true });
            writeFileSync(join(this.cfg.dataDir, 'debug', 'last-speech.wav'), wav({ ...speech, pcm: speech.raw }));
            writeFileSync(join(this.cfg.dataDir, 'debug', 'last-speech.txt'), `${model} ${voice} ${speech.mimeType} ${speech.raw.length} bytes, kept ${speech.pcm.length}\n`);
          } catch {
            // Diagnosis only.
          }
        }
        return speech;
      } catch (e) {
        if (!modelUnavailable(e)) throw e;
        last = e;
      }
    }
    throw new Error(`No Gemini speech model is available on this API key (tried ${models.join(', ')}): ${(last as Error)?.message ?? ''}`);
  }

  /** The speech model that last worked (shown in /status). */
  ttsModel: string | null = null;

  private async voice(m: IncomingMessage): Promise<{ text: string; reply?: string }> {
    if (!this.gemini) return { text: t('🎙️ Voice notes need a Gemini API key (GEMINI_API_KEY), even when chatting with Claude.', '🎙️ ข้อความเสียงต้องใช้คีย์ API ของ Gemini (GEMINI_API_KEY) แม้จะคุยกับ Claude อยู่ก็ตาม') };
    this.agent.checkBudget('gemini');
    const translateTo = this.briefings.translateTo();
    const audio = await toGeminiAudio(m.audio!);
    const tr = await transcribe(this.gemini, this.cfg.voiceModel, audio, translateTo, (u) => this.agent.recordUsage(u, 'voice'));
    if (!tr.transcript.trim()) return { text: t("🎙️ I couldn't hear anything in that voice note.", '🎙️ ไม่ได้ยินเสียงอะไรในข้อความเสียงนี้เลย') };
    const prompt = voicePrompt(tr, translateTo) + (m.text ? `\nThe user added: ${m.text}` : '');
    const reply = await this.agent.reply({ chatKey: m.chatKey, text: prompt, userName: m.userName, kind: 'voice' });
    const text = [
      t(`🎙️ Voice note (${tr.language})`, `🎙️ ข้อความเสียง (${tr.language})`),
      `📝 ${tr.transcript}`,
      tr.translation ? `🌐 ${translateTo}: ${tr.translation}` : '',
      '',
      reply,
    ]
      .filter((l, i) => l !== '' || i === 3)
      .join('\n');
    return { text, reply };
  }
}
