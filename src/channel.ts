import type { Agent, IncomingImage } from './agent';
import type { Briefings } from './briefings';
import { runCommand, SLOW_COMMANDS, type Button, type CommandReply } from './commands';
import type { Config } from './config';
import type { GenerateContent } from './llm/gemini';
import type { Store } from './store';
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
}

/** A short message for the user when handling their message failed. */
export function friendlyError(e: unknown): string {
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
    const ctx = { chatKey: m.chatKey, userId: m.userId, agent: this.agent, store: this.store, cfg: this.cfg, briefings: this.briefings, status: this.status };
    if (m.text.startsWith('/id')) return runCommand('/id', ctx);

    const allowed = this.allowList(m.platform);
    if (!allowed.length) {
      const name = m.platform === 'telegram' ? 'TELEGRAM_ALLOWED_USERS' : 'LINE_ALLOWED_USERS';
      return { text: `This bot is not set up yet. Your ${m.platform === 'telegram' ? 'Telegram' : 'LINE'} user id is ${m.userId}. Put it in ${name} (run \`npm run setup\`) and restart the bot.` };
    }
    if (!allowed.includes(m.userId)) return null; // a stranger: stay silent

    const command = await runCommand(m.text, ctx);
    if (command) return command;

    if (m.audio) return { text: await this.voice(m) };
    if (!m.text && !m.images?.length) return null;
    return { text: await this.agent.reply({ chatKey: m.chatKey, text: m.text, images: m.images, userName: m.userName }) };
  }

  private async voice(m: IncomingMessage): Promise<string> {
    if (!this.gemini) return '🎙️ Voice notes need a Gemini API key (GEMINI_API_KEY), even when chatting with Claude.';
    this.agent.checkBudget();
    const translateTo = this.briefings.translateTo();
    const t = await transcribe(this.gemini, this.cfg.voiceModel, m.audio!, translateTo, (u) => this.agent.recordUsage(u, 'voice'));
    if (!t.transcript.trim()) return "🎙️ I couldn't hear anything in that voice note.";
    const prompt = voicePrompt(t, translateTo) + (m.text ? `\nThe user added: ${m.text}` : '');
    const reply = await this.agent.reply({ chatKey: m.chatKey, text: prompt, userName: m.userName, kind: 'voice' });
    return [
      `🎙️ Voice note (${t.language})`,
      `📝 ${t.transcript}`,
      t.translation ? `🌐 ${translateTo}: ${t.translation}` : '',
      '',
      reply,
    ]
      .filter((l, i) => l !== '' || i === 3)
      .join('\n');
  }
}
