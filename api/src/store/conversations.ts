import type { ModelMessage } from 'ai';
import type { ReasoningEffort } from '../config.ts';
import { transaction, type Db } from '../db/database.ts';
import { toFtsQuery } from '../memory/fts.ts';
import { newId, nowIso } from '../util/ids.ts';
import type { MessageQuote } from './quotes.ts';
import type { Attachment } from './attachments.ts';

/**
 * "heartbeat" is the one conversation the agent's own check-ins are written to. "subagent" is
 * the transcript of one helper: opened by the task it was given, never written to by the user.
 */
export type ConversationKind = 'chat' | 'heartbeat' | 'subagent';

/**
 * Who started a turn, when it was not the user typing: a check-in, or the greeting that opens a
 * new user's first chat.
 */
export type MessageOrigin = 'heartbeat' | 'greeting';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  /** For a helper's transcript, the conversation whose turn sent the helper; otherwise null. */
  parentId: string | null;
  title: string | null;
  /** Per-conversation model override; null means "use the default model". */
  model: string | null;
  reasoning?: ReasoningEffort | null;
  /** Rolling summary of everything up to and including `summaryUptoSeq`. */
  summary: string | null;
  summaryUptoSeq: number;
  /**
   * Core memory as it was when this conversation's system prompt was last (re)built. The
   * prompt is rendered from this, not from live core memory, so that a memory edit in the
   * middle of a conversation does not invalidate the provider's prompt cache.
   */
  coreSnapshot: Record<string, string> | null;
  /** Provider-reported context size as of message `contextTokensSeq`. */
  contextTokens: number | null;
  contextTokensSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  /** AI SDK message content, exactly as the model sees it. */
  content: ModelMessage['content'];
  /** Human-visible text: what the user typed, or what the assistant said. */
  text: string;
  /** The original upload descriptors; never inferred from model-visible content. */
  attachments?: Attachment[];
  quotes?: MessageQuote[];
  /** A system-started opener, or an assistant message from an automatic interest digest. */
  origin: MessageOrigin | null;
  model: string | null;
  runId: string | null;
  createdAt: string;
}

export interface NewMessage {
  role: MessageRole;
  content: ModelMessage['content'];
  text?: string;
  attachments?: Attachment[];
  quotes?: MessageQuote[];
  origin?: MessageOrigin | null;
  model?: string | null;
  runId?: string | null;
}

export interface MessageSearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  seq: number;
  role: MessageRole;
  snippet: string;
  /** The whole message as the human saw it. */
  text: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

