import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docxText } from './documents';

const S = 'https://www.googleapis.com/auth/';

/** Everything the bot asks Google for, granted with `npm run google-auth`. */
export const GOOGLE_SCOPES = [
  `${S}calendar.events`, // read, add, change and delete events on your calendars
  `${S}calendar.calendarlist.readonly`, // see which calendars you have (shared, family...)
  `${S}gmail.readonly`, // read and search mail
  `${S}gmail.compose`, // create drafts (the bot never sends mail)
  `${S}tasks`, // Google Tasks
  `${S}drive.readonly`, // search and read Drive files
  `${S}documents`, // create and add to Google Docs
  `${S}spreadsheets`, // read and add rows to Google Sheets
  `${S}contacts.readonly`, // look up people's email addresses and phone numbers
];

/** Scopes granted by the first version of the bot, assumed when token.json doesn't list them. */
const ORIGINAL_SCOPES = [`${S}calendar.events`, `${S}gmail.readonly`, `${S}gmail.compose`, `${S}tasks`, `${S}drive.readonly`];

export type GoogleFeature = 'calendar' | 'calendarList' | 'gmail' | 'tasks' | 'drive' | 'docs' | 'sheets' | 'contacts';

const FEATURE_SCOPE: Record<GoogleFeature, string> = {
  calendar: `${S}calendar.events`,
  calendarList: `${S}calendar.calendarlist.readonly`,
  gmail: `${S}gmail.readonly`,
  tasks: `${S}tasks`,
  drive: `${S}drive.readonly`,
  docs: `${S}documents`,
  sheets: `${S}spreadsheets`,
  contacts: `${S}contacts.readonly`,
};

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  token_uri: string;
  auth_uri: string;
}

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** ms since epoch */
  expiry_date: number;
  scope?: string;
}

export const credentialsPath = (dataDir: string) => join(dataDir, 'credentials.json');
export const tokenPath = (dataDir: string) => join(dataDir, 'token.json');

/** Reads a Google "OAuth client ID" JSON file (Desktop app or Web). */
export function readClient(file: string): OAuthClient {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const c = raw.installed ?? raw.web;
  if (!c?.client_id) throw new Error(`${file} is not an OAuth client file (download it from Google Cloud > Credentials).`);
  return {
    client_id: c.client_id,
    client_secret: c.client_secret,
    token_uri: c.token_uri ?? 'https://oauth2.googleapis.com/token',
    auth_uri: c.auth_uri ?? 'https://accounts.google.com/o/oauth2/auth',
  };
}

export class GoogleAuthError extends Error {}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Builds an RFC 822 message for a Gmail draft (UTF-8 subject and body). */
export function buildRawEmail(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
  ].join('\r\n');
  return b64url(mime);
}

/** Plain text from HTML: drops tags, scripts and styles, keeps line breaks. */
export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/** Finds the best text body in a Gmail message payload: text/plain first, else text/html converted to text. */
export function gmailBody(payload: GmailPart | undefined): string {
  const find = (p: GmailPart | undefined, type: string): string | null => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const child of p.parts ?? []) {
      const r = find(child, type);
      if (r) return r;
    }
    return null;
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain.trim();
  const html = find(payload, 'text/html');
  return html ? htmlToText(html) : '';
}

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

export interface CalendarEvent {
  /** "<calendarId>::<eventId>", what the update and delete tools take. */
  id?: string;
  calendar?: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  link?: string;
}

export interface EmailSummary {
  id?: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
}

export interface DriveFile {
  id?: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  link: string;
}

export interface DriveContent {
  name: string;
  mimeType: string;
  /** Extracted text, when the file is text-like. */
  text?: string;
  /** Raw PDF bytes, for the AI to read. */
  pdf?: Buffer;
}

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
}

const MAX_TEXT = 60_000;
const MAX_DOWNLOAD = 15 * 1024 * 1024;

/** Minimal Google Workspace client over the REST APIs, with automatic token refresh. */
export class Google {
  private token: StoredToken;
  private calendarCache: { at: number; list: CalendarInfo[] } | null = null;

  constructor(
    private readonly client: OAuthClient,
    private readonly tokenFile: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.token = JSON.parse(readFileSync(tokenFile, 'utf8'));
  }

  /** Returns a client when both credentials.json and token.json exist in the data folder. */
  static load(dataDir: string): Google | null {
    const creds = credentialsPath(dataDir);
    const token = tokenPath(dataDir);
    if (!existsSync(creds) || !existsSync(token)) return null;
    return new Google(readClient(creds), token);
  }

