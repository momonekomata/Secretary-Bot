import type { Agent } from './agent';

/** A chat platform the bot can push messages to (for reminders and nudges). */
export interface Channel {
  /** Prefix of the chat keys this channel owns, e.g. "telegram". */
  readonly prefix: string;
  /** Sends `text` to the chat with id `chatId` (the part of the chat key after the prefix). */
  send(chatId: string, text: string): Promise<void>;
}

export class Channels {
  private byPrefix = new Map<string, Channel>();

  add(c: Channel) {
    this.byPrefix.set(c.prefix, c);
  }

  async send(chatKey: string, text: string) {
    const i = chatKey.indexOf(':');
    const channel = this.byPrefix.get(chatKey.slice(0, i));
    if (!channel) throw new Error(`No channel for chat ${chatKey}`);
    await channel.send(chatKey.slice(i + 1), text);
  }
}

/** Handles the slash commands every channel shares. Returns a reply, or null if `text` is not a command. */
export function handleCommand(text: string, chatKey: string, userId: string, agent: Agent): string | null {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '');
  switch (cmd) {
    case '/start':
    case '/help':
      return [
        'Hi! I am your personal assistant. Just talk to me.',
        '• Send a photo of Japanese text and I will read and explain it.',
        '• "Remind me at 9pm to do my WaniKani reviews."',
        '• "Remember that my JLPT exam is on 6 December."',
        'Commands: /reset (forget this conversation, keep memories), /id (show your ids).',
      ].join('\n');
    case '/reset':
      agent.resetConversation(chatKey);
      return 'Conversation cleared. I still keep your saved memories and reminders.';
    case '/id':
      return `Your user id: ${userId}\nThis chat: ${chatKey}`;
    default:
      return null;
  }
}

/** A short message for the user when handling their message failed. */
export function friendlyError(e: unknown): string {
  const status = (e as { status?: number }).status;
  if (status === 429) return 'I am being rate limited right now. Try again in a minute.';
  if (status === 401) return 'My Claude API key was rejected. Check ANTHROPIC_API_KEY on the bot.';
  if (status && status >= 500) return 'Claude is having trouble right now. Try again shortly.';
  return 'Something went wrong on my side. Try again, or check the bot logs.';
}
