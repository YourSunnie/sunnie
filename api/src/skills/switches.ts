import { skillName } from '../../skills/protocol.ts';
import type { Db } from '../db/database.ts';
import { nowIso } from '../util/ids.ts';

/**
 * Which of the skills shipped with Sunnie the user turned on. They come preloaded and off: a
 * bundled skill without a row here is never offered to the agent. The agent's own skills are
 * always on.
 */
export class SkillSwitches {
  private readonly db: Db;

  constructor(db: Db) { this.db = db; }

  enabled(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM skill_switches WHERE name = ?').get(name);
  }

  set(name: string, enabled: boolean): void {
    if (enabled) {
      this.db.prepare('INSERT OR IGNORE INTO skill_switches (name, enabled_at) VALUES (?, ?)').run(skillName(name), nowIso());
    } else {
      this.db.prepare('DELETE FROM skill_switches WHERE name = ?').run(name);
    }
  }
}
