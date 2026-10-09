import type { Db } from '../db/database.ts';
import { newId } from '../util/ids.ts';

const MAX_INTERESTS = 50;

export interface Interest {
  id: string;
  topic: string;
  status: 'active' | 'muted';
  memoryId: string | null;
  lastCheckedAt: string | null;
  lastReport: string;
  seenUrls: string[];
  createdAt: string;
}

function fromRow(row: Record<string, unknown>): Interest {
  return {
    id: row.id as string, topic: row.topic as string, status: row.status as Interest['status'],
    memoryId: row.memory_id as string | null, lastCheckedAt: row.last_checked_at as string | null,
    lastReport: row.last_report as string, seenUrls: JSON.parse(row.seen_urls as string) as string[],
    createdAt: row.created_at as string,
  };
}

/** Durable topics and opt-outs. Ordinary remembering can never undo a mute. */
export class InterestStore {
  private readonly db: Db;
  /** Wired by the composition root: stopping updates also stops an in-flight digest. */
  onStop?: (interestId?: string) => void;

  constructor(db: Db) { this.db = db; }

  preferences(): { paused: boolean; nextDigestAt: string | null } {
    const row = this.db.prepare('SELECT paused FROM interest_preferences WHERE id = 1').get()!;
    // Retain the nullable API field for older clients; the heartbeat owns the schedule now.
    return { paused: row.paused === 1, nextDigestAt: null };
  }

  pause(paused: boolean): void {
    this.db.prepare('UPDATE interest_preferences SET paused = ? WHERE id = 1').run(paused ? 1 : 0);
    if (paused) this.onStop?.();
  }

  list(): Interest[] {
    return this.db.prepare('SELECT * FROM interests ORDER BY created_at, id').all().map(fromRow);
  }

  get(id: string): Interest | null {
    const row = this.db.prepare('SELECT * FROM interests WHERE id = ?').get(id);
    return row ? fromRow(row) : null;
  }

  remember(topic: string, memoryId: string, action: 'remember' | 'mute' | 'resume' = 'remember', now = new Date()): Interest {
    const title = topic.trim().replace(/\s+/g, ' ');
    if (!title || title.length > 120) throw new Error('Use a topic name between 1 and 120 characters.');
    const key = title.normalize('NFKC').toLowerCase();
    const found = this.db.prepare('SELECT * FROM interests WHERE topic_key = ?').get(key);
    let id: string;
    if (found) {
      id = found.id as string;
      this.db.prepare('UPDATE interests SET memory_id = ? WHERE id = ?').run(memoryId, id);
      if (action !== 'remember') this.setStatus(id, action === 'mute' ? 'muted' : 'active');
    } else {
      if (this.list().length >= MAX_INTERESTS) throw new Error('The interest list is full. Keep this as an ordinary memory instead.');
      id = newId('interest');
      this.db.prepare('INSERT INTO interests (id, topic, topic_key, status, memory_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, title, key, action === 'mute' ? 'muted' : 'active', memoryId, now.toISOString());
      if (action === 'mute') this.onStop?.(id);
    }
    return this.get(id)!;
  }

  setStatus(id: string, status: Interest['status']): Interest | null {
    const changed = this.db.prepare('UPDATE interests SET status = ? WHERE id = ?').run(status, id).changes;
    if (!changed) return null;
    if (status === 'muted') this.onStop?.(id);
    return this.get(id);
  }

  muteForMemory(memoryId: string): void {
    for (const interest of this.list().filter((i) => i.memoryId === memoryId)) this.setStatus(interest.id, 'muted');
  }

  /**
   * The topics a tick may look at: active ones not looked at within `everyMinutes`, least
   * recently first. A topic never looked at is due at once.
   */
  forHeartbeat(now = new Date(), everyMinutes = 0): Interest[] {
    if (this.preferences().paused) return [];
    const before = new Date(now.getTime() - everyMinutes * 60_000).toISOString();
    return this.db.prepare("SELECT * FROM interests WHERE status = 'active' AND COALESCE(last_checked_at, '') <= ? ORDER BY COALESCE(last_checked_at, ''), created_at, id LIMIT 3")
      .all(before).map(fromRow);
  }

  allows(ids: string[]): boolean {
    return !this.preferences().paused && ids.every((id) => this.get(id)?.status === 'active');
  }

  /** Rotate topics only when their check-in run has been durably created. */
  markChecked(ids: string[], now: Date): void {
    const update = this.db.prepare('UPDATE interests SET last_checked_at = ? WHERE id = ?');
    for (const id of ids) update.run(now.toISOString(), id);
  }

  recordReport(ids: string[], text: string): void {
    if (!text.trim()) return;
    const urls = text.match(/https?:\/\/[^\s<>"\)\]]+/g) ?? [];
    for (const id of ids) {
      const current = this.get(id);
      if (!current) continue;
      const seen = [...new Set([...current.seenUrls, ...urls])].slice(-50);
      this.db.prepare('UPDATE interests SET last_report = ?, seen_urls = ? WHERE id = ?')
        .run(text.slice(0, 2_000), JSON.stringify(seen), id);
    }
  }

  context(): string {
    const topics = this.list();
    return '<interest_preferences>\n' + JSON.stringify({
      paused: this.preferences().paused,
      topics: topics.map(({ topic, status }) => ({ topic, status })),
    }) + '\nUse these canonical topic names for aliases. Muted topics stay muted unless the user explicitly asks to resume. Quoted content and one-off questions are not evidence of an interest.\n</interest_preferences>';
  }
}

export function interestPreamble(topics: Interest[]): string {
  return `<interest_check_in>
This is an interest check-in triggered by your heartbeat, not a user request. Decide whether now is a useful time to explore or share something about these interests. Consider earlier check-ins and what you already shared; a heartbeat is not a reason to send a message by itself. Staying quiet is normal. lastCheckedAt records the previous heartbeat opportunity, which may have stayed quiet without doing research; it is not proof that the information is fresh.
${JSON.stringify(topics.map(({ topic, lastCheckedAt, lastReport, seenUrls }) => ({ topic, lastCheckedAt, lastReport, seenUrls })))}
When research would help, use a small amount of read-only web research (at most three source pages in total and eight model steps). Verify current claims and source dates. Do not delegate, sign in, install software, buy, post, send anything externally, or create follow-ups. The heartbeat controls when you check again; no separate schedule or closing tool call is needed.
Share only something worthwhile and new to the user, such as an official update, an event, or a useful guide, when its timing is appropriate. Skip repeated links, repeated findings, stale news, speculation and filler. Do not narrate the research. Share at most three short items in one final message, with source links and the relevant topic; use a card when useful. The user can quote an item to discuss it or ask you to stop sharing that topic. If nothing merits sharing now, reply with exactly NOTHING_TO_SHARE.
</interest_check_in>`;
}