  /** Scopes the user granted. */
  get scopes(): Set<string> {
    return new Set(this.token.scope ? this.token.scope.split(/\s+/) : ORIGINAL_SCOPES);
  }

  has(feature: GoogleFeature): boolean {
    return this.scopes.has(FEATURE_SCOPE[feature]);
  }

  /** Features the current sign-in doesn't cover (run `npm run google-auth` again to add them). */
  missing(): GoogleFeature[] {
    return (Object.keys(FEATURE_SCOPE) as GoogleFeature[]).filter((f) => !this.has(f));
  }

  private async accessToken(): Promise<string> {
    if (this.token.access_token && this.token.expiry_date > Date.now() + 60_000) return this.token.access_token;
    const res = await this.fetchFn(this.client.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.client_id,
        client_secret: this.client.client_secret,
        refresh_token: this.token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GoogleAuthError(
        json.error === 'invalid_grant'
          ? 'Google sign-in has expired or was revoked. Run `npm run google-auth` again.'
          : `Google token refresh failed: ${json.error_description ?? json.error ?? res.status}`,
      );
    }
    this.token = {
      ...this.token,
      access_token: json.access_token,
      expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
      ...(json.scope ? { scope: json.scope } : {}),
    };
    writeFileSync(this.tokenFile, JSON.stringify(this.token, null, 1));
    return json.access_token;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 403 && /insufficient|scope/i.test(body)) {
        throw new GoogleAuthError('Google needs one more permission for this. Run `npm run google-auth` again and allow everything.');
      }
      throw new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  /** Checks the stored sign-in still works. */
  async check(): Promise<void> {
    await this.accessToken();
  }

  // --- Calendar ---

