import { randomBytes } from 'node:crypto';

interface Hosted {
  data: Buffer;
  type: string;
  name: string;
  expires: number;
}

/**
 * Serves files at unguessable, expiring links under PUBLIC_URL/files/..., for platforms that can
 * only take a URL (LINE audio messages, backup files).
 */
export class FileHost {
  private files = new Map<string, Hosted>();

  constructor(private readonly publicUrl: string) {}

  get enabled(): boolean {
    return !!this.publicUrl;
  }

  /** Returns a public https link to `data`, valid for `ttlMs`. */
  add(name: string, type: string, data: Buffer, ttlMs = 24 * 3600_000): string {
    const now = Date.now();
    for (const [k, f] of this.files) if (f.expires < now) this.files.delete(k);
    const token = randomBytes(18).toString('base64url');
    this.files.set(token, { data, type, name, expires: now + ttlMs });
    return `${this.publicUrl.replace(/\/$/, '')}/files/${token}/${encodeURIComponent(name)}`;
  }

  /** Looks up a request path like /files/<token>/<name>. */
  get(path: string): Hosted | null {
    const m = /^\/files\/([\w-]+)\//.exec(path);
    const f = m ? this.files.get(m[1]) : undefined;
    if (!f || f.expires < Date.now()) return null;
    return f;
  }
}
