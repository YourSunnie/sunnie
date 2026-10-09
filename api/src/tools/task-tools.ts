import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Task, TaskStore } from '../tasks/task-store.ts';
import { formatTime, parseLocalTime } from '../util/time.ts';

export interface TaskToolDeps {
  tasks: TaskStore;
  conversationId: string;
  /** The user's zone for this turn; times the model writes are read in it. */
  timeZone?: string;
}

const MAX_LISTED = 50;

/** One line per task, as the model reads it — in tool results and in a check-in. */
export function describeTask(task: Task, timeZone?: string | null): string {
  const when =
    task.status === 'done'
      ? 'done'
      : task.dueAt
        ? `next look ${formatTime(new Date(task.dueAt), timeZone ?? task.timeZone)}`
        : 'next look at the next check-in';
  const note = task.note ? ` — note: ${task.note}` : '';
  return `${task.id} [${when}] ${task.content}${note}`;
}

export function createTaskTools({ tasks, conversationId, timeZone }: TaskToolDeps): ToolSet {
  const when = {
    due: z
      .string()
      .optional()
      .describe('When to look at it next, as local time "YYYY-MM-DD HH:MM" in the same zone as "Current time".'),
    wait_minutes: z
      .number()
      .int()
      .positive()
      .max(525_600)
      .optional()
      .describe('Alternative to due: look at it this many minutes from now.'),
  };

  /** undefined: no time given. */
  const nextLook = (due?: string, waitMinutes?: number): Date | undefined => {
    if (due) {
      const at = parseLocalTime(due, timeZone);
      if (!at) throw new Error(`Could not read due "${due}". Write it as YYYY-MM-DD HH:MM, or use wait_minutes.`);
      return at;
    }
    return waitMinutes ? new Date(Date.now() + waitMinutes * 60_000) : undefined;
  };
  const required = (id: string): Task => {
    const task = tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}. Use task_list to see the open ones.`);
    return task;
  };

  return {
    task_add: tool({
      description:
        'Note a follow-up for yourself: something to do or check later without the user having to ask ' +
        'again — a reminder they asked for, a price or reply to watch, work to finish. You are woken ' +
        'for it at a check-in once its time has come. Write it self-contained, with names and details ' +
        'spelled out; it will be read later without this conversation. Give due or wait_minutes, or ' +
        'neither for the next check-in. Not for things you can do right now.',
      inputSchema: z.object({ content: z.string().min(1).max(2000), ...when }),
      execute: async ({ content, due, wait_minutes }) => {
        const task = tasks.add({ content, dueAt: nextLook(due, wait_minutes) ?? null, timeZone, conversationId });
        return `Added ${describeTask(task, timeZone)}`;
      },
    }),

    task_list: tool({
      description:
        'List your follow-ups: the open ones with when each is next looked at, or the ones already ' +
        'done. Use it before adding one that may already exist, or when the user asks what is pending.',
      inputSchema: z.object({ status: z.enum(['open', 'done']).optional().describe('Default "open".') }),
      execute: async ({ status }) => {
        const list = tasks.list({ status: status ?? 'open', limit: MAX_LISTED });
        if (list.length === 0) return status === 'done' ? 'No finished follow-ups.' : 'No open follow-ups.';
        return list.map((t) => describeTask(t, timeZone)).join('\n');
      },
    }),

    task_update: tool({
      description:
        'Change an open follow-up: move it to a later time (due or wait_minutes), record where you got ' +
        'to in note (replaces the previous note), or reword it. Use this when a follow-up has to wait, ' +
        'and in a check-in to keep one that must be looked at again.',
      inputSchema: z.object({
        id: z.string(),
        content: z.string().min(1).max(2000).optional(),
        note: z.string().max(2000).optional(),
        ...when,
      }),
      execute: async ({ id, content, note, due, wait_minutes }) => {
        required(id);
        const updated = tasks.update(id, { content, note, dueAt: nextLook(due, wait_minutes) })!;
        return `Updated ${describeTask(updated, timeZone)}`;
      },
    }),

    task_done: tool({
      description:
        'Close a follow-up that is finished, or that is no longer wanted. It will not wake you again.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        required(id);
        tasks.update(id, { status: 'done' });
        return `Closed ${id}`;
      },
    }),
  };
}
