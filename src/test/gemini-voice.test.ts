import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiGenerate, geminiVoiceGenerate } from '../llm/gemini';

afterEach(() => vi.unstubAllGlobals());

describe('Gemini voice requests', () => {
  it('go to the v1beta API, where speechConfig exists (v1 rejects it)', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, body: JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) });
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: 'AAAA' } }] } }] });
    });
    const params = {
      model: 'gemini-3.8-flash-tts',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    };
    await geminiVoiceGenerate('key')(params);
    expect(seen[0].url).toContain('/v1beta/models/gemini-3.8-flash-tts:generateContent');
    expect(JSON.stringify(seen[0].body)).toContain('"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}');

    // Chat keeps the SDK's default (stable) API version.
    await geminiGenerate('key')({ model: 'gemini-3.8-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(seen[1].url).toContain('/v1/models/gemini-3.8-flash:generateContent');
  });
});
