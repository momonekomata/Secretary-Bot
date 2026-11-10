import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VertexGemini, vertexSetup } from '../llm/vertex';

const cfg = (over: Partial<{ enabled: boolean; keyFile: string; project: string; location: string }> = {}) => ({ enabled: true, keyFile: '', project: '', location: 'global', ...over });

describe('Vertex AI setup', () => {
  it('is used when the key file exists, taking the project from the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-vx-'));
    const keyFile = join(dir, 'vertex-key.json');
    expect(vertexSetup(cfg({ keyFile }))).toBeNull(); // no key yet
    writeFileSync(keyFile, JSON.stringify({ type: 'service_account', project_id: 'my-bot-123', client_email: 'bot@my-bot-123.iam.gserviceaccount.com' }));
    expect(vertexSetup(cfg({ keyFile }))).toEqual({ keyFile, project: 'my-bot-123', location: 'global' });
    expect(vertexSetup(cfg({ keyFile, project: 'other', location: 'asia-southeast1' }))).toMatchObject({ project: 'other', location: 'asia-southeast1' });
    expect(vertexSetup(cfg({ keyFile, enabled: false }))).toBeNull(); // GEMINI_VIA_VERTEX=off
    writeFileSync(keyFile, 'not json');
    expect(() => vertexSetup(cfg({ keyFile }))).toThrow(/not a readable Google Cloud service-account key/);
  });
});

describe('Gemini via Vertex AI', () => {
  const fakeAi = (fail: Error | null) => {
    const calls: string[] = [];
    return {
      calls,
      ai: {
        models: {
          generateContent: async (p: { model: string }) => {
            calls.push(`vertex:${p.model}`);
            if (fail) throw fail;
            return { text: 'from vertex' };
          },
          countTokens: async () => ({ totalTokens: 1 }),
        },
      },
    };
  };
  const setup = { keyFile: 'k.json', project: 'p', location: 'global' };

  it('uses Vertex AI, and the Gemini API key only for calls that fail there', async () => {
    const ok = fakeAi(null);
    const v = new VertexGemini(setup, () => undefined, ok.ai as never);
    const studio = async () => ({ text: 'from ai studio' }) as never;
    expect(await v.generate(studio)({ model: 'gemini-3.8-flash', contents: 'hi' })).toEqual({ text: 'from vertex' });
    expect(v.fallbacks).toBe(0);
    await v.check('gemini-3.8-flash');

    const logs: string[] = [];
    const bad = fakeAi(new Error('403 PERMISSION_DENIED: Vertex AI API has not been used in project p'));
    const v2 = new VertexGemini(setup, (...a) => logs.push(a.join(' ')), bad.ai as never);
    expect(await v2.generate(studio)({ model: 'gemini-3.8-flash-tts', contents: 'hi' })).toEqual({ text: 'from ai studio' });
    expect(v2.fallbacks).toBe(1);
    expect(v2.lastError).toMatch(/PERMISSION_DENIED/);
    expect(logs[0]).toMatch(/^Vertex AI call failed, used the Gemini API key instead/);
    // Without a Gemini API key there is nothing to fall back to: the error comes through.
    await expect(v2.generate(null)({ model: 'gemini-3.8-flash', contents: 'hi' })).rejects.toThrow(/PERMISSION_DENIED/);
  });
});
