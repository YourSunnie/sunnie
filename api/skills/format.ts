import { parseDocument } from 'yaml';
import { MAX_SKILL_BYTES, skillName } from './protocol.ts';

export function parseSkill(content: string, directoryName?: string): { name: string; description: string } {
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md is too large; move supporting material to references/.');
  }
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter between --- lines.');
  const document = parseDocument(match[1]!, { uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error('SKILL.md has invalid YAML metadata. Use a name and a quoted or multiline description.');
  }
  let data: Record<string, unknown>;
  try { data = document.toJS({ maxAliasCount: 20 }) as Record<string, unknown>; }
  catch { throw new Error('SKILL.md metadata contains too many YAML aliases. Use plain metadata values.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string' || typeof data.description !== 'string') {
    throw new Error('SKILL.md needs string fields name and description in its YAML frontmatter.');
  }
  const name = skillName(data.name);
  if (directoryName !== undefined && directoryName !== name) throw new Error('The YAML name must match the skill directory name.');
  const description = data.description.trim();
  if (!description || description.length > 1024) throw new Error('A skill description must be 1–1024 characters and say when to use it.');
  if (!content.slice(match[0].length).trim()) throw new Error('Add Markdown instructions after the YAML frontmatter.');
  return { name, description };
}
