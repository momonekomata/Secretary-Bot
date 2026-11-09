import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { archiveUsage, Briefings, usageStats } from '../briefings';
import { buildRawEmail, Google, readClient } from '../google';
import { newsUrl, parseRss } from '../news';
import { Store, type UsageRow } from '../store';
import { runTool } from '../tools';
import { transcribe, voicePrompt } from '../voice';
import { aqiCategory, describeCode, weekendDays, type DayForecast } from '../weather';
import { NOW, echoProvider, fakeFetch, fakeGemini, geminiRes, testConfig } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>AI model breaks record - Tech Daily</title><link>https://news.google.com/a</link><pubDate>Sat, 07 Nov 2026 08:00:00 GMT</pubDate><source url="https://x">Tech Daily</source></item>
<item><title><![CDATA[Baht &amp; markets rally]]></title><link>https://news.google.com/b</link><pubDate>Sat, 07 Nov 2026 07:00:00 GMT</pubDate><source url="https://y">Bangkok Post</source></item>
</channel></rss>`;

const GEO = { results: [{ name: 'Bangkok', country: 'Thailand', latitude: 13.75, longitude: 100.5 }] };
const FORECAST = {
  current: { temperature_2m: 31, apparent_temperature: 35, relative_humidity_2m: 70, weather_code: 2, wind_speed_10m: 9 },
  daily: {
    time: ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
    weather_code: [2, 61, 1, 1, 3, 0, 0],
    temperature_2m_max: [34, 32, 33, 33, 33, 34, 34],
    temperature_2m_min: [25, 24, 25, 25, 25, 25, 25],
    precipitation_probability_max: [10, 70, 5, 5, 20, 0, 0],
    uv_index_max: [9, 6, 9, 9, 8, 9, 9],
  },
};
const AIR = { current: { us_aqi: 124, pm2_5: 44.8, pm10: 60.2 } };

describe('news', () => {
  it('parses Google News RSS and strips the source suffix', () => {
    expect(parseRss(RSS, 5)).toEqual([
      { title: 'AI model breaks record', source: 'Tech Daily', link: 'https://news.google.com/a', published: 'Sat, 07 Nov 2026 08:00:00 GMT' },
      { title: 'Baht & markets rally', source: 'Bangkok Post', link: 'https://news.google.com/b', published: 'Sat, 07 Nov 2026 07:00:00 GMT' },
    ]);
    expect(parseRss(RSS, 1)).toHaveLength(1);
  });

  it('builds search and top-story URLs for a locale', () => {
    expect(newsUrl('AI', { language: 'th', country: 'TH' })).toBe('https://news.google.com/rss/search?q=AI%20when%3A2d&hl=th&gl=TH&ceid=TH%3Ath');
    expect(newsUrl(null, { language: 'en-US', country: 'US' })).toBe('https://news.google.com/rss?hl=en-US&gl=US&ceid=US%3Aen');
  });
});

describe('weather', () => {
  it('describes codes and AQI levels', () => {
    expect(describeCode(61)).toBe('🌦️ Light rain');
    expect(aqiCategory(124).label).toMatch(/sensitive/);
    expect(aqiCategory(30).label).toMatch(/Good/);
  });

  it('picks the coming weekend', () => {
    const day = (date: string): DayForecast => ({ date, code: 0, min: 20, max: 30, rainChance: 0, uvMax: 5 });
    const fromFriday = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(day);
    expect(weekendDays(fromFriday).map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15']);
    expect(weekendDays(['2026-11-15', '2026-11-16'].map(day)).map((d) => d.date)).toEqual(['2026-11-15']);
  });

  it('get_weather tool reports weather and air quality', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'geocoding-api': GEO, 'air-quality-api': AIR, 'api.open-meteo.com': FORECAST }));
    const r = await runTool('get_weather', { city: '', days: 2 }, { chatKey: 'c', store: new Store(null), cfg: testConfig(), google: null });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('Weather for Bangkok, Thailand');
    expect(r.content).toContain('31°C (feels like 35°C)');
    expect(r.content).toContain('US AQI 124');
    expect(r.content.split('\n')).toHaveLength(5);
  });
});

describe('briefings', () => {
  it('builds the morning briefing from every source, tolerating failures', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'news.google.com': RSS, 'geocoding-api': GEO, 'air-quality-api': AIR, 'api.open-meteo.com': FORECAST }));
    const store = new Store(null);
    store.addTodo('telegram:1', 'Pay rent');
    store.updateSettings({ newsTopics: ['AI'] });
    const { provider, requests } = echoProvider('🌅 Good morning!');
    const agent = new Agent(testConfig(), store, { gemini: provider }, null, () => NOW);
    const b = new Briefings(testConfig(), store, agent, () => NOW);

    expect(await b.morning('telegram:1')).toBe('🌅 Good morning!');
    const data = requests[0].userText;
    expect(data).toContain('## Weather & air quality');
    expect(data).toContain('US AQI 124');
    expect(data).toContain('• Pay rent');
    expect(data).toContain('AI model breaks record');
    expect(data).not.toContain('calendar'); // Google not connected
    expect(requests[0].system).toContain('morning executive briefing');
    expect(store.usage()[0].kind).toBe('briefing');
  });

  it('formats usage stats and archives old rows to a gzip CSV', () => {
    const store = new Store(null);
    const row = (ts: string, cost: number): UsageRow => ({ ts, kind: 'chat', model: 'gemini-3.8-flash', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, webSearches: 0, cost });
    store.addUsage(row('2026-09-01T00:00:00Z', 0.5));
    store.addUsage(row('2026-11-07T05:00:00Z', 0.25));
    const stats = usageStats(store.usage(), 'Asia/Bangkok', NOW);
    expect(stats).toContain('Today: $0.2500 (1 calls)');
    expect(stats).toContain('gemini-3.8-flash: in 100 / out 10 tokens');

    const dir = mkdtempSync(join(tmpdir(), 'sb-'));
    const backup = archiveUsage(store, dir, 30, NOW)!;
    expect(backup.rows).toBe(1);
    expect(gunzipSync(backup.data).toString()).toContain('2026-09-01T00:00:00Z,chat,gemini-3.8-flash');
    expect(store.usage()).toHaveLength(1);
    expect(archiveUsage(store, dir, 30, NOW)).toBeNull();
  });
});

describe('google', () => {
  it('encodes UTF-8 email drafts', () => {
    const raw = Buffer.from(buildRawEmail('a@b.com', 'สวัสดี', 'Hello ✓'), 'base64url').toString();
    expect(raw).toContain('To: a@b.com');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('สวัสดี').toString('base64')}?=`);
    expect(Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString()).toBe('Hello ✓');
  });

  function client(dir: string, token: object, fetchFn: typeof fetch) {
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
    writeFileSync(join(dir, 'token.json'), JSON.stringify(token));
    return new Google(readClient(join(dir, 'credentials.json')), join(dir, 'token.json'), fetchFn);
  }

  it('refreshes an expired token and calls the API with it', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(`${url.split('?')[0]} ${(init?.headers as Record<string, string>)?.Authorization ?? ''}`);
      if (url.includes('oauth2')) return Response.json({ access_token: 'fresh', expires_in: 3600 });
      return Response.json({ items: [{ id: 't', title: 'Call mum', due: '2026-11-08T00:00:00.000Z' }] });
    }) as typeof fetch;
    const g = client(mkdtempSync(join(tmpdir(), 'sb-')), { access_token: 'old', refresh_token: 'r', expiry_date: 0 }, fetchFn);
    expect(await g.tasks()).toEqual([{ id: 't', title: 'Call mum', due: '2026-11-08T00:00:00.000Z', notes: undefined }]);
    expect(seen).toEqual(['https://oauth2.googleapis.com/token ', 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks Bearer fresh']);
  });

  it('explains an expired sign-in', async () => {
    const fetchFn = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    const g = client(mkdtempSync(join(tmpdir(), 'sb-')), { access_token: '', refresh_token: 'r', expiry_date: 0 }, fetchFn);
    await expect(g.check()).rejects.toThrow(/npm run google-auth/);
  });
});

describe('voice', () => {
  it('transcribes and translates with Gemini structured output', async () => {
    const { generate, calls } = fakeGemini([
      geminiRes([{ text: JSON.stringify({ language: 'Thai', transcript: 'พรุ่งนี้โทรหาหมอฟัน', translation: 'Call the dentist tomorrow' }) }]),
    ]);
    const usage: number[] = [];
    const t = await transcribe(generate, 'gemini-3.8-flash', { mimeType: 'audio/ogg', data: 'AAAA' }, 'English', (u) => usage.push(u.input));
    expect(t).toEqual({ language: 'Thai', transcript: 'พรุ่งนี้โทรหาหมอฟัน', translation: 'Call the dentist tomorrow' });
    expect(calls[0].config?.responseMimeType).toBe('application/json');
    expect(JSON.stringify(calls[0].contents)).toContain('audio/ogg');
    expect(usage).toEqual([1000]);
    expect(voicePrompt(t, 'English')).toContain('create them now with your tools');
  });
});
