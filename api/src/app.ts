import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { AgentDeps } from './agent/agent.ts';
import { Heartbeat } from './agent/heartbeat.ts';
import { RunManager } from './agent/runs.ts';
import { createApp } from './api/server.ts';
import { LocalComputer, type Computer } from './computer/computer.ts';
import type { Config } from './config.ts';
import { openDatabase, type Db } from './db/database.ts';
import { LoginStore } from './logins/login-store.ts';
import { CoreMemory } from './memory/core-memory.ts';
import { InterestStore } from './memory/interests.ts';
import { MemoryStore } from './memory/memory-store.ts';
import { SemanticRecall } from './memory/semantic.ts';
import { createModelRegistry, type Embedder, type ModelRegistry } from './models/registry.ts';
import { JevRouter } from './router/jev.ts';
import { JevRecallFilter, noRecallFilter, type RecallFilter } from './router/recall.ts';
import { JevRiskFilter, noRiskFilter, type RiskFilter } from './router/risk.ts';
import { JevSkillScreen, noSkillScreen, type SkillScreen } from './router/skill-screen.ts';
import { noRouter, type ToolRouter } from './router/router.ts';
import { ConversationStore } from './store/conversations.ts';
import { AttachmentStore } from './store/attachments.ts';
import { RunStore } from './store/runs.ts';
import { TaskStore } from './tasks/task-store.ts';
import { HomeStore } from './home/home-store.ts';
import { CardStateStore } from './home/card-store.ts';
import { PhoneStore } from './phone/phone-store.ts';
import { ExaSearch } from './search/exa.ts';
import type { WebSearch } from './search/search.ts';
import { SkillClient } from './skills/client.ts';
import { SkillSources } from './skills/sources.ts';
import { SkillSwitches } from './skills/switches.ts';
import { DriveClient } from './drive/client.ts';
import { BrowserHandoff } from './browser/handoff.ts';
import { ApnsSender, noPush, type PushSender } from './push/apns.ts';
import { DeviceStore } from './push/devices.ts';
import { Notifier } from './push/notifier.ts';
import { createLogger, errorMessage, type Logger } from './util/log.ts';

export interface Sunnie {
  app: Hono;
  db: Db;
  deps: AgentDeps;
  runs: RunManager;
  /** Not started here: the process entry starts the clock, tests call `tick` themselves. */
  heartbeat: Heartbeat;
  notifier: Notifier;
  close(): Promise<void>;
}

/** Parts that tests (or an alternative deployment) may swap out. */
export interface SunnieOverrides {
  dbPath?: string;
  models?: ModelRegistry;
  computer?: Computer;
  router?: ToolRouter;
  risk?: RiskFilter;
  recall?: RecallFilter;
  skillScreen?: SkillScreen;
  /** `null` = recall by keywords, whatever the config says. */
  embedder?: Embedder | null;
  push?: PushSender;
  /** `null` = no web search, whatever the config says. */
  search?: WebSearch | null;
}

const TYPESAFE_API = 'https://api.typesafe.ai/v1';
const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/**
 * Jev is reachable two ways with the same request shape: TypeSafe's own API, or OpenRouter's
 * System One endpoint. A TypeSafe key wins when present; otherwise the OpenRouter key that
 * already pays for inference is used, so one key is enough to run everything.
 */
function jevAccess(config: Config, env: NodeJS.ProcessEnv): { baseURL: string; apiKey: string } | null {
  const { router } = config;
  const direct = router.apiKey ?? env[router.apiKeyEnv];
  if (direct) return { baseURL: router.baseURL ?? TYPESAFE_API, apiKey: direct };

  const openrouter = config.providers.openrouter;
  const viaOpenRouter = openrouter?.apiKey ?? (openrouter?.apiKeyEnv ? env[openrouter.apiKeyEnv] : undefined);
  if (viaOpenRouter && !router.baseURL) return { baseURL: OPENROUTER_API, apiKey: viaOpenRouter };
  return null;
}

export function createRouter(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): ToolRouter {
  const { router } = config;
  if (router.type === 'none') return noRouter;

  const access = jevAccess(config, env);
  if (access) return new JevRouter({ ...router, ...access, log });

  log.warn(
    `tool router disabled: neither ${router.apiKeyEnv} nor an OpenRouter key is set, so the language model will pick its own tools`,
  );
  return noRouter;
}

/** The risk filter calls Jev at the same endpoint, with the same key and model, as the tool router. */
export function createRiskFilter(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): RiskFilter {
  const { approvals, router } = config;
  if (approvals.type === 'none') return noRiskFilter;

  const access = jevAccess(config, env);
  if (access) return new JevRiskFilter({ ...approvals, ...access, model: router.model, log });

  log.warn(
    `approvals disabled: neither ${router.apiKeyEnv} nor an OpenRouter key is set, so no tool call will wait for confirmation`,
  );
  return noRiskFilter;
}

/** Skills are screened by Jev whenever tool calls are: at the same endpoint, with the same key and model. */
export function createSkillScreen(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): SkillScreen {
  const { approvals, router } = config;
  if (approvals.type === 'none') return noSkillScreen;
  const access = jevAccess(config, env);
  return access ? new JevSkillScreen({ ...access, timeoutMs: approvals.timeoutMs, model: router.model, log }) : noSkillScreen;
}