function toConversation(r: Row): Conversation {
  return {
    id: r.id as string,
    kind: r.kind as ConversationKind,
    parentId: r.parent_id as string | null,
    title: r.title as string | null,
    model: r.model as string | null,
    reasoning: r.reasoning as ReasoningEffort | null,
    summary: r.summary as string | null,
    summaryUptoSeq: r.summary_upto_seq as number,
    coreSnapshot: r.core_snapshot ? (JSON.parse(r.core_snapshot as string) as Record<string, string>) : null,
    contextTokens: r.context_tokens as number | null,
    contextTokensSeq: r.context_tokens_seq as number | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toMessage(r: Row): StoredMessage {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    seq: r.seq as number,
    role: r.role as MessageRole,
    content: JSON.parse(r.content as string) as ModelMessage['content'],
    text: r.text as string,
    attachments: JSON.parse(r.attachments as string) as Attachment[],
    quotes: JSON.parse(r.quotes as string) as MessageQuote[],
    origin: r.origin as MessageOrigin | null,
    model: r.model as string | null,
    runId: r.run_id as string | null,
    createdAt: r.created_at as string,
  };
}

export function toModelMessage(m: StoredMessage): ModelMessage {
  return { role: m.role, content: m.content } as ModelMessage;
}

/**
 * What a check-in says when it has nothing for the user. Interest check-ins store an empty text;
 * a follow-up check-in is told to say "Nothing to report." (`heartbeatPreamble`).
 */
const QUIET_WORDS = "'', 'nothing_to_share', 'nothing to report.', 'nothing to report'";

/** The last thing a run said aloud: its newest assistant message with visible text. */
const LAST_WORDS = `SELECT a2.pk FROM messages a2 WHERE a2.run_id = ?run AND a2.role = 'assistant' AND trim(a2.text) <> ''
  ORDER BY a2.seq DESC LIMIT 1`;

/**
 * The quiet check-ins of a conversation (parameters: conversation id, then the id of a run still
 * going, or ''): runs the system opened, nobody else wrote in, and whose last words — if any —
 * were only "nothing to share". History keeps them (invariant 4); listings may leave them out.
 */
const QUIET_RUNS = `SELECT o.run_id FROM messages o
  WHERE o.conversation_id = ? AND o.role = 'user' AND o.origin IS NOT NULL AND o.run_id IS NOT NULL AND o.run_id <> ?
    AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.run_id = o.run_id AND u.role = 'user' AND u.origin IS NULL)
    AND COALESCE(lower(trim((SELECT a.text FROM messages a WHERE a.pk = (${LAST_WORDS.replace('?run', 'o.run_id')})))), '') IN (${QUIET_WORDS})`;

export class ConversationStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(
    input: { title?: string | null; model?: string | null; reasoning?: ReasoningEffort | null; kind?: ConversationKind; parentId?: string | null } = {},
  ): Conversation {
    const id = newId('conv');
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO conversations (id, kind, parent_id, title, model, reasoning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.kind ?? 'chat', input.parentId ?? null, input.title ?? null, input.model ?? null, input.reasoning ?? null, now, now);
    return this.get(id)!;
  }

  modelDefaults(): { model: string; reasoning: ReasoningEffort } | null {
    const row = this.db.prepare('SELECT model, reasoning FROM chat_model_defaults WHERE id = 1').get();
    return row ? { model: row.model as string, reasoning: row.reasoning as ReasoningEffort } : null;
  }

  setModelDefaults(input: { model: string; reasoning: ReasoningEffort }): void {
    this.db.prepare(`INSERT INTO chat_model_defaults (id, model, reasoning) VALUES (1, ?, ?)
      ON CONFLICT (id) DO UPDATE SET model = excluded.model, reasoning = excluded.reasoning`)
      .run(input.model, input.reasoning);
  }

  /**
   * Whether the agent has met its user: it greeted them, or they wrote to it. The agent's own
   * check-ins do not count; a brief can run before anyone has connected.
   */
  hasMetUser(): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE role = 'user' AND (origin IS NULL OR origin = 'greeting') LIMIT 1").get();
  }

  /** The introduction a greeting opened, if one ever was. */
  introduction(): { conversationId: string; startedAt: string; finishedAt: string | null } | null {
    const row = this.db.prepare('SELECT conversation_id, started_at, finished_at FROM introduction WHERE id = 1').get();
    return row ? { conversationId: row.conversation_id as string, startedAt: row.started_at as string, finishedAt: row.finished_at as string | null } : null;
  }

  startIntroduction(conversationId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO introduction (id, conversation_id, started_at, finished_at) VALUES (1, ?, ?, NULL)')
      .run(conversationId, nowIso());
  }

  /** Ends the introduction; false when none was going on. */
  finishIntroduction(): boolean {
    return this.db.prepare('UPDATE introduction SET finished_at = ? WHERE id = 1 AND finished_at IS NULL').run(nowIso()).changes > 0;
  }

  /** Messages the user typed in a conversation. */
  typedCount(conversationId: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user' AND origin IS NULL")
      .get(conversationId) as { n: number }).n;
  }

  /** The newest conversation of a kind — for "heartbeat", the one check-ins are written to. */
  findByKind(kind: ConversationKind): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE kind = ? ORDER BY pk DESC LIMIT 1').get(kind);
    return row ? toConversation(row) : null;
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? toConversation(row) : null;
  }

  /** The conversations the user has; helpers' transcripts are reached through their parent. */
  list(opts: { limit?: number; before?: string } = {}): Conversation[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const rows = opts.before
      ? this.db
          .prepare(
            "SELECT * FROM conversations WHERE kind != 'subagent' AND updated_at < ? ORDER BY updated_at DESC LIMIT ?",
          )
          .all(opts.before, limit)
      : this.db.prepare("SELECT * FROM conversations WHERE kind != 'subagent' ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map(toConversation);
  }

  /** The transcripts of the helpers sent from a conversation, oldest first. */
  children(parentId: string): Conversation[] {
    return this.db.prepare('SELECT * FROM conversations WHERE parent_id = ? ORDER BY pk ASC').all(parentId).map(toConversation);
  }

  update(id: string, patch: { title?: string | null; model?: string | null }): Conversation | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title !== undefined ? patch.title : current.title,
        patch.model !== undefined ? patch.model : current.model,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  /** Deletes a conversation and, with it, the transcripts of the helpers it sent. */
  delete(id: string): boolean {
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM conversations WHERE parent_id = ?').run(id);
      return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
    });
  }

  /**
   * Appends atomically, so a model step's assistant + tool messages are never half-written.
   * `alongside` runs in the same transaction, for what must change together with the messages.
   */
  appendMessages(conversationId: string, messages: NewMessage[], alongside?: () => void): StoredMessage[] {
    if (messages.length === 0) return [];
    return transaction(this.db, () => {
      const max = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { seq: number };
      const insert = this.db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, role, content, text, attachments, quotes, origin, model, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = nowIso();
      const stored: StoredMessage[] = [];
      let seq = max.seq;
      for (const m of messages) {
        seq += 1;
        const row: StoredMessage = {
          id: newId('msg'),
          conversationId,
          seq,
          role: m.role,
          content: m.content,
          text: m.text ?? '',
          attachments: m.attachments ?? [],
          quotes: m.quotes ?? [],
          origin: m.origin ?? null,
          model: m.model ?? null,
          runId: m.runId ?? null,
          createdAt: now,
        };
        insert.run(
          row.id,
          conversationId,
          seq,
          row.role,
          JSON.stringify(row.content),
          row.text,
          JSON.stringify(row.attachments),
          JSON.stringify(row.quotes),
          row.origin,
          row.model,
          row.runId,
          now,
        );
        stored.push(row);
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      alongside?.();
      return stored;
    });
  }

  /**
   * `hideQuiet` leaves out the check-ins that came to nothing (see `QUIET_RUNS`); the run still
   * going is never one of them, since it has not said its last word.
   */
  getMessage(id: string): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? toMessage(row) : null;
  }

  listMessages(
    conversationId: string,
    opts: { afterSeq?: number; beforeSeq?: number; limit?: number; hideQuiet?: { activeRunId: string | null } } = {},
  ): StoredMessage[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const quiet = opts.hideQuiet ? `AND (run_id IS NULL OR run_id NOT IN (${QUIET_RUNS}))` : '';
    const quietArgs = opts.hideQuiet ? [conversationId, opts.hideQuiet.activeRunId ?? ''] : [];
    // Page backwards from the newest message, but always return ascending order.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE conversation_id = ? AND seq > ? AND seq < ? ${quiet}
           ORDER BY seq ${opts.afterSeq !== undefined ? 'ASC' : 'DESC'} LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(conversationId, opts.afterSeq ?? 0, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, ...quietArgs, limit);
    return rows.map(toMessage);
  }

  /**
   * What check-ins brought back, newest first: for each check-in run that was not quiet, its
   * last words, with the line that opened it. Runs the user joined are conversations, not news,
   * and the run still going has not said its last word yet.
   */
  checkInNews(conversationId: string, opts: { limit: number; activeRunId: string | null }): Array<{ message: StoredMessage; opener: string }> {
    return this.db
      .prepare(
        `SELECT a.*, o.text AS opener_text FROM messages o
         JOIN messages a ON a.pk = (${LAST_WORDS.replace('?run', 'o.run_id')})
         WHERE o.conversation_id = ? AND o.role = 'user' AND o.origin IS NOT NULL AND o.run_id IS NOT NULL AND o.run_id <> ?
           AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.run_id = o.run_id AND u.role = 'user' AND u.origin IS NULL)
           AND lower(trim(a.text)) NOT IN (${QUIET_WORDS})
         ORDER BY a.seq DESC LIMIT ?`,
      )
      .all(conversationId, opts.activeRunId ?? '', Math.min(opts.limit, 50))
      .map((r) => ({ message: toMessage(r), opener: r.opener_text as string }));
  }

  /** Messages not yet folded into the conversation summary — i.e. what the model still sees. */
  liveMessages(conversation: Conversation): StoredMessage[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC')
      .all(conversation.id, conversation.summaryUptoSeq)
      .map(toMessage);
  }

  messagesForRun(runId: string): StoredMessage[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY seq ASC')
      .all(runId)
      .map(toMessage);
  }

  setSummary(conversationId: string, summary: string, uptoSeq: number): void {
    this.db
      .prepare(
        `UPDATE conversations
         SET summary = ?, summary_upto_seq = ?, context_tokens = NULL, context_tokens_seq = NULL
         WHERE id = ?`,
      )
      .run(summary, uptoSeq, conversationId);
  }

  setCoreSnapshot(conversationId: string, snapshot: Record<string, string>): void {
    this.db
      .prepare('UPDATE conversations SET core_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), conversationId);
  }

  setContextTokens(conversationId: string, tokens: number, seq: number): void {
    this.db
      .prepare('UPDATE conversations SET context_tokens = ?, context_tokens_seq = ? WHERE id = ?')
      .run(tokens, seq, conversationId);
  }

  recordCompaction(entry: {
    conversationId: string;
    fromSeq: number;
    uptoSeq: number;
    summary: string;
    tokensBefore: number;
    memoriesSaved: number;
    model: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO compactions
           (id, conversation_id, from_seq, upto_seq, summary, tokens_before, memories_saved, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('cmp'),
        entry.conversationId,
        entry.fromSeq,
        entry.uptoSeq,
        entry.summary,
        entry.tokensBefore,
        entry.memoriesSaved,
        entry.model,
        nowIso(),
      );
  }

  /**
   * Full-text search over everything ever said, including messages already compacted away.
   * Helpers' transcripts are left out: their tasks were not said by the user, and what they
   * found is in the answer the main agent made of it.
   */
  searchMessages(query: string, opts: { limit?: number } = {}): MessageSearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.seq, m.role, m.created_at, m.text, c.title,
                snippet(messages_fts, 0, '', '', ' … ', 48) AS snippet
         FROM messages_fts
         JOIN messages m ON m.pk = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') AND c.kind != 'subagent'
         ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(fts, Math.min(opts.limit ?? 8, 50));
    return rows.map((r) => ({
      messageId: r.id as string,
      conversationId: r.conversation_id as string,
      conversationTitle: r.title as string | null,
      seq: r.seq as number,
      role: r.role as MessageRole,
      snippet: r.snippet as string,
      text: r.text as string,
      createdAt: r.created_at as string,
    }));
  }
}
