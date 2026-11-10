/**
 * Language for the bot's fixed messages (command replies, alerts, menus): English, or Thai when one of the
 * user's standing preferences asks for Thai. AI-written replies follow the preferences on their own.
 *
 * Use t('English text', 'ข้อความภาษาไทย') wherever the bot sends fixed text to the user.
 * main.ts points the language at the user's preferences; it is English until then (and in tests).
 */

export type Lang = 'en' | 'th';

/** Thai when a standing preference mentions it ("Always reply in Thai", "ตอบเป็นภาษาไทย"). */
export function langFromPreferences(preferences: string[] = []): Lang {
  return preferences.some((p) => /\bthai\b|ไทย/i.test(p)) ? 'th' : 'en';
}

let current: () => Lang = () => 'en';

/** Sets where the current language comes from (main.ts: the user's preferences). */
export function useLanguage(get: () => Lang) {
  current = get;
}

export function lang(): Lang {
  return current();
}

/** The English or Thai text, by the current language. */
export function t(en: string, th: string): string {
  return current() === 'th' ? th : en;
}
