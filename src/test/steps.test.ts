import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../llm/claude';
import { GeminiProvider } from '../llm/gemini';
import { MAX_STEPS, OUT_OF_STEPS, type TurnRequest } from '../llm/types';
import { claudeMsg, fakeClaude, fakeGemini, geminiRes } from './helpers';

/** A request whose one tool always succeeds, so the model could keep calling it forever. */
function request(model: string): TurnRequest {
  return {
    model,
    effort: 'medium',
    system: 'sys',
    history: [],
    userText: 'look up 30 Thai dishes',
    tools: [{ name: 'thaifcd_food', description: 'x', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    webTools: false,
    runTool: async () => ({ content: 'saved' }),
    onUsage: () => undefined,
  };
}

describe('a reply that uses up its tool steps', () => {
  it('Gemini: after the last step, answers once without tools instead of returning nothing', async () => {
    const call = () => geminiRes([{ functionCall: { id: 'c', name: 'thaifcd_food', args: {} } }]);
    const { generate, calls } = fakeGemini([...Array.from({ length: MAX_STEPS }, call), geminiRes([{ text: 'Saved 20 dishes; 10 left. Say "continue" to go on.' }])]);
    const r = await new GeminiProvider(generate).run(request('gemini-3.8-flash'));
    expect(r).toMatchObject({ text: 'Saved 20 dishes; 10 left. Say "continue" to go on.', outOfSteps: true });
    expect(calls).toHaveLength(MAX_STEPS + 1);
    const final = calls.at(-1)!;
    expect(JSON.stringify(final.config)).toContain('"functionCallingConfig":{"mode":"NONE"}');
    expect(JSON.stringify(final.contents)).toContain(OUT_OF_STEPS.slice(0, 40));
  });

  it('Claude: the same, with tool_choice none on the final request', async () => {
    const toolUse = () => claudeMsg('tool_use', [{ type: 'tool_use', id: 't', name: 'thaifcd_food', input: {} }]);
    const { create, calls } = fakeClaude([...Array.from({ length: MAX_STEPS }, toolUse), claudeMsg('end_turn', [{ type: 'text', text: 'Did 20, 10 to go.' }])]);
    const r = await new ClaudeProvider(create).run(request('claude-sonnet-5-5'));
    expect(r).toMatchObject({ text: 'Did 20, 10 to go.', outOfSteps: true });
    expect(calls).toHaveLength(MAX_STEPS + 1);
    expect(calls.at(-1)!.tool_choice).toEqual({ type: 'none' });
    expect(JSON.stringify(calls.at(-1)!.messages.at(-1))).toContain(OUT_OF_STEPS.slice(0, 40));
    expect(calls[0].tool_choice).toBeUndefined();
  });
});

describe('outside lookups that hang', () => {
  it('a ThaiFCD export that times out moves on to the page', async () => {
    const { fetchThaiFcd } = await import('../thaifcd');
    const asked: string[] = [];
    const page =
      '<div>Food Code:</div><div>F1</div><div>Thai name:</div><div>ข้าวทดสอบ</div><div>English name:</div><div>Rice, test</div>' +
      '<table><tr><th>Nutrients (สารอาหาร)</th><th>Unit</th><th>Per 100 g edible portion</th></tr><tr><td>Energy, by calculation</td><td>kcal</td><td>140</td></tr></table>';
    const fetchFn = (async (u: string, init?: RequestInit) => {
      asked.push(u);
      expect(init?.signal).toBeTruthy(); // every lookup has a time limit
      if (u.includes('_excel')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(page);
    }) as typeof fetch;
    expect((await fetchThaiFcd({ dbcode: 'STD', id: '1' }, fetchFn))!.per100.kcal).toBe(140);
    expect(asked).toHaveLength(2);
  });
});
