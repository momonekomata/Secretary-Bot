import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { langFromPreferences, t, useLanguage } from '../i18n';
import { MENU, MENU_ALIASES, menuFor } from '../menu';

afterEach(() => useLanguage(() => 'en'));

describe('Telegram "/" menu', () => {
  it('lists every command the bot has (or knows it as an alias)', () => {
    const source = readFileSync(join(__dirname, '..', 'commands.ts'), 'utf8');
    const commands = [...source.matchAll(/case '\/([a-z]+)':/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(40);
    const listed = new Set([...MENU.map(([c]) => c), ...MENU_ALIASES]);
    expect(commands.filter((c) => !listed.has(c))).toEqual([]);
  });

  it('fits Telegram limits, with English and Thai descriptions', () => {
    expect(MENU.length).toBeLessThanOrEqual(100);
    for (const [command, en, th] of MENU) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(en.length).toBeGreaterThan(2);
      expect(th).toMatch(/[฀-๿]/);
      expect(th.length).toBeLessThanOrEqual(256);
    }
    expect(menuFor('th').find((c) => c.command === 'budget')?.description).toBe('รายจ่ายเดือนนี้และงบประมาณ');
  });
});

describe('language for fixed messages', () => {
  it('follows a preference for Thai', () => {
    expect(langFromPreferences(['Always reply in Thai'])).toBe('th');
    expect(langFromPreferences(['ตอบเป็นภาษาไทย'])).toBe('th');
    expect(langFromPreferences(['Use emoji'])).toBe('en');
    expect(t('Hello', 'สวัสดี')).toBe('Hello');
    useLanguage(() => 'th');
    expect(t('Hello', 'สวัสดี')).toBe('สวัสดี');
  });
});

describe('registering the menu with Telegram', () => {
  it('sets it for private chats too, and /status says what Telegram shows', async () => {
    const { vi } = await import('vitest');
    const { Telegram } = await import('../telegram');
    const { testConfig } = await import('./helpers');
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let shown = MENU.slice(0, 26).map(([command]) => ({ command, description: 'x' }));
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = url.split('/').pop()!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ ok: true, result: method === 'getMyCommands' ? shown : true });
    });
    const tg = new Telegram({ ...testConfig().telegram, token: 't' }, {} as never, () => undefined);
    await (tg as unknown as { registerCommands(): Promise<void> }).registerCommands();
    const sets = calls.filter((c) => c.method === 'setMyCommands');
    expect(sets).toHaveLength(2);
    expect(sets[1].body.scope).toEqual({ type: 'all_private_chats' });
    expect((sets[0].body.commands as unknown[]).length).toBe(MENU.length);

    expect(await tg.menuStatus()).toMatch(new RegExp(`^"/" menu: 26 of ${MENU.length} commands \\(missing /`));
    shown = MENU.map(([command]) => ({ command, description: 'x' }));
    expect(await tg.menuStatus()).toMatch(/^"\/" menu: all \d+ commands ✅/);
    vi.unstubAllGlobals();
  });
});
