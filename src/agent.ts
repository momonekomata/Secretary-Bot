import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config';
import type { Store } from './store';
import { customTools, formatTime, runTool } from './tools';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type Message = Anthropic.Beta.BetaMessage;
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

export interface IncomingImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** base64, no newlines */
  data: string;
}

export interface Incoming {
  chatKey: string;
  text: string;
  images?: IncomingImage[];
  /** Display name from the platform, if known. */
  userName?: string;
}

/** The one SDK call the agent needs; injectable for tests. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

const MAX_STEPS = 12;

export function systemPrompt(cfg: Pick<Config, 'botName' | 'persona'>): string {
  return [
    `You are ${cfg.botName}, a personal AI assistant that lives in the user's Telegram and LINE chats.`,
    'You help with everyday questions, planning, writing, and translation, and you are also the user\'s Japanese study companion: they study kanji with WaniKani and grammar with Bunpro, tracked in an app called Japanese Journey.',
    'Reply in the language the user writes in (often Thai, English, or Japanese). When you use Japanese words for a learner, add the reading in hiragana and a short gloss the first time.',
    'Your reply is shown in a chat bubble as plain text: no Markdown headings, tables, bold, or code fences. Keep it short and conversational; use simple "•" bullets only when a list really helps.',
    'You have tools for saving memories about the user, scheduling reminders, checking live WaniKani progress, and searching or reading the web. Use them when they help; don\'t announce that you are about to.',
    'Each turn ends with a system note giving the current time and what you remember about the user. Use the time to work out reminder times; never guess dates.',
    cfg.persona ? `Additional instructions from the owner:\n${cfg.persona}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function serverTools(cfg: Config): Anthropic.Beta.BetaToolUnion[] {
  if (!cfg.webTools) return [];
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
  ];
}

function finalText(msg: Message): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export class Agent {
  private readonly system: string;
  private readonly tools: Anthropic.Beta.BetaToolUnion[];
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly create: CreateMessage,
    private readonly now: () => Date = () => new Date(),
  ) {
    // Frozen for the life of the process so the prompt cache stays warm.
    this.system = systemPrompt(cfg);
    this.tools = [...customTools, ...serverTools(cfg)];
  }

  /** Runs one user message through the agent. Messages from the same chat are handled one at a time. */
  reply(input: Incoming): Promise<string> {
    const prev = this.locks.get(input.chatKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.turn(input));
    this.locks.set(input.chatKey, run);
    run.finally(() => {
      if (this.locks.get(input.chatKey) === run) this.locks.delete(input.chatKey);
    }).catch(() => undefined);
    return run;
  }

  /** Forgets the running conversation (memories and reminders stay). */
  resetConversation(chatKey: string) {
    this.store.clearHistory(chatKey);
  }

  private contextNote(chatKey: string, userName?: string): string {
    const mems = this.store.memories(chatKey);
    return [
      `Current time: ${formatTime(this.now(), this.cfg.timezone)} (${this.cfg.timezone}).`,
      userName ? `The user's display name: ${userName}.` : '',
      mems.length ? `What you remember about the user:\n${mems.map((m) => `#${m.id} ${m.text}`).join('\n')}` : 'You have no saved memories about this user yet.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async turn(input: Incoming): Promise<string> {
    const { chatKey } = input;
    const userContent: ContentBlockParam[] = [
      ...(input.images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      { type: 'text', text: input.text || '(sent a photo)' },
    ];

    // Earlier turns are replayed as plain text only. No thinking blocks from earlier turns are
    // sent back, so trimming old history or changing the context note never invalidates them;
    // within this turn the history is append-only, as the API requires.
    const messages: MessageParam[] = [
      ...this.store.history(chatKey).map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: userContent },
      { role: 'system', content: this.contextNote(chatKey, input.userName) },
    ];

    let reply = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await this.create({
        model: this.cfg.model,
        max_tokens: 16000,
        system: this.system,
        tools: this.tools,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: this.cfg.effort },
        cache_control: { type: 'ephemeral' },
        // On a safety-classifier decline, let the API re-run the request on its recommended model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });

      if (res.stop_reason === 'refusal') {
        reply = "Sorry, I can't help with that one.";
        break;
      }

      messages.push({ role: 'assistant', content: res.content });

      if (res.stop_reason === 'pause_turn') continue; // long server-tool turn: send it back to continue

      if (res.stop_reason === 'tool_use') {
        const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        const results = await Promise.all(
          calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const r = await runTool(call.name, call.input, {
              chatKey,
              store: this.store,
              timezone: this.cfg.timezone,
              wanikaniToken: this.cfg.wanikaniToken,
              now: this.now,
            });
            return { type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        messages.push({ role: 'user', content: results });
        continue;
      }

      reply = finalText(res);
      if (res.stop_reason === 'max_tokens') reply += reply ? '\n\n(…cut off, ask me to continue)' : '';
      break;
    }

    if (!reply) reply = "Hmm, I got lost in thought there. Could you ask again?";
    const remembered = input.images?.length ? `[sent ${input.images.length} photo(s)] ${input.text}`.trim() : input.text;
    this.store.appendExchange(chatKey, remembered, reply, this.cfg.historyLimit);
    return reply;
  }
}

/** Real SDK-backed CreateMessage. */
export function anthropicCreate(client: Anthropic = new Anthropic()): CreateMessage {
  return (params) => client.beta.messages.create(params);
}
