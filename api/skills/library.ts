// Runs only on the agent's computer. The server uses src/skills/client.ts through Computer.exec.
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSkill } from './format.ts';
import { readSkillFile, skillDirectories, skillRoot, writeSkillFile } from './files.ts';
import { MAX_SKILLS, skillName, type LoadedSkill, type SkillCatalog } from './protocol.ts';

/**
 * `bundled` is the skills/bundled/ directory shipped with this client. Its skills come last, so a
 * skill of the agent's own with the same name replaces one of them rather than clashing with it.
 */
export function listSkills(home: string, bundled?: string): SkillCatalog {
  const result: SkillCatalog = { skills: [], warnings: [] };
  const seen = new Set<string>();
  const warn = (message: string) => { if (result.warnings.length < 20) result.warnings.push(message.slice(0, 500)); };
  for (const scope of ['.agents', '.sunnie', 'bundled'] as const) {
    let root: string | undefined;
    let directories: string[];
    try {
      root = scope === 'bundled' ? bundledRoot(bundled) : skillRoot(home, scope);
      if (!root) continue;
      directories = skillDirectories(root);
    } catch (error) { warn(String(error)); continue; }
    for (const name of directories) {
      if (result.skills.length >= MAX_SKILLS) {
        warn(`Only the first ${MAX_SKILLS} skills are loaded. Remove unused skills before adding more.`);
        return result;
      }
      const path = join(root, name, 'SKILL.md');
      if (scope === 'bundled' && seen.has(name)) continue;
      try {
        const skill = parseSkill(readSkillFile(join(root, name)), name);
        if (seen.has(skill.name)) { warn(`${path}: shadowed by the skill in ~/.agents/skills.`); continue; }
        seen.add(skill.name);
        result.skills.push(scope === 'bundled' ? { ...skill, path, bundled: true } : { ...skill, path });
      } catch (error) { warn(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return result;
}

function bundledRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return lstatSync(path).isDirectory() ? path : undefined; }
  catch { return undefined; }
}

/** The agent's own skills: what counts towards the limit, and what an install must not replace. */
export function ownSkills(catalog: SkillCatalog): SkillCatalog['skills'] {
  return catalog.skills.filter((skill) => !skill.bundled);
}

export function readSkill(home: string, name: string, bundled?: string): LoadedSkill {
  skillName(name);
  const skill = listSkills(home, bundled).skills.find((item) => item.name === name);
  if (!skill) throw new Error(`Skill ${name} is not available. Use skill_list to find installed names and any validation errors.`);
  const content = readSkillFile(dirname(skill.path));
  return { ...parseSkill(content, name), path: skill.path, content, ...(skill.bundled ? { bundled: true } : {}) };
}

export function writeSkill(home: string, name: string, content: string): LoadedSkill {
  const skill = parseSkill(content, skillName(name));
  const own = ownSkills(listSkills(home));
  if (!own.some((s) => s.name === name) && own.length >= MAX_SKILLS) {
    throw new Error('The skill catalog is full. Remove an unused skill before creating another.');
  }
  const path = writeSkillFile(home, name, content);
  return { ...skill, path, content };
}
