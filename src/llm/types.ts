import type { Effort } from '../config';
import type { DocumentInput } from '../documents';
import type { Usage } from '../models';
import type { Turn } from '../store';

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** base64, no newlines */
  data: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** A tool both providers can call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

export interface TurnRequest {
  model: string;
  effort: Effort;
  /** Stable for the life of the process (keeps prompt caches warm). */
  system: string;
  /** Earlier turns, plain text only. */
  history: Turn[];
  userText: string;
  images?: ImageInput[];
  /** PDFs for the model to read. */
  documents?: DocumentInput[];
  /** Per-turn context (time, memories), sent after the user's message. */
  note?: string;
  tools: ToolSpec[];
  /** Allow provider-hosted web search/fetch where the provider has it. */
  webTools: boolean;
  runTool(name: string, input: unknown): Promise<ToolResult>;
  onUsage(u: Usage): void;
}

export interface TurnResult {
  text: string;
  refused?: boolean;
  truncated?: boolean;
  /** The reply used all its tool steps (the text is the model's summary of what's done and left). */
  outOfSteps?: boolean;
}

export interface Provider {
  run(req: TurnRequest): Promise<TurnResult>;
}

export const MAX_STEPS = 20;

/**
 * Told to the model when a reply used all its tool steps: one last answer without tools, so the user hears what
 * was done instead of getting nothing.
 */
export const OUT_OF_STEPS =
  '[System note] You have used all the tool steps for this message. Do not call tools now. Reply to the user: ' +
  'say briefly what you completed and what is still left, and that they can say "continue" to go on.';
