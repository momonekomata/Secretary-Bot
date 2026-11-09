import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Google } from '../google';
import { HealthDb } from '../healthdb';
import { ImportJob, importFromDrive } from '../samsungexport';

describe('background health import', () => {
  it('posts progress and the report, and runs one import at a time', async () => {
    const job = new ImportJob();
    const sent: string[] = [];
    let finish!: (report: string) => void;
    const started = job.start(
      (progress) =>
        new Promise<string>((resolve) => {
          progress('📂 Downloaded 123 MB. Unpacking…');
          finish = resolve;
        }),
      async (t) => void sent.push(t),
    );
    expect(started).toBe(true);
    expect(job.start(async () => 'x', async () => undefined)).toBe(false);
    expect(job.status()).toMatch(/^📦 A health import is running \(started 0 min ago\)\. Last step: 📂 Downloaded 123 MB/);
    finish('📦 Imported samsung_health.rar');
    await job.running!.done;
    expect(sent).toEqual(['📂 Downloaded 123 MB. Unpacking…', '📦 Imported samsung_health.rar']);
    expect(job.running).toBeNull();
  });

  it('reports failures and gives up after the time limit', async () => {
    const job = new ImportJob();
    const sent: string[] = [];
    job.start(() => new Promise<string>(() => undefined), async (t) => void sent.push(t), 20);
    await job.running!.done;
    expect(sent).toEqual(['❌ The health import failed: The import took longer than 0 minutes and was stopped.\nYou can try again with /healthimport.']);
    expect(job.status()).toBe('No health import is running.');
  });

  it.skipIf(spawnSync('bsdtar', ['--version']).status !== 0)('imports from Drive with progress messages', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sb-src-'));
    mkdirSync(join(src, 'export'));
    writeFileSync(
      join(src, 'export', 'com.samsung.shealth.tracker.pedometer_day_summary.20261109120000.csv'),
      'com.samsung.shealth.tracker.pedometer_day_summary,6313005,1\nstep_count,day_time\n5000,1740787200000\n',
    );
    const zip = join(src, 'export.zip');
    expect(spawnSync('bsdtar', ['-a', '-cf', zip, '-C', src, 'export']).status).toBe(0);
    const google = {
      listFiles: async () => [{ id: 'f1', name: 'samsung_health_export.zip', modifiedTime: '' }],
      downloadToFile: async (_id: string, path: string, opts?: { onProgress?: (b: number, t: number | null) => void }) => {
        opts?.onProgress?.(500, 1000);
        copyFileSync(zip, path);
        return 1000;
      },
    } as unknown as Google;
    const progress: string[] = [];
    const report = await importFromDrive(google, new HealthDb(null), 'Asia/Bangkok', { progress: (m) => progress.push(m), log: () => undefined, progressEveryMs: 0 });
    expect(report).toMatchObject({ file: 'samsung_health_export.zip', days: 1 });
    expect(progress).toEqual([
      '📦 Found samsung_health_export.zip. Downloading from Google Drive…',
      '⬇️ Downloaded 0 of 0 MB…',
      '📂 Downloaded 0 MB. Unpacking…',
      '📂 Unpacking… 1 data file so far',
      '📖 Unpacked. Reading your health data…',
      '📖 Reading 1 of 1: pedometer day summary…',
    ]);
  });
});

describe('unpacking', () => {
  it.skipIf(spawnSync('bsdtar', ['--version']).status !== 0)('takes out only the CSV files, reporting each', async () => {
    const { extract } = await import('../samsungexport');
    const { readdirSync } = await import('node:fs');
    const src = mkdtempSync(join(tmpdir(), 'sb-x-'));
    mkdirSync(join(src, 'export', 'jsons', 'heart'), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(src, 'export', 'jsons', 'heart', `${i}.json`), '{}');
    writeFileSync(join(src, 'export', 'com.samsung.shealth.sleep.20261109120000.csv'), 'a\n');
    writeFileSync(join(src, 'export', 'com.samsung.health.weight.20261109120000.csv'), 'a\n');
    const zip = join(src, 'x.zip');
    expect(spawnSync('bsdtar', ['-a', '-cf', zip, '-C', src, 'export']).status).toBe(0);
    const out = join(src, 'out');
    const counts: number[] = [];
    await extract(zip, out, { onFile: (n) => counts.push(n) });
    const all = readdirSync(out, { recursive: true }).map(String);
    expect(all.filter((f) => f.endsWith('.csv'))).toHaveLength(2);
    expect(all.some((f) => f.endsWith('.json'))).toBe(false);
    expect(counts.at(-1)).toBe(2);
  });
});

describe('Drive download', () => {
  async function client(body: ReadableStream<Uint8Array>, length?: number) {
    const { Google, readClient } = await import('../google');
    const dir = mkdtempSync(join(tmpdir(), 'sb-dl-'));
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
    writeFileSync(join(dir, 'token.json'), JSON.stringify({ access_token: 'at', refresh_token: 'r', expiry_date: Date.now() + 3_600_000 }));
    const fetchFn = (async () => new Response(body, { headers: length ? { 'content-length': String(length) } : {} })) as unknown as typeof fetch;
    return { google: new Google(readClient(join(dir, 'credentials.json')), join(dir, 'token.json'), fetchFn), dir };
  }

  it('counts bytes while saving the file', async () => {
    const chunks = [new Uint8Array(300), new Uint8Array(700)];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
    const { google, dir } = await client(body, 1000);
    const seen: string[] = [];
    const n = await google.downloadToFile('f', join(dir, 'out.bin'), { onProgress: (b, t) => seen.push(`${b}/${t}`) });
    expect(n).toBe(1000);
    expect(seen).toEqual(['300/1000', '1000/1000']);
  });

  it('gives up when the download stalls', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); } }); // never closes
    const { google, dir } = await client(body);
    await expect(google.downloadToFile('f', join(dir, 'out.bin'), { idleTimeoutMs: 50 })).rejects.toThrow(/stalled/);
  });
});
