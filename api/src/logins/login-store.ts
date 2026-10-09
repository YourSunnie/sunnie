import { createHmac } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { newId, nowIso } from '../util/ids.ts';

/**
 * A saved sign-in. The user writes these through the API; the agent can fill them into its
 * browser by name but is never given the password or the one-time-code secret.
 */
export interface Login {
  id: string;
  name: string;
  /** Host the login belongs to, e.g. "github.com". It is only ever filled in there or on a subdomain. */
  site: string;
  username: string;
  password: string;
  /** Base32 TOTP secret, or '' when the site has no authenticator-app codes. */
  totpSecret: string;
  createdAt: string;
  updatedAt: string;
}

/** What clients and the agent may see of a login. */
export interface LoginDto {
  id: string;
  name: string;
  site: string;
  username: string;
  hasPassword: boolean;
  hasTotp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoginInput {
  name?: string;
  site: string;
  username?: string;
  password?: string;
  totpSecret?: string;
}

export function toLoginDto(l: Login): LoginDto {
  return {
    id: l.id,
    name: l.name,
    site: l.site,
    username: l.username,
    hasPassword: l.password !== '',
    hasTotp: l.totpSecret !== '',
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/** Accepts "github.com", "www.github.com" or a pasted URL, and keeps the bare host. */
export function normalizeSite(input: string): string {
  const trimmed = input.trim().toLowerCase();
  let host = trimmed;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new Error(`"${input}" is not a site. Use a host name such as github.com.`);
  }
  host = host.replace(/^www\./, '');
  if (!host) throw new Error('site must not be empty');
  return host;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Accepts a bare base32 secret (spaces allowed) or an otpauth:// URI, and keeps the secret. */
export function normalizeTotpSecret(input: string): string {
  let secret = input.trim();
  if (!secret) return '';
  if (secret.toLowerCase().startsWith('otpauth://')) {
    secret = new URL(secret).searchParams.get('secret') ?? '';
  }
  secret = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (secret.length < 8 || [...secret].some((ch) => !BASE32.includes(ch))) {
    throw new Error('The one-time-code secret must be the base32 setup key (or otpauth:// link) the site shows when you enable an authenticator app.');
  }
  return secret;
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}

/** RFC 6238 with the parameters every authenticator app defaults to: SHA-1, 30 seconds, 6 digits. */
export function totp(secret: string, now: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

type Row = Record<string, unknown>;

function toLogin(r: Row): Login {
  return {
    id: r.id as string,
    name: r.name as string,
    site: r.site as string,
    username: r.username as string,
    password: r.password as string,
    totpSecret: r.totp_secret as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** Thrown for input the caller can fix; the API maps it to 400 or 409. */
export class LoginError extends Error {
  readonly conflict: boolean;

  constructor(message: string, conflict = false) {
    super(message);
    this.conflict = conflict;
  }
}

export class LoginStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): Login[] {
    return this.db.prepare('SELECT * FROM logins ORDER BY name COLLATE NOCASE').all().map(toLogin);
  }

  get(id: string): Login | undefined {
    const row = this.db.prepare('SELECT * FROM logins WHERE id = ?').get(id);
    return row ? toLogin(row) : undefined;
  }

  /** Names are how the agent refers to a login, so they match without regard to case. */
  byName(name: string): Login | undefined {
    const row = this.db.prepare('SELECT * FROM logins WHERE name = ? COLLATE NOCASE').get(name.trim());
    return row ? toLogin(row) : undefined;
  }

  create(input: LoginInput): Login {
    const next = this.validated({ name: '', username: '', password: '', totpSecret: '', ...input });
    const id = newId('login');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO logins (id, name, site, username, password, totp_secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, next.name, next.site, next.username, next.password, next.totpSecret, now, now);
    return this.get(id)!;
  }

  /** Fields left out keep their value; an empty string clears a password or code secret. */
  update(id: string, patch: Partial<LoginInput>): Login | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing };
    for (const key of ['name', 'site', 'username', 'password', 'totpSecret'] as const) {
      if (patch[key] !== undefined) merged[key] = patch[key];
    }
    const next = this.validated(merged, id);
    this.db
      .prepare(
        `UPDATE logins SET name = ?, site = ?, username = ?, password = ?, totp_secret = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.name, next.site, next.username, next.password, next.totpSecret, nowIso(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM logins WHERE id = ?').run(id).changes > 0;
  }

  private validated(input: Required<LoginInput>, selfId?: string): Required<LoginInput> {
    let site: string;
    let totpSecret: string;
    try {
      site = normalizeSite(input.site);
      totpSecret = normalizeTotpSecret(input.totpSecret);
    } catch (err) {
      throw new LoginError((err as Error).message);
    }
    const name = input.name.trim() || site;
    const clash = this.byName(name);
    if (clash && clash.id !== selfId) {
      throw new LoginError(`A login named "${clash.name}" already exists. Give this one a different name.`, true);
    }
    return { name, site, username: input.username.trim(), password: input.password, totpSecret };
  }
}
