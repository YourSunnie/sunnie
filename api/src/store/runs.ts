import { transaction, type Db } from '../db/database.ts';
import type { MessageQuote } from './quotes.ts';
import { nowIso } from '../util/ids.ts';

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

/** A run as it is kept across restarts. One still `running` when the server starts was interrupted. */
export interface RunRecord {
  id: string;
  conversationId: string;
  status: RunStatus;
  /** What the run was started with, so a restart can start it again. */
  input: Record<string, unknown>;
  /** How many times it has been picked up again after a restart. */
  resumes: number;
  error: string | null;
  finishReason: string | null;
  /** What the run reported when it completed (steps, usage), for a client that asks afterwards. */
  outcome: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

/** A tool call that had begun in a step the server did not live to store. */
export interface LostAction {
  name: string;
  input: unknown;
  /** Whether the call had returned; its result is gone either way. */
  finished: boolean;
}

/** A message the user sent while the run was at work, waiting to join it. */
export interface Steer {
  pk: number;
  text: string;
  attachmentIds: string[];
  quotes?: MessageQuote[];
  timeZone: string | null;
}

type Row = Record<string, unknown>;

function toRecord(r: Row): RunRecord {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    status: r.status as RunStatus,
    input: JSON.parse(r.input as string) as Record<string, unknown>,
    resumes: r.resumes as number,
    error: r.error as string | null,
    finishReason: r.finish_reason as string | null,
    outcome: r.outcome ? (JSON.parse(r.outcome as string) as Record<string, unknown>) : null,
    startedAt: r.started_at as string,
    finishedAt: r.finished_at as string | null,
  };
}

/**
 * Runs, and the tool calls of the step each is in. A step is stored only once it is complete, so
 * after a crash nothing in the messages says that an action of the unfinished step had already
 * begun. This is where that is written down — before the call runs.
 */
export class RunStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(run: { id: string; conversationId: string; input: Record<string, unknown>; requestId?: string | null; startedAt: string }, steers: Steer[] = [], carried: Steer[] = [], alongside?: () => void): void {
    transaction(this.db, () => {
      this.db
        .prepare("INSERT INTO runs (id, conversation_id, status, input, request_id, started_at) VALUES (?, ?, 'running', ?, ?, ?)")
        .run(run.id, run.conversationId, JSON.stringify(run.input), run.requestId ?? null, run.startedAt);
      // Retries of the original steer must resolve to the run that now owns its message.
      const move = this.db.prepare('UPDATE run_steers SET run_id = ? WHERE pk = ?');
      for (const steer of [...steers, ...carried]) move.run(run.id, steer.pk);
      this.takeSteers(steers);
      alongside?.();
    });
  }

  finish(
    id: string,
    end: { status: Exclude<RunStatus, 'running'>; error?: string | null; finishReason?: string | null; outcome?: Record<string, unknown> | null },
  ): void {
    this.db
      .prepare('UPDATE runs SET status = ?, error = ?, finish_reason = ?, outcome = ?, finished_at = ? WHERE id = ?')
      .run(end.status, end.error ?? null, end.finishReason ?? null, end.outcome ? JSON.stringify(end.outcome) : null, nowIso(), id);
    this.db.prepare('DELETE FROM run_actions WHERE run_id = ?').run(id);
  }

  get(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** One send identity across both message routes, including a steer passed to a later run. */
  findByRequest(conversationId: string, requestId: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE conversation_id = ? AND request_id = ?').get(conversationId, requestId)
      ?? this.db.prepare(
        'SELECT r.* FROM runs r JOIN run_steers s ON s.run_id = r.id WHERE r.conversation_id = ? AND s.request_id = ? ORDER BY s.pk ASC LIMIT 1',
      ).get(conversationId, requestId);
    return row ? toRecord(row) : null;
  }

  /** Runs the last process left unfinished, oldest first. */
  interrupted(): RunRecord[] {
    return this.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY pk ASC").all().map(toRecord);
  }

  /** A crash can land after finishing a run but before passing its waiting messages onward. */
  unsettled(): RunRecord[] {
    return this.db.prepare(
      "SELECT * FROM runs WHERE status != 'running' AND EXISTS (SELECT 1 FROM run_steers WHERE run_id = runs.id AND taken = 0) ORDER BY pk ASC",
    ).all().map(toRecord);
  }

  /** Counts the restart, and sets aside the actions of the step that was lost with it. */
  markResumed(id: string): void {
    this.db.prepare('UPDATE runs SET resumes = resumes + 1 WHERE id = ?').run(id);
    this.db.prepare('UPDATE run_actions SET lost = 1 WHERE run_id = ?').run(id);
  }

  actionStarted(runId: string, call: { toolCallId: string; name: string; input: unknown }): void {
    this.db
      .prepare('INSERT INTO run_actions (run_id, tool_call_id, name, input, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, call.toolCallId, call.name, JSON.stringify(call.input ?? null), nowIso());
  }

  actionFinished(runId: string, toolCallId: string): void {
    this.db.prepare('UPDATE run_actions SET finished = 1 WHERE run_id = ? AND tool_call_id = ? AND lost = 0').run(runId, toolCallId);
  }

  /** The step's messages are stored: its actions now have their results there. */
  stepStored(runId: string): void {
    this.db.prepare('DELETE FROM run_actions WHERE run_id = ? AND lost = 0').run(runId);
  }

  /** Queues a message for a run at work. False if this request id was queued for it before. */
  addSteer(runId: string, steer: { text: string; quotes?: MessageQuote[]; attachmentIds?: string[]; timeZone?: string | null; requestId?: string | null }): boolean {
    if (steer.requestId) {
      const known = this.db.prepare('SELECT 1 FROM run_steers WHERE run_id = ? AND request_id = ?').get(runId, steer.requestId);
      if (known) return false;
    }
    this.db
      .prepare('INSERT INTO run_steers (run_id, text, attachment_ids, quotes, time_zone, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, steer.text, JSON.stringify(steer.attachmentIds ?? []), JSON.stringify(steer.quotes ?? []), steer.timeZone ?? null, steer.requestId ?? null, nowIso());
    return true;
  }

  /** Messages still waiting to join the run, oldest first. */
  pendingSteers(runId: string): Steer[] {
    return this.db
      .prepare('SELECT pk, text, attachment_ids, quotes, time_zone FROM run_steers WHERE run_id = ? AND taken = 0 ORDER BY pk ASC')
      .all(runId)
      .map((r: Row) => ({ pk: r.pk as number, text: r.text as string, quotes: JSON.parse(r.quotes as string) as MessageQuote[], attachmentIds: JSON.parse(r.attachment_ids as string) as string[], timeZone: r.time_zone as string | null }));
  }

  /** These have joined the conversation (or were dropped with their run). */
  takeSteers(steers: Steer[]): void {
    const take = this.db.prepare('UPDATE run_steers SET taken = 1 WHERE pk = ?');
    for (const s of steers) take.run(s.pk);
  }

  lostActions(runId: string): LostAction[] {
    return this.db
      .prepare('SELECT name, input, finished FROM run_actions WHERE run_id = ? AND lost = 1 ORDER BY pk ASC')
      .all(runId)
      .map((r: Row) => ({ name: r.name as string, input: JSON.parse(r.input as string) as unknown, finished: r.finished === 1 }));
  }
}
