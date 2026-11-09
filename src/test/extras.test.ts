import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { hasFfmpeg, speakable, synthesize, toGeminiAudio, toM4a, toOggOpus, wav } from '../audio';
import { Briefings } from '../briefings';
import { Channels, Secretary } from '../channel';
import { runCommand, settingsView } from '../commands';
import { docxText, fileToInput, UserFacingError } from '../documents';
import { FileHost } from '../files';
import { gmailBody, Google, readClient } from '../google';
import { Maps } from '../maps';
import { Scheduler } from '../scheduler';
import { Store } from '../store';
import { nextOccurrence, zonedTime } from '../time';
import { googleFileId, runTool, toolSpecs } from '../tools';
import { NOW, echoProvider, fakeFetch, fakeGemini, geminiRes, testConfig } from './helpers';

afterEach(() => vi.unstubAllGlobals());

/** A tiny .zip writer (deflate, no CRC check needed by our reader). */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const DOCX = zip({ 'word/document.xml': '<w:body><w:p><w:r><w:t>Contract</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Price: 5 &amp; 6</w:t></w:r></w:p></w:body>' });

/** A Google client whose HTTP calls are answered by `handler` and recorded. */
function fakeGoogle(handler: (method: string, url: string, body: string) => unknown, scope?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
  writeFileSync(join(dir, 'token.json'), JSON.stringify({ access_token: 'at', refresh_token: 'r', expiry_date: Date.now() + 3_600_000, ...(scope !== undefined ? { scope } : {}) }));
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push(`${method} ${url}${body ? ` ${body}` : ''}`);
    const r = handler(method, url, body);
    if (r instanceof Response) return r;
    if (typeof r === 'string') return new Response(r);
    return r === undefined ? new Response(null, { status: 204 }) : Response.json(r);
  }) as typeof fetch;
  return { google: new Google(readClient(join(dir, 'credentials.json')), join(dir, 'token.json'), fetchFn), calls };
}

const ALL_SCOPES = [
  'calendar.events',
  'calendar.calendarlist.readonly',
  'gmail.readonly',
  'gmail.compose',
  'tasks',
  'drive.readonly',
  'documents',
  'spreadsheets',
  'contacts.readonly',
]
  .map((s) => `https://www.googleapis.com/auth/${s}`)
  .join(' ');

