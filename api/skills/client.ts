import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectSkill, installSkill } from './install.ts';
import { listSkills, readSkill, writeSkill } from './library.ts';
import type { SkillRequest, SkillResponse } from './protocol.ts';

/** The skills shipped with Sunnie: beside this file, with the server's code, not in the agent's home. */
const BUNDLED = fileURLToPath(new URL('./bundled', import.meta.url));

async function main(): Promise<SkillResponse> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 600_000) throw new Error('Skill request is too large.');
  }
  const request = JSON.parse(input) as SkillRequest;
  const home = homedir();
  switch (request.action) {
    case 'list': return { ok: true, result: listSkills(home, BUNDLED) };
    case 'read': return { ok: true, result: readSkill(home, request.name, BUNDLED) };
    case 'write': return { ok: true, result: writeSkill(home, request.name, request.content) };
    case 'install': return { ok: true, result: installSkill(home, request.repository, request.path, request.ref) };
    case 'inspect': return { ok: true, result: inspectSkill(request.repository, request.path, request.ref) };
    default: throw new Error('Unknown skill operation.');
  }
}

main()
  .catch((error: unknown): SkillResponse => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  .then((response) => process.stdout.write(JSON.stringify(response)));
