export type ProviderName = 'gemini' | 'claude';

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderName;
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** USD per 1M cached input tokens; defaults to 10% of input. */
  cacheRead?: number;
  note: string;
}

/**
 * Models offered in /settings. Prices are list prices as of November 2026 and only used for the
 * /stats estimate and the spending caps; override them with MODEL_PRICES if they change.
 */
export const MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-flash', label: '⚡ Gemini 3.8 Flash', provider: 'gemini', input: 0.75, output: 3.75, note: 'fast, cheap, everyday default' },
  { id: 'gemini-4-argon', label: '🧠 Gemini 4 Argon', provider: 'gemini', input: 2, output: 10, note: 'deep research and planning' },
  { id: 'claude-sonnet-5-5', label: '✍️ Claude Sonnet 5.5', provider: 'claude', input: 2, output: 10, cacheRead: 0.2, note: 'writing and email drafting' },
  { id: 'claude-opus-5-5', label: '🎯 Claude Opus 5.5', provider: 'claude', input: 4, output: 20, cacheRead: 0.2, note: 'most capable, multi-step tasks' },
  { id: 'claude-haiku-5-5', label: '🪶 Claude Haiku 5.5', provider: 'claude', input: 0.1, output: 0.5, cacheRead: 0.01, note: 'cheapest Claude' },
];

/** Gemini 4 Argon's introductory price ends on 1 December 2026. */
const ARGON_FULL_PRICE_FROM = Date.parse('2026-12-01T00:00:00Z');

export function modelInfo(id: string, overridesJson = '', at = new Date()): ModelInfo {
  const known = MODELS.find((m) => m.id === id);
  let info: ModelInfo = known ?? {
    id,
    label: id,
    provider: id.startsWith('claude') ? 'claude' : 'gemini',
    input: 0,
    output: 0,
    note: 'custom model',
  };
  if (id === 'gemini-4-argon' && at.getTime() >= ARGON_FULL_PRICE_FROM) info = { ...info, input: 4, output: 20 };
  if (overridesJson) {
    try {
      const o = (JSON.parse(overridesJson) as Record<string, Partial<ModelInfo>>)[id];
      if (o) info = { ...info, ...o };
    } catch {
      // Ignore malformed MODEL_PRICES; the defaults still apply.
    }
  }
  return info;
}

export interface Usage {
  model: string;
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  webSearches?: number;
}

/** Estimated USD cost of one API call. */
export function costOf(u: Usage, info: ModelInfo): number {
  const cacheRead = info.cacheRead ?? info.input * 0.1;
  return (
    (u.input * info.input + (u.cacheWrite ?? 0) * info.input * 1.25 + (u.cacheRead ?? 0) * cacheRead + u.output * info.output) / 1e6 +
    (u.webSearches ?? 0) * 0.01
  );
}
