import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { shq } from './computer/computer.ts';

const providerSchema = z.object({
  type: z.enum(['openrouter', 'openai', 'google', 'anthropic', 'deepseek', 'xai', 'openai-compatible']),
  /** Name of the environment variable holding the key. Preferred over `apiKey`. */
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  /** Required for `openai-compatible`; optional override for the native providers. */
  baseURL: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * The agent's name. It is fixed (the user decided, 2026-10-06): Sunnie is always Sunnie, whatever
 * a config file or a user in chat asks for.
 */
export const AGENT_NAME = 'Sunnie';

export const reasoningSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const modelInfoSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Native attachment input. Disable a kind when the selected model cannot read it. */
  media: z.object({ images: z.boolean().optional(), pdf: z.boolean().optional() }).optional(),
  /** Reasoning effort for this model; overrides agent.reasoning. */
  reasoning: reasoningSchema.optional(),
  /**
   * Extra provider-specific request options, passed through untouched — e.g.
   * { "provider": { "order": ["openai"] } } to pin an OpenRouter upstream.
   */
  providerOptions: z.record(z.string(), z.json()).optional(),
  /**
   * How the tool router's decision reaches this model. "tool-choice" (the default) imposes it
   * through the API; "hint" tells the model in a note, for providers that accept no tool choice
   * but "auto". A model is switched to "hint" by itself the first time its provider refuses.
   */
  steer: z.enum(['tool-choice', 'hint']).optional(),
  /**
   * A stronger model the agent may consult mid-step (Anthropic's advisor tool; the provider runs
   * it). `model` is the advisor, at least as capable as this one; `maxUses` caps consultations per
   * model call; `maxTokens` caps each piece of advice (minimum 1,024). Costs the advisor's price.
   */
  advisor: z
    .object({
      model: z.string(),
      maxUses: z.number().int().positive().optional(),
      maxTokens: z.number().int().min(1024).optional(),
    })
    .optional(),
});

const fileConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(8787),
    })
    .prefault({}),
  agent: z
    .object({
      /**
       * "<provider>/<model-id>". Anything after the first slash is passed to the provider verbatim.
       * Always one pinned model: the thinking is done by a model the user chose, never by a
       * router that picks one per request.
       */
      defaultModel: z.string().default('openrouter/openai/gpt-6-luna'),
      /** Reasoning effort for models that support it; a model's own `reasoning` overrides it. */
      reasoning: reasoningSchema.default('medium'),
      /**
       * How many genuinely different ways around an obstacle the agent tries before it stops and
       * reports. Stated in the system prompt; the hard limit on a turn is `maxSteps`.
       */
      maxAttempts: z.number().int().min(1).max(10).default(3),
      /** Upper bound on model calls within a single user turn (one more, without tools, wraps up). */
      maxSteps: z.number().int().positive().default(40),
      /** Retries of a model call that failed transiently (rate limit, overload) before producing anything. */
      stepRetries: z.number().int().min(0).default(3),
      retryBaseMs: z.number().int().positive().default(2000),
      /**
       * A model call that sends nothing for this long is given up on, and retried if it had not
       * produced anything yet. At `high` and `xhigh` reasoning it is given twice as long, because
       * a model can think in silence; so is the summariser, which answers in one piece.
       */
      stallTimeoutMs: z.number().int().positive().default(150_000),
      temperature: z.number().optional(),
      /**
       * An advisory token budget for one turn, told to a model that takes one (Anthropic's task
       * budget): it paces itself and winds down instead of being cut off. Counts what it generates
       * and the tool results it reads in the turn. Minimum 20,000; unset means no budget.
       */
      turnBudgetTokens: z.number().int().min(20_000).optional(),
    })
    .prefault({}),
  providers: z.record(z.string(), providerSchema).default({}),
  /** Optional per-model metadata, keyed by the full "<provider>/<model-id>" spec. */
  models: z.record(z.string(), modelInfoSchema).default({}),
  compaction: z
    .object({
      /** Hard cap on context size regardless of how large the model's window is. */
      maxContextTokens: z.number().int().positive().default(100_000),
      /** Fraction of the model's context window that may be used before compacting. */
      threshold: z.number().min(0.1).max(0.95).default(0.75),
      /** Most recent messages kept verbatim after a compaction. */
      keepRecentTokens: z.number().int().positive().default(16_000),
      /** Model used for summarising; defaults to the conversation's model. */
      model: z.string().optional(),
    })
    .prefault({}),
  memory: z
    .object({
      /** Archival memories auto-injected alongside each user message. */
      recallLimit: z.number().int().min(0).default(6),
      /**
       * Whether a message calls for a recall at all is one decision per turn. When it does, up to
       * `recallLimit` memories and a few passages of earlier conversations ride along with it.
       */
      recall: z
        .object({
          /**
           * "jev" = TypeSafe Jev decides per message, reached the same way as the tool router.
           * "none" (the default since 2026-10-09: Jev is kept for the risk question) = every message
           * gets its nearest memories.
           */
          type: z.enum(['jev', 'none']).default('none'),
          /** A recall happens when Jev's probability that the message needs one reaches this. */
          threshold: z.number().min(0).max(1).default(0.5),
          timeoutMs: z.number().int().positive().default(4000),
        })
        .prefault({}),
      /**
       * Recall by meaning: memories are embedded once, a message when it arrives, and the nearest
       * ones are attached. Without a usable model here, recall is by keywords.
       */
      embedding: z
        .object({
          /** "<provider>/<embedding-model-id>", or "none". */
          model: z.string().default('openrouter/voyageai/voyage-4-lite'),
          /** How long a turn waits for its message to be embedded before it recalls by keywords. */
          timeoutMs: z.number().int().positive().default(3000),
        })
        .prefault({}),
      /** Max characters per core-memory block. */
      coreBlockLimit: z.number().int().positive().default(4000),
    })
    .prefault({}),
  computer: z
    .object({
      /** The agent's home directory. Defaults to <SUNNIE_HOME>/workspace. */
      workspace: z.string().optional(),
      /** Linux user to run the agent's commands as. Requires the server to run as root. */
      user: z.string().optional(),
      shell: z.string().default('/bin/bash'),
      defaultTimeoutSec: z.number().int().positive().default(120),
      maxTimeoutSec: z.number().int().positive().default(1800),
      maxOutputChars: z.number().int().positive().default(16_000),
    })
    .prefault({}),
  skills: z
    .object({
      enabled: z.boolean().default(true),
      /** Runs on the agent's computer. Defaults to the bundled skills client. */
      command: z.string().optional(),
    })
    .prefault({}),
  /** The agent's web browser: Google Chrome on its computer, with a profile that keeps sign-ins. */
  browser: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Shell command that runs the browser client on the agent's computer. Defaults to the
       * client shipped with the server, which is right whenever the computer is this machine.
       */
      command: z.string().optional(),
      /**
       * Off by default: the browser runs with a real window (on a virtual screen where the
       * computer has none), because sites detect and block headless browsers.
       */
      headless: z.boolean().default(false),
      /** A specific browser binary. Unset: the installed Google Chrome, and Chromium only where there is none. */
      executablePath: z.string().optional(),
      /** Where Playwright's Chromium (the fallback) is installed, when not in the agent's own cache directory. */
      browsersPath: z.string().optional(),
      /** The browser is closed after this long without use; sign-ins survive. */
      idleMinutes: z.number().int().positive().default(30),
      /** Cap on the page outline returned by one browser tool call. */
      maxOutputChars: z.number().int().positive().default(12_000),
    })
    .prefault({}),
  /**
   * Web search (`web_search`), and a crawler `web_fetch` falls back on when a site blocks the
   * computer. The server makes these calls, so the key never reaches the agent. Without a key
   * there is no `web_search` tool.
   */
  search: z
    .object({
      /** "exa" = Exa's API (exa.ai). "none" = no web search. */
      type: z.enum(['exa', 'none']).default('exa'),
      /** Exa's API, or a gateway that speaks it. */
      baseURL: z.string().default('https://api.exa.ai'),
      apiKeyEnv: z.string().default('EXA_API_KEY'),
      apiKey: z.string().optional(),
      /** Results a search returns when the model does not say (it may ask for up to 10). */
      defaultResults: z.number().int().min(1).max(10).default(5),
      /** Whether `web_fetch` reads a page through the search service when a direct fetch is refused or fails. */
      fetchFallback: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(20_000),
    })
    .prefault({}),
  /**
   * Decides which tool the agent uses at each step, ahead of the language model. Off by default
   * since 2026-10-09 (the user's decision): current models choose their own tools well, and every
   * step asked Jev three questions and waited one to four seconds. Jev stays the judge of risk
   * (`approvals`), which reads the endpoint and key from here.
   */
  router: z
    .object({
      /** "jev" = TypeSafe Jev. "none" = the language model picks its own tools. */
      type: z.enum(['jev', 'none']).default('none'),
      model: z.string().default('jev-latest'),
      /**
       * Where Jev is called. By default: TypeSafe's own API when its key is set, otherwise
       * OpenRouter's System One endpoint using the OpenRouter key.
       */
      baseURL: z.string().optional(),
      apiKeyEnv: z.string().default('TYPESAFE_API_KEY'),
      apiKey: z.string().optional(),
      /** Decisions below this confidence are handed back to the language model. */
      confidenceThreshold: z.number().min(0).max(1).default(0.7),
      /**
       * A decision to reply — which ends the turn — needs at least this confidence, and never
       * less than `confidenceThreshold`. Higher than for a tool on purpose: a wrong tool costs a
       * step, a wrong reply stops a task the user then has to ask for again.
       */
      replyThreshold: z.number().min(0).max(1).default(0.8),
      /**
       * Each routing request also asks whether the user's message holds something worth
       * remembering; at this probability `memory_save` becomes the next action. 1 = never ask.
       */
      rememberThreshold: z.number().min(0).max(1).default(0.7),
      /** How a decision is enforced; see applyRoute in router/router.ts. */
      mode: z.enum(['tool-choice', 'active-tools']).default('tool-choice'),
      timeoutMs: z.number().int().positive().default(4000),
    })
    .prefault({}),
  /**
   * Confirmation of risky actions: every tool call is shown to a risk filter before it runs,
   * and a high-risk one waits for the user to allow or deny it.
   */
  approvals: z
    .object({
      /** "jev" = TypeSafe Jev, reached the same way as the tool router. "none" = never ask. */
      type: z.enum(['jev', 'none']).default('jev'),
      /** A call waits for the user when Jev's probability that it is high risk reaches this. */
      threshold: z.number().min(0).max(1).default(0.5),
      /** A call Jev could not judge (timeout, outage): "ask" the user anyway, or "allow" it. */
      onError: z.enum(['ask', 'allow']).default('ask'),
      timeoutMs: z.number().int().positive().default(4000),
      /**
       * Also ask the model's provider, where it offers a judgement of its own on the tool calls
       * the model writes (Anthropic's dangerous-tool-use safeguard, which knows a tool named
       * `bash`): a call it flags is held like one the risk filter holds. Costs nothing extra.
       */
      providerCheck: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Proactivity: on a timer the agent looks at the follow-ups it has noted for itself (tasks)
   * and works on the ones that are due, in a conversation of its own.
   */
  heartbeat: z
    .object({
      enabled: z.boolean().default(true),
      /** How often follow-ups and active interests are considered. With neither, no model is called. */
      intervalMinutes: z.number().positive().default(10),
      /** A follow-up whose check-in failed or was stopped comes back after this long. */
      recheckMinutes: z.number().positive().default(60),
      /** Most follow-ups handed to one check-in; the rest wait for the next tick. */
      maxTasksPerRun: z.number().int().positive().default(10),
      /**
       * A check-in that waits for an approval holds up every other follow-up. Once it has waited
       * this long and something else is due, the request counts as unanswered (a no), the
       * check-in ends, and what it was woken for comes back after `recheckMinutes`.
       */
      approvalWaitMinutes: z.number().positive().default(15),
      /** A topic the user follows is looked at no more often than this, however often the heartbeat ticks. */
      interestMinutes: z.number().positive().default(240),
      /** Model for check-in runs; defaults to the default model. */
      model: z.string().optional(),
      /**
       * Once a day, from this hour in the user's zone, a check-in refreshes the app's Home screen
       * (the data of the user's widgets, and a note or two). It costs one small run a day; false turns it off.
       */
      brief: z.boolean().default(true),
      briefHour: z.number().int().min(0).max(23).default(6),
    })
    .prefault({}),
  /**
   * Helpers: for work that splits into independent pieces, the agent hands each piece to a
   * sub-agent — the same turn loop on a smaller prompt and tool set — and they run side by side.
   */
  subagents: z
    .object({
      enabled: z.boolean().default(true),
      /** Most tasks one `delegate` call may hand out. */
      maxTasks: z.number().int().min(1).max(20).default(10),
      /** Helpers at work at the same time; the rest of a call's tasks wait their turn. */
      concurrency: z.number().int().min(1).max(20).default(5),
      /** Model calls one helper gets (one more, without tools, writes its report). */
      maxSteps: z.number().int().positive().default(15),
      /** Cap on one helper's report as the main agent receives it. */
      maxReportChars: z.number().int().positive().default(6000),
      /** Model for helpers; defaults to the model of the turn that sent them. */
      model: z.string().optional(),
    })
    .prefault({}),
  /**
   * Notifications on the user's iPhone: a run waiting for an OK, an answer, a failure. Off until
   * `apns` is set. Apple only delivers to an app for the team that signed it, so this needs that
   * team's APNs key (Certificates, Identifiers & Profiles → Keys).
   */
  push: z
    .object({
      apns: z
        .object({
          teamId: z.string().min(1),
          keyId: z.string().min(1),
          /** Path of the .p8 key file. Without it, the key's text is read from `keyEnv`. */
          keyPath: z.string().optional(),
          keyEnv: z.string().default('SUNNIE_APNS_KEY'),
          /** The app's bundle id. */
          topic: z.string().default('com.yoursunnie.Sunnie'),
          /** Replaces Apple's hosts; for tests. */
          endpoint: z.string().optional(),
          timeoutMs: z.number().int().positive().default(10_000),
        })
        .optional(),
    })
    .prefault({}),
  /**
   * Where the hosting service reports this instance's allowance, for the app to show as a
   * percentage: a GET answered with `{ used, limit, resetsAt? }` (tokens). The server asks,
   * with the bearer token in `apiKeyEnv`, so the app never sees the service. Unset: nothing to show.
   */
  usage: z
    .object({
      url: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      apiKey: z.string().optional(),
      timeoutMs: z.number().int().positive().default(5000),
    })
    .prefault({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelInfoConfig = z.infer<typeof modelInfoSchema>;
export type ReasoningEffort = z.infer<typeof reasoningSchema>;
type FileConfig = z.infer<typeof fileConfigSchema>;

export interface Config extends FileConfig {
  /** Absolute path of the data directory. */
  home: string;
  dbPath: string;
  /** Bearer token clients must present. */
  apiKey: string;
  computer: FileConfig['computer'] & { workspace: string };
  browser: FileConfig['browser'] & { command: string };
  skills: FileConfig['skills'] & { command: string };
}

/** Providers available out of the box; a config file can override or add to these. */
const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  openrouter: { type: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
  openai: { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
  google: { type: 'google', apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  deepseek: { type: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  xai: { type: 'xai', apiKeyEnv: 'XAI_API_KEY' },
};

export class ConfigError extends Error {}

export function parseConfig(
  raw: unknown,
  opts: { home: string; apiKey: string; env?: NodeJS.ProcessEnv },
): Config {
  const parsed = fileConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(`Invalid config: ${z.prettifyError(parsed.error)}`);
  }
  const env = opts.env ?? {};
  const file = parsed.data;
  const home = resolve(opts.home);

  if (env.SUNNIE_HOST) file.server.host = env.SUNNIE_HOST;
  if (env.SUNNIE_PORT) file.server.port = Number(env.SUNNIE_PORT);
  if (env.SUNNIE_MODEL) file.agent.defaultModel = env.SUNNIE_MODEL;
  if (env.SUNNIE_COMPUTER_USER) file.computer.user = env.SUNNIE_COMPUTER_USER;
  if (env.PLAYWRIGHT_BROWSERS_PATH) file.browser.browsersPath ??= env.PLAYWRIGHT_BROWSERS_PATH;
  if (env.SUNNIE_LOG_LEVEL) file.logLevel = env.SUNNIE_LOG_LEVEL as Config['logLevel'];
  if (env.SUNNIE_APNS_TEAM_ID && env.SUNNIE_APNS_KEY_ID) {
    file.push.apns = {
      keyEnv: 'SUNNIE_APNS_KEY',
      topic: 'com.yoursunnie.Sunnie',
      timeoutMs: 10_000,
      ...file.push.apns,
      teamId: env.SUNNIE_APNS_TEAM_ID,
      keyId: env.SUNNIE_APNS_KEY_ID,
    };
    if (env.SUNNIE_APNS_KEY_PATH) file.push.apns.keyPath = env.SUNNIE_APNS_KEY_PATH;
  }

  const workspace = resolve(env.SUNNIE_WORKSPACE ?? file.computer.workspace ?? join(home, 'workspace'));
  const browserClient = fileURLToPath(new URL('../browser/client.ts', import.meta.url));
  const skillsClient = fileURLToPath(new URL('../skills/client.ts', import.meta.url));

  return {
    ...file,
    providers: { ...BUILTIN_PROVIDERS, ...file.providers },
    computer: { ...file.computer, workspace },
    browser: { ...file.browser, command: file.browser.command ?? `${shq(process.execPath)} ${shq(browserClient)}` },
    skills: { ...file.skills, command: file.skills.command ?? `${shq(process.execPath)} ${shq(skillsClient)}` },
    home,
    dbPath: join(home, 'sunnie.db'),
    apiKey: opts.apiKey,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolve(env.SUNNIE_HOME ?? './data');
  const configPath = env.SUNNIE_CONFIG ? resolve(env.SUNNIE_CONFIG) : join(home, 'config.json');

  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Could not parse ${configPath}: ${(err as Error).message}`);
    }
  } else if (env.SUNNIE_CONFIG) {
    throw new ConfigError(`SUNNIE_CONFIG points to ${configPath}, which does not exist`);
  }

  const apiKey = env.SUNNIE_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'SUNNIE_API_KEY is not set. Generate one with `openssl rand -hex 32` and put it in .env',
    );
  }

  return parseConfig(raw, { home, apiKey, env });
}