describe('Google: calendars, mail, drive, docs, sheets, contacts', () => {
  it('lists events from every visible calendar with ids, and edits and deletes them', async () => {
    const { google, calls } = fakeGoogle((method, url) => {
      if (url.includes('calendarList')) return { items: [{ id: 'me@x.com', summary: 'Me', primary: true }, { id: 'family#x@group.calendar.google.com', summary: 'Family' }, { id: 'h', summary: 'Hidden', hidden: true }] };
      if (method === 'GET' && url.includes('me%40x.com/events')) return { items: [{ id: 'e2', summary: 'Dentist', start: { dateTime: '2026-11-08T15:00:00+07:00' }, end: { dateTime: '2026-11-08T16:00:00+07:00' } }] };
      if (method === 'GET' && url.includes('family')) return { items: [{ id: 'e1', summary: 'Dinner', start: { dateTime: '2026-11-08T09:00:00+07:00' }, end: { dateTime: '2026-11-08T10:00:00+07:00' } }] };
      if (method === 'PATCH') return { id: 'e2', summary: 'Dentist', start: { dateTime: '2026-11-08T17:00:00+07:00' }, end: { dateTime: '2026-11-08T18:00:00+07:00' } };
      return undefined;
    }, ALL_SCOPES);
    const events = await google.events(NOW, new Date(NOW.getTime() + 864e5));
    expect(events.map((e) => [e.summary, e.calendar, e.id])).toEqual([
      ['Dinner', 'Family', 'family#x@group.calendar.google.com::e1'],
      ['Dentist', 'Me', 'me@x.com::e2'],
    ]);
    await google.updateEvent('me@x.com::e2', { start: '2026-11-08T17:00:00+07:00', end: '2026-11-08T18:00:00+07:00', summary: '' });
    await google.deleteEvent('family#x@group.calendar.google.com::e1');
    expect(calls.find((c) => c.startsWith('PATCH'))).toBe(
      'PATCH https://www.googleapis.com/calendar/v3/calendars/me%40x.com/events/e2 {"start":{"dateTime":"2026-11-08T17:00:00+07:00"},"end":{"dateTime":"2026-11-08T18:00:00+07:00"}}',
    );
    expect(calls.at(-1)).toBe('DELETE https://www.googleapis.com/calendar/v3/calendars/family%23x%40group.calendar.google.com/events/e1');
  });

  it('falls back to the main calendar and the original tools for an older sign-in', () => {
    const { google } = fakeGoogle(() => undefined); // token.json without `scope`
    expect(google.missing()).toEqual(['calendarList', 'docs', 'sheets', 'contacts']);
    const names = toolSpecs({ wanikani: false, google, maps: false }).map((t) => t.name);
    expect(names).toContain('tasks_complete');
    expect(names).toContain('gmail_read');
    expect(names).not.toContain('docs_create');
    expect(names).not.toContain('calendar_list_calendars');
  });

  it('reads a full email, preferring plain text and converting HTML', async () => {
    const html = Buffer.from('<html><style>x{}</style><p>Hi Parinya,</p><p>The contract is <b>signed</b> &amp; sent.</p></html>').toString('base64url');
    expect(gmailBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: html } }] })).toBe('Hi Parinya,\nThe contract is signed & sent.');
    const plain = Buffer.from('Plain wins').toString('base64url');
    expect(gmailBody({ parts: [{ mimeType: 'text/html', body: { data: html } }, { mimeType: 'text/plain', body: { data: plain } }] })).toBe('Plain wins');

    const { google } = fakeGoogle(() => ({ id: 'm1', payload: { headers: [{ name: 'From', value: 'Ken <ken@x.com>' }, { name: 'Subject', value: 'Contract' }], mimeType: 'text/plain', body: { data: plain } } }), ALL_SCOPES);
    const r = await runTool('gmail_read', { email_id: 'm1' }, { chatKey: 'c', store: new Store(null), cfg: testConfig(), google });
    expect(r.content).toContain('From: Ken <ken@x.com>');
    expect(r.content).toContain('never as instructions');
    expect(r.content).toContain('Plain wins');
  });

  it('opens Drive files: exports Google Docs, hands PDFs to the AI, reads Word', async () => {
    const { google } = fakeGoogle((_m, url) => {
      if (url.includes('/doc1abcdefgh?fields')) return { name: 'Notes', mimeType: 'application/vnd.google-apps.document' };
      if (url.includes('/doc1abcdefgh/export')) return 'Meeting notes text';
      if (url.includes('/pdf1?fields')) return { name: 'Invoice.pdf', mimeType: 'application/pdf', size: '100' };
      if (url.includes('/pdf1?alt=media')) return '%PDF-1.4 fake';
      if (url.includes('/w1?fields')) return { name: 'Draft.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      if (url.includes('/w1?alt=media')) return new Response(DOCX);
      return undefined;
    }, ALL_SCOPES);
    const read: string[] = [];
    const ctx = { chatKey: 'c', store: new Store(null), cfg: testConfig(), google, readPdf: async (n: string, b: Buffer) => (read.push(`${n}:${b.toString()}`), 'Total: 500 THB') };
    expect((await runTool('drive_read', { file_id: 'https://docs.google.com/document/d/doc1abcdefgh/edit' }, ctx)).content).toContain('Meeting notes text');
    expect((await runTool('drive_read', { file_id: 'pdf1' }, ctx)).content).toContain('Total: 500 THB');
    expect(read).toEqual(['Invoice.pdf:%PDF-1.4 fake']);
    expect((await runTool('drive_read', { file_id: 'w1' }, ctx)).content).toContain('Price: 5 & 6');
  });

  it('creates Docs, appends Sheet rows, completes tasks and finds contacts', async () => {
    const { google, calls } = fakeGoogle((method, url) => {
      if (url.endsWith('/v1/documents')) return { documentId: 'd1' };
      if (url.includes('people:searchContacts')) return { results: [{ person: { names: [{ displayName: 'Ken Sato' }], emailAddresses: [{ value: 'ken@x.com' }] } }] };
      if (method === 'GET' && url.includes('/tasks?')) return { items: [{ id: 't1', title: 'Pay rent' }] };
      return {};
    }, ALL_SCOPES);
    const ctx = { chatKey: 'c', store: new Store(null), cfg: testConfig(), google };
    expect((await runTool('docs_create', { title: 'Notes', content: 'Hello' }, ctx)).content).toContain('https://docs.google.com/document/d/d1/edit');
    expect(calls.some((c) => c.includes('d1:batchUpdate') && c.includes('"endOfSegmentLocation":{}'))).toBe(true);
    await runTool('sheets_append_row', { spreadsheet_id: 'https://docs.google.com/spreadsheets/d/sheet123456/edit', range: 'Expenses', values: ['2026-11-07', 'Lunch', '120'] }, ctx);
    expect(calls.at(-1)).toBe(
      'POST https://sheets.googleapis.com/v4/spreadsheets/sheet123456/values/Expenses:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS {"values":[["2026-11-07","Lunch","120"]]}',
    );
    expect((await runTool('contacts_search', { query: 'Ken' }, ctx)).content).toBe('• Ken Sato: ken@x.com');
    await runTool('tasks_complete', { task_id: 't1' }, ctx);
    expect(calls.at(-1)).toContain('PATCH https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/t1 {"status":"completed"}');
  });

  it('explains a missing permission', async () => {
    const { google } = fakeGoogle(() => new Response('{"error":{"message":"Request had insufficient authentication scopes."}}', { status: 403 }), ALL_SCOPES);
    const r = await runTool('docs_create', { title: 'x', content: '' }, { chatKey: 'c', store: new Store(null), cfg: testConfig(), google });
    expect(r.content).toMatch(/npm run google-auth/);
  });

  it('parses file ids from links', () => {
    expect(googleFileId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjK/edit#gid=0')).toBe('1AbCdEfGhIjK');
    expect(googleFileId('https://drive.google.com/open?id=1AbCdEfGhIjK')).toBe('1AbCdEfGhIjK');
    expect(googleFileId(' plainId ')).toBe('plainId');
  });
});

