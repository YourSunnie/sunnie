import { conflict } from '../util/errors.ts';
import { newId, nowIso } from '../util/ids.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import { INTERRUPTED, runTurn, type AgentDeps } from './agent.ts';
import type { HandoffAsk, HandoffOutcome } from '../browser/handoff.ts';
import type { ProposedCall } from '../router/risk.ts';
import type { MessageOrigin } from '../store/conversations.ts';
import type { RunRecord, RunStatus, RunStore, Steer } from '../store/runs.ts';
import { toMessageDto, type AgentEvent, type RunUsage } from './events.ts';
import { quotesSchema, type MessageQuote } from '../store/quotes.ts';
import { steerAttachmentIds, steerBatch } from './steers.ts';

export type { RunStatus };

/** An event as delivered to clients: numbered so a dropped connection can resume after `seq`. */
export type RunEvent = AgentEvent & { seq: number };

export interface Run {
  id: string;
  conversationId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Why a completed run stopped ("stop", "step-limit", …); null until then. */
  finishReason: string | null;
  /** Tool calls waiting for the user to allow or deny them. */
  pendingApprovals: ProposedCall[];
  /** Set when an approval went unanswered (see `giveUpWaiting`): the run did not do all it set out to. */
  unanswered?: boolean;
  /** Resolves once the run has reached a terminal status. Never rejects. */
  done: Promise<void>;
}

interface RunState extends Run {
  events: RunEvent[];
  /** Where this process's event numbers start; see `SEQ_STRIDE`. */
  seqBase: number;
  /** Stopped by a shutdown rather than by anyone's decision: the next start picks it up again. */
  interrupted: boolean;
  /** What `run.completed` carried, kept so the run can be reported after it has left memory. */
  outcome: { steps: number; usage: RunUsage } | null;
  listeners: Set<() => void>;
  abort: AbortController;
  /** Answers a pending approval, by tool call id. */
  answers: Map<string, (approved: boolean | 'unanswered') => void>;
  /** Ends a browser hand-off the run is waiting for, by tool call id, when the run itself ends first. */
  handoffs: Map<string, (how: 'cancelled' | 'unanswered') => void>;
  /** When each pending approval or hand-off began to wait, by tool call id. */
  waitingSince: Map<string, number>;
  /** What started the run, for the heartbeat: its origin and the follow-ups it was woken for. */
  origin?: MessageOrigin;
  wokenIds: string[];
}

export interface StartRunInput {
  conversationId: string;
  text: string;
  attachmentIds?: string[];
  quotes?: MessageQuote[];
  /** Topics of a heartbeat interest check-in, retained across restarts. */
  interestIds?: string[];
  interestCheckAt?: string;
  /** A Home brief (see `startBrief`); retained across restarts like `interestIds`. */
  brief?: boolean;
  briefAt?: string;
  /** Redesigning a widget for the width the user picked on Home (see `startResize`). */
  resize?: { widgetId: string; columns: number };
  preamble?: string;
  origin?: MessageOrigin;
  model?: string | null;
  timeZone?: string;
  /**
   * The client's own id for this send. Sending again with the same one (a retry after a dropped
   * connection) returns the run the first send started instead of starting another.
   */
  requestId?: string;
  /** For a check-in: the follow-ups it was woken for, as they were then (see `Heartbeat.settle`). */
  woken?: Array<{ id: string; updatedAt: string }>;
}

/** How long a finished run's events stay available for a late reconnect. */
const RETENTION_MS = 10 * 60 * 1000;

/**
 * A run picked up after a restart keeps its id, but the events of the earlier process are gone.
 * Its numbering therefore starts this far beyond the last start's, so that a client asking for
 * "everything after the last event I saw" gets all of the new ones instead of skipping as many.
 */
const SEQ_STRIDE = 1_000_000;

/** Told about every event of every live run, after clients can see it (notifications listen here). */
export type RunObserver = (run: Run, input: StartRunInput, event: AgentEvent) => void;

/** A run that keeps taking the server down with it must not be started for ever. */
const RESUME_LIMIT = 3;

/** Placeholder run id for a conversation locked by `exclusive`. */
const MAINTENANCE = 'maintenance';

/**
 * Owns in-flight turns. A run belongs to the server, not to the HTTP request that started it:
 * a phone that loses signal mid-answer can reconnect and replay what it missed, and the work
 * finishes either way. Nor to the process: a run is written down when it starts, and one that
 * a restart cut short is taken up again from its last stored step (`recover`).
 */
