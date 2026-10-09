import type { ToolSet } from 'ai';
import type { Computer } from '../computer/computer.ts';
import type { Config } from '../config.ts';
import type { LoginStore } from '../logins/login-store.ts';
import type { CoreMemory } from '../memory/core-memory.ts';
import type { InterestStore } from '../memory/interests.ts';
import type { MemoryStore } from '../memory/memory-store.ts';
import type { ConversationStore } from '../store/conversations.ts';
import type { TaskStore } from '../tasks/task-store.ts';
import type { DriveClient } from '../drive/client.ts';
import type { HomeStore } from '../home/home-store.ts';
import type { PhoneStore } from '../phone/phone-store.ts';
import type { WebSearch } from '../search/search.ts';
import type { BrowserHandoff, HandoffAsk } from '../browser/handoff.ts';
import { createBrowserTools } from './browser-tools.ts';
import { createComputerTools } from './computer-tools.ts';
import { createDelegateTools, type HelperCalls } from './delegate-tools.ts';
import { createGreetingTools } from './greeting-tools.ts';
import { createHomeTools } from './home-tools.ts';
import { createMemoryTools } from './memory-tools.ts';
import { createPhoneTools } from './phone-tools.ts';
import { createTaskTools } from './task-tools.ts';
import { createWebTools } from './web-tools.ts';
import { createSkillTools } from './skill-tools.ts';
import type { SkillClient } from '../skills/client.ts';
import type { SkillSources } from '../skills/sources.ts';

export interface ToolDeps {
  config: Config;
  computer: Computer;
  skills: SkillClient;
  skillSources: SkillSources;
  memory: MemoryStore;
  interests: InterestStore;
  core: CoreMemory;
  logins: LoginStore;
  tasks: TaskStore;
  home: HomeStore;
  phone: PhoneStore;
  drive: DriveClient;
  /** Web search; absent when no search service is configured. */
  search?: WebSearch;
  conversations: ConversationStore;
  conversationId: string;
  /** The user's zone for this turn, when the client sent one. */
  timeZone?: string;
  /** Whether the conversation's model can be shown pictures (`view_image`). Unset means yes. */
  images?: boolean;
  /** Sends and answers helpers. Absent when helpers are off. */
  helpers?: HelperCalls;
  /** The browser handed to the user, when it is. */
  handoff: BrowserHandoff;
  /** Asks the user to take the browser over, for this run. Absent in a turn that cannot ask. */
  askHandoff?: HandoffAsk;
}

/**
 * Tools that only look, so that doing one again changes nothing. A call to any other tool is
 * written down before it runs (`RunStore`), so that a turn picked up after a restart knows what
 * may already have happened. A new tool counts as acting unless it is listed here.
 */
export const LOOK_ONLY: ReadonlySet<string> = new Set([
  'read_file',
  'view_image',
  'web_fetch',
  'web_search',
  'browser_open',
  'browser_read',
  'browser_screenshot',
  // Asking the user is not acting on anything: a turn picked up after a restart asks again.
  'browser_handoff',
  'memory_search',
  'conversation_search',
  'task_list',
  'home_list',
  'phone_data',
  'skill_list',
  'skill_read',
]);

/**
 * What a helper works with: the computer, the web, and browser tabs of its own. It looks things
 * up and reports; memory, follow-ups, the login vault and further helpers stay with the agent
 * that sent it.
 */
export function createHelperTools(deps: Pick<ToolDeps, 'config' | 'computer' | 'logins' | 'conversationId' | 'skills' | 'search' | 'images'>): ToolSet {
  return {
    ...createComputerTools(deps.computer, { ...deps.config.computer, images: deps.images }),
    ...createWebTools(deps.computer, deps.search, deps.config.search),
    ...(deps.config.skills.enabled ? createSkillTools(deps.skills) : {}),
    ...(deps.config.browser.enabled
      ? createBrowserTools({
          computer: deps.computer,
          logins: deps.logins,
          config: deps.config.browser,
          session: deps.conversationId,
          vault: false,
          upload: false,
          images: deps.images,
        })
      : {}),
  };
}

/** Builds the tool set for one turn. Tools close over the conversation they act on behalf of. */
export function createTools(deps: ToolDeps): ToolSet {
  return {
    ...(deps.config.skills.enabled ? createSkillTools(deps.skills, deps.skillSources) : {}),
    ...createComputerTools(deps.computer, { ...deps.config.computer, images: deps.images }),
    ...createMemoryTools(deps),
    ...createWebTools(deps.computer, deps.search, deps.config.search),
    // Without the heartbeat nothing would ever come back to a task, so the tools would mislead.
    ...(deps.config.heartbeat.enabled ? createTaskTools(deps) : {}),
    ...createHomeTools(deps.home, deps.drive),
    ...createPhoneTools(deps.phone, deps.timeZone),
    ...(deps.config.browser.enabled
      ? createBrowserTools({
          computer: deps.computer,
          logins: deps.logins,
          config: deps.config.browser,
          images: deps.images,
          handoff: { held: () => deps.handoff.held, ask: deps.askHandoff },
        })
      : {}),
    ...createGreetingTools(deps.conversations),
    ...(deps.helpers ? createDelegateTools(deps.helpers, deps.config.subagents) : {}),
  };
}
