import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import type { Embedder } from '../models/registry.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import { toMemory, type Memory, type MemoryHit } from './memory-store.ts';

/** Values per embedding call; some providers refuse more than 100. */
const BATCH = 64;
/** A catch-up call has no turn waiting on it. */
const BACKFILL_TIMEOUT_MS = 30_000;

const hashOf = (content: string) => createHash('sha256').update(content).digest('hex');

function normalise(vector: number[]): Float32Array {
  const out = new Float32Array(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

interface Row {
  memory: Memory;
  /** Absent when the memory has no embedding by this model of its present content. */
  vector?: Float32Array;
}

export interface SemanticRecallOptions {
  db: Db;
  embedder: Embedder;
  /** How long a search may wait for the provider. */
  timeoutMs: number;
  log: Logger;
}

/**
 * Recall by meaning: every memory has an embedding, a message gets one when it arrives, and the
 * nearest memories are the ones recalled. The vectors are derived data — a memory written or
 * changed since is embedded in the same call as the next message, so nothing has to tell this
 * class about writes. All vectors are read and compared on each search, which is fine for one
 * person's memories (thousands) and would not be for millions.
 */
export class SemanticRecall {
  private readonly opts: SemanticRecallOptions;

  constructor(opts: SemanticRecallOptions) {
    this.opts = opts;
  }

  get spec(): string {
    return this.opts.embedder.spec;
  }

  /**
   * The memories nearest in meaning to `query`, best first. Null when the provider could not be
   * reached in time: the caller then recalls by keywords. Never throws.
   */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<MemoryHit[] | null> {
    const { log } = this.opts;
    const started = Date.now();
    try {
      const rows = this.rows();
      if (rows.length === 0) return [];
      const missing = rows.filter((r) => !r.vector).slice(0, BATCH - 1);
      const vectors = await this.embed([query, ...missing.map((r) => r.memory.content)], this.opts.timeoutMs, signal);
      const target = normalise(vectors[0]!);
      this.store(missing, vectors.slice(1));

      const hits: MemoryHit[] = [];
      for (const { memory, vector } of rows) {
        // A vector of another length is from a model that changed its size: not comparable.
        if (!vector || vector.length !== target.length) continue;
        let dot = 0;
        for (let i = 0; i < target.length; i++) dot += target[i]! * vector[i]!;
        hits.push({ ...memory, score: dot });
      }
      log.debug('semantic recall', { ms: Date.now() - started, memories: rows.length, embedded: missing.length });
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      if (!signal?.aborted) log.warn('semantic recall failed; recalling by keywords', { error: errorMessage(err) });
      return null;
    }
  }

  /** Embeds every memory that has no current vector. For start-up; never throws. */
  async backfill(signal?: AbortSignal): Promise<void> {
    const { db, log } = this.opts;
    try {
      db.prepare('DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)').run();
      let done = 0;
      for (;;) {
        const missing = this.rows().filter((r) => !r.vector).slice(0, BATCH);
        if (missing.length === 0) break;
        const vectors = await this.embed(missing.map((r) => r.memory.content), BACKFILL_TIMEOUT_MS, signal);
        if (signal?.aborted) return;
        this.store(missing, vectors);
        done += missing.length;
      }
      if (done > 0) log.info('embedded memories for semantic recall', { memories: done, model: this.spec });
    } catch (err) {
      if (!signal?.aborted) log.warn('embedding memories failed; they are embedded with the next recall', { error: errorMessage(err) });
    }
  }

  private embed(values: string[], timeoutMs: number, signal?: AbortSignal): Promise<number[][]> {
    return this.opts.embedder.embed(values, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]));
  }

  private rows(): Row[] {
    return this.opts.db
      .prepare(
        `SELECT m.*, v.content_hash, v.vector FROM memories m
         LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?
         ORDER BY m.updated_at DESC`,
      )
      .all(this.spec)
      .map((r) => {
        const memory = toMemory(r);
        const blob = r.vector as Uint8Array | null;
        if (!blob || r.content_hash !== hashOf(memory.content)) return { memory };
        // Copied: a Float32Array needs an aligned buffer, which a blob's view does not promise.
        return { memory, vector: new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)) };
      });
  }

  private store(rows: Row[], vectors: number[][]): void {
    const insert = this.opts.db.prepare(
      // Only for a memory that still exists: one deleted while its embedding was on the way stays gone.
      `INSERT OR REPLACE INTO memory_vectors (memory_id, model, content_hash, vector)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)`,
    );
    rows.forEach((row, i) => {
      const vector = normalise(vectors[i]!);
      row.vector = vector;
      insert.run(row.memory.id, this.spec, hashOf(row.memory.content), new Uint8Array(vector.buffer), row.memory.id);
    });
  }
}