describe('/gtask and /gdone', () => {
  it('lists numbered tasks and ticks one off', async () => {
    const { google, calls } = fakeGoogle((method, url) => (method === 'GET' && url.includes('/tasks?') ? { items: [{ id: 'a', title: 'Buy milk' }, { id: 'b', title: 'Call mum' }] } : {}), ALL_SCOPES);
    const store = new Store(null);
    const cfg = testConfig();
    const agent = new Agent(cfg, store, { gemini: echoProvider().provider }, google, () => NOW);
    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings: new Briefings(cfg, store, agent), status: async () => '', now: () => NOW };
    expect((await runCommand('/gtask', ctx))!.text).toContain('2. Call mum');
    expect((await runCommand('/gdone 2', ctx))!.text).toBe('✅ Done in Google Tasks: Call mum');
    expect(calls.at(-1)).toContain('/tasks/b {"status":"completed"}');
    expect((await runCommand('/gdone milk', ctx))!.text).toBe('✅ Done in Google Tasks: Buy milk');
  });
});

describe('Maps', () => {
  it('searches places near the user and computes travel time', async () => {
    const sent: { url: string; body: unknown; mask: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), mask: (init.headers as Record<string, string>)['X-Goog-FieldMask'] });
      return url.includes('places')
        ? Response.json({ places: [{ displayName: { text: 'Ramen Bar' }, formattedAddress: 'Sukhumvit 21', rating: 4.6, currentOpeningHours: { openNow: true } }] })
        : Response.json({ routes: [{ duration: '1830s', distanceMeters: 12_340 }] });
    }) as typeof fetch;
    const maps = new Maps('key', fetchFn);
    const store = new Store(null);
    store.updateSettings({ city: { name: 'Bangkok', lat: 13.75, lon: 100.5 } });
    const ctx = { chatKey: 'c', store, cfg: testConfig(), google: null, maps };
    expect((await runTool('maps_search_places', { query: 'ramen' }, ctx)).content).toBe('• Ramen Bar — Sukhumvit 21, ★4.6, open now');
    expect(sent[0].body).toMatchObject({ textQuery: 'ramen', locationBias: { circle: { center: { latitude: 13.75, longitude: 100.5 } } } });
    expect((await runTool('maps_travel_time', { origin: 'Asok', destination: 'Don Mueang Airport', mode: 'DRIVE' }, ctx)).content).toBe(
      'Asok → Don Mueang Airport by drive: about 31 min, 12.3 km.',
    );
    expect(sent[1].body).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' });
  });
});