export class RunManager {
  private readonly runs = new Map<string, RunState>();
  private readonly activeByConversation = new Map<string, string>();
  private readonly deps: AgentDeps;
  private readonly store: RunStore;
  private readonly log: Logger;
  private readonly observers: RunObserver[] = [];

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.store = deps.runLog;
    this.log = deps.log;
  }

  /** An observer must not throw; one that does is logged and the run carries on. */
  observe(observer: RunObserver): void {
    this.observers.push(observer);
  }

  start(input: StartRunInput, steers: Steer[] = [], carried: Steer[] = []): Run {
    if (input.requestId) {
      const earlier = this.store.findByRequest(input.conversationId, input.requestId);
      const run = earlier && this.get(earlier.id);
      if (run) return run;
    }
    if (this.activeByConversation.has(input.conversationId)) {
      throw conflict('This conversation already has a run in progress');
    }
    const id = newId('run');
    const startedAt = nowIso();
    // Checked before the run is written down, so an unknown model is a 400 on the request.
    this.deps.models.resolve(input.model ?? this.deps.conversations.get(input.conversationId)?.model);
    this.deps.attachments.resolve(input.attachmentIds);
    quotesSchema.parse(input.quotes ?? []);
    if (input.interestIds?.length && !this.deps.interests.allows(input.interestIds)) throw conflict('Interest updates were stopped');
    this.store.create({ id, conversationId: input.conversationId, input: { ...input }, requestId: input.requestId, startedAt }, steers, carried, () => {
      if (input.interestIds?.length) this.deps.interests.markChecked(input.interestIds, new Date(input.interestCheckAt ?? startedAt));
      if (input.brief) this.deps.home.markBrief(id, input.briefAt ?? startedAt);
    });
    return this.begin(id, input, startedAt, 0);
  }

  /**
   * Takes up the runs the last process left unfinished. Each goes on from its last stored step;
   * one that cannot (its model is gone, it has been restarted too often) ends as failed.
   * Call once, at start.
   */
  recover(): Array<{ run: Run; input: StartRunInput }> {
    const resumed: Array<{ run: Run; input: StartRunInput }> = [];
    for (const record of this.store.interrupted()) {
      const input = record.input as unknown as StartRunInput;
      try {
        if (input.interestIds?.length && (!this.deps.config.heartbeat.enabled || !this.deps.interests.allows(input.interestIds))
            && !this.deps.conversations.messagesForRun(record.id).some((m) => m.role === 'user' && !m.origin)) {
          this.store.finish(record.id, { status: 'cancelled' });
          continue;
        }
        if (record.resumes >= RESUME_LIMIT) throw new Error(`Interrupted by a server restart ${record.resumes + 1} times; not started again.`);
        this.deps.models.resolve(input.model ?? this.deps.conversations.get(record.conversationId)?.model);
        this.store.markResumed(record.id);
        resumed.push({ run: this.begin(record.id, input, record.startedAt, record.resumes + 1), input });
        this.log.info('run resumed after a restart', { runId: record.id, resumes: record.resumes + 1 });
      } catch (err) {
        this.store.finish(record.id, { status: 'failed', error: errorMessage(err) });
        this.log.warn('interrupted run could not be resumed', { runId: record.id, error: errorMessage(err) });
      }
    }
    for (const record of this.store.unsettled()) {
      try {
        this.settleSteers(record, record.input as unknown as StartRunInput);
      } catch (err) {
        this.log.warn('waiting messages could not be resumed', { runId: record.id, error: errorMessage(err) });
      }
    }
    return resumed;
  }

  private begin(id: string, input: StartRunInput, startedAt: string, resumes: number): Run {
    const model = this.deps.models.resolve(input.model ?? this.deps.conversations.get(input.conversationId)?.model);

    const state: RunState = {
      id,
      conversationId: input.conversationId,
      status: 'running',
      startedAt,
      finishedAt: null,
      error: null,
      finishReason: null,
      pendingApprovals: [],
      done: Promise.resolve(),
      events: [],
      seqBase: resumes * SEQ_STRIDE,
      interrupted: false,
      outcome: null,
      listeners: new Set(),
      abort: new AbortController(),
      answers: new Map(),
      handoffs: new Map(),
      waitingSince: new Map(),
      wokenIds: [],
    };
    const emit = (event: AgentEvent) => {
      state.events.push({ ...event, seq: state.seqBase + state.events.length + 1 });
      for (const wake of state.listeners) wake();
      for (const observer of this.observers) {
        try {
          observer(state, input, event);
        } catch (err) {
          this.log.warn('a run observer failed', { runId: state.id, error: errorMessage(err) });
        }
      }
    };

    // Waits as long as it takes: the user may be away, and the run is theirs to cancel.
    const confirm = (call: ProposedCall) =>
      new Promise<boolean | 'unanswered'>((resolve) => {
        if (state.abort.signal.aborted) return resolve(false);
        // Having given way once, the run is on its way out: it does not start waiting again.
        if (state.unanswered) return resolve('unanswered');
        state.pendingApprovals.push(call);
        state.waitingSince.set(call.toolCallId, Date.now());
        state.answers.set(call.toolCallId, (approved) => {
          state.answers.delete(call.toolCallId);
          state.waitingSince.delete(call.toolCallId);
          state.pendingApprovals = state.pendingApprovals.filter((p) => p.toolCallId !== call.toolCallId);
          resolve(approved);
        });
      });
    // Hands the browser to the user and waits, like `confirm`: as long as it takes.
    const handoff: HandoffAsk = (request) =>
      new Promise<HandoffOutcome>((resolve, reject) => {
        if (state.abort.signal.aborted) return resolve({ outcome: 'cancelled' });
        if (state.unanswered) return resolve({ outcome: 'unanswered' });
        let pending: { id: string };
        try {
          pending = this.deps.handoff.request({ ...request, runId: state.id, conversationId: input.conversationId }, (outcome) => {
            state.handoffs.delete(request.toolCallId);
            state.waitingSince.delete(request.toolCallId);
            // A stopped run ends the hand-off for the user; that is not their decision to report.
            if (outcome.outcome !== 'cancelled' && !state.abort.signal.aborted) {
              emit({ type: 'browser.handoff.resolved', toolCallId: request.toolCallId, handoffId: pending.id, outcome: outcome.outcome });
            }
            resolve(outcome);
          });
        } catch (err) {
          return reject(err);
        }
        state.waitingSince.set(request.toolCallId, Date.now());
        state.handoffs.set(request.toolCallId, (how) => this.deps.handoff.cancel(request.toolCallId, how));
        emit({ type: 'browser.handoff.requested', toolCallId: request.toolCallId, handoffId: pending.id, reason: request.reason });
      });
    state.abort.signal.addEventListener('abort', () => {
      for (const answer of [...state.answers.values()]) answer(false);
      for (const end of [...state.handoffs.values()]) end('cancelled');
    });

    state.origin = input.origin;
    state.wokenIds = (input.woken ?? []).map((t) => t.id);
    this.runs.set(state.id, state);
    this.activeByConversation.set(input.conversationId, state.id);
    emit({ type: 'run.started', runId: state.id, conversationId: input.conversationId, model: model.spec });

    const { woken: _woken, requestId: _requestId, interestCheckAt: _interestCheckAt, briefAt: _briefAt, ...turn } = input;
    state.done = runTurn(this.deps, { ...turn, runId: state.id, resumed: resumes > 0, signal: state.abort.signal, emit, confirm, handoff })
      .then((result) => {
        state.status = result.status;
        state.finishReason = result.finishReason;
        if (state.interrupted && result.status === 'cancelled') return;
        state.outcome = { steps: result.steps, usage: result.usage };
        if (result.status === 'cancelled') emit({ type: 'run.cancelled' });
        else emit({ type: 'run.completed', finishReason: result.finishReason, steps: result.steps, usage: result.usage });
      })
      .catch((err: unknown) => {
        if (state.abort.signal.aborted) {
          state.status = 'cancelled';
          if (!state.interrupted) emit({ type: 'run.cancelled' });
          return;
        }
        state.status = 'failed';
        state.error = errorMessage(err);
        this.log.error('run failed', { runId: state.id, error: state.error });
        emit({ type: 'run.failed', error: state.error });
      })
      .finally(() => {
        state.finishedAt = nowIso();
        // An interrupted run stays "running" on disk: that is what the next start looks for.
        if (state.status !== 'running' && !(state.interrupted && state.status === 'cancelled')) {
          try {
            this.store.finish(state.id, { status: state.status, error: state.error, finishReason: state.finishReason, outcome: state.outcome });
          } catch (err) {
            this.log.error('could not record the end of a run', { runId: state.id, error: errorMessage(err) });
          }
        }
        this.activeByConversation.delete(input.conversationId);
        if (!state.interrupted) {
          try {
            this.settleSteers(state, input);
          } catch (err) {
            this.log.error('could not pass on the messages waiting for a run', { runId: state.id, error: errorMessage(err) });
          }
        }
        for (const wake of state.listeners) wake();
        setTimeout(() => this.runs.delete(state.id), RETENTION_MS).unref();
      });

    return state;
  }

  /** A run in memory, or one that ended earlier (before a restart, or long ago) brought back from the database. */
  get(runId: string): Run | null {
    const live = this.runs.get(runId);
    if (live) return live;
    const record = this.store.get(runId);
    return record && record.status !== 'running' ? this.revive(record) : null;
  }

  /**
   * A finished run as it can still be told: its events are gone, so the stream is made again
   * from what was stored — the run's messages and how it ended. That is all a client needs to
   * end up where one that watched it live did.
   */
  private revive(record: RunRecord): RunState {
    const { conversations, models } = this.deps;
    const input = record.input as unknown as StartRunInput;
    const messages = conversations.messagesForRun(record.id).filter((m) => m.conversationId === record.conversationId);
    const model = messages.findLast((m) => m.model)?.model ?? input.model ?? conversations.get(record.conversationId)?.model ?? models.defaultSpec;
    const outcome = record.outcome as { steps: number; usage: RunUsage } | null;
    const zero: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const events: AgentEvent[] = [
      { type: 'run.started', runId: record.id, conversationId: record.conversationId, model },
      ...messages.map((m) => ({ type: 'message' as const, message: toMessageDto(m) })),
      record.status === 'completed'
        ? { type: 'run.completed', finishReason: record.finishReason ?? 'stop', steps: outcome?.steps ?? 0, usage: outcome?.usage ?? zero }
        : record.status === 'cancelled'
          ? { type: 'run.cancelled' }
          : { type: 'run.failed', error: record.error ?? 'The run failed.' },
    ];
    // Numbered beyond anything the run sent while it lived, for the same reason as a resumed run's.
    const seqBase = (record.resumes + 1) * SEQ_STRIDE;
    const state: RunState = {
      id: record.id,
      conversationId: record.conversationId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? record.startedAt,
      error: record.error,
      finishReason: record.finishReason,
      pendingApprovals: [],
      done: Promise.resolve(),
      events: events.map((event, i) => ({ ...event, seq: seqBase + i + 1 })),
      seqBase,
      interrupted: false,
      outcome,
      listeners: new Set(),
      abort: new AbortController(),
      answers: new Map(),
      handoffs: new Map(),
      waitingSince: new Map(),
      wokenIds: [],
    };
    this.runs.set(state.id, state);
    setTimeout(() => this.runs.delete(state.id), RETENTION_MS).unref();
    return state;
  }

  activeFor(conversationId: string): Run | null {
    const id = this.activeByConversation.get(conversationId);
    return id ? (this.runs.get(id) ?? null) : null;
  }

  /** Whether the conversation has a run or maintenance in progress, so `start` would answer 409. */
  isBusy(conversationId: string): boolean {
    return this.activeByConversation.has(conversationId);
  }

  /**
   * Runs maintenance (e.g. a manual compaction) that must not overlap with a turn: the
   * conversation is held busy for the duration, so `start` answers 409 meanwhile.
   */
  async exclusive<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeByConversation.has(conversationId)) {
      throw conflict('This conversation already has a run in progress');
    }
    this.activeByConversation.set(conversationId, MAINTENANCE);
    try {
      return await fn();
    } finally {
      this.activeByConversation.delete(conversationId);
    }
  }

  /**
   * Hands a run at work another message from the user. It joins between two steps; if the run
   * ends first, it becomes the next run. `409` once the run is over — then it is an ordinary send.
   */
  steer(runId: string, message: { text: string; quotes?: MessageQuote[]; attachmentIds?: string[]; timeZone?: string; requestId?: string }): Run {
    const requested = this.get(runId);
    if (requested && message.requestId) {
      const earlier = this.store.findByRequest(requested.conversationId, message.requestId);
      const accepted = earlier && this.get(earlier.id);
      if (accepted) return accepted;
    }
    const state = this.runs.get(runId);
    if (!state || state.status !== 'running' || state.abort.signal.aborted) throw conflict('This run is no longer at work');
    this.deps.attachments.resolve(message.attachmentIds);
    quotesSchema.parse(message.quotes ?? []);
    this.store.addSteer(runId, message);
    return state;
  }

  /** What becomes of messages that were still waiting when their run ended. */
  private settleSteers(state: Pick<Run, 'id' | 'status'>, input: StartRunInput): void {
    const waiting = this.store.pendingSteers(state.id);
    if (waiting.length === 0) return;
    // A run the user stopped, or one that failed, takes what was said to it down with it.
    if (state.status !== 'completed') {
      this.store.takeSteers(waiting);
      return;
    }
    const batch = steerBatch(waiting, this.deps.attachments);
    this.start({
      conversationId: input.conversationId,
      text: batch.map((s) => s.text).filter(Boolean).join('\n\n'),
      attachmentIds: steerAttachmentIds(batch),
      quotes: batch.flatMap((s) => s.quotes ?? []),
      model: input.model,
      timeZone: batch.findLast((s) => s.timeZone)?.timeZone ?? input.timeZone,
    }, batch, waiting.slice(batch.length));
  }

  cancelInterestDigests(interestId?: string): void {
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      if (this.deps.conversations.messagesForRun(run.id).some((m) => m.role === 'user' && !m.origin)) continue;
      const ids = this.store.get(run.id)?.input.interestIds as string[] | undefined;
      if (ids?.length && (!interestId || ids.includes(interestId))) this.cancel(run.id);
    }
  }

  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state || state.status !== 'running') return false;
    state.abort.abort();
    return true;
  }

  /**
   * The check-in that holds `conversationId` while it waits for an approval: since when its
   * oldest request has waited, and which follow-ups it was woken for. Null when the conversation
   * is free, busy with something the user started, or simply still working.
   */
  waitingCheckIn(conversationId: string): { runId: string; since: number; woken: string[] } | null {
    const id = this.activeByConversation.get(conversationId);
    const state = id ? this.runs.get(id) : undefined;
    if (!state || state.origin !== 'heartbeat' || state.waitingSince.size === 0) return null;
    return { runId: state.id, since: Math.min(...state.waitingSince.values()), woken: state.wokenIds };
  }

  /**
   * Answers every approval the run is waiting for as unanswered — a no that is nobody's
   * decision. The turn goes on from there and ends by itself. Returns how many were waiting.
   */
  giveUpWaiting(runId: string): number {
    const state = this.runs.get(runId);
    const answers = state ? [...state.answers.values()] : [];
    const handoffs = state ? [...state.handoffs.values()] : [];
    if (state && answers.length + handoffs.length > 0) state.unanswered = true;
    for (const answer of answers) answer('unanswered');
    for (const end of handoffs) end('unanswered');
    return answers.length + handoffs.length;
  }

  /** Allows or denies a held tool call. False if that call is not waiting for an answer. */
  resolveApproval(runId: string, toolCallId: string, approved: boolean): boolean {
    const answer = this.runs.get(runId)?.answers.get(toolCallId);
    if (!answer) return false;
    answer(approved);
    return true;
  }

  /**
   * Stops everything in flight and waits for it to settle. Used on shutdown. The runs are not
   * cancelled for good: they are left as interrupted, and the next start goes on with them.
   */
  async shutdown(): Promise<void> {
    const active = [...this.runs.values()].filter((run) => run.status === 'running');
    for (const run of active) {
      // One the user had already stopped stays stopped.
      if (run.abort.signal.aborted) continue;
      run.interrupted = true;
      run.abort.abort(INTERRUPTED);
    }
    await Promise.all(active.map((run) => run.done));
  }

  /**
   * Replays the run's events after `afterSeq`, then follows it live until it ends or
   * `signal` fires. Unsubscribing never affects the run itself.
   */
  async *subscribe(runId: string, afterSeq = 0, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    const state = this.runs.get(runId);
    if (!state) return;

    let cursor = Math.max(0, afterSeq - state.seqBase);
    let wake: () => void = () => {};
    const listener = () => wake();
    state.listeners.add(listener);
    signal?.addEventListener('abort', listener, { once: true });
    try {
      while (!signal?.aborted) {
        while (cursor < state.events.length) yield state.events[cursor++]!;
        if (state.finishedAt) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // An event may have landed between draining the buffer and installing `wake`.
          if (cursor < state.events.length || state.finishedAt || signal?.aborted) resolve();
        });
      }
    } finally {
      state.listeners.delete(listener);
      signal?.removeEventListener('abort', listener);
    }
  }
}

export function toRunDto(run: Run) {
  return {
    id: run.id,
    conversationId: run.conversationId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    pendingApprovals: run.pendingApprovals,
  };
}
