import type { Db } from '../db/database.ts';
import { newId, nowIso } from '../util/ids.ts';

export const TASK_STATUSES = ['open', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A follow-up the agent keeps for itself and works on at a heartbeat. */
export interface Task {
  id: string;
  content: string;
  status: TaskStatus;
  /** Where the agent got to; replaced, not appended. */
  note: string;
  /** Not looked at before this moment. Null means at the next heartbeat. */
  dueAt: string | null;
  /** How many heartbeats have woken the agent for this task. */
  checks: number;
  /** The user's zone when the task was written, so a check-in can tell the time the same way. */
  timeZone: string | null;
  /** The conversation the task was added in. */
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    content: r.content as string,
    status: r.status as TaskStatus,
    note: r.note as string,
    dueAt: r.due_at as string | null,
    checks: r.checks as number,
    timeZone: r.time_zone as string | null,
    conversationId: r.conversation_id as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class TaskStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(input: { content: string; dueAt?: Date | null; timeZone?: string | null; conversationId?: string | null }): Task {
    const id = newId('task');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, content, due_at, time_zone, conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.content, input.dueAt?.toISOString() ?? null, input.timeZone ?? null, input.conversationId ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? toTask(row) : null;
  }

  /** Soonest first; within done tasks, most recently closed first. */
  list(opts: { status?: TaskStatus; limit?: number } = {}): Task[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const order = opts.status === 'done' ? 'updated_at DESC' : 'status DESC, COALESCE(due_at, created_at) ASC';
    const rows = opts.status
      ? this.db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY ${order} LIMIT ?`).all(opts.status, limit)
      : this.db.prepare(`SELECT * FROM tasks ORDER BY ${order} LIMIT ?`).all(limit);
    return rows.map(toTask);
  }

  /** `dueAt: null` means "at the next heartbeat"; leaving a field out keeps its value. */
  update(
    id: string,
    patch: { content?: string; note?: string; status?: TaskStatus; dueAt?: Date | null },
  ): Task | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE tasks SET content = ?, note = ?, status = ?, due_at = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.content ?? current.content,
        patch.note ?? current.note,
        patch.status ?? current.status,
        patch.dueAt !== undefined ? (patch.dueAt?.toISOString() ?? null) : current.dueAt,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  /** Open tasks whose time has come, longest-waiting first. */
  due(now: Date, limit: number): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'open' AND (due_at IS NULL OR due_at <= ?)
         ORDER BY COALESCE(due_at, created_at) ASC LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(toTask);
  }

  /**
   * Records that a heartbeat is waking the agent for these tasks and pushes them out to
   * `nextDueAt`, so that they are not picked up again by the ticks during the check-in.
   * `updated_at` is left alone on purpose: it tells whether the agent touched the task since.
   */
  markChecked(ids: string[], nextDueAt: Date): void {
    const stmt = this.db.prepare('UPDATE tasks SET checks = checks + 1, due_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(nextDueAt.toISOString(), id);
  }

  countOpen(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get() as { n: number }).n;
  }
}
