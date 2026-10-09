import type { Db } from '../db/database.ts';
import { nowIso } from '../util/ids.ts';

/**
 * Core memory is always in the system prompt, so it is small and curated:
 *  - `user`:    who the user is — name, life, work, stable preferences.
 *  - `persona`: how Sunnie has learned to behave for this user — tone, habits, standing instructions.
 */
export const CORE_BLOCKS = ['user', 'persona'] as const;
export type CoreBlock = (typeof CORE_BLOCKS)[number];

export function isCoreBlock(value: string): value is CoreBlock {
  return (CORE_BLOCKS as readonly string[]).includes(value);
}

export class CoreMemory {
  private readonly db: Db;
  readonly blockLimit: number;

  constructor(db: Db, blockLimit: number) {
    this.db = db;
    this.blockLimit = blockLimit;
  }

  get(block: CoreBlock): string {
    const row = this.db.prepare('SELECT content FROM core_memory WHERE block = ?').get(block);
    return (row?.content as string | undefined) ?? '';
  }

  all(): Record<CoreBlock, string> {
    return { user: this.get('user'), persona: this.get('persona') };
  }

  set(block: CoreBlock, content: string): string {
    const next = content.trim();
    if (next.length > this.blockLimit) {
      throw new Error(
        `Core memory block "${block}" would be ${next.length} characters; the limit is ${this.blockLimit}. ` +
          'Condense it, or move details into archival memory with memory_save.',
      );
    }
    this.db
      .prepare(
        `INSERT INTO core_memory (block, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(block) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(block, next, nowIso());
    return next;
  }

  append(block: CoreBlock, text: string): string {
    const current = this.get(block);
    return this.set(block, current ? `${current}\n${text.trim()}` : text);
  }

  /** Replaces one exact occurrence of `oldText`; an empty `newText` deletes it. */
  replace(block: CoreBlock, oldText: string, newText: string): string {
    const current = this.get(block);
    const first = current.indexOf(oldText);
    if (!oldText || first === -1) {
      throw new Error(`old_text was not found in core memory block "${block}". It must match exactly.`);
    }
    if (current.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error(`old_text matches more than once in block "${block}". Include more surrounding text.`);
    }
    const next = current.slice(0, first) + newText + current.slice(first + oldText.length);
    return this.set(block, next.replace(/\n{3,}/g, '\n\n'));
  }
}
