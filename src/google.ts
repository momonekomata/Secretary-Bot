import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Everything the bot asks Google for, granted once with `npm run google-auth`. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', // read and add calendar events
  'https://www.googleapis.com/auth/gmail.readonly', // read inbox
  'https://www.googleapis.com/auth/gmail.compose', // create drafts (the bot never sends mail)
  'https://www.googleapis.com/auth/tasks', // Google Tasks
  'https://www.googleapis.com/auth/drive.readonly', // search Drive
];

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

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  link?: string;
}

export interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
}

export interface DriveFile {
  name: string;
  mimeType: string;
  modifiedTime: string;
  link: string;
}

/** Minimal Google Workspace client over the REST APIs, with automatic token refresh. */
export class Google {
  private token: StoredToken;

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
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GoogleAuthError(
        json.error === 'invalid_grant'
          ? 'Google sign-in has expired or was revoked. Run `npm run google-auth` again.'
          : `Google token refresh failed: ${json.error_description ?? json.error ?? res.status}`,
      );
    }
    this.token = { ...this.token, access_token: json.access_token, expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000 };
    writeFileSync(this.tokenFile, JSON.stringify(this.token, null, 1));
    return json.access_token;
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
    }
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  /** Checks the stored sign-in still works. */
  async check(): Promise<void> {
    await this.accessToken();
  }

  async events(from: Date, to: Date, max = 20): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(max),
    });
    const r = await this.api<{ items?: { summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; htmlLink?: string }[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`,
    );
    return (r.items ?? []).map((e) => ({
      summary: e.summary ?? '(no title)',
      start: e.start.dateTime ?? e.start.date ?? '',
      end: e.end.dateTime ?? e.end.date ?? '',
      location: e.location,
      link: e.htmlLink,
    }));
  }

  async createEvent(summary: string, startIso: string, endIso: string, description = ''): Promise<CalendarEvent> {
    const e = await this.api<{ htmlLink?: string }>('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({ summary, description, start: { dateTime: startIso }, end: { dateTime: endIso } }),
    });
    return { summary, start: startIso, end: endIso, link: e.htmlLink };
  }

  async unreadEmails(max = 8): Promise<EmailSummary[]> {
    const list = await this.api<{ messages?: { id: string }[] }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread category:primary', maxResults: String(max) })}`,
    );
    return Promise.all(
      (list.messages ?? []).map(async ({ id }) => {
        const m = await this.api<{ snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
        return { from: h('From'), subject: h('Subject') || '(no subject)', date: h('Date'), snippet: decodeHtml(m.snippet ?? '') };
      }),
    );
  }

  /** Creates a Gmail draft. The bot never sends email itself. */
  async createDraft(to: string, subject: string, body: string): Promise<void> {
    await this.api('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: buildRawEmail(to, subject, body) } }),
    });
  }

  async tasks(max = 20): Promise<GoogleTask[]> {
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

  async driveSearch(query: string, max = 10): Promise<DriveFile[]> {
    const safe = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = query ? `(name contains '${safe}' or fullText contains '${safe}') and trashed = false` : 'trashed = false';
    const r = await this.api<{ files?: { name: string; mimeType: string; modifiedTime: string; webViewLink: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
        q,
        pageSize: String(max),
        fields: 'files(name,mimeType,modifiedTime,webViewLink)',
        ...(query ? {} : { orderBy: 'modifiedTime desc' }),
      })}`,
    );
    return (r.files ?? []).map((f) => ({ name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, link: f.webViewLink }));
  }
}

function decodeHtml(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// --- formatting helpers shared by tools, commands and briefings ---

export function formatEvents(events: CalendarEvent[], timeZone: string): string {
  if (!events.length) return 'No events.';
  return events
    .map((e) => {
      const allDay = !e.start.includes('T');
      const when = allDay
        ? `${e.start} (all day)`
        : new Date(e.start).toLocaleString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `• ${when}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}`;
    })
    .join('\n');
}

export function formatEmails(emails: EmailSummary[]): string {
  if (!emails.length) return 'No unread emails in Primary.';
  return emails.map((m) => `• From ${m.from}: "${m.subject}" — ${m.snippet}`).join('\n');
}

export function formatTasks(tasks: GoogleTask[]): string {
  if (!tasks.length) return 'No open Google Tasks.';
  return tasks.map((t) => `• ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`).join('\n');
}
