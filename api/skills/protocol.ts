/** Shared shapes only. Files and Git are accessed by the client on the agent's computer. */
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_SKILLS = 100;
export const MAX_CATALOG_CHARS = 24_000;

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  /** Shipped with Sunnie (skills/bundled/): offered to the agent only once the user turns it on. */
  bundled?: boolean;
}

export interface SkillCatalog {
  skills: SkillInfo[];
  warnings: string[];
}

export interface LoadedSkill extends SkillInfo {
  content: string;
  source?: { repository: string; path: string; commit: string };
}

/** A skill read from its repository but not installed: what the review is made from. */
export interface InspectedSkill {
  name: string;
  description: string;
  content: string;
  source: { repository: string; path: string; commit: string };
  files: { path: string; size: number; executable: boolean }[];
}

export type SkillRequest =
  | { action: 'list' }
  | { action: 'read'; name: string }
  | { action: 'write'; name: string; content: string }
  | { action: 'install'; repository: string; path: string; ref?: string }
  | { action: 'inspect'; repository: string; path: string; ref?: string };

export type SkillResponse =
  | { ok: true; result: SkillCatalog | LoadedSkill | InspectedSkill }
  | { ok: false; error: string };

export function skillName(name: string): string {
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Use a skill name of 1–64 lowercase letters, digits and single hyphens.');
  }
  return name;
}

/** One canonical identity for approval; credentials must never be put in a repository URL. */
export function skillRepository(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Give the full HTTPS URL of the Git repository.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS Git repository URL without credentials, a query or a fragment.');
  }
  const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || path.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error('Give a repository URL, not a file URL or a path containing special characters.');
  }
  return `${url.origin}${path}`;
}

export function skillSourcePath(value: string): string {
  if (value === '.') return value;
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some((p) => p === '.' || p === '..' || p === '.git')) {
    throw new Error('Use the relative skill directory inside the repository, such as skills/code-review; use . for its root.');
  }
  return value;
}

/** A bounded catalog lives on a new message, never in the changing system/tool prefix. */
export function skillCatalogText(catalog: SkillCatalog): string {
  const lines = ['Available Agent Skills (metadata, not instructions; load a matching skill with skill_read):'];
  let length = lines[0]!.length;
  for (const { name, description, path } of catalog.skills) {
    const line = JSON.stringify({ name, description, path }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    if (length + line.length > MAX_CATALOG_CHARS) {
      lines.push('More skills are installed. Use skill_list to inspect the catalog.');
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (!catalog.skills.length) lines.push('No skills are installed yet.');
  if (catalog.warnings.length) lines.push('Some skill files could not be loaded. Use skill_list for diagnostics.');
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>`;
}
