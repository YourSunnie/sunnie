// This module runs on the agent's computer, never in the server process.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_SKILL_BYTES, skillName } from './protocol.ts';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** No symlinks in the discovery roots: a cloned project's files are not installed skills. */
export function skillRoot(home: string, scope: '.agents' | '.sunnie', create = false): string | undefined {
  let path = realpathSync(home);
  for (const part of [scope, 'skills']) {
    path = join(path, part);
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    try {
      if (!lstatSync(path).isDirectory()) throw new Error(`${path} must be a real directory, not a symlink.`);
    } catch (error) {
      if (missing(error) && !create) return undefined;
      throw error;
    }
  }
  return path;
}

export function skillDirectories(root: string): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  let visited = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++visited > 2000) throw new Error(`Too many entries in ${root}; keep only skill directories there.`);
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}

export function readSkillFile(directory: string): string {
  if (!lstatSync(directory).isDirectory()) throw new Error('A skill must be a real directory, not a symlink.');
  const file = openSync(join(directory, 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error(`SKILL.md must be a regular file of at most ${MAX_SKILL_BYTES} bytes.`);
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      length += count;
      if (length > MAX_SKILL_BYTES) throw new Error('SKILL.md is too large; move supporting material to references/.');
      if (count === 0) break;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(file); }
}

/** Replace only the instruction file; a skill's scripts and resources remain intact. */
export function writeSkillFile(home: string, name: string, content: string): string {
  const root = skillRoot(home, '.agents', true)!;
  const directory = join(root, skillName(name));
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(directory).isDirectory()) throw new Error('The skill path is not a real directory.');
  const path = join(directory, 'SKILL.md');
  try {
    if (!lstatSync(path).isFile()) throw new Error('Refusing to replace a SKILL.md that is not a regular file.');
  } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(directory, `.skill-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}