describe('repeating reminders', () => {
  const tz = 'Asia/Bangkok';
  const at = new Date('2026-11-09T02:00:00Z'); // Mon 09:00 Bangkok

  it('computes the next local occurrence', () => {
    expect(nextOccurrence(at, 'daily', tz, at)!.toISOString()).toBe('2026-11-10T02:00:00.000Z');
    expect(nextOccurrence(at, 'weekly', tz, at)!.toISOString()).toBe('2026-11-16T02:00:00.000Z');
    expect(nextOccurrence(new Date('2026-11-13T02:00:00Z'), 'weekdays', tz, new Date('2026-11-13T02:00:00Z'))!.toISOString()).toBe('2026-11-16T02:00:00.000Z'); // Fri → Mon
    expect(nextOccurrence(new Date('2027-01-31T02:00:00Z'), 'monthly', tz, new Date('2027-01-31T02:00:00Z'))!.toISOString()).toBe('2027-02-28T02:00:00.000Z');
    expect(nextOccurrence(at, 'none', tz, at)).toBeNull();
  });

  it('keeps the wall-clock time across daylight saving changes', () => {
    expect(zonedTime(2026, 3, 9, 9, 0, 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z'); // EDT
    const before = zonedTime(2026, 3, 7, 9, 0, 'America/New_York'); // EST
    expect(before.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(nextOccurrence(before, 'daily', 'America/New_York', new Date('2026-03-08T15:00:00Z'))!.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('set_reminder stores the repeat and the scheduler reschedules after firing', async () => {
    const store = new Store(null);
    const r = await runTool('set_reminder', { at: '2026-11-07T17:00:30+07:00', text: 'Stand-up', repeat: 'weekdays' }, { chatKey: 'test:1', store, cfg: testConfig(), google: null, now: () => NOW });
    expect(r.content).toMatch(/repeating weekdays/);
    const sent: string[] = [];
    const channels = new Channels();
    channels.add({ prefix: 'test', send: async (_id, text) => void sent.push(text) });
    const cfg = testConfig({ schedule: { ...testConfig().schedule, weather: '', briefing: '', weekend: '', cleanup: '' } });
    await new Scheduler(cfg, store, channels, null, () => undefined).tick(new Date('2026-11-07T10:01:00Z')); // Sat 17:01
    expect(sent).toEqual(['⏰ Stand-up']);
    expect(store.reminders()).toMatchObject([{ text: 'Stand-up', repeat: 'weekdays', dueAt: '2026-11-09T10:00:00.000Z' }]); // next Monday, same minute
  });
});

describe('files and locations', () => {
  it('turns sent files into AI input', () => {
    expect(fileToInput('a.pdf', 'application/pdf', Buffer.from('%PDF')).documents![0]).toMatchObject({ name: 'a.pdf', mediaType: 'application/pdf' });
    expect(fileToInput('notes.md', 'application/octet-stream', Buffer.from('# Hi')).text).toBe('[File notes.md]\n# Hi');
    expect(fileToInput('c.docx', '', DOCX).text).toBe('[File c.docx]\nContract\nPrice: 5 & 6');
    expect(docxText(DOCX)).toBe('Contract\nPrice: 5 & 6');
    expect(() => fileToInput('a.xlsx', 'application/vnd.ms-excel', Buffer.from('x'))).toThrow(UserFacingError);
  });

  it('sends a file to the agent without saving its contents in the history', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const echo = echoProvider('It is a contract.');
    const agent = new Agent(cfg, store, { gemini: echo.provider }, null, () => NOW);
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent), null, async () => '');
    const r = await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '', file: { name: 'deal.docx', mime: '', data: DOCX } });
    expect(r!.text).toBe('It is a contract.');
    expect(echo.requests[0].userText).toContain('Price: 5 & 6');
    expect(store.history('telegram:1')[0].text).toMatch(/^\[sent file deal\.docx\] I sent you this file/);
    expect(store.history('telegram:1')[0].text).not.toContain('Price');

    const pdf = await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: 'total?', file: { name: 'bill.pdf', mime: 'application/pdf', data: Buffer.from('%PDF') } });
    expect(pdf!.text).toBe('It is a contract.');
    expect(echo.requests[1].documents![0].name).toBe('bill.pdf');
  });

  it('uses a shared location as the weather city', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        nominatim: { address: { suburb: 'Khlong Toei', city: 'Bangkok', country: 'Thailand' } },
        'air-quality-api': { current: { us_aqi: 40, pm2_5: 9, pm10: 15 } },
        'api.open-meteo.com': {
          current: { temperature_2m: 30, apparent_temperature: 33, relative_humidity_2m: 60, weather_code: 1, wind_speed_10m: 5 },
          daily: { time: ['2026-11-07'], weather_code: [1], temperature_2m_max: [33], temperature_2m_min: [25], precipitation_probability_max: [5], uv_index_max: [8] },
        },
      }),
    );
    const store = new Store(null);
    const cfg = testConfig();
    const agent = new Agent(cfg, store, { gemini: echoProvider().provider });
    const s = new Secretary(cfg, store, agent, new Briefings(cfg, store, agent), null, async () => '');
    const r = await s.handle({ platform: 'line', chatKey: 'line:U1', userId: 'U1', text: '', location: { lat: 13.72, lon: 100.56 } });
    expect(r!.text).toMatch(/^📍 Got it: Khlong Toei, Bangkok, Thailand/);
    expect(r!.text).toContain('30°C');
    expect(store.settings().city).toMatchObject({ name: 'Khlong Toei, Bangkok', lat: 13.72 });
  });
});

