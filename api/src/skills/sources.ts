import { skillRepository } from '../../skills/protocol.ts';
import type { Db } from '../db/database.ts';
import { nowIso } from '../util/ids.ts';

/** A model-written file must never be able to approve its own remote source. */
export class SkillSources {
  private readonly db: Db;

  constructor(db: Db) { this.db = db; }

  has(repository: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM skill_sources WHERE repository = ?').get(skillRepository(repository));
  }

  trust(repository: string): void {
    this.db.prepare('INSERT OR IGNORE INTO skill_sources (repository, trusted_at) VALUES (?, ?)')
      .run(skillRepository(repository), nowIso());
  }

  list(): { repository: string; trustedAt: string }[] {
    return this.db.prepare('SELECT repository, trusted_at AS trustedAt FROM skill_sources ORDER BY repository').all() as { repository: string; trustedAt: string }[];
  }

  revoke(repository: string): void {
    this.db.prepare('DELETE FROM skill_sources WHERE repository = ?').run(skillRepository(repository));
  }
}
