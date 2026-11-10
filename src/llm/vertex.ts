import { existsSync, readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config';
import type { GenerateContent } from './gemini';

/**
 * Gemini through Vertex AI (Google Cloud), so usage goes on the Google Cloud bill, where trial or Cloud credits
 * apply (the Gemini API key from AI Studio isn't covered by them). It needs a service-account key file.
 */
export interface VertexSetup {
  keyFile: string;
  project: string;
  location: string;
}

/** The Vertex AI settings when the key file is there (project from the key unless VERTEX_PROJECT is set), else null. */
export function vertexSetup(cfg: Config['vertex']): VertexSetup | null {
  if (!cfg.enabled || !existsSync(cfg.keyFile)) return null;
  let project = cfg.project;
  if (!project) {
    try {
      project = String(JSON.parse(readFileSync(cfg.keyFile, 'utf8')).project_id ?? '');
    } catch {
      throw new Error(`${cfg.keyFile} is not a readable Google Cloud service-account key (JSON).`);
    }
  }
  if (!project) throw new Error(`No Google Cloud project: set VERTEX_PROJECT, or use a service-account key that has project_id.`);
  return { keyFile: cfg.keyFile, project, location: cfg.location || 'global' };
}

export class VertexGemini {
  private readonly ai: GoogleGenAI;
  /** Calls that failed on Vertex AI today and went to the AI Studio key instead. */
  fallbacks = 0;
  private fallbackDay = '';
  lastError = '';

  constructor(
    readonly setup: VertexSetup,
    private readonly log: (...a: unknown[]) => void = console.log,
    ai?: GoogleGenAI,
  ) {
    this.ai = ai ?? new GoogleGenAI({ vertexai: true, project: setup.project, location: setup.location, googleAuthOptions: { keyFilename: setup.keyFile } });
  }

  /** Gemini via Vertex AI; if a call fails there and `fallback` (the AI Studio key) is set, that call uses it instead. */
  generate(fallback: GenerateContent | null): GenerateContent {
    return async (params) => {
      try {
        return await this.ai.models.generateContent(params);
      } catch (e) {
        if (!fallback) throw e;
        this.noteFallback(e);
        return fallback(params);
      }
    };
  }

  private noteFallback(e: unknown) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.fallbackDay) {
      this.fallbackDay = day;
      this.fallbacks = 0;
    }
    this.fallbacks++;
    this.lastError = String((e as Error)?.message ?? e).slice(0, 300);
    // The first few each day go to the log; /status shows the count and the last error.
    if (this.fallbacks <= 3) this.log('Vertex AI call failed, used the Gemini API key instead:', this.lastError);
  }

  /** A free check that Vertex AI answers with this key (counting tokens costs nothing). */
  async check(model: string): Promise<void> {
    await this.ai.models.countTokens({ model, contents: 'hi' });
  }
}
