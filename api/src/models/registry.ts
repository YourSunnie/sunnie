import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, type EmbeddingModel, type JSONValue, type LanguageModel, type ToolSet } from 'ai';
import type { Config, ModelInfoConfig, ProviderConfig, ReasoningEffort } from '../config.ts';
import { badRequest } from '../util/errors.ts';

/** Assumed when a model has no `contextWindow` configured. Deliberately conservative. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Output cap for an Anthropic model with no `maxOutputTokens` configured. Claude's cap counts
 * thinking as well as the reply, and the SDK's own fallback for a model it does not know (4,096)
 * cuts a thoughtful step short; every current Claude model allows far more than this.
 */
const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** Provider options placed on one message or system prompt; the shape is the provider's. */
export type MessageProviderOptions = Record<string, Record<string, JSONValue>>;

/** Per-call settings a provider needs; spread straight into streamText / generateText. */
export interface ModelCallOptions {
  reasoning?: ReasoningEffort;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

/** A provider's own judgement of a tool call the model has written, where the provider offers one. */
export interface ToolVerdict {
  flagged: boolean;
  explanation?: string;
}

/**
 * How a provider's verdicts on a step's tool calls are read off its stream. The agent asks for
 * raw chunks and hands each one here; the shape of the chunk is this file's business.
 */
export interface VerdictReader {
  /**
   * The verdicts a raw chunk carries, by tool call id — the chunk that closes the message, so an
   * empty map means "the message is over and nothing was judged". Undefined for any other chunk.
   */
  fromRaw(raw: unknown): Map<string, ToolVerdict> | undefined;
}

export interface ResolvedModel {
  /** "<provider>/<model-id>" */
  spec: string;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  contextWindow: number;
  maxOutputTokens: number | undefined;
  /** Native inline attachment input; explicit model settings override transport defaults. */
  media?: { images: boolean; pdf: boolean };
  /**
   * For a provider that caches only where a request asks it to (Anthropic): the provider options
   * that mark "cache everything up to here" — one for the system prompt (also covering the tool
   * list, which the provider renders ahead of it) and one for the last message of a call, so the
   * next step of the turn reads the whole history from the cache. Absent for providers that cache
   * by themselves. The agent places them; what they contain is this file's business.
   */
  cacheMarks?: { system: MessageProviderOptions; message: MessageProviderOptions };
  /**
   * For a provider that takes operator notes as system messages inside the conversation
   * (Anthropic): the provider options such a note carries. The agent then sends its unstored
   * notes (a wrap-up, a restart) that way instead of inside the user's own message. Absent for
   * providers that take no such message.
   */
  systemNotes?: MessageProviderOptions;
  /**
   * Tools the provider runs itself for this model (an advisor), added to the agent's tool set as
   * they are: no gate, no router. Absent when none are configured.
   */
  providerTools?: ToolSet;
  /**
   * For a provider that judges the tool calls its model writes (Anthropic's dangerous-tool-use
   * safeguard): how to read its verdicts off the stream. The call options already ask for them.
   * Absent for providers without one, and when `approvals.providerCheck` is off.
   */
  verdicts?: VerdictReader;
  /**
   * Call settings for this model. `sessionId` identifies the conversation: providers use it to
   * keep every request of a conversation on the same backend, which is what makes prompt
   * caching hit.
   */
  callOptions(ctx: { sessionId: string }): ModelCallOptions;
  /**
   * Whether the tool router's decision has to reach this model as a note rather than as an
   * imposed tool choice. Shared by every resolution of the same spec and set by the agent the
   * first time the provider refuses a tool choice, so the refusal is paid for once per process.
   */
  steer: { byHint: boolean };
}

/** Turns texts into vectors whose closeness stands for closeness in meaning. */
export interface Embedder {
  /** "<provider>/<model-id>" */
  readonly spec: string;
  /** One vector per value, in the same order. Throws when the provider fails or `signal` aborts. */
  embed(values: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface ModelRegistry {
  readonly defaultSpec: string;
  resolve(spec?: string | null, reasoning?: ReasoningEffort | null): ResolvedModel;
  /** Throws when the provider is unknown, has no key, or offers no embedding models. */
  embedder(spec: string): Embedder;
  listProviders(): Array<{ id: string; type: string; configured: boolean }>;
  listModels(): Array<{ spec: string; contextWindow: number; isDefault: boolean }>;
}

type ModelFactory = (modelId: string) => LanguageModel;
type EmbeddingFactory = (modelId: string) => EmbeddingModel;
interface Provider {
  language: ModelFactory;
  /** Absent for a provider that has no embedding models. */
  embedding?: EmbeddingFactory;
  /** Absent for a provider without an advisor tool. */
  advisor?: (advisor: NonNullable<ModelInfoConfig['advisor']>) => ToolSet;
}

export function createModelRegistry(
  config: Pick<Config, 'providers' | 'models' | 'agent'> & { approvals?: Pick<Config['approvals'], 'providerCheck'> },
  env: NodeJS.ProcessEnv = process.env,
): ModelRegistry {
  const factories = new Map<string, Provider>();

  const apiKeyFor = (p: ProviderConfig) => p.apiKey ?? (p.apiKeyEnv ? env[p.apiKeyEnv] : undefined);

  const providerFor = (providerId: string): Provider => {
    const cached = factories.get(providerId);
    if (cached) return cached;

    const p = config.providers[providerId];
    if (!p) {
      const known = Object.keys(config.providers).join(', ');
      throw badRequest(`Unknown model provider "${providerId}". Configured providers: ${known}`);
    }
    const apiKey = apiKeyFor(p);
    // Local OpenAI-compatible servers (Ollama, llama.cpp, vLLM) legitimately run without a key.
    if (!apiKey && p.type !== 'openai-compatible') {
      throw badRequest(
        `Provider "${providerId}" has no API key. Set ${p.apiKeyEnv ?? 'providers.' + providerId + '.apiKey'}.`,
      );
    }

    const common = { apiKey, baseURL: p.baseURL, headers: p.headers };
    let factory: Provider;
    switch (p.type) {
      case 'openrouter':
        {
          const openrouter = createOpenRouter({ ...common, compatibility: 'strict' });
          factory = { language: openrouter, embedding: (id) => openrouter.textEmbeddingModel(id) };
        }
        break;
      case 'openai':
        {
          const openai = createOpenAI(common);
          factory = { language: openai, embedding: (id) => openai.embeddingModel(id) };
        }
        break;
      case 'google':
        {
          const google = createGoogle(common);
          factory = { language: google, embedding: (id) => google.embeddingModel(id) };
        }
        break;
      case 'anthropic': {
        const anthropic = createAnthropic(common);
        factory = {
          language: anthropic,
          advisor: (a) => ({ advisor: anthropic.tools.advisor_20260301({ model: a.model, maxUses: a.maxUses, maxTokens: a.maxTokens }) }),
        };
        break;
      }
      case 'deepseek':
        factory = { language: createDeepSeek(common) };
        break;
      case 'xai':
        factory = { language: createXai(common) };
        break;
      case 'openai-compatible': {
        if (!p.baseURL) throw badRequest(`Provider "${providerId}" needs a baseURL.`);
        const compatible = createOpenAICompatible({
          name: providerId,
          baseURL: p.baseURL,
          apiKey,
          headers: p.headers,
          includeUsage: true,
        });
        factory = { language: compatible, embedding: (id) => compatible.embeddingModel(id) };
        break;
      }
    }
    factories.set(providerId, factory);
    return factory;
  };

  /** The one place provider-specific request shaping lives; the agent never sees it. */
  const callOptionsFor = (spec: string, providerId: string, sessionId: string, override?: ReasoningEffort | null): ModelCallOptions => {
    const type = config.providers[providerId]?.type;
    const reasoning = override ?? config.models[spec]?.reasoning ?? config.agent.reasoning;
    const extra = config.models[spec]?.providerOptions ?? {};

    if (type === 'openrouter') {
      return {
        providerOptions: {
          openrouter: {
            // Sticky routing: same upstream provider — and, for router models, the same
            // resolved model — for the whole conversation, so its cached prefix is reused.
            session_id: sessionId,
            prompt_cache_key: sessionId,
            // Anthropic-family models only cache when asked to; others ignore this.
            cache_control: { type: 'ephemeral' },
            ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
            ...extra,
            ...(override ? { reasoning: { effort: override } } : {}),
          },
        },
      };
    }
    if (type === 'openai') {
      return { reasoning, providerOptions: { openai: { promptCacheKey: sessionId, ...extra } } };
    }
    if (type === 'anthropic') {
      return {
        providerOptions: {
          anthropic: {
            thinking: {
              // Current Claude models think adaptively (a fixed budget is refused); the summary is
              // asked for because the app shows reasoning as it streams — omitted, a step would look
              // stalled until its first word.
              type: 'adaptive',
              display: 'summarized',
              // A thinking block is tied to the exact prefix it was produced after. A note that
              // rides unstored behind one call (a wrap-up, a restart) changes that prefix for the
              // next, and Claude would refuse the whole request; dropping the block loses one
              // step's reasoning instead.
              blockBinding: { prefixMismatchBehavior: 'drop_block' },
            },
            // Effort is the one lever: thinking cannot be turned off on these models, so the
            // lowest settings map to the least thinking rather than none.
            ...(reasoning ? { effort: anthropicEffort(reasoning) } : {}),
            ...(config.agent.turnBudgetTokens ? { taskBudget: { type: 'tokens', total: config.agent.turnBudgetTokens } } : {}),
            // A second opinion on every tool call, beside the risk filter's; the provider only
            // judges tools it knows by name (`bash`). Its verdict comes back in the stream.
            ...(providerCheck ? { safeguards: [{ type: 'dangerous_tool_use' }] } : {}),
            ...extra,
          },
        },
      };
    }
    return {
      reasoning,
      ...(Object.keys(extra).length > 0 ? { providerOptions: { [providerId]: extra } } : {}),
    };
  };

  const providerCheck = config.approvals?.providerCheck ?? true;

  /** Anthropic's verdicts ride on the `message_delta` event that closes a message. */
  const ANTHROPIC_VERDICTS: VerdictReader = {
    fromRaw(raw) {
      const chunk = raw as {
        type?: string;
        delta?: {
          safeguard_results?: Array<{
            type?: string;
            status?: { tool_uses?: Record<string, { type?: string; outcome?: string | null; explanation?: string | null }> | null };
          }> | null;
        };
      } | null;
      if (chunk?.type !== 'message_delta') return undefined;
      const verdicts = new Map<string, ToolVerdict>();
      for (const result of chunk.delta?.safeguard_results ?? []) {
        if (result?.type !== 'dangerous_tool_use') continue;
        for (const [id, judged] of Object.entries(result.status?.tool_uses ?? {})) {
          if (judged?.type !== 'evaluated') continue;
          verdicts.set(id, { flagged: judged.outcome === 'flagged', ...(judged.explanation ? { explanation: judged.explanation } : {}) });
        }
      }
      return verdicts;
    },
  };

  /** Claude's effort levels, from the portable reasoning setting. */
  const anthropicEffort = (effort: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' =>
    effort === 'none' || effort === 'minimal' ? 'low' : effort;

  // The system prompt and tools are the same across a conversation and across the agent's
  // conversations with the same core memory, so they are kept for the longer hour; the tail of
  // the history is for the next step, moments away.
  const ANTHROPIC_CACHE_MARKS: NonNullable<ResolvedModel['cacheMarks']> = {
    system: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    message: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  };
  // A note is for the step it rides on: the next user message clears it by itself.
  const ANTHROPIC_SYSTEM_NOTES: MessageProviderOptions = { anthropic: { clearAt: 'next_user_message' } };

  const steering = new Map<string, { byHint: boolean }>();
  const steerOf = (spec: string) => {
    let steer = steering.get(spec);
    if (!steer) steering.set(spec, (steer = { byHint: config.models[spec]?.steer === 'hint' }));
    return steer;
  };

  const split = (full: string) => {
    const slash = full.indexOf('/');
    if (slash <= 0 || slash === full.length - 1) {
      throw badRequest(`Model must look like "<provider>/<model-id>", got "${full}"`);
    }
    return { providerId: full.slice(0, slash), modelId: full.slice(slash + 1) };
  };

  const contextWindowOf = (spec: string) => config.models[spec]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

  return {
    defaultSpec: config.agent.defaultModel,

    resolve(spec, reasoning) {
      const full = spec || config.agent.defaultModel;
      const { providerId, modelId } = split(full);
      const providerType = config.providers[providerId]?.type;
      const provider = providerFor(providerId);
      const advisor = config.models[full]?.advisor;
      if (advisor && !provider.advisor) throw badRequest(`Provider "${providerId}" has no advisor tool; remove "advisor" from models.${full}.`);
      return {
        spec: full,
        providerId,
        modelId,
        model: provider.language(modelId),
        contextWindow: contextWindowOf(full),
        maxOutputTokens: config.models[full]?.maxOutputTokens ?? (providerType === 'anthropic' ? ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS : undefined),
        media: {
          images: config.models[full]?.media?.images ?? true,
          // DeepSeek drops non-image files; xAI Responses needs a provider file reference.
          pdf: config.models[full]?.media?.pdf ?? (providerType !== 'deepseek' && providerType !== 'xai'),
        },
        ...(providerType === 'anthropic' ? { cacheMarks: ANTHROPIC_CACHE_MARKS, systemNotes: ANTHROPIC_SYSTEM_NOTES } : {}),
        ...(providerType === 'anthropic' && providerCheck ? { verdicts: ANTHROPIC_VERDICTS } : {}),
        ...(advisor && provider.advisor ? { providerTools: provider.advisor(advisor) } : {}),
        callOptions: ({ sessionId }) => callOptionsFor(full, providerId, sessionId, reasoning),
        steer: steerOf(full),
      };
    },

    embedder(spec) {
      const { providerId, modelId } = split(spec);
      const embedding = providerFor(providerId).embedding;
      if (!embedding) throw badRequest(`Provider "${providerId}" has no embedding models.`);
      const model = embedding(modelId);
      return {
        spec,
        async embed(values, signal) {
          // No retries here: the caller has a fallback and a turn waiting on it.
          const { embeddings } = await embedMany({ model, values, abortSignal: signal, maxRetries: 0 });
          if (embeddings.length !== values.length) throw new Error(`${spec} returned ${embeddings.length} embeddings for ${values.length} values`);
          return embeddings;
        },
      };
    },

    listProviders() {
      return Object.entries(config.providers).map(([id, p]) => ({
        id,
        type: p.type,
        configured: Boolean(apiKeyFor(p)) || (p.type === 'openai-compatible' && !p.apiKeyEnv),
      }));
    },

    listModels() {
      const specs = new Set([config.agent.defaultModel, ...Object.keys(config.models)]);
      return [...specs].map((spec) => ({
        spec,
        contextWindow: contextWindowOf(spec),
        isDefault: spec === config.agent.defaultModel,
      }));
    },
  };
}
