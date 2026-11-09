import { BudgetExceeded, type Agent, type IncomingImage } from './agent';
import type { Briefings } from './briefings';
import { runCommand, SLOW_COMMANDS, type Button, type CommandReply } from './commands';
import type { Config } from './config';
import type { GenerateContent } from './llm/gemini';
import type { Store } from './store';
import { speakable, synthesize, toGeminiAudio, type Speech } from './audio';
import { fileToInput, UserFacingError } from './documents';
import type { JapaneseDaily } from './japanese';
import type { Reviews } from './review';
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
    else await channel.send(id, `${caption}\n(Saved on the bot as backups/${name}.)`);
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
  if (status === 429) return 'The AI service is rate limiting me right now. Try again in a minute.';
  if (status === 401 || status === 403) return 'My AI API key was rejected. Check GEMINI_API_KEY / ANTHROPIC_API_KEY on the bot.';
  if (status && status >= 500) return 'The AI service is having trouble right now. Try again shortly.';
  const msg = (e as Error)?.message ?? '';
  if (/needs (GEMINI|ANTHROPIC)_API_KEY|Google sign-in|too long for me/.test(msg)) return msg;
  return 'Something went wrong on my side. Try again, or check the bot logs.';
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
      return { text: `This bot is not set up yet. Your ${m.platform === 'telegram' ? 'Telegram' : 'LINE'} user id is ${m.userId}. Put it in ${name} (run \`npm run setup\`) and restart the bot.` };
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
    return `📍 Got it: ${city.name}${city.country ? `, ${city.country}` : ''}. I'll use this for weather, briefings and nearby places (updated ${formatTime(new Date(), this.cfg.timezone)}).${weather}`;
  }

  /** Spoken version of `text` (Gemini text-to-speech), or null when unavailable. */
  async speech(text: string): Promise<Speech | null> {
    if (!this.gemini) return null;
    const spoken = speakable(text);
    if (!spoken) return null;
    this.agent.checkBudget('gemini');
    const s = this.store.settings();
    const prompt = s.speakingStyle ? `Say ${s.speakingStyle}: ${spoken}` : spoken;
    return synthesize(this.gemini, this.cfg.ttsModel, s.ttsVoice ?? this.cfg.ttsVoice, prompt, (u) => this.agent.recordUsage(u, 'speech'));
  }

  private async voice(m: IncomingMessage): Promise<{ text: string; reply?: string }> {
    if (!this.gemini) return { text: '🎙️ Voice notes need a Gemini API key (GEMINI_API_KEY), even when chatting with Claude.' };
    this.agent.checkBudget('gemini');
    const translateTo = this.briefings.translateTo();
    const audio = await toGeminiAudio(m.audio!);
    const t = await transcribe(this.gemini, this.cfg.voiceModel, audio, translateTo, (u) => this.agent.recordUsage(u, 'voice'));
    if (!t.transcript.trim()) return { text: "🎙️ I couldn't hear anything in that voice note." };
    const prompt = voicePrompt(t, translateTo) + (m.text ? `\nThe user added: ${m.text}` : '');
    const reply = await this.agent.reply({ chatKey: m.chatKey, text: prompt, userName: m.userName, kind: 'voice' });
    const text = [
      `🎙️ Voice note (${t.language})`,
      `📝 ${t.transcript}`,
      t.translation ? `🌐 ${translateTo}: ${t.translation}` : '',
      '',
      reply,
    ]
      .filter((l, i) => l !== '' || i === 3)
      .join('\n');
    return { text, reply };
  }
}
