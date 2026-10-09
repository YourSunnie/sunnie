import type { Db } from '../db/database.ts';
import { nowIso } from '../util/ids.ts';

/** Which APNs host a device token belongs to: debug builds get sandbox tokens. */
export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

export interface PushDevice {
  token: string;
  environment: PushEnvironment;
  createdAt: string;
  updatedAt: string;
}

/** The phones that asked to be told when a run needs or has something for the user. */
export class DeviceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Registering a known token again only refreshes it, so the app may do it on every launch. */
  register(token: string, environment: PushEnvironment): PushDevice {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO push_devices (token, environment, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET environment = excluded.environment, updated_at = excluded.updated_at`,
      )
      .run(token, environment, now, now);
    return this.get(token)!;
  }

  get(token: string): PushDevice | null {
    const row = this.db.prepare('SELECT * FROM push_devices WHERE token = ?').get(token);
    return row ? toDevice(row) : null;
  }

  list(): PushDevice[] {
    return this.db.prepare('SELECT * FROM push_devices ORDER BY created_at').all().map(toDevice);
  }

  remove(token: string): boolean {
    return this.db.prepare('DELETE FROM push_devices WHERE token = ?').run(token).changes > 0;
  }
}

function toDevice(r: Record<string, unknown>): PushDevice {
  return {
    token: r.token as string,
    environment: r.environment as PushEnvironment,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
