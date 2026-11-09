import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effort } from './config';
import type { Repeat } from './time';

/** One remembered turn. Only plain text is kept between turns (see agent.ts for why). */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface Memory {
  id: number;
  text: string;
  createdAt: string;
}

export interface Reminder {
  id: number;
  chatKey: string;
  text: string;
  /** ISO 8601 instant. */
  dueAt: string;
  /** Repeating reminders are rescheduled after they fire. */
  repeat?: Repeat;
}

export interface Todo {
  id: number;
  title: string;
  createdAt: string;
}

export interface FoodEntry {
  id: number;
  /** ISO instant the food was eaten. */
  ts: string;
  /** Local day YYYY-MM-DD. */
  day: string;
  meal: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  name: string;
  portion: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface BodyProfile {
  sex?: 'male' | 'female';
  /** Birth year, so the age stays right. */
  birthYear?: number;
  heightCm?: number;
  weightKg?: number;
  activity?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal?: 'lose' | 'maintain' | 'gain';
  /** Own daily calorie target, overriding the calculated one. */
  targetKcal?: number;
}

export interface City {
  name: string;
  country?: string;
  lat: number;
  lon: number;
}

/** Bot-wide settings changed from chat with /settings, /model, /setcity, /addtopic... */
export interface Settings {
  model?: string;
  effort?: Effort;
  translateTo?: string;
  newsTopics?: string[];
  city?: City;
  /** Name the bot calls itself (overrides BOT_NAME). */
  botName?: string;
  /** Ready-made personality key from personas.ts, or "custom". */
  personaKey?: string;
  /** Personality description (a preset's text, or the user's own). */
  persona?: string;
  /** Gemini prebuilt voice for spoken replies, and how to speak. */
  ttsVoice?: string;
  speakingStyle?: string;
  /** JLPT level for kanji/word of the day when WaniKani isn't connected. */
  jlptLevel?: 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
  /** Active roleplay scene, if any. */
  roleplay?: { scenario: string; startedAt: string };
  /** Speak replies: never, only when answering a voice note, or always. */
  voiceReplies?: 'off' | 'voice-notes' | 'always';
}

export interface UsageRow {
  ts: string;
  /** What the call was for: chat, briefing, voice, ... */
  kind: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  cost: number;
}

interface Data {
  nextId: number;
  history: Record<string, Turn[]>;
  /** Memories, todos: per person, keyed by chat. */
  memories: Record<string, Memory[]>;
  todos: Record<string, Todo[]>;
  reminders: Reminder[];
  settings: Settings;
  usage: UsageRow[];
  /** Kanji and words already sent as "of the day", newest last. */
  japanese: { kanji: string[]; words: string[] };
  food: Record<string, FoodEntry[]>;
  body: Record<string, BodyProfile>;
  weights: Record<string, { day: string; kg: number }[]>;
  /** Last local day (YYYY-MM-DD) each scheduled job or one-a-day alert ran. */
  ranOn: Record<string, string>;
}

const empty = (): Data => ({
  nextId: 1,
  history: {},
  memories: {},
  todos: {},
  reminders: [],
  settings: {},
  usage: [],
  japanese: { kanji: [], words: [] },
  food: {},
  body: {},
  weights: {},
  ranOn: {},
});

/**
 * Tiny JSON-file store. Fine for a personal bot with a handful of chats;
 * writes are atomic (write temp file, then rename).
 */
export class Store {
  private data: Data;
  private file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'store.json') : null;
    this.data = empty();
    if (dir && this.file) {
      mkdirSync(dir, { recursive: true });
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        // Older files kept the daily nudge in `nudgedOn`.
        if (raw.nudgedOn && !raw.ranOn) raw.ranOn = Object.fromEntries(Object.entries(raw.nudgedOn).map(([k, v]) => [`nudge:${k}`, v]));
        delete raw.nudgedOn;
        this.data = { ...empty(), ...raw };
      } catch {
        // First run, or unreadable file: start fresh.
      }
    }
  }

  private save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  // --- conversation ---

  history(chatKey: string): Turn[] {
    return this.data.history[chatKey] ?? [];
  }

  /** Appends a finished exchange and trims from the front so the window starts with a user turn. */
  appendExchange(chatKey: string, user: string, assistant: string, limit: number) {
    let turns = [...this.history(chatKey), { role: 'user' as const, text: user }, { role: 'assistant' as const, text: assistant }];
    if (turns.length > limit) turns = turns.slice(turns.length - limit);
    while (turns.length && turns[0].role !== 'user') turns.shift();
    this.data.history[chatKey] = turns;
    this.save();
  }

  clearHistory(chatKey: string) {
    delete this.data.history[chatKey];
    this.save();
  }

  // --- memories ---

  memories(chatKey: string): Memory[] {
    return this.data.memories[chatKey] ?? [];
  }

  addMemory(chatKey: string, text: string): Memory {
    const m = { id: this.data.nextId++, text, createdAt: new Date().toISOString() };
    this.data.memories[chatKey] = [...this.memories(chatKey), m];
    this.save();
    return m;
  }

  removeMemory(chatKey: string, id: number): boolean {
    const before = this.memories(chatKey);
    const after = before.filter((m) => m.id !== id);
    this.data.memories[chatKey] = after;
    this.save();
    return after.length !== before.length;
  }

  // --- todos ---

  todos(chatKey: string): Todo[] {
    return this.data.todos[chatKey] ?? [];
  }

  addTodo(chatKey: string, title: string): Todo {
    const t = { id: this.data.nextId++, title, createdAt: new Date().toISOString() };
    this.data.todos[chatKey] = [...this.todos(chatKey), t];
    this.save();
    return t;
  }

  /** Removes a todo by id. */
  completeTodo(chatKey: string, id: number): Todo | null {
    const t = this.todos(chatKey).find((x) => x.id === id) ?? null;
    if (t) {
      this.data.todos[chatKey] = this.todos(chatKey).filter((x) => x.id !== id);
      this.save();
    }
    return t;
  }

  clearTodos(chatKey: string): number {
    const n = this.todos(chatKey).length;
    delete this.data.todos[chatKey];
    this.save();
    return n;
  }

  // --- reminders ---

  reminders(chatKey?: string): Reminder[] {
    return chatKey ? this.data.reminders.filter((r) => r.chatKey === chatKey) : this.data.reminders;
  }

  addReminder(chatKey: string, text: string, dueAt: Date, repeat: Repeat = 'none'): Reminder {
    const r: Reminder = { id: this.data.nextId++, chatKey, text, dueAt: dueAt.toISOString(), ...(repeat !== 'none' ? { repeat } : {}) };
    this.data.reminders.push(r);
    this.save();
    return r;
  }

  /** Puts a fired repeating reminder back with its next time (same id, so it can still be cancelled). */
  rescheduleReminder(r: Reminder, next: Date) {
    this.data.reminders.push({ ...r, dueAt: next.toISOString() });
    this.save();
  }

  removeReminder(chatKey: string, id: number): boolean {
    const n = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter((r) => !(r.id === id && r.chatKey === chatKey));
    this.save();
    return this.data.reminders.length !== n;
  }

  /** Removes and returns reminders due at or before `now`. */
  takeDueReminders(now: Date): Reminder[] {
    const due = this.data.reminders.filter((r) => Date.parse(r.dueAt) <= now.getTime());
    if (due.length) {
      this.data.reminders = this.data.reminders.filter((r) => !due.includes(r));
      this.save();
    }
    return due;
  }

  // --- settings ---

  settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  // --- usage log ---

  addUsage(row: UsageRow) {
    this.data.usage.push(row);
    this.save();
  }

  usage(): UsageRow[] {
    return this.data.usage;
  }

  /** Removes and returns usage rows older than `cutoff`. */
  takeUsageBefore(cutoff: Date): UsageRow[] {
    const old = this.data.usage.filter((u) => Date.parse(u.ts) < cutoff.getTime());
    if (old.length) {
      this.data.usage = this.data.usage.filter((u) => Date.parse(u.ts) >= cutoff.getTime());
      this.save();
    }
    return old;
  }

  // --- Japanese of the day ---

  japaneseHistory(): { kanji: string[]; words: string[] } {
    return this.data.japanese;
  }

  addJapanese(kind: 'kanji' | 'words', item: string) {
    const list = this.data.japanese[kind].filter((x) => x !== item);
    this.data.japanese[kind] = [...list, item].slice(-500);
    this.save();
  }

  // --- food and body ---

  food(chatKey: string, day?: string): FoodEntry[] {
    const all = this.data.food[chatKey] ?? [];
    return day ? all.filter((f) => f.day === day) : all;
  }

  addFood(chatKey: string, entry: Omit<FoodEntry, 'id'>): FoodEntry {
    const f = { ...entry, id: this.data.nextId++ };
    // Keep about a year of entries.
    this.data.food[chatKey] = [...(this.data.food[chatKey] ?? []), f].slice(-3000);
    this.save();
    return f;
  }

  removeFood(chatKey: string, id: number): FoodEntry | null {
    const f = this.food(chatKey).find((x) => x.id === id) ?? null;
    if (f) {
      this.data.food[chatKey] = this.food(chatKey).filter((x) => x.id !== id);
      this.save();
    }
    return f;
  }

  body(chatKey: string): BodyProfile {
    return this.data.body[chatKey] ?? {};
  }

  updateBody(chatKey: string, patch: Partial<BodyProfile>) {
    this.data.body[chatKey] = { ...this.body(chatKey), ...patch };
    this.save();
  }

  weights(chatKey: string): { day: string; kg: number }[] {
    return this.data.weights[chatKey] ?? [];
  }

  logWeight(chatKey: string, day: string, kg: number) {
    const list = this.weights(chatKey).filter((w) => w.day !== day);
    this.data.weights[chatKey] = [...list, { day, kg }].sort((a, b) => a.day.localeCompare(b.day)).slice(-1000);
    this.updateBody(chatKey, { weightKg: kg });
  }

  // --- once-a-day bookkeeping ---

  ranOn(key: string): string | undefined {
    return this.data.ranOn[key];
  }

  markRan(key: string, day: string) {
    this.data.ranOn[key] = day;
    this.save();
  }
}
