import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { Briefings } from '../briefings';
import { Channels } from '../channel';
import { runCommand } from '../commands';
import { bmi, bmiCategory, bmr, bodyNumbers, formatFoodDay } from '../health';
import { JapaneseDaily } from '../japanese';
import type { Provider, TurnRequest } from '../llm/types';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { runTool } from '../tools';
import type { WkSubject } from '../wanikani';
import { NOW, echoProvider, fakeFetch, testConfig } from './helpers';

afterEach(() => vi.unstubAllGlobals());

function setup(over = {}, provider?: Provider) {
  const store = new Store(null);
  const cfg = testConfig(over);
  const echo = echoProvider('card text');
  const agent = new Agent(cfg, store, { gemini: provider ?? echo.provider }, null, () => NOW);
  const briefings = new Briefings(cfg, store, agent, () => NOW);
  return { store, cfg, agent, briefings, echo };
}

const tool = (store: Store, name: string, input: unknown) =>
  runTool(name, input, { chatKey: 'telegram:1', store, cfg: testConfig(), google: null, now: () => NOW });

describe('Japanese of the day', () => {
  const kanji = (characters: string, level: number): WkSubject => ({
    id: level * 100 + characters.charCodeAt(0),
    object: 'kanji',
    characters,
    level,
    meanings: ['Language'],
    readings: [{ reading: 'ご', type: 'onyomi', primary: true }],
    meaningMnemonic: 'A mouth that speaks five words.',
  });

  it('uses WaniKani kanji from the current level, gives the AI the real readings, and avoids repeats', async () => {
    const { store, cfg, agent, echo } = setup({ wanikaniToken: 'wk' });
    const wk = { level: async () => 12, subjects: async () => [kanji('語', 12), kanji('話', 12), kanji('日', 10)] };
    const jp = new JapaneseDaily(cfg, store, agent, wk, () => 0);
    await jp.kanji();
    await jp.kanji();
    expect(store.japaneseHistory().kanji).toEqual(['語', '話']);
    expect(echo.requests[0].userText).toContain('Readings: onyomi ご (main)');
    expect(echo.requests[0].system).toContain("Use exactly the meanings and readings given");
    await jp.kanji(); // level 12 used up: falls back to level 10
    expect(store.japaneseHistory().kanji.at(-1)).toBe('日');
  });

  it('without WaniKani, asks for a JLPT-level item and records it', async () => {
    const provider: Provider = { run: async () => ({ text: 'KANJI: 水\n💧 水 means water…' }) };
    const { store, cfg, agent } = setup({}, provider);
    store.updateSettings({ jlptLevel: 'N5' });
    store.addJapanese('kanji', '火');
    let seen: TurnRequest | null = null;
    const spy: Provider = { run: async (r) => ((seen = r), provider.run(r)) };
    const jp = new JapaneseDaily(cfg, store, new Agent(cfg, store, { gemini: spy }, null, () => NOW));
    expect(await jp.kanji()).toBe('💧 水 means water…');
    expect(seen!.system).toContain('JLPT N5');
    expect(seen!.system).toContain('not one of these: 火');
    expect(store.japaneseHistory().kanji).toEqual(['火', '水']);
    void agent;
  });

  it('is sent daily at the Japanese time and set with /jlpt', async () => {
    const { store, cfg, agent, briefings } = setup({ notifyChats: ['test:9'], schedule: { ...testConfig().schedule, japanese: '17:00', weather: '', briefing: '', weekend: '', cleanup: '' } });
    const jp = new JapaneseDaily(cfg, store, agent);
    jp.daily = async () => '🇯🇵 Today’s Japanese';
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'test', send: async (_id, t) => void sent.push(t) });
    await new Scheduler(cfg, store, channels, briefings, () => undefined, jp).tick(NOW);
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual(['🇯🇵 Today’s Japanese']);

    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', japanese: jp, now: () => NOW };
    expect((await runCommand('/jlpt n3', ctx))!.text).toMatch(/JLPT N3/);
    expect(store.settings().jlptLevel).toBe('N3');
  });
});

describe('health numbers', () => {
  it('computes BMI with Asian cut-offs, BMR (Mifflin-St Jeor) and a target', () => {
    expect(bmi(160, 55).toFixed(1)).toBe('21.5');
    expect(bmiCategory(23.5)).toBe('overweight (at risk)');
    expect(bmr('female', 55, 160, 30)).toBe(1239);
    expect(bmr('male', 70, 175, 30)).toBeCloseTo(1648.75);
    const n = bodyNumbers({ sex: 'female', birthYear: 1996, heightCm: 160, weightKg: 55, activity: 'moderate', goal: 'lose' }, 2026);
    expect(n).toMatchObject({ age: 30, bmr: 1239, tdee: 1920, target: 1420 });
    expect(bodyNumbers({ sex: 'female', heightCm: 160 }, 2026)).toEqual({ missing: ['age or birth year', 'weight (kg)'] });
    // Never below a safe floor.
    expect(bodyNumbers({ sex: 'female', birthYear: 1950, heightCm: 145, weightKg: 40, activity: 'sedentary', goal: 'lose' }, 2026)).toMatchObject({ target: 1200 });
  });
});

