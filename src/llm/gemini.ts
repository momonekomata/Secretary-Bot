import { GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponse, type Part } from '@google/genai';
import type { Effort } from '../config';
import type { Usage } from '../models';
import { GEMINI_WEB_TOOLS, runGeminiWebTool } from './gemini-web';
import { MAX_STEPS, type Provider, type TurnRequest, type TurnResult } from './types';

/** The one SDK call the provider needs; injectable for tests. */
export type GenerateContent = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export function geminiGenerate(apiKey: string): GenerateContent {
  const ai = new GoogleGenAI({ apiKey });
  return (params) => ai.models.generateContent(params);
}

const LEVELS: Record<Effort, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

export function geminiUsage(model: string, res: GenerateContentResponse): Usage {
  const m = res.usageMetadata;
  const cached = m?.cachedContentTokenCount ?? 0;
  return {
    model,
    input: Math.max(0, (m?.promptTokenCount ?? 0) + (m?.toolUsePromptTokenCount ?? 0) - cached),
    // Thinking tokens are billed as output.
    output: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0),
    cacheRead: cached,
  };
}

/** Visible text of a response (thought summaries excluded). */
export function geminiText(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Sends a request with a thinking level; if the model rejects thinking settings, retries once without
 * them (not every Gemini model accepts every level).
 */
export async function generateWithThinking(generate: GenerateContent, params: GenerateContentParameters, effort: Effort) {
  try {
    return await generate({ ...params, config: { ...params.config, thinkingConfig: { thinkingLevel: LEVELS[effort] } } });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400 && /thinking/i.test(String((e as Error).message))) return generate(params);
    throw e;
  }
}

export class GeminiProvider implements Provider {
  constructor(private readonly generate: GenerateContent) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    const userParts: Part[] = [
      ...(req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
      { text: req.userText || '(sent a photo)' },
      // Gemini has no mid-conversation system role: the per-turn note rides at the end of the user turn.
      ...(req.note ? [{ text: `\n\n[System note]\n${req.note}` }] : []),
    ];
    const contents: Content[] = [
      ...req.history.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
      { role: 'user', parts: userParts },
    ];
    const specs = [...req.tools, ...(req.webTools ? GEMINI_WEB_TOOLS : [])];
    const webNames = new Set(GEMINI_WEB_TOOLS.map((t) => t.name));
    const tools = specs.length
      ? [{ functionDeclarations: specs.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
      : undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await generateWithThinking(
        this.generate,
        { model: req.model, contents, config: { systemInstruction: req.system, ...(tools ? { tools } : {}) } },
        req.effort,
      );
      req.onUsage(geminiUsage(req.model, res));

      const candidate = res.candidates?.[0];
      const reason = String(candidate?.finishReason ?? '');
      if (!candidate?.content) {
        if (res.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(reason)) return { text: '', refused: true };
        return { text: '' };
      }

      // Send the model's turn back unchanged: Gemini 3+ attaches thought signatures to its parts.
      contents.push(candidate.content);
      const calls = (candidate.content.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall!);
      if (calls.length) {
        const responses = await Promise.all(
          calls.map(async (call): Promise<Part> => {
            const r =
              req.webTools && webNames.has(call.name ?? '')
                ? await runGeminiWebTool(this.generate, req.model, call.name!, call.args ?? {}, req.onUsage)
                : await req.runTool(call.name ?? '', call.args ?? {});
            return {
              functionResponse: { id: call.id, name: call.name, response: r.isError ? { error: r.content } : { output: r.content } },
            };
          }),
        );
        contents.push({ role: 'user', parts: responses });
        continue;
      }

      return { text: geminiText(res), truncated: reason === 'MAX_TOKENS', refused: /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(reason) };
    }
    return { text: '' };
  }
}