/** The recall filter calls Jev at the same endpoint, with the same key and model, as the tool router. */
export function createRecallFilter(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): RecallFilter {
  const { memory, router } = config;
  if (memory.recall.type === 'none') return noRecallFilter;

  const access = jevAccess(config, env);
  if (access) return new JevRecallFilter({ ...memory.recall, ...access, model: router.model, log });

  log.warn(
    `recall filter disabled: neither ${router.apiKeyEnv} nor an OpenRouter key is set, so every message gets its keyword matches and nothing more`,
  );
  return noRecallFilter;
}

/** The embedding model for recall by meaning, when one is configured and its provider has a key. */
export function createEmbedder(config: Config, models: ModelRegistry, log: Logger): Embedder | undefined {
  const spec = config.memory.embedding.model;
  if (spec === 'none') return undefined;
  try {
    return models.embedder(spec);
  } catch (err) {
    log.info(`semantic recall disabled (${errorMessage(err)}): memories are recalled by keywords`);
    return undefined;
  }
}

/**
 * APNs when it is configured and its key can be read; otherwise notifications are off. A key that
 * cannot be read is reported and leaves the server running without them.
 */
export function createSearch(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): WebSearch | undefined {
  const search = config.search;
  if (search.type === 'none') return undefined;
  const apiKey = search.apiKey ?? env[search.apiKeyEnv];
  if (!apiKey) {
    log.info(`web search disabled: ${search.apiKeyEnv} is not set, so there is no web_search tool`);
    return undefined;
  }
  return new ExaSearch({ baseURL: search.baseURL, apiKey, timeoutMs: search.timeoutMs, log });
}

export function createPushSender(config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): PushSender {
  const apns = config.push.apns;
  if (!apns) return noPush;
  try {
    // A key kept in .env usually has its line breaks written as \n.
    const key = apns.keyPath ? readFileSync(apns.keyPath, 'utf8') : env[apns.keyEnv]?.replace(/\\n/g, '\n');
    if (!key?.trim()) throw new Error(`neither keyPath nor ${apns.keyEnv} holds the .p8 key`);
    return new ApnsSender({ ...apns, key, log });
  } catch (err) {
    log.warn('notifications disabled: the APNs key could not be used', { error: errorMessage(err) });
    return noPush;
  }
}

/** Composition root: wires storage, memory, models, the computer and the HTTP API together. */
export function createSunnie(config: Config, overrides: SunnieOverrides = {}): Sunnie {
  const log = createLogger(config.logLevel);
  const db = openDatabase(overrides.dbPath ?? config.dbPath);
  const computer = overrides.computer ?? new LocalComputer({
    workspace: config.computer.workspace,
    shell: config.computer.shell,
    user: config.computer.user,
    defaultTimeoutMs: config.computer.defaultTimeoutSec * 1000,
    maxOutputChars: config.computer.maxOutputChars,
  });

  const models = overrides.models ?? createModelRegistry(config);
  const embedder = overrides.embedder === undefined ? createEmbedder(config, models, log) : (overrides.embedder ?? undefined);
  const semantic = embedder && new SemanticRecall({ db, embedder, timeoutMs: config.memory.embedding.timeoutMs, log });
  const closing = new AbortController();

  const deps: AgentDeps = {
    config,
    log,
    conversations: new ConversationStore(db),
    attachments: new AttachmentStore(db),
    memory: new MemoryStore(db),
    interests: new InterestStore(db),
    core: new CoreMemory(db, config.memory.coreBlockLimit),
    logins: new LoginStore(db),
    tasks: new TaskStore(db),
    home: new HomeStore(db),
    cards: new CardStateStore(db),
    phone: new PhoneStore(db),
    runLog: new RunStore(db),
    models,
    router: overrides.router ?? createRouter(config, log),
    risk: overrides.risk ?? createRiskFilter(config, log),
    recall: overrides.recall ?? createRecallFilter(config, log),
    skillScreen: overrides.skillScreen ?? createSkillScreen(config, log),
    semantic,
    search: overrides.search === undefined ? createSearch(config, log) : (overrides.search ?? undefined),
    computer,
    drive: new DriveClient(computer),
    skills: new SkillClient(computer, config.skills.command, new SkillSwitches(db)),
    skillSources: new SkillSources(db),
    handoff: new BrowserHandoff({ computer, config: config.browser, log }),
  };
  const runs = new RunManager(deps);
  const devices = new DeviceStore(db);
  const sender = overrides.push ?? createPushSender(config, log);
  const notifier = new Notifier({ devices, sender, conversations: deps.conversations, log });
  runs.observe((run, input, event) => notifier.observe({ ...run, origin: input.origin, brief: input.brief }, event));
  const heartbeat = new Heartbeat(deps, runs);
  deps.interests.onStop = (id) => runs.cancelInterestDigests(id);
  // Memories written before there was an embedding model, or by another one, catch up in the background.
  void semantic?.backfill(closing.signal);
  // Turns the last process did not finish go on from their last stored step.
  for (const { run, input } of runs.recover()) heartbeat.adopt(run, input);

  return {
    app: createApp(deps, runs, { devices, notifier }),
    db,
    deps,
    runs,
    heartbeat,
    notifier,
    async close() {
      closing.abort();
      heartbeat.stop();
      await runs.shutdown();
      await notifier.idle();
      sender.close();
      db.close();
    },
  };
}