describe('food diary', () => {
  it('logs food from the AI, totals the day against the target, and removes entries', async () => {
    const store = new Store(null);
    await tool(store, 'body_profile_update', { sex: 'female', age: 30, height_cm: 160, weight_kg: 55, activity: 'moderate', goal: 'lose', target_kcal: 0 });
    const r = await tool(store, 'food_log_add', {
      meal: 'lunch',
      eaten_at: '',
      items: [
        { name: 'Pad kra pao moo', portion: '1 plate', kcal: 580, protein_g: 25, carbs_g: 65, fat_g: 22 },
        { name: 'Fried egg', portion: '1', kcal: 90, protein_g: 6, carbs_g: 0, fat_g: 7 },
      ],
    });
    expect(r.content).toMatch(/^Logged #\d+ Pad kra pao moo 580 kcal, #\d+ Fried egg 90 kcal\./);
    expect(r.content).toContain('Total: 670 kcal');
    expect(r.content).toContain('Target 1420 kcal: 750 kcal left');
    const id = store.food('telegram:1')[1].id;
    expect((await tool(store, 'food_log_remove', { id })).content).toBe('Removed Fried egg (90 kcal).');
    expect(store.food('telegram:1', '2026-11-07').map((f) => f.name)).toEqual(['Pad kra pao moo']);
    expect(store.weights('telegram:1')).toEqual([{ day: '2026-11-07', kg: 55 }]);
  });

  it('shows /food, /bmi and /weight, and tells the AI about today in the per-turn note', async () => {
    const { store, cfg, agent, briefings, echo } = setup();
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
    expect((await runCommand('/food', ctx))!.text).toMatch(/nothing logged yet/);
    expect((await runCommand('/bmi', ctx))!.text).toMatch(/I still need: sex/);
    store.addFood('telegram:1', { ts: NOW.toISOString(), day: '2026-11-07', meal: 'breakfast', name: 'Jok', portion: '1 bowl', kcal: 300, protein: 12, carbs: 45, fat: 6 });
    expect((await runCommand('/food', ctx))!.text).toContain('🍳 Breakfast: 300 kcal');
    store.updateBody('telegram:1', { sex: 'male', birthYear: 1990, heightCm: 175 });
    const w = (await runCommand('/weight 72.4', ctx))!.text;
    expect(w).toMatch(/^⚖️ Logged 72.4 kg\./);
    expect(w).toContain('BMI 23.6: overweight (at risk)');
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[0].note).toContain('Food logged today: 1 item(s), 300 kcal.');
    expect(echo.requests[0].system).toContain('food_log_add');
  });

  it('formats a day by meal', () => {
    const e = (meal: 'dinner' | 'snack', name: string, kcal: number, id: number) => ({ id, ts: '', day: 'd', meal, name, portion: '', kcal, protein: 1, carbs: 2, fat: 3 });
    const text = formatFoodDay([e('snack', 'Thai tea', 250, 7), e('dinner', 'Som tam', 150, 8)], 1800);
    expect(text.indexOf('Dinner')).toBeLessThan(text.indexOf('Snack'));
    expect(text).toContain('Target 1800 kcal: 1400 kcal left');
  });
});

describe('companion and roleplay', () => {
  it('starts a preset scene with an opening line and keeps it in the per-turn note until ended', async () => {
    const { store, cfg, agent, briefings, echo } = setup();
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
    const menu = await runCommand('/roleplay', ctx);
    expect(menu!.buttons!.flat().map((b) => b.command)).toContain('/roleplay ramen');
    const r = await runCommand('/roleplay ramen', ctx);
    expect(r!.text).toMatch(/^🎬 🍜 Ramen shop in Tokyo/);
    expect(echo.requests[0].note).toContain('Roleplay in progress');
    expect(echo.requests[0].note).toContain('ramen shop in Tokyo');
    expect((await runCommand('/roleplay end', ctx))!.text).toMatch(/Scene ended/);
    await agent.reply({ chatKey: 'telegram:1', text: 'hi' });
    expect(echo.requests[1].note).not.toContain('Roleplay');
  });

  it('lets the AI start and end scenes itself', async () => {
    const store = new Store(null);
    await tool(store, 'roleplay_start', { scenario: 'Barista in Osaka, Japanese practice' });
    expect(store.settings().roleplay?.scenario).toBe('Barista in Osaka, Japanese practice');
    await tool(store, 'roleplay_end', {});
    expect(store.settings().roleplay).toBeUndefined();
  });

  it('offers a companion personality', async () => {
    const { store, cfg, agent, briefings } = setup();
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW };
    await runCommand('/persona companion', ctx);
    expect(store.settings().persona).toMatch(/warm, attentive friend/);
  });
});

describe('/forecast', () => {
  it('gives 7 days without using the AI', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'geocoding-api': { results: [{ name: 'Bangkok', country: 'Thailand', latitude: 13.75, longitude: 100.5 }] },
        'air-quality-api': { current: { us_aqi: 60, pm2_5: 20, pm10: 30 } },
        'api.open-meteo.com': {
          current: { temperature_2m: 31, apparent_temperature: 35, relative_humidity_2m: 70, weather_code: 2, wind_speed_10m: 9 },
          daily: {
            time: ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
            weather_code: [2, 61, 1, 1, 3, 0, 0],
            temperature_2m_max: [34, 32, 33, 33, 33, 34, 34],
            temperature_2m_min: [25, 24, 25, 25, 25, 25, 25],
            precipitation_probability_max: [10, 70, 5, 5, 20, 0, 0],
            uv_index_max: [9, 6, 9, 9, 8, 9, 9],
          },
        },
      }),
    );
    const { store, cfg, agent, briefings, echo } = setup();
    const r = await runCommand('/forecast', { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '', now: () => NOW });
    expect(r!.text.split('\n').filter((l) => /°C, rain/.test(l))).toHaveLength(7);
    expect(echo.requests).toHaveLength(0);
  });
});
