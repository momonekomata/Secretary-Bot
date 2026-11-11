import Anthropic from '@anthropic-ai/sdk';
import { MAX_STEPS, OUT_OF_STEPS, type Provider, type ToolSpec, type TurnRequest, type TurnResult } from './types';

type Message = Anthropic.Beta.BetaMessage;
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The one SDK call the provider needs; injectable for tests. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

export function anthropicCreate(client: Anthropic = new Anthropic()): CreateMessage {
  return (params) => client.beta.messages.create(params);
}

function toClaudeTool(t: ToolSpec): Anthropic.Beta.BetaTool {
  // Strict mode needs every property listed in `required`.
  const strict = Object.keys(t.parameters.properties).length === t.parameters.required.length;
  return { name: t.name, description: t.description, input_schema: t.parameters, ...(strict ? { strict: true } : {}) };
}

export class ClaudeProvider implements Provider {
  constructor(private readonly create: CreateMessage) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...req.tools.map(toClaudeTool),
      ...(req.webTools
        ? ([
            { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
            { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
          ] as const)
        : []),
    ];
    const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(req.documents ?? []).map((d) => ({
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: d.mediaType, data: d.data },
        title: d.name,
      })),
      ...(req.images ?? []).map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      { type: 'text', text: req.userText || '(sent a photo)' },
    ];

    // Earlier turns are replayed as plain text only. No thinking blocks from earlier turns are sent
    // back, so trimming old history or changing the context note never invalidates them; within
    // this turn the history is append-only, as the API requires.
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...req.history.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: userContent },
      ...(req.note ? [{ role: 'system' as const, content: req.note }] : []),
    ];

    for (let step = 0; step <= MAX_STEPS; step++) {
      // The step after the last: no more tools, just tell the user what was done and what's left.
      const finalStep = step === MAX_STEPS;
      if (finalStep) {
        const last = messages[messages.length - 1];
        if (last.role === 'user' && Array.isArray(last.content)) last.content = [...last.content, { type: 'text', text: OUT_OF_STEPS }];
        else messages.push({ role: 'user', content: OUT_OF_STEPS });
      }
      const res = await this.create({
        model: req.model,
        max_tokens: 16000,
        system: req.system,
        ...(tools.length ? { tools, ...(finalStep ? { tool_choice: { type: 'none' as const } } : {}) } : {}),
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: req.effort },
        cache_control: { type: 'ephemeral' },
        // On a safety-classifier decline, let the API re-run the request on its recommended model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      const u = res.usage;
      req.onUsage({
        model: res.model ?? req.model,
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        webSearches: u?.server_tool_use?.web_search_requests ?? 0,
      });

      if (res.stop_reason === 'refusal') return { text: '', refused: true };

      messages.push({ role: 'assistant', content: res.content });

      if (res.stop_reason === 'pause_turn' && !finalStep) continue; // long server-tool turn: send it back to continue

      if (res.stop_reason === 'tool_use' && !finalStep) {
        const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        const results = await Promise.all(
          calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            const r = await req.runTool(call.name, call.input);
            return { type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        messages.push({ role: 'user', content: results });
        continue;
      }

      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { text, truncated: res.stop_reason === 'max_tokens', ...(finalStep ? { outOfSteps: true } : {}) };
    }
    return { text: '' };
  }
}
