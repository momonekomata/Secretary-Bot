import type Anthropic from '@anthropic-ai/sdk';
import { fetchWaniKani } from './wanikani';
import type { Store } from './store';

type Tool = Anthropic.Beta.BetaTool;

/** Context a tool call runs in: which chat asked, and where things live. */
export interface ToolContext {
  chatKey: string;
  store: Store;
  timezone: string;
  wanikaniToken: string;
  now?: () => Date;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

export const customTools: Tool[] = [
  {
    name: 'remember',
    description:
      "Save a durable fact about the user (preferences, goals, people, plans) so you know it in future chats. Use when the user tells you something worth keeping or asks you to remember. Keep each memory to one short sentence.",
    input_schema: obj({ text: { type: 'string', description: 'The fact to remember, one sentence.' } }, ['text']),
    strict: true,
  },
  {
    name: 'forget',
    description: 'Delete a saved memory by id, when the user asks or a memory is out of date.',
    input_schema: obj({ id: { type: 'integer' } }, ['id']),
    strict: true,
  },
  {
    name: 'set_reminder',
    description:
      'Schedule a message to the user at a future time. Work out the absolute time from the current time you were given and send it as ISO 8601 with a UTC offset, e.g. 2026-11-08T09:00:00+07:00.',
    input_schema: obj(
      {
        at: { type: 'string', description: 'When to send it, ISO 8601 with offset.' },
        text: { type: 'string', description: 'What to say when it fires, written to the user.' },
      },
      ['at', 'text'],
    ),
    strict: true,
  },
  {
    name: 'list_reminders',
    description: "List this user's pending reminders with their ids.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by id.',
    input_schema: obj({ id: { type: 'integer' } }, ['id']),
    strict: true,
  },
  {
    name: 'get_wanikani_status',
    description:
      "Get the user's live WaniKani progress: level, lessons and reviews available now, upcoming reviews by hour, and item counts by SRS stage. Use for questions about their kanji study or what to do next.",
    input_schema: obj({}, []),
    strict: true,
  },
];

export function formatTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  }).format(d);
}

const STAGES = ['Locked', 'Apprentice 1', 'Apprentice 2', 'Apprentice 3', 'Apprentice 4', 'Guru 1', 'Guru 2', 'Master', 'Enlightened', 'Burned'];

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const now = (ctx.now ?? (() => new Date()))();
  switch (name) {
    case 'remember': {
      const text = String(args.text ?? '').trim();
      if (!text) return { content: 'Nothing to remember: text was empty.', isError: true };
      const m = ctx.store.addMemory(ctx.chatKey, text.slice(0, 500));
      return { content: `Saved memory #${m.id}.` };
    }
    case 'forget': {
      const ok = ctx.store.removeMemory(ctx.chatKey, Number(args.id));
      return ok ? { content: `Forgot memory #${args.id}.` } : { content: `No memory #${args.id}.`, isError: true };
    }
    case 'set_reminder': {
      const at = new Date(String(args.at));
      const text = String(args.text ?? '').trim();
      if (Number.isNaN(at.getTime())) return { content: `Could not parse time "${args.at}". Use ISO 8601 with offset.`, isError: true };
      if (at.getTime() <= now.getTime()) return { content: `That time (${formatTime(at, ctx.timezone)}) is in the past.`, isError: true };
      if (at.getTime() - now.getTime() > 366 * 864e5) return { content: 'Reminders can be at most a year ahead.', isError: true };
      if (!text) return { content: 'Reminder text was empty.', isError: true };
      const r = ctx.store.addReminder(ctx.chatKey, text.slice(0, 1000), at);
      return { content: `Reminder #${r.id} set for ${formatTime(at, ctx.timezone)}.` };
    }
    case 'list_reminders': {
      const rs = ctx.store.reminders(ctx.chatKey);
      if (!rs.length) return { content: 'No pending reminders.' };
      return { content: rs.map((r) => `#${r.id} at ${formatTime(new Date(r.dueAt), ctx.timezone)}: ${r.text}`).join('\n') };
    }
    case 'cancel_reminder': {
      const ok = ctx.store.removeReminder(ctx.chatKey, Number(args.id));
      return ok ? { content: `Cancelled reminder #${args.id}.` } : { content: `No pending reminder #${args.id}.`, isError: true };
    }
    case 'get_wanikani_status': {
      if (!ctx.wanikaniToken) return { content: 'WaniKani is not connected (WANIKANI_TOKEN is not set on the bot).', isError: true };
      try {
        const wk = await fetchWaniKani(ctx.wanikaniToken);
        const stages = wk.stageCounts.map((n, i) => `${STAGES[i]}: ${n}`).filter((_, i) => i > 0).join(', ');
        return {
          content: [
            `User ${wk.username}, level ${wk.level}.`,
            `Lessons available now: ${wk.lessonsAvailable}. Reviews available now: ${wk.reviewsAvailable}.`,
            `Next reviews at: ${wk.nextReviewsAt ? formatTime(new Date(wk.nextReviewsAt), ctx.timezone) : 'none scheduled'}.`,
            `Reviews arriving in each of the next hours: ${wk.upcoming.join(', ') || 'none'}.`,
            `Items by SRS stage: ${stages}.`,
          ].join('\n'),
        };
      } catch (e) {
        return { content: `WaniKani request failed: ${(e as Error).message}`, isError: true };
      }
    }
    default:
      return { content: `Unknown tool ${name}.`, isError: true };
  }
}