describe('spoken replies', () => {
  it('cleans text for speech', () => {
    expect(speakable('🌅 Good morning!\n• Rain at 3pm ☔ https://x.y/z\n- Bring an umbrella')).toBe('Good morning!\nRain at 3pm \nBring an umbrella');
    expect(speakable('a. '.repeat(1000)).length).toBeLessThanOrEqual(1500);
  });

  it('asks Gemini TTS for audio and reads the sample rate', async () => {
    const pcm = Buffer.alloc(48_000); // 1 s at 24 kHz, 16-bit
    const { generate, calls } = fakeGemini([geminiRes([{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }])]);
    const s = await synthesize(generate, 'gemini-3.8-flash-tts', 'Kore', 'Hello', () => undefined);
    expect(s).toMatchObject({ rate: 24000, durationMs: 1000 });
    expect(calls[0].config).toMatchObject({ responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } });
    expect(wav(s!).subarray(0, 4).toString()).toBe('RIFF');
  });

  it.skipIf(!hasFfmpeg())('encodes speech for Telegram and LINE and converts LINE audio for Gemini', async () => {
    const speech = { pcm: Buffer.alloc(48_000), rate: 24000, durationMs: 1000 };
    expect((await toOggOpus(speech)).subarray(0, 4).toString()).toBe('OggS');
    const m4a = await toM4a(speech);
    expect(m4a.subarray(4, 8).toString()).toBe('ftyp');
    const converted = await toGeminiAudio({ mimeType: 'audio/m4a', data: m4a.toString('base64') });
    expect(converted.mimeType).toBe('audio/ogg');
  });

  it('passes Telegram voice notes straight through', async () => {
    expect(await toGeminiAudio({ mimeType: 'audio/ogg', data: 'AA' })).toEqual({ mimeType: 'audio/ogg', data: 'AA' });
  });

  it('speaks replies to voice notes, and /voice and /say control it', async () => {
    const store = new Store(null);
    const cfg = testConfig();
    const agent = new Agent(cfg, store, { gemini: echoProvider('Added milk.').provider }, null, () => NOW);
    const { generate } = fakeGemini([geminiRes([{ text: JSON.stringify({ language: 'English', transcript: 'add milk', translation: '' }) }])]);
    const briefings = new Briefings(cfg, store, agent);
    const s = new Secretary(cfg, store, agent, briefings, generate, async () => '');
    const r = await s.handle({ platform: 'telegram', chatKey: 'telegram:1', userId: '1', text: '', audio: { mimeType: 'audio/ogg', data: 'AA' } });
    expect(r!.speak).toBe('Added milk.');

    const ctx = { chatKey: 'telegram:1', userId: '1', agent, store, cfg, briefings, status: async () => '' };
    await runCommand('/voice off', ctx);
    expect(store.settings().voiceReplies).toBe('off');
    expect(settingsView(ctx).text).toContain('Spoken replies: off');
    expect(await runCommand('/say こんにちは', ctx)).toEqual({ text: '', speak: 'こんにちは' });
  });
});

describe('FileHost', () => {
  it('serves files at unguessable links until they expire', () => {
    const host = new FileHost('https://bot.example.com/');
    const url = host.add('reply.m4a', 'audio/mp4', Buffer.from('x'), 1000);
    expect(url).toMatch(/^https:\/\/bot\.example\.com\/files\/[\w-]{24}\/reply\.m4a$/);
    expect(host.get(new URL(url).pathname)!.type).toBe('audio/mp4');
    expect(host.get('/files/nope/reply.m4a')).toBeNull();
    expect(new FileHost('').enabled).toBe(false);
  });
});
