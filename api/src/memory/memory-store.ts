import type { Db } from '../db/database.ts';
import { newId, nowIso } from '../util/ids.ts';
import { searchTerms, toFtsQuery } from './fts.ts';

export const MEMORY_KINDS = ['fact', 'preference', 'event', 'instruction', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Who wrote the memory: the agent via a tool, the compactor, or a client through the API. */
export type MemorySource = 'agent' | 'compaction' | 'api';

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  conversationId: string | null;
  recallCount: number;
  lastRecalledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHit extends Memory {
  /** Higher is more relevant. */
  score: number;
}

type Row = Record<string, unknown>;

/** How many times the wanted number of hits each query fetches before the lists are merged. */
const CANDIDATES = 4;
const CONTEXT_WEIGHT = 0.5;
/** A memory touched today scores this much above one that matches as well but is long untouched. */
const FRESH_BOOST = 0.2;
const FRESH_HALF_LIFE_DAYS = 180;
const SIMILAR_OVERLAP = 0.5;

export function toMemory(r: Row): Memory {
  return {
    id: r.id as string,
    kind: r.kind as MemoryKind,
    content: r.content as string,
    source: r.source as MemorySource,
    conversationId: r.conversation_id as string | null,
    recallCount: r.recall_count as number,
    lastRecalledAt: r.last_recalled_at as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * Archival memory: an unbounded set of small, self-contained statements, retrieved by
 * full-text relevance. Core memory (always in context) lives in core-memory.ts.
 */
export class MemoryStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Saving text that is already stored returns the existing memory instead of a duplicate. */
  add(input: {
    content: string;
    kind?: MemoryKind;
    source: MemorySource;
    conversationId?: string | null;
  }): { memory: Memory; created: boolean } {
    const content = input.content.trim();
    if (!content) throw new Error('Memory content is empty');

    const existing = this.db
      .prepare('SELECT * FROM memories WHERE content = ? COLLATE NOCASE')
      .get(content);
    if (existing) return { memory: toMemory(existing), created: false };

    const id = newId('mem');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memories (id, kind, content, source, conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind ?? 'fact', content, input.source, input.conversationId ?? null, now, now);
    return { memory: this.get(id)!, created: true };
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return row ? toMemory(row) : null;
  }

  update(id: string, patch: { content?: string; kind?: MemoryKind }): Memory | null {
    const current = this.get(id);
    if (!current) return null;
    const content = patch.content?.trim() || current.content;
    this.db
      .prepare('UPDATE memories SET content = ?, kind = ?, updated_at = ? WHERE id = ?')
      .run(content, patch.kind ?? current.kind, nowIso(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id);
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  list(opts: { limit?: number; offset?: number } = {}): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(Math.min(opts.limit ?? 50, 200), opts.offset ?? 0)
      .map(toMemory);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  }

  /**
   * Full-text matches, best first. `context` is what was said just before the query (a phone
   * message is often "book it"): its matches count for half, so they decide only where the
   * query itself says little. Between memories that match about equally the newer one leads,
   * since it is the likelier to still be true.
   */
  search(query: string, opts: { limit?: number; context?: string } = {}): MemoryHit[] {
    const limit = Math.min(opts.limit ?? 8, 50);
    const pool = new Map<string, MemoryHit>();
    const collect = (text: string, weight: number) => {
      const fts = toFtsQuery(text);
      if (!fts) return;
      const rows = this.db
        .prepare(
          `SELECT m.*, -bm25(memories_fts) AS score
           FROM memories_fts JOIN memories m ON m.pk = memories_fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY bm25(memories_fts) LIMIT ?`,
        )
        .all(fts, limit * CANDIDATES);
      // Each list is scaled to its best hit, so a long context cannot outweigh a short query.
      const best = (rows[0]?.score as number | undefined) || 1;
      for (const r of rows) {
        const hit = pool.get(r.id as string) ?? { ...toMemory(r), score: 0 };
        hit.score += (weight * (r.score as number)) / best;
        pool.set(hit.id, hit);
      }
    };
    collect(query, 1);
    if (opts.context) collect(opts.context, CONTEXT_WEIGHT);

    const now = Date.now();
    for (const hit of pool.values()) {
      const ageDays = Math.max(0, now - Date.parse(hit.updatedAt)) / 86_400_000;
      hit.score *= 1 + FRESH_BOOST * 0.5 ** (ageDays / FRESH_HALF_LIFE_DAYS);
    }
    return [...pool.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Stored memories that share most of their words with `content`: what a new memory may repeat
   * or replace. Word overlap, not meaning, so it finds rewordings and misses paraphrases.
   */
  similar(content: string, opts: { limit?: number; exceptId?: string } = {}): Memory[] {
    const words = new Set(searchTerms(content, 64));
    if (words.size === 0) return [];
    return this.search(content, { limit: 12 })
      .filter((hit) => {
        if (hit.id === opts.exceptId) return false;
        const theirs = searchTerms(hit.content, 64);
        const shared = theirs.filter((w) => words.has(w)).length;
        return shared >= 2 && shared / Math.min(words.size, theirs.length) >= SIMILAR_OVERLAP;
      })
      .slice(0, opts.limit ?? 3);
  }

  /** What was saved from one conversation, newest first. */
  fromConversation(conversationId: string, limit = 40): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(conversationId, limit)
      .map(toMemory);
  }

  markRecalled(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?',
    );
    const now = nowIso();
    for (const id of ids) stmt.run(now, id);
  }
}
