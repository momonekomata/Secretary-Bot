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
