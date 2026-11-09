import type Anthropic from '@anthropic-ai/sdk';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { config, type Config } from '../config';
import type { CreateMessage } from '../llm/claude';
import type { GenerateContent } from '../llm/gemini';
import type { Provider, TurnRequest } from '../llm/types';

export const NOW = new Date('2026-11-07T10:00:00Z'); // Sat 17:00 in Bangkok

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...config,
    geminiKey: 'g',
    anthropicKey: 'a',
    defaultModel: 'gemini-3.8-flash',
    defaultEffort: 'medium',
    timezone: 'Asia/Bangkok',
    wanikaniToken: '',
    historyLimit: 6,
    dataDir: '',
    notifyChats: [],
    telegram: { ...config.telegram, allowedUsers: ['1'] },
    line: { ...config.line, allowedUsers: ['U1'] },
    billing: {
      warnUsd: null,
      capUsd: null,
      retentionDays: 30,
      priceOverrides: '',
      providers: { gemini: { warnUsd: null, capUsd: null }, claude: { warnUsd: null, capUsd: null } },
    },
    weather: { defaultCity: 'Bangkok', aqiAlert: null },
    ...over,
  };
}

export type ClaudeMessage = Anthropic.Beta.BetaMessage;

export function claudeMsg(stop: ClaudeMessage['stop_reason'], content: unknown[], usage = { input_tokens: 1000, output_tokens: 100 }): ClaudeMessage {
  return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, content, usage } as unknown as ClaudeMessage;
}

/** A fake Claude that replays scripted responses and records each request (deep-copied). */
export function fakeClaude(responses: ClaudeMessage[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = async (p) => {
    calls.push(structuredClone(p));
    const r = responses.shift();
    if (!r) throw new Error('no more scripted responses');
    return r;
  };
  return { create, calls };
}

export function geminiRes(parts: unknown[], finishReason = 'STOP', usage = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 }) {
  return { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata: usage } as unknown as GenerateContentResponse;
}

export function fakeGemini(responses: (GenerateContentResponse | Error)[]) {
  const calls: GenerateContentParameters[] = [];
  const generate: GenerateContent = async (p) => {
    calls.push(structuredClone(p));
    const r = responses.shift();
    if (!r) throw new Error('no more scripted responses');
    if (r instanceof Error) throw r;
    return r;
  };
  return { generate, calls };
}

/** A provider that answers with fixed text and records requests. */
export function echoProvider(text = 'ok') {
  const requests: TurnRequest[] = [];
  const provider: Provider = {
    async run(req) {
      requests.push(req);
      req.onUsage({ model: req.model, input: 1_000_000, output: 0 }); // $0.75 on Gemini 3.8 Flash
      return { text };
    },
  };
  return { provider, requests };
}

/** Stubs fetch with handlers chosen by URL substring. */
export function fakeFetch(routes: Record<string, unknown>) {
  return async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    return typeof body === 'string' ? new Response(body) : Response.json(body);
  };
}
