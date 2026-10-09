// Git and filesystem operations run as the agent's user, behind Computer.exec.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSkill } from './format.ts';
import { skillRoot } from './files.ts';
import { listSkills, ownSkills } from './library.ts';
import { MAX_SKILLS, MAX_SKILL_BYTES, skillRepository, skillSourcePath, type InspectedSkill, type LoadedSkill } from './protocol.ts';

const MAX_FILES = 256;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

interface BundleEntry { path: string; oid: string; size: number; executable: boolean }

/**
 * Reads one skill directory of a repository at a ref, without checking anything out or running
 * anything, and hands it to `use` while the fetched objects are still there.
 */
function withBundle<T>(repository: string, sourcePath: string, ref: string,
  use: (bundle: { commit: string; entries: BundleEntry[]; content: string; skill: ReturnType<typeof parseSkill>; read: (entry: BundleEntry) => Buffer }) => T): T {
  repository = skillRepository(repository);
  sourcePath = skillSourcePath(sourcePath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..')) {
    throw new Error('Use a Git branch, tag or commit as ref, without options or revision expressions.');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'sunnie-skill-'));
  const deadline = Date.now() + 100_000;
  const git = (args: string[], maxBuffer = 512_000): Buffer => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('Skill download timed out. Inspect the source and try again later.');
    try {
      return execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'http.followRedirects=initial', ...args,
      ], {
        cwd: temporary, timeout, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    } catch {
      throw new Error('Could not read the Git repository within the time or size limit. Check its HTTPS URL, access and ref. Installation supports repositories readable without an interactive login.');
    }
  };
  try {
    git(['init', '--quiet']);
    // Read objects directly: no checkout hooks, smudge filters, submodules or install scripts.
    git(['fetch', '--quiet', '--depth=1', '--no-tags', '--', repository, ref]);
    const commit = git(['rev-parse', '--verify', 'FETCH_HEAD']).toString('utf8').trim();
    const prefix = sourcePath === '.' ? '' : `${sourcePath}/`;
    const tree = git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit, '--', sourcePath === '.' ? '.' : prefix]).toString('utf8');
    const entries: BundleEntry[] = [];
    let bytes = 0;
    for (const record of tree.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error('A skill bundle may contain only regular files; symlinks and submodules are not installed.');
      const fullPath = match[4]!;
      if (!fullPath.startsWith(prefix)) throw new Error('A repository file escaped the requested skill directory.');
      const path = fullPath.slice(prefix.length);
      if (path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
        throw new Error('A skill bundle contains an unsafe file path. Choose a different source.');
      }
      const size = Number(match[3]);
      bytes += size;
      if (entries.length >= MAX_FILES || bytes > MAX_BUNDLE_BYTES) throw new Error('A skill bundle is limited to 256 files and 20 MiB. Choose a smaller skill directory.');
      entries.push({ path, oid: match[2]!, size, executable: match[1] === '100755' });
    }
    const manifest = entries.find((entry) => entry.path === 'SKILL.md');
    if (!manifest) throw new Error('There is no SKILL.md in that repository directory. Inspect the repository and choose the directory containing the skill.');
    if (manifest.size > MAX_SKILL_BYTES) throw new Error('The source SKILL.md is too large.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(git(['cat-file', 'blob', manifest.oid], MAX_SKILL_BYTES + 1));
    const skill = parseSkill(content, sourcePath === '.' ? undefined : sourcePath.split('/').at(-1));
    const read = (entry: BundleEntry) => {
      const data = git(['cat-file', 'blob', entry.oid], entry.size + 1);
      if (data.length !== entry.size) throw new Error('A downloaded skill file has an unexpected size.');
      return data;
    };
    return use({ commit, entries, content, skill, read });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** What a skill would bring, read without installing it: for whoever decides whether to. */
export function inspectSkill(repository: string, sourcePath: string, ref = 'HEAD'): InspectedSkill {
  return withBundle(repository, sourcePath, ref, ({ commit, entries, content, skill }) => ({
    name: skill.name,
    description: skill.description,
    content,
    source: { repository: skillRepository(repository), path: skillSourcePath(sourcePath), commit },
    files: entries.map(({ path, size, executable }) => ({ path, size, executable })),
  }));
}

export function installSkill(home: string, repository: string, sourcePath: string, ref = 'HEAD'): LoadedSkill {
  const own = ownSkills(listSkills(home));
  if (own.length >= MAX_SKILLS) throw new Error('The skill catalog is full. Remove an unused skill before installing another.');
  return withBundle(repository, sourcePath, ref, ({ commit, entries, content, skill, read }) => {
    const root = skillRoot(home, '.agents', true)!;
    const destination = join(root, skill.name);
    if (existsSync(destination) || own.some((s) => s.name === skill.name)) {
      throw new Error(`Skill ${skill.name} already exists. Read it and use skill_write for deliberate instruction edits; installation never overwrites it.`);
    }
    let stage: string | undefined = mkdtempSync(join(root, '.install-'));
    try {
      for (const entry of entries) {
        const target = join(stage, entry.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, read(entry), { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
      }
      const source = { repository: skillRepository(repository), path: skillSourcePath(sourcePath), commit };
      writeFileSync(join(stage, '.sunnie-source.json'), JSON.stringify(source), { flag: 'wx', mode: 0o600 });
      renameSync(stage, destination);
      stage = undefined;
      return { ...skill, path: join(destination, 'SKILL.md'), content, source };
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
    }
  });
}
