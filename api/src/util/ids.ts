import { randomBytes } from 'node:crypto';

export type IdPrefix = 'conv' | 'msg' | 'mem' | 'run' | 'cmp' | 'login' | 'task' | 'att' | 'interest' | 'hand';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
