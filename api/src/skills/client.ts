import type { Computer } from '../computer/computer.ts';
import type { InspectedSkill, LoadedSkill, SkillCatalog, SkillInfo, SkillRequest, SkillResponse } from '../../skills/protocol.ts';
import type { SkillSwitches } from './switches.ts';

/** A catalog entry as the app sees it: whether it came with Sunnie, and whether it is on. */
export interface SkillListing extends SkillInfo {
  bundled: boolean;
  enabled: boolean;
}

/** All skill files and network access stay on the agent's computer, just like the browser. */
export class SkillClient {
  private readonly computer: Computer;
  private readonly command: string;
  /** The commit a reviewed install call was shown at, by tool call id: that is what it installs. */
  private readonly reviewed = new Map<string, string>();
  private readonly switches: SkillSwitches;

  constructor(computer: Computer, command: string, switches: SkillSwitches) {
    this.computer = computer;
    this.command = command;
    this.switches = switches;
  }

  private on(skill: SkillInfo): boolean {
    return !skill.bundled || this.switches.enabled(skill.name);
  }

  private async request(request: SkillRequest, signal?: AbortSignal): Promise<SkillCatalog | LoadedSkill | InspectedSkill> {
    const result = await this.computer.exec(this.command, {
      stdin: JSON.stringify(request),
      timeoutMs: request.action === 'install' || request.action === 'inspect' ? 120_000 : 10_000,
      maxOutputChars: 600_000,
      signal,
    });
    if (result.aborted) throw new Error('Skill operation cancelled. Check the installed skills before trying again.');
    if (result.timedOut || result.exitCode !== 0 || result.truncated) {
      throw new Error('The skill command did not finish successfully. Use skill_list to check what is installed before retrying.');
    }
    let response: SkillResponse;
    try { response = JSON.parse(result.stdout) as SkillResponse; }
    catch { throw new Error('The skill command returned an unreadable response. Check the skills client on your computer.'); }
    if (!response.ok) throw new Error(response.error.slice(0, 1200));
    return response.result;
  }

  /** What the agent is offered: a bundled skill the user has not turned on is left out. */
  async list(signal?: AbortSignal): Promise<SkillCatalog> {
    const catalog = await this.request({ action: 'list' }, signal) as SkillCatalog;
    return { ...catalog, skills: catalog.skills.filter((skill) => this.on(skill)) };
  }

  /** Everything installed, on or off: for the user's Settings → Skills. */
  async catalog(signal?: AbortSignal): Promise<{ skills: SkillListing[]; warnings: string[] }> {
    const catalog = await this.request({ action: 'list' }, signal) as SkillCatalog;
    return {
      warnings: catalog.warnings,
      skills: catalog.skills.map((skill) => ({ ...skill, bundled: !!skill.bundled, enabled: this.on(skill) })),
    };
  }

  setEnabled(name: string, enabled: boolean): void {
    this.switches.set(name, enabled);
  }

  async read(name: string, signal?: AbortSignal): Promise<LoadedSkill> {
    const skill = await this.request({ action: 'read', name }, signal) as LoadedSkill;
    if (!this.on(skill)) throw new Error(`Skill ${name} is turned off. The user can turn it on in Settings → Skills; until then, do the task without it.`);
    return skill;
  }

  async write(name: string, content: string, signal?: AbortSignal): Promise<LoadedSkill> {
    return await this.request({ action: 'write', name, content }, signal) as LoadedSkill;
  }

  /** Reads a skill from its repository without installing it. */
  async inspect(repository: string, path: string, ref: string | undefined, signal?: AbortSignal): Promise<InspectedSkill> {
    return await this.request({ action: 'inspect', repository, path, ref }, signal) as InspectedSkill;
  }

  /** The install call `toolCallId` was reviewed at `commit`; it installs that commit, whatever the branch says by then. */
  pin(toolCallId: string, commit: string): void {
    this.reviewed.set(toolCallId, commit);
  }

  async install(repository: string, path: string, ref: string | undefined, signal?: AbortSignal, toolCallId?: string): Promise<LoadedSkill> {
    const pinned = toolCallId ? this.reviewed.get(toolCallId) : undefined;
    if (toolCallId) this.reviewed.delete(toolCallId);
    return await this.request({ action: 'install', repository, path, ref: pinned ?? ref }, signal) as LoadedSkill;
  }
}
