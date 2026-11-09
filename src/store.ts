import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
}

interface Data {
  nextId: number;
  history: Record<string, Turn[]>;
  /** Memories are per person, keyed by chat. */
  memories: Record<string, Memory[]>;
  reminders: Reminder[];
  /** Last day (YYYY-MM-DD) the daily nudge went out, per chat. */
  nudgedOn: Record<string, string>;
}

const empty = (): Data => ({ nextId: 1, history: {}, memories: {}, reminders: [], nudgedOn: {} });

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
        this.data = { ...empty(), ...JSON.parse(readFileSync(this.file, 'utf8')) };
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

  reminders(chatKey?: string): Reminder[] {
    return chatKey ? this.data.reminders.filter((r) => r.chatKey === chatKey) : this.data.reminders;
  }

  addReminder(chatKey: string, text: string, dueAt: Date): Reminder {
    const r = { id: this.data.nextId++, chatKey, text, dueAt: dueAt.toISOString() };
    this.data.reminders.push(r);
    this.save();
    return r;
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

  nudgedOn(chatKey: string): string | undefined {
    return this.data.nudgedOn[chatKey];
  }

  markNudged(chatKey: string, day: string) {
    this.data.nudgedOn[chatKey] = day;
    this.save();
  }
}