  /** Calendars shown in the user's Google Calendar (just the main one without the calendar-list permission). */
  async calendars(): Promise<CalendarInfo[]> {
    if (!this.has('calendarList')) return [{ id: 'primary', name: 'Main calendar', primary: true }];
    if (this.calendarCache && Date.now() - this.calendarCache.at < 600_000) return this.calendarCache.list;
    const r = await this.api<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; selected?: boolean; hidden?: boolean }[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader',
    );
    const list = (r.items ?? [])
      .filter((c) => !c.hidden && (c.selected !== false || c.primary))
      .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: !!c.primary }));
    this.calendarCache = { at: Date.now(), list };
    return list;
  }

  /** Finds a calendar by name (case-insensitive, partial); "" means the main one. */
  async findCalendar(name: string): Promise<CalendarInfo> {
    const list = await this.calendars();
    const primary = list.find((c) => c.primary) ?? { id: 'primary', name: 'Main calendar', primary: true };
    if (!name.trim()) return primary;
    const n = name.trim().toLowerCase();
    const found = list.find((c) => c.name.toLowerCase() === n) ?? list.find((c) => c.name.toLowerCase().includes(n));
    if (!found) throw new Error(`No calendar called "${name}". Calendars: ${list.map((c) => c.name).join(', ')}`);
    return found;
  }

  /** Events from all visible calendars, sorted by start time. */
  async events(from: Date, to: Date, max = 25): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) });
    const cals = await this.calendars();
    const lists = await Promise.all(
      cals.map(async (cal) => {
        const r = await this.api<{
          items?: { id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; htmlLink?: string }[];
        }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`).catch(() => ({ items: [] }));
        return (r.items ?? []).map((e) => ({
          id: `${cal.id}::${e.id}`,
          calendar: cals.length > 1 ? cal.name : undefined,
          summary: e.summary ?? '(no title)',
          start: e.start.dateTime ?? e.start.date ?? '',
          end: e.end.dateTime ?? e.end.date ?? '',
          location: e.location,
          link: e.htmlLink,
        }));
      }),
    );
    return lists
      .flat()
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, max);
  }

  async createEvent(summary: string, startIso: string, endIso: string, description = '', calendarName = ''): Promise<CalendarEvent> {
    const cal = await this.findCalendar(calendarName);
    const e = await this.api<{ id: string; htmlLink?: string }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({ summary, description, start: { dateTime: startIso }, end: { dateTime: endIso } }),
    });
    return { id: `${cal.id}::${e.id}`, calendar: cal.name, summary, start: startIso, end: endIso, link: e.htmlLink };
  }

  private splitEventId(id: string): [string, string] {
    const i = id.lastIndexOf('::');
    return i < 0 ? ['primary', id] : [id.slice(0, i), id.slice(i + 2)];
  }

  /** Changes an event. Empty fields stay as they are. */
  async updateEvent(id: string, patch: { summary?: string; start?: string; end?: string; description?: string; location?: string }): Promise<CalendarEvent> {
    const [cal, ev] = this.splitEventId(id);
    const body: Record<string, unknown> = {};
    if (patch.summary) body.summary = patch.summary;
    if (patch.description) body.description = patch.description;
    if (patch.location) body.location = patch.location;
    if (patch.start) body.start = { dateTime: patch.start };
    if (patch.end) body.end = { dateTime: patch.end };
    const e = await this.api<{ id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; htmlLink?: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(ev)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return { id, summary: e.summary ?? '', start: e.start.dateTime ?? e.start.date ?? '', end: e.end.dateTime ?? e.end.date ?? '', link: e.htmlLink };
  }

  async deleteEvent(id: string): Promise<void> {
    const [cal, ev] = this.splitEventId(id);
    await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(ev)}`, { method: 'DELETE' });
  }

  // --- Gmail ---

  /** Searches mail with Gmail's search syntax, e.g. "from:ken contract newer_than:14d". */
  async searchEmails(query: string, max = 10): Promise<EmailSummary[]> {
    const list = await this.api<{ messages?: { id: string }[] }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`,
    );
    return Promise.all(
      (list.messages ?? []).map(async ({ id }) => {
        const m = await this.api<{ snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
        return { id, from: h('From'), subject: h('Subject') || '(no subject)', date: h('Date'), snippet: decodeHtml(m.snippet ?? '') };
      }),
    );
  }

  unreadEmails(max = 8): Promise<EmailSummary[]> {
    return this.searchEmails('is:unread category:primary', max);
  }

  /** Reads one email in full (text body, up to ~12,000 characters). */
  async readEmail(id: string): Promise<Email> {
    const m = await this.api<{ id: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    );
    const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
    const body = gmailBody(m.payload);
    return { id, from: h('From'), to: h('To'), subject: h('Subject') || '(no subject)', date: h('Date'), body: body.length > 12_000 ? `${body.slice(0, 12_000)}\n[…cut]` : body };
  }

  /** Creates a Gmail draft. The bot never sends email itself. */
  async createDraft(to: string, subject: string, body: string): Promise<void> {
    await this.api('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: buildRawEmail(to, subject, body) } }),
    });
  }

  // --- Tasks ---

  async tasks(max = 30): Promise<GoogleTask[]> {
    const r = await this.api<{ items?: GoogleTask[] }>(
      `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?${new URLSearchParams({ showCompleted: 'false', maxResults: String(max) })}`,
    );
    return (r.items ?? []).map((t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due }));
  }

  /** `due` is a date (YYYY-MM-DD); Google Tasks ignores the time of day. */
  async addTask(title: string, notes = '', due?: string): Promise<GoogleTask> {
    return this.api<GoogleTask>('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, notes, ...(due ? { due: `${due.slice(0, 10)}T00:00:00.000Z` } : {}) }),
    });
  }

  async completeTask(id: string): Promise<void> {
    await this.api(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
  }

  // --- Drive ---

  async driveSearch(query: string, max = 10): Promise<DriveFile[]> {
    const safe = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = query ? `(name contains '${safe}' or fullText contains '${safe}') and trashed = false` : 'trashed = false';
    const r = await this.api<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
        q,
        pageSize: String(max),
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        ...(query ? {} : { orderBy: 'modifiedTime desc' }),
      })}`,
    );
    return (r.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, link: f.webViewLink }));
  }

  /** Opens a Drive file: Google Docs/Sheets/Slides are exported as text, PDFs returned as bytes. */
  async driveRead(fileId: string): Promise<DriveContent> {
    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
    const meta = await this.api<{ name: string; mimeType: string; size?: string }>(`${base}?fields=name,mimeType,size`);
    const name = meta.name ?? 'file';
    const mimeType = meta.mimeType ?? '';
    const exportAs: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    const cut = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[…cut]` : t);
    if (exportAs[mimeType]) {
      const res = await this.request(`${base}/export?mimeType=${encodeURIComponent(exportAs[mimeType])}`);
      return { name, mimeType, text: cut(await res.text()) };
    }
    if (mimeType.startsWith('application/vnd.google-apps')) return { name, mimeType, text: `(${name} is a ${mimeType.split('.').pop()}, which can't be read as text.)` };
    if (Number(meta.size ?? 0) > MAX_DOWNLOAD) return { name, mimeType, text: `(${name} is too large to read, over 15 MB.)` };
    const res = await this.request(`${base}?alt=media`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (mimeType === 'application/pdf') return { name, mimeType, pdf: buf };
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { name, mimeType, text: cut(docxText(buf)) };
    if (mimeType.startsWith('text/') || /json|xml|csv|markdown/.test(mimeType)) return { name, mimeType, text: cut(buf.toString('utf8')) };
    return { name, mimeType, text: `(${name} is a ${mimeType} file, which I can't read. PDFs, Word, Google Docs/Sheets/Slides and text files work.)` };
  }

  /** Lists Drive files matching a Drive query (ids, names, times). */
  async listFiles(q: string, orderBy = 'modifiedTime desc', max = 50): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const r = await this.api<{ files?: { id: string; name: string; modifiedTime: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, orderBy, pageSize: String(max), fields: 'files(id,name,modifiedTime)' })}`,
    );
    return r.files ?? [];
  }

  /** Downloads a (small) Drive file as text. */
  async downloadText(fileId: string): Promise<string> {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    return res.text();
  }

  /** Streams a Drive file to disk (for big files such as a Samsung Health export). */
  async downloadToFile(fileId: string, path: string): Promise<number> {
    const { createWriteStream } = await import('node:fs');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!res.body) throw new Error('Empty download');
    const out = createWriteStream(path);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), out);
    return out.bytesWritten;
  }

  // --- Docs ---

  /** Creates a Google Doc with `text` and returns its link. */
  async createDoc(title: string, text: string): Promise<{ id: string; link: string }> {
    const doc = await this.api<{ documentId: string }>('https://docs.googleapis.com/v1/documents', { method: 'POST', body: JSON.stringify({ title }) });
    if (text) await this.appendDoc(doc.documentId, text);
    return { id: doc.documentId, link: `https://docs.google.com/document/d/${doc.documentId}/edit` };
  }

  async appendDoc(documentId: string, text: string): Promise<void> {
    await this.api(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text: text.endsWith('\n') ? text : `${text}\n` } }] }),
    });
  }

  // --- Sheets ---

  /** Reads cells, e.g. range "Sheet1!A1:D20" or "" for the first sheet. */
  async readSheet(spreadsheetId: string, range: string): Promise<string[][]> {
    const r = await this.api<{ values?: string[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range || 'A1:Z200')}`,
    );
    return r.values ?? [];
  }

  /** Adds a row after the last row of a table, e.g. an expense. */
  async appendRow(spreadsheetId: string, range: string, row: string[]): Promise<void> {
    await this.api(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range || 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [row] }) },
    );
  }

  async createSheet(title: string, header: string[]): Promise<{ id: string; link: string }> {
    const s = await this.api<{ spreadsheetId: string; spreadsheetUrl: string }>('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({ properties: { title } }),
    });
    if (header.length) await this.appendRow(s.spreadsheetId, 'A1', header);
    return { id: s.spreadsheetId, link: s.spreadsheetUrl };
  }

  // --- Contacts ---

  async searchContacts(query: string): Promise<Contact[]> {
    const r = await this.api<{
      results?: { person: { names?: { displayName: string }[]; emailAddresses?: { value: string }[]; phoneNumbers?: { value: string }[] } }[];
    }>(`https://people.googleapis.com/v1/people:searchContacts?${new URLSearchParams({ query, readMask: 'names,emailAddresses,phoneNumbers', pageSize: '10' })}`);
    return (r.results ?? []).map(({ person: p }) => ({
      name: p.names?.[0]?.displayName ?? '(no name)',
      emails: (p.emailAddresses ?? []).map((e) => e.value),
      phones: (p.phoneNumbers ?? []).map((e) => e.value),
    }));
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// --- formatting helpers shared by tools, commands and briefings ---

export function formatEvents(events: CalendarEvent[], timeZone: string, withIds = false): string {
  if (!events.length) return 'No events.';
  return events
    .map((e) => {
      const allDay = !e.start.includes('T');
      const when = allDay
        ? `${e.start} (all day)`
        : new Date(e.start).toLocaleString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `• ${when}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}${e.calendar ? ` [${e.calendar}]` : ''}${withIds && e.id ? ` (id: ${e.id})` : ''}`;
    })
    .join('\n');
}

export function formatEmails(emails: EmailSummary[], withIds = false): string {
  if (!emails.length) return 'No emails found.';
  return emails.map((m) => `• ${m.date ? `${m.date.replace(/\s*\(.*\)$/, '')} ` : ''}from ${m.from}: "${m.subject}" — ${m.snippet}${withIds && m.id ? ` (id: ${m.id})` : ''}`).join('\n');
}

export function formatTasks(tasks: GoogleTask[], numbered = false): string {
  if (!tasks.length) return 'No open Google Tasks.';
  return tasks.map((t, i) => `${numbered ? `${i + 1}.` : '•'} ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`).join('\n');
}
