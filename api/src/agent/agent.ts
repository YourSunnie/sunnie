import { streamText, type ModelMessage, type ToolSet } from 'ai';
import { buildAttachmentContent } from '../attachments/content.ts';
import type { Computer } from '../computer/computer.ts';
import type { SkillClient } from '../skills/client.ts';
import type { SkillSources } from '../skills/sources.ts';
import { skillCatalogText, skillRepository } from '../../skills/protocol.ts';
import { AGENT_NAME, type Config } from '../config.ts';
import type { LoginStore } from '../logins/login-store.ts';
import type { CoreMemory } from '../memory/core-memory.ts';
import type { InterestStore } from '../memory/interests.ts';
import type { MemoryHit, MemoryStore } from '../memory/memory-store.ts';
import type { MessageProviderOptions, ModelRegistry, ResolvedModel, ToolVerdict } from '../models/registry.ts';
import {
  toModelMessage,
  type Conversation,
  type ConversationStore,
  type MessageOrigin,
  type MessageSearchHit,
  type NewMessage,
  type StoredMessage,
} from '../store/conversations.ts';
import type { RecallFilter } from '../router/recall.ts';
import { recallContext, recallMemories, recallQuery } from '../memory/recall.ts';
import type { SemanticRecall } from '../memory/semantic.ts';
import type { ProposedCall, RiskFilter, RiskVerdict } from '../router/risk.ts';
import { needsCaution, type SkillScreen } from '../router/skill-screen.ts';
import { explainSkill, type SkillReview } from '../skills/review.ts';
import type { InspectedSkill } from '../../skills/protocol.ts';
import type { LostAction, RunStore } from '../store/runs.ts';
import type { AttachmentStore } from '../store/attachments.ts';
import { applyRoute, type RouteDecision, type ToolRouter } from '../router/router.ts';
import type { TaskStore } from '../tasks/task-store.ts';
import type { HomeStore } from '../home/home-store.ts';
import type { CardStateStore } from '../home/card-store.ts';
import { repairCards } from './card-repair.ts';
import type { PhoneStore } from '../phone/phone-store.ts';
import { createBrowserTargets } from '../tools/browser-tools.ts';
import { LOOK_ONLY, createHelperTools, createTools } from '../tools/index.ts';
import { notFound } from '../util/errors.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import { compactConversation, contextBudget, estimateContextTokens } from './compaction.ts';
import { toMessageDto, toolOutputText, type Emit, type RunUsage } from './events.ts';
import { BRIEF_STEPS, checkBriefWidgetCall, checkResizeWidgetCall, RESIZE_STEPS } from './heartbeat.ts';
import { buildHelperInstructions, buildInstructions, buildSummaryBlock, buildUserContext } from './prompt.ts';
import { backoffMs, isTransient, pause } from './retry.ts';
import { messageHelper, runHelpers } from './subagents.ts';
import { quoteContext, type MessageQuote } from '../store/quotes.ts';
import { steerAttachmentIds, steerBatch } from './steers.ts';
import type { DriveClient } from '../drive/client.ts';
import type { WebSearch } from '../search/search.ts';
import type { BrowserHandoff, HandoffAsk } from '../browser/handoff.ts';

export interface AgentDeps {
  config: Config;
  conversations: ConversationStore;
  attachments: AttachmentStore;
  memory: MemoryStore;
  interests: InterestStore;
  core: CoreMemory;
  logins: LoginStore;
  tasks: TaskStore;
  home: HomeStore;
  /** What the user set in the interactive cards of replies. */
  cards: CardStateStore;
  phone: PhoneStore;
  runLog: RunStore;
  computer: Computer;
  drive: DriveClient;
  skills: SkillClient;
  skillSources: SkillSources;
  models: ModelRegistry;
  router: ToolRouter;
  /** Web search; absent when no search service is configured. */
  search?: WebSearch;
  risk: RiskFilter;
  recall: RecallFilter;
  /** Looks at a skill before it is installed. */
  skillScreen: SkillScreen;
  /** Recall by meaning; absent when no embedding model is usable, and recall is by keywords. */
  semantic?: SemanticRecall;
  /** The browser handed to the user, when it is: one for the whole server, as there is one browser. */
  handoff: BrowserHandoff;
  log: Logger;
}

export interface TurnInput {
  conversationId: string;
  runId: string;
  /** What the human sees as the message that opened the turn. */
  text: string;
  attachmentIds?: string[];
  quotes?: MessageQuote[];
  interestIds?: string[];
  /** A Home brief: like an interest check-in, it only looks things up, and it may write to Home. */
  brief?: boolean;
  /** A widget resize: like a brief, quiet, and it may only write that one widget. */
  resize?: { widgetId: string; columns: number };
  /** Instructions for the model placed ahead of `text`, for a turn the user did not start. */
  preamble?: string;
  /** Set when the turn was started by the system rather than by the user typing. */
  origin?: MessageOrigin;
  /** Overrides the conversation's model for this turn only. */
  model?: string | null;
  /** IANA zone of the user's device, so "now" reads in their local time. */
  timeZone?: string;
  /**
   * The turn was begun by an earlier process and is being picked up after a restart: what it has
   * stored stays, and it goes on from there.
   */
  resumed?: boolean;
  signal: AbortSignal;
  emit: Emit;
  /**
   * Asks the user whether a held tool call may run, and waits for the answer. Without it
   * there is nobody to ask, so a held call is declined.
   */
  confirm?: (call: ProposedCall) => Promise<boolean | 'unanswered'>;
  /**
   * Asks the user to take the browser over for a moment, and waits for them to hand it back.
   * Without it there is nobody to ask, and the agent has no `browser_handoff` tool.
   */
  handoff?: HandoffAsk;
}

export interface TurnResult {
  status: 'completed' | 'cancelled';
  finishReason: string;
  steps: number;
  usage: RunUsage;
}

/**
 * Provider prompt caches are gone after this much silence, so that is the free moment to
 * rebuild the system prompt from live core memory.
 */
const CACHE_IDLE_MS = 30 * 60 * 1000;

/** Which upstream actually served a step, when the provider reports it (OpenRouter does). */
function upstreamOf(metadata: Record<string, Record<string, unknown>> | undefined): string | undefined {
  for (const entry of Object.values(metadata ?? {})) {
    if (typeof entry?.provider === 'string') return entry.provider;
  }
  return undefined;
}

/** The check-in interval to state in the system prompt; undefined when the heartbeat is off. */
export function heartbeatMinutes(config: Config): number | undefined {
  return config.heartbeat.enabled ? config.heartbeat.intervalMinutes : undefined;
}

/** The helper limits to state in the system prompt; undefined when helpers are off. */
export function helperLimit(config: Config): { tasks: number; steps: number } | undefined {
  return config.subagents.enabled ? { tasks: config.subagents.maxTasks, steps: config.subagents.maxSteps } : undefined;
}

/** What an automatic interest check-in may call: looking things up, nothing else. */
const DIGEST_TOOLS = ['web_search', 'web_fetch', 'browser_open', 'browser_read', 'memory_search', 'conversation_search', 'skill_list', 'skill_read'];

/**
 * How long a gated call waits for the provider's verdict on it. The verdict closes the message the
 * call came in, moments after the call itself; this only bounds a stream that never gets there.
 */
const VERDICT_WAIT_MS = 30_000;

/** What the user is shown when a model ends a turn without writing anything, twice. */
const EMPTY_REPLY = '(I finished the steps above without writing a reply. Ask me to sum up if you need it.)';

/** The model answered without the tool it was forced to; the AI SDK rejects such an answer. */
function isToolChoiceViolation(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'AI_ToolChoiceViolationError';
}

/**
 * The provider refused the request over its tool choice — Z.AI: "Tool choice must be auto, none,
 * or required"; Meta: "only \"auto\" is supported for tool_choice".
 */
function isToolChoiceRefusal(err: unknown): boolean {
  return !isToolChoiceViolation(err) && /tool.?choice/i.test((err as { message?: string } | undefined)?.message ?? '');
}

/**
 * The router's decision as a note, for a model whose provider accepts no imposed tool choice.
 * Like the wrap-up note it is sent, never stored.
 */
function steerNote(decision: RouteDecision): string | undefined {
  if (decision.kind === 'tool') {
    return (
      `[Automatic note, not written by the user] The next step has been chosen for you: call the \`${decision.tool}\` tool now. ` +
      'Use a different tool only if this one cannot do what is needed.'
    );
  }
  if (decision.kind === 'respond') {
    return '[Automatic note, not written by the user] The next step has been chosen for you: reply to the user now. No tool can be called in this step.';
  }
  return undefined;
}

/**
 * Puts a note behind the messages of one call. A provider that takes operator notes as system
 * messages in the conversation (`systemNotes`) gets it that way, apart from the user's own words;
 * elsewhere it joins a closing user message rather than follow it, because some providers reject
 * two user messages in a row.
 */
function withNote(messages: ModelMessage[], note: string | undefined, systemNotes?: MessageProviderOptions): ModelMessage[] {
  if (!note) return messages;
  if (systemNotes) return [...messages, { role: 'system', content: note, providerOptions: systemNotes }];
  const last = messages.at(-1);
  if (last?.role !== 'user') return [...messages, { role: 'user', content: note }];
  const parts = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
  return [...messages.slice(0, -1), { role: 'user', content: [...parts, { type: 'text', text: note }] }];
}

/**
 * Marks the last message of a call for a provider that caches only where asked (the model's
 * `cacheMarks`): the whole history up to it is then read from the cache by the next step. The
 * stored message is untouched; the mark lives on the copy that goes out.
 */
function markTail(messages: ModelMessage[], mark: MessageProviderOptions | undefined): ModelMessage[] {
  const last = messages.at(-1);
  if (!mark || !last) return messages;
  return [...messages.slice(0, -1), { ...last, providerOptions: { ...last.providerOptions, ...mark } } as ModelMessage];
}

/**
 * Drops from the outgoing copy of the history the calls and results of provider-run tools that
 * are not in this call's tool set: a provider refuses a transcript that names a tool it was not
 * given (an advisor turned off after it was used). Stored content is untouched.
 */
export function withoutStaleProviderTools(messages: ModelMessage[], tools: ToolSet): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return m;
    const parts = m.content as Array<{ type: string; toolName?: string; toolCallId?: string; providerExecuted?: boolean }>;
    // The result of such a call sits beside it in the same message, with the same id.
    const stale = new Set(parts.filter((p) => p.type === 'tool-call' && p.providerExecuted && p.toolName && !(p.toolName in tools)).map((p) => p.toolCallId));
    if (stale.size === 0) return m;
    const kept = parts.filter((p) => !((p.type === 'tool-call' || p.type === 'tool-result') && stale.has(p.toolCallId)));
    return { ...m, content: kept } as ModelMessage;
  });
}

/** How long an aborted model stream gets to end by itself. */
const ABORT_GRACE_MS = 1_000;

/** Passages of earlier conversations attached to a message that calls for a recall. */
const HISTORY_RECALL = 5;

const STEP_LIMIT_NOTE =
  '(I reached my step limit for this turn before finishing. Say "continue" and I will pick up where I left off.)';

/**
 * What the model is told when the turn's steps are used up. It is not stored: it rides behind
 * the stored messages on one call, so the cached prefix is untouched and history stays as it was.
 */
const WRAP_UP =
  '[Automatic note, not written by the user] You have used all the steps you have for this turn, and no more tools ' +
  'can be called. Reply to the user now: what you found or finished, what you tried that did not work, and what is ' +
  'still open. If more work is needed, tell them they can say "continue".';

/**
 * Stored ahead of a message the user sent while the agent was at work, as part of what the model
 * sees of it (not of what the user sees).
 */
const STEERED =
  '[Automatic note, not written by the user] The user sent the following while you were working on the above. ' +
  'Take it into account from here on: it may add to what you are doing, change it, or call it off.';

const DECLINED =
  'The user declined this action, so it was not run. Do not retry it or reach the same result another way. ' +
  'Tell the user it was not done and ask how they would like to proceed.';

/** The same two notes for a helper, whose reader is the agent that sent it. */
const HELPER_WRAP_UP =
  '[Automatic note] You have used all the steps you have, and no more tools can be called. Write your report now: ' +
  'what you found, what you tried that did not work, and what is still open.';

const HELPER_DECLINED =
  'This action needs the user\'s go-ahead, which only the agent you report to can get, so it was not run. Do not ' +
  'retry it or reach the same result another way. Finish what you can without it, and say in your report exactly ' +
  'what is waiting, so that it can be taken from there.';

/**
 * Not every model honours "no tools in this step" (Gemini through OpenRouter calls one anyway).
 * The decision to reply is then enforced here, where the call would run.
 */
const REPLY_ONLY =
  'No tool can be used in this step, so this call was not run. Reply to the user now with what you have: ' +
  'what you found, what you tried, and what is still open.';

/**
 * A check-in asked for a go-ahead while nobody was there, and other follow-ups were waiting
 * behind it. Not the user's no, so the model must not report it as one.
 */
const UNANSWERED =
  'This action needs the user\'s go-ahead. Nobody answered in time and other reminders were waiting, so it was ' +
  'not run. Do not retry it or reach the same result another way. Tell the user briefly what is waiting for their ' +
  'OK; this check-in comes round again by itself, so do not reschedule it.';

/**
 * The abort reason of a turn that is stopped only because the server is: it is picked up again
 * at the next start, so it must not leave a half-said answer behind as its last message.
 */
export const INTERRUPTED = new Error('The server is shutting down');

const clipInput = (input: unknown) => {
  const text = JSON.stringify(input) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

/**
 * What a turn picked up after a restart is told about the step that was lost. Like the wrap-up
 * note it is sent, never stored, so it has to ride on every call of the turn. It asks for the
 * check only on the first of them: seen live, a model that reads "check before repeating" on
 * every step checks on every step and never gets back to the task.
 */
function interruptedNote(lost: LostAction[], first: boolean): string | undefined {
  if (lost.length === 0) return undefined;
  const lines = lost.map(
    (a) => `- ${a.name} ${clipInput(a.input)} — ${a.finished ? 'finished, but its result was lost' : 'had started; it may or may not have finished'}`,
  );
  const head =
    '[Automatic note, not written by the user] The server restarted in the middle of this turn, and the step in ' +
    `progress was lost. In that step you had already begun:\n${lines.join('\n')}\n`;
  return first
    ? `${head}Do not repeat one blindly: first check, once, how much of it took effect.`
    : `${head}You have looked at what is there since (your steps above). Do not check again, and do not redo what is ` +
        'already there: do only the part that is still missing, then finish what the user asked.';
}

/** A promise with its resolver at hand. */
function settled<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Puts a gate in front of every tool's `execute`. Only `execute` is wrapped: names,
 * descriptions and schemas — everything the model and the prompt cache see — stay as they are.
 */
function gateTools(
  tools: ToolSet,
  gate: (call: ProposedCall) => Promise<void>,
  journal?: { started(call: ProposedCall): void; finished(toolCallId: string): void },
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      const gated: typeof execute = async (input, options) => {
        const call = { toolCallId: options.toolCallId, name, input };
        await gate(call);
        if (!journal || LOOK_ONLY.has(name)) return execute(input, options);
        journal.started(call);
        try {
          return await execute(input, options);
        } finally {
          journal.finished(call.toolCallId);
        }
      };
      return [name, { ...tool, execute: gated }];
    }),
  ) as ToolSet;
}

/** What the model sees: the rolling summary, then every message not yet folded into it. */
export function buildContextMessages(conversation: Conversation, live: StoredMessage[]): ModelMessage[] {
  const messages = live.map(toModelMessage);
  if (!conversation.summary) return messages;

  const summary = { type: 'text' as const, text: buildSummaryBlock(conversation.summary) };
  const first = messages[0];
  if (first?.role === 'user') {
    // Fold into the first user message: some providers reject two user messages in a row.
    const parts = typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : first.content;
    messages[0] = { role: 'user', content: [summary, ...parts] };
  } else {
    messages.unshift({ role: 'user', content: [summary] });
  }
  return messages;
}

function assistantText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('');
}

/**
 * Runs one user turn: persist the message, then call the model in a loop — executing its tool
 * calls and compacting when the context fills — until it answers without asking for a tool.
 *
 * Each model step is persisted atomically after it finishes, so stored history never contains
 * a tool call without its result.
 */
export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnResult> {
  const { config, conversations, attachments, memory, core, logins, tasks, runLog, computer, models, router, risk, recall, log } = deps;
  const { conversationId, runId, signal, emit } = input;

  const initial = conversations.get(conversationId);
  if (!initial) throw notFound('Conversation');
  const model = models.resolve(input.model ?? initial.model, initial.reasoning);
  const uploaded = attachments.resolve(input.attachmentIds);
  const prepareAttachments = (files: typeof uploaded) => buildAttachmentContent(
    computer,
    files.map((file) => ({ ...file, data: attachments.getBytes(file.id)!, preview: attachments.getPreview(file.id) ?? undefined })),
    signal,
    model.media,
  );
  // A helper's turn is this same loop on a smaller prompt, a smaller tool set and fewer steps.
  const helper = initial.kind === 'subagent';
  // Interest check-ins and Home briefs are digests: read-only, quiet unless they find something.
  let digest = !!input.interestIds?.length || !!input.brief || !!input.resize;
  const digestTools = input.resize ? ['home_widget', 'home_list']
    : input.brief ? [...DIGEST_TOOLS, 'home_widget', 'home_list', 'task_list', 'phone_data'] : DIGEST_TOOLS;
  let maxSteps = helper ? config.subagents.maxSteps
    : digest ? Math.min(input.resize ? RESIZE_STEPS : input.brief ? BRIEF_STEPS : 8, config.agent.maxSteps) : config.agent.maxSteps;
  // A run interrupted before it stored its opening message has nothing to go on from: it starts over.
  const ownMessages = input.resumed ? conversations.messagesForRun(runId).filter((m) => m.conversationId === conversationId) : [];
  const resuming = ownMessages.length > 0;
  if (ownMessages.some((m) => m.role === 'user' && !m.origin)) {
    digest = false;
    maxSteps = helper ? config.subagents.maxSteps : config.agent.maxSteps;
  }
  const lost = resuming ? runLog.lostActions(runId) : [];
  /** Steps this process has stored for the turn; the restart note changes once there is one. */
  let stepsStored = 0;

  // Refresh the prompt's view of core memory only when no warm cache is at stake: on the first
  // turn, or after a long pause. (Compaction refreshes it too — it rewrites the prefix anyway.)
  const idleMs = Date.now() - Date.parse(initial.updatedAt);
  if (!resuming && (!initial.coreSnapshot || idleMs > CACHE_IDLE_MS)) {
    conversations.setCoreSnapshot(conversationId, core.all());
  }

  // Whether to recall at all is the recall filter's decision; what is recalled is settled here.
  // It is stored with the message for good, so it is kept small. With an embedding model: the
  // memories nearest in meaning to the message and the turns before it. Without one, or when it
  // does not answer in time: the best keyword matches,
  // (of the message, and of the turns just before it when the message says little), topped up —
  // when the filter judged the message itself — with the most recently touched memories
  // (keywords alone miss what is relevant without sharing a word) and with the passages of
  // earlier conversations the message seems to be about.
  // A helper gets no recall: its task holds what it needs, written by the agent that has the memory.
  // Nor does a turn that is picked up again: what was attached is stored with its message.
  const limit = helper || resuming ? 0 : config.memory.recallLimit;
  let recalled: MemoryHit[] = [];
  let history: MessageSearchHit[] = [];
  if (limit > 0) {
    const before = conversations.liveMessages(initial);
    if (recall.judges) {
      history = conversations
        .searchMessages(input.text, { limit: HISTORY_RECALL * 6 })
        .filter((h) => h.conversationId !== conversationId)
        .slice(0, HISTORY_RECALL);
    }
    const ask = () => recall.needed({ text: input.text, summary: initial.summary, messages: before, signal });
    const byKeywords = () =>
      recallMemories(memory, { text: input.text, context: recallContext(before), limit, topUp: recall.judges });

    let matches: MemoryHit[];
    let matched: number;
    let wanted: boolean;
    if (deps.semantic && memory.count() > 0) {
      // By meaning there is always something nearest, so the decision is asked for while the
      // message is being embedded rather than after: the two waits overlap.
      const [nearest, yes] = await Promise.all([deps.semantic.search(recallQuery(before, input.text), limit, signal), ask()]);
      ({ memories: matches, matched } = nearest ? { memories: nearest, matched: nearest.length } : byKeywords());
      wanted = yes && matches.length + history.length > 0;
    } else {
      ({ memories: matches, matched } = byKeywords());
      // Nothing to attach, nothing to ask: the decision is only requested when it changes something.
      wanted = matches.length + history.length > 0 && (await ask());
    }
    if (wanted) {
      recalled = matches;
      // A top-up was attached for being recent, not for fitting: it does not count as a recall.
      memory.markRecalled(matches.slice(0, matched).map((m) => m.id));
    } else history = [];
  }
  const skillContext = async () => {
    if (!config.skills.enabled) return undefined;
    try { return skillCatalogText(await deps.skills.list(signal)); }
    catch (error) {
      if (signal.aborted) throw error;
      log.warn('skill discovery failed; continuing without the catalog', { error: errorMessage(error) });
      return 'The skill catalog could not be loaded. Use skill_list if this task needs an installed skill.';
    }
  };
  const context = buildUserContext({
    now: new Date(), timeZone: input.timeZone, recalled, history,
    skills: resuming ? undefined : await skillContext(),
    interests: helper || resuming ? undefined : deps.interests.context(),
    cards: helper || resuming ? undefined : deps.cards.takeChanges(conversationId) ?? undefined,
  });

  const persist = (messages: NewMessage[], alongside?: () => void): StoredMessage[] => {
    const stored = conversations.appendMessages(
      conversationId,
      messages.map((m) => ({ ...m, runId, model: m.role === 'user' ? null : (m.model ?? model.spec) })),
      () => {
        runLog.stepStored(runId);
        alongside?.();
      },
    );
    for (const m of stored) emit({ type: 'message', message: toMessageDto(m) });
    return stored;
  };

  if (!resuming) {
    const attachmentContent = uploaded.length ? await prepareAttachments(uploaded) : [];
    persist([
      {
        role: 'user',
        content: [
          { type: 'text', text: context },
          ...(input.preamble ? [{ type: 'text' as const, text: input.preamble }] : []),
          ...attachmentContent,
          ...(input.quotes?.length ? [{ type: 'text' as const, text: quoteContext(input.quotes) }] : []),
          { type: 'text', text: input.text },
        ],
        text: input.text,
        attachments: uploaded,
        quotes: input.quotes,
        origin: input.origin,
      },
    ]);
  }
  if (!initial.title) {
    const title = input.text.trim() || input.quotes?.[0]?.title || uploaded.map((file) => file.filename).join(', ');
    conversations.update(conversationId, { title: title.replace(/\s+/g, ' ').trim().slice(0, 80) });
  }

  /** Whether the step in progress is one in which the agent was told to reply, not to act. */
  let replyOnly = false;
  /** What the step in progress was called with; the risk filter judges a call against it. */
  let seen: { summary: string | null; messages: StoredMessage[] } = { summary: null, messages: [] };
  /**
   * The provider's verdicts on the step's tool calls, once its stream has delivered them. Reset
   * for every step; settled empty when the stream ends without any.
   */
  let stepVerdicts = settled<Map<string, ToolVerdict>>();
  const providerVerdict = async (toolCallId: string): Promise<ToolVerdict | undefined> => {
    if (!model.verdicts) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), VERDICT_WAIT_MS);
      timer.unref();
    });
    const verdicts = await Promise.race([stepVerdicts.promise, giveUp]).finally(() => clearTimeout(timer));
    return verdicts?.get(toolCallId);
  };
  const usage: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const declined = helper ? HELPER_DECLINED : DECLINED;
  /** Helpers this turn has sent. A cancelled turn waits for them to stop before it is over. */
  const helpersAtWork: Array<Promise<unknown>> = [];
  const atWork = (work: Promise<string>) => {
    helpersAtWork.push(work.catch(() => {}));
    return work;
  };
  const sending = { parentId: conversationId, model: model.spec, timeZone: input.timeZone, signal, emit, usage };
  const targetOf = config.browser.enabled
    ? createBrowserTargets({ computer, logins, config: config.browser, session: helper ? conversationId : undefined })
    : undefined;
  /**
   * Reads the skill a `skill_install` call names and has Jev screen it; when someone will be asked
   * (`explain`, or the screen finds something), writes what they are shown. The install is pinned
   * to the commit that was read, so what was reviewed is what is installed.
   */
  const reviewSkillCall = async (call: ProposedCall, explain: boolean): Promise<SkillReview | undefined> => {
    const { repository, path, ref, why = '' } = call.input as { repository: string; path: string; ref?: string; why?: string };
    let skill: InspectedSkill;
    try {
      skill = await deps.skills.inspect(repository, path, ref, signal);
    } catch {
      // The install would fail the same way and say why; there is nothing to review.
      return undefined;
    }
    deps.skills.pin(call.toolCallId, skill.source.commit);
    const screening = await deps.skillScreen.screen({ ...seen, skill, why, signal });
    const caution = needsCaution(screening);
    if (!explain && !caution) return undefined;
    return explainSkill({ model, skill, why, screening, caution, sessionId: conversationId, log, signal });
  };
  const tools = gateTools(
    helper
      ? createHelperTools({ config, computer, logins, conversationId, skills: deps.skills, search: deps.search, images: model.media?.images })
      : createTools({
          config,
          computer,
          skills: deps.skills,
          search: deps.search,
          skillSources: deps.skillSources,
          memory,
          interests: deps.interests,
          core,
          logins,
          tasks,
          home: deps.home,
          phone: deps.phone,
          drive: deps.drive,
          conversations,
          conversationId,
          timeZone: input.timeZone,
          images: model.media?.images,
          handoff: deps.handoff,
          askHandoff: input.handoff,
          helpers: config.subagents.enabled
            ? {
                delegate: (list, { toolCallId, allowQuestions }) =>
                  atWork(runHelpers(deps, runTurn, { ...sending, toolCallId, tasks: list, allowQuestions })),
                message: (id, message, { toolCallId }) =>
                  atWork(messageHelper(deps, runTurn, { ...sending, toolCallId, helper: id, message })),
              }
            : undefined,
        }),
    async (proposed) => {
      if (replyOnly) throw new Error(REPLY_ONLY);
      if (digest && !digestTools.includes(proposed.name)) {
        throw new Error(input.resize
          ? 'This resize may only write the widget again with home_widget. Write it, then reply NOTHING_TO_SHARE.'
          : input.brief
          ? 'This Home brief may only look things up and write widgets to Home. Write what you found, then reply NOTHING_TO_SHARE.'
          : 'This automatic interest check permits read-only research only. Share what you found or reply NOTHING_TO_SHARE.');
      }
      if (digest && input.brief && proposed.name === 'home_widget') checkBriefWidgetCall(deps.home, proposed.input);
      if (digest && input.resize && proposed.name === 'home_widget') checkResizeWidgetCall(input.resize, proposed.input);
      // A ref is all a browser call says about its element; the filter and the user get the element itself.
      const target = await targetOf?.(proposed, signal);
      const call: ProposedCall = target ? { ...proposed, target } : proposed;
      // An element nobody could name is a call the filter cannot judge: its ref alone reads as harmless.
      // The provider's own verdict, where there is one, is waited for alongside: either opinion holds the call.
      const [filtered, provider] = await Promise.all([
        target === null && risk.name !== 'none'
          ? Promise.resolve<RiskVerdict>(config.approvals.onError === 'ask' ? { confirm: true, reason: 'filter-unavailable' } : { confirm: false })
          : risk.assess({ ...seen, call, tools, signal }),
        providerVerdict(call.toolCallId),
      ]);
      const verdict: RiskVerdict = provider?.flagged && !filtered.confirm
        ? { confirm: true, risk: filtered.risk, reason: 'flagged', explanation: provider.explanation }
        : provider?.flagged ? { ...filtered, explanation: provider.explanation } : filtered;
      const repository = call.name === 'skill_install'
        ? skillRepository((call.input as { repository: string }).repository) : undefined;
      const needsTrust = repository !== undefined && !deps.skillSources.has(repository);
      // A skill is read and screened before anyone decides on it, and the person deciding is told
      // in plain words what it is: a repository and a path mean nothing to most people.
      const review = call.name === 'skill_install' ? await reviewSkillCall(call, needsTrust || verdict.confirm) : undefined;
      if (!verdict.confirm && !needsTrust && !review?.caution) return;
      emit({
        type: 'tool.approval.requested', ...call, ...(review ? { review } : {}), risk: verdict.risk,
        reason: needsTrust ? 'untrusted-skill-source' : verdict.confirm ? verdict.reason : review?.caution ? 'skill-caution' : undefined,
        ...(verdict.explanation ? { explanation: verdict.explanation } : {}),
      });
      const answer = (await input.confirm?.(call)) ?? false;
      const approved = answer === true;
      // A cancelled run answers for the user; that is not their decision to report.
      if (!signal.aborted) {
        emit({ type: 'tool.approval.resolved', toolCallId: call.toolCallId, approved, ...(answer === 'unanswered' ? { reason: 'unanswered' as const } : {}) });
      }
      if (answer === 'unanswered' && !signal.aborted) throw new Error(UNANSWERED);
      if (!approved || signal.aborted) throw new Error(declined);
      if (needsTrust) deps.skillSources.trust(repository!);
    },
    // A helper only looks things up, and its run is not one a restart picks up again.
    helper ? undefined : { started: (call) => runLog.actionStarted(runId, call), finished: (id) => runLog.actionFinished(runId, id) },
  );
  // The router and the risk filter see the agent's own tools; what the provider runs itself is only sent.
  const allTools: ToolSet = { ...tools, ...(helper ? {} : model.providerTools) };
  /** Steps taken before the user last steered the turn; the count starts over with each such message. */
  let stepsBefore = 0;
  const result = (status: TurnResult['status'], finishReason: string, steps: number): TurnResult => ({
    status,
    finishReason,
    steps: stepsBefore + steps,
    usage,
  });

  // A step that answers without a tool ends the turn, so a turn whose last stored message is the
  // assistant's was over; only the run had not been told.
  if (resuming && ownMessages.at(-1)!.role === 'assistant') return result('completed', 'stop', 0);

  // Deep reasoning can be silent for minutes; anything else that quiet has stopped answering.
  const effort = initial.reasoning ?? config.agent.reasoning;
  const stallMs = config.agent.stallTimeoutMs * (effort === 'high' || effort === 'xhigh' ? 2 : 1);
  let retries = 0;
  /** The one tool the previous step of this turn called, if it called exactly one. */
  let previousTool: string | undefined;
  /** Steps in a row, up to now, whose tool calls failed — not counting ones the user declined. */
  let failuresInARow = 0;
  /**
   * Set once a model has shown that it cannot be steered: the router's decisions are then
   * advice for the rest of the turn. A router may never fail a turn — nor may enforcing it.
   */
  let unsteerable = false;
  /** Whether the step is being repeated because the model answered with nothing at all. */
  let emptyRetried = false;
  // One call beyond the limit, without tools: a turn that runs out of steps ends with the agent's
  // own account of where it stands rather than mid-task.
  for (let step = 1; step <= maxSteps + 1; step++) {
    // What the user sent meanwhile joins here, between two steps: it is stored as their next
    // message and the turn goes on with it in view. Not behind another user message (some
    // providers reject two in a row) — then it waits for the step in between.
    const steers = helper ? [] : steerBatch(runLog.pendingSteers(runId), attachments);
    if (steers.length > 0 && conversations.listMessages(conversationId, { limit: 1 }).at(-1)?.role !== 'user') {
      const said = steers.map((s) => s.text).filter(Boolean).join('\n\n');
      const zone = steers.findLast((s) => s.timeZone)?.timeZone ?? input.timeZone;
      const files = attachments.resolve(steerAttachmentIds(steers));
      const quotes = steers.flatMap((s) => s.quotes ?? []);
      const attachmentContent = files.length ? await prepareAttachments(files) : [];
      persist(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildUserContext({ now: new Date(), timeZone: zone, recalled: [], skills: await skillContext(), interests: deps.interests.context() }) },
              { type: 'text', text: STEERED },
              ...attachmentContent,
              ...(quotes.length ? [{ type: 'text' as const, text: quoteContext(quotes) }] : []),
              { type: 'text', text: said },
            ],
            text: said,
            attachments: files,
            quotes,
          },
        ],
        () => runLog.takeSteers(steers),
      );
      digest = false;
      maxSteps = config.agent.maxSteps;
      // A new message is a new piece of work: it gets the steps of one.
      stepsBefore += step - 1;
      step = 1;
      failuresInARow = 0;
      previousTool = undefined;
      emptyRetried = false;
    }
    const wrapUp = step > maxSteps;
    // Re-read every step: compaction moves the summary and refreshes the core snapshot.
    const instructionsFor = (c: Conversation) => {
      const common = {
        name: AGENT_NAME,
        computer,
        browser: config.browser.enabled,
        search: deps.search !== undefined,
        skills: config.skills.enabled,
        maxAttempts: config.agent.maxAttempts,
        maxSteps: helper ? config.subagents.maxSteps : config.agent.maxSteps,
        blocks: c.coreSnapshot ?? core.all(),
      };
      return helper
        ? buildHelperInstructions(common)
        : buildInstructions({ ...common, heartbeatMinutes: heartbeatMinutes(config), helpers: helperLimit(config), advisor: Boolean(model.providerTools?.advisor) });
    };
    let conversation = conversations.get(conversationId)!;
    let live = conversations.liveMessages(conversation);

    const contextTokens = estimateContextTokens(conversation, live, instructionsFor(conversation));
    if (contextTokens > contextBudget(config, model)) {
      try {
        const compacted = await compactConversation(deps, conversation, model, { signal, emit, contextTokens });
        if (compacted) {
          conversation = conversations.get(conversationId)!;
          live = conversations.liveMessages(conversation);
        }
      } catch (err) {
        // The budget is a soft limit, well inside the model's real window: a summariser that is
        // down should not take the user's turn down with it. Compaction is retried next step.
        if (signal.aborted) return result('cancelled', 'cancelled', step);
        log.warn('compaction failed; continuing uncompacted', { runId, error: errorMessage(err) });
        emit({ type: 'compaction.failed', error: errorMessage(err) });
      }
    }
    const instructions = instructionsFor(conversation);
    if (model.media && live.some((message) => Array.isArray(message.content) && message.content.some((part) =>
      part.type === 'file' && ((part.mediaType.startsWith('image/') && !model.media!.images) || (part.mediaType === 'application/pdf' && !model.media!.pdf)),
    ))) {
      throw new Error('This conversation contains media that the selected model is not configured to read. Choose a compatible model or start a new conversation.');
    }
    seen = { summary: conversation.summary, messages: live };

    // The router decides which tool (if any) comes next; the model fills in the arguments.
    const known = [...Object.values(core.all()), ...recalled.map((m) => m.content)];
    let decision: RouteDecision = wrapUp
      ? { kind: 'respond', confidence: 1 }
      : await router.route({ summary: conversation.summary, messages: live, tools, known, signal });
    // The router picks a tool, not its arguments, and judges from a clipped view of the results.
    // Sending the agent to the tool it has just used is where that goes wrong — seen live: the
    // same page read three times over. So the second time in a row the language model decides.
    if (decision.kind === 'tool' && decision.tool === previousTool) {
      decision = { kind: 'auto', reason: 'repeat', leaning: decision.tool, confidence: decision.confidence };
    }
    // Right after a failure the router tends to call the task over. Whether there is another way
    // is the language model's call (its prompt says how hard to try), until the attempts it is
    // given are used up; from then on the router may end the turn again.
    if (decision.kind === 'respond' && failuresInARow > 0 && failuresInARow < config.agent.maxAttempts) {
      decision = { kind: 'auto', reason: 'after-failure', confidence: decision.confidence };
    }
    if (unsteerable && decision.kind !== 'auto' && !wrapUp) {
      decision = {
        kind: 'auto',
        reason: 'not-followed',
        leaning: decision.kind === 'tool' ? decision.tool : undefined,
        confidence: decision.confidence,
      };
    }
    const steered = decision.kind !== 'auto';
    const byHint = model.steer.byHint;
    replyOnly = decision.kind === 'respond';
    if (router.name !== 'none' && !wrapUp) {
      emit({
        type: 'route',
        router: router.name,
        decision: decision.kind,
        tool: decision.kind === 'tool' ? decision.tool : decision.kind === 'auto' ? decision.leaning : undefined,
        confidence: decision.confidence,
        reason: decision.kind === 'auto' ? decision.reason : undefined,
      });
    }

    // A provider can accept a request and then go quiet without closing the connection. Nobody
    // may be watching (a check-in), so the call is given up on rather than waited for. The clock
    // stops while tools run: a long command or a held approval is not the model stalling.
    const stall = new AbortController();
    let stalled = false;
    let runningTools = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const watch = () => {
      clearTimeout(stallTimer);
      if (runningTools > 0) return;
      stallTimer = setTimeout(() => {
        stalled = true;
        stall.abort();
      }, stallMs);
    };
    watch();
    const aborting = AbortSignal.any([signal, stall.signal]);

    stepVerdicts = settled();
    const stream = streamText({
      model: model.model,
      // Only a provider with verdicts to read has its raw chunks looked at.
      includeRawChunks: Boolean(model.verdicts),
      instructions: model.cacheMarks ? { role: 'system', content: instructions, providerOptions: model.cacheMarks.system } : instructions,
      // The cache mark goes on the last stored message, so a note behind it never has it.
      messages: withNote(
        markTail(withoutStaleProviderTools(buildContextMessages(conversation, live), allTools), model.cacheMarks?.message),
        [interruptedNote(lost, stepsStored === 0), wrapUp ? (helper ? HELPER_WRAP_UP : WRAP_UP) : byHint ? steerNote(decision) : undefined].filter(Boolean).join('\n\n') || undefined,
        model.systemNotes,
      ),
      allowSystemInMessages: Boolean(model.systemNotes),
      tools: allTools,
      // A model steered by notes gets no tool choice at all: its provider would refuse the call.
      ...(byHint ? {} : applyRoute(decision, config.router.mode, tools)),
      ...model.callOptions({ sessionId: conversationId }),
      abortSignal: aborting,
      temperature: config.agent.temperature,
      maxOutputTokens: model.maxOutputTokens,
      // Errors are taken from the stream below; the default handler would only log them again.
      onError: () => {},
    });

    let text = '';
    let failure: { error: unknown } | undefined;
    let aborted = false;
    /** Whether the client has been shown anything from this attempt. */
    let produced = false;
    /** Whether a tool has run in this attempt; after that the step can no longer be repeated. */
    let toolsRan = false;
    let calledTool = false;
    // Abort is a request the provider's stream is expected to honour by ending. One that does
    // not would leave this loop waiting for ever, so after a moment it stops listening.
    const parts = stream.stream[Symbol.asyncIterator]();
    const abandoned = new Promise<'abandoned'>((resolve) => {
      const giveUp = () => setTimeout(() => resolve('abandoned'), ABORT_GRACE_MS).unref();
      if (aborting.aborted) giveUp();
      else aborting.addEventListener('abort', giveUp, { once: true });
    });
    for (;;) {
      const next = await Promise.race([parts.next(), abandoned]);
      if (next === 'abandoned') {
        aborted = true;
        void parts.return?.(undefined).catch(() => {});
        break;
      }
      if (next.done) break;
      const part = next.value;
      if (part.type === 'tool-call') {
        runningTools += 1;
        calledTool = true;
      }
      else if (part.type === 'tool-result' || part.type === 'tool-error') {
        runningTools = Math.max(0, runningTools - 1);
        toolsRan = true;
      }
      watch();
      switch (part.type) {
        case 'text-delta':
          produced = true;
          text += part.text;
          if (!digest) emit({ type: 'text.delta', text: part.text });
          break;
        case 'reasoning-delta':
          produced = true;
          emit({ type: 'reasoning.delta', text: part.text });
          break;
        case 'tool-call':
          produced = true;
          emit({ type: 'tool.call', toolCallId: part.toolCallId, name: part.toolName, input: part.input });
          break;
        case 'tool-result':
          emit({
            type: 'tool.result',
            toolCallId: part.toolCallId,
            name: part.toolName,
            output: toolOutputText(part.output).text,
            isError: false,
          });
          break;
        case 'tool-error':
          emit({
            type: 'tool.result',
            toolCallId: part.toolCallId,
            name: part.toolName,
            output: errorMessage(part.error),
            isError: true,
          });
          break;
        case 'error':
          failure = { error: part.error };
          break;
        case 'abort':
          aborted = true;
          break;
        case 'raw': {
          const verdicts = model.verdicts?.fromRaw(part.rawValue);
          if (verdicts) {
            stepVerdicts.resolve(verdicts);
            log.debug('provider verdicts', { runId, step, judged: verdicts.size, flagged: [...verdicts.values()].filter((v) => v.flagged).length });
          }
          break;
        }
        default:
          break;
      }
    }
    // A stream that ended without them has none: a call still waiting is judged by the filter alone.
    stepVerdicts.resolve(new Map());

    clearTimeout(stallTimer);
    if (stalled && !signal.aborted) {
      const seconds = Math.round(stallMs / 1000);
      failure = { error: new Error(`The model timed out: it sent nothing for ${seconds} seconds.`) };
    } else if (aborted || signal.aborted) {
      // Keep what the user already saw. A half-finished tool exchange is dropped instead,
      // since a call without its result would poison the history.
      if (!digest && text.trim() && signal.reason !== INTERRUPTED) persist([{ role: 'assistant', content: [{ type: 'text', text }], text }]);
      // This loop has stopped listening to the step, but its helpers are still winding down; a
      // run that is over must not have work, or events, trailing after it.
      await Promise.all(helpersAtWork);
      return result('cancelled', 'cancelled', step);
    }
    // The model could not be made to follow the router. That is no reason to fail the user's
    // turn: the step is done again with the choice left to the model, as long as nothing ran.
    if (failure && steered && !toolsRan && !signal.aborted && !byHint && isToolChoiceRefusal(failure.error)) {
      // The provider takes no tool choice. From here on, for as long as this process lives, the
      // router's decisions reach this model as notes, and the refused request is not repeated.
      log.warn('provider refused the tool choice; steering this model by notes from now on', { model: model.spec, error: errorMessage(failure.error) });
      model.steer.byHint = true;
      step -= 1;
      continue;
    }
    // The wrap-up is a courtesy; if it cannot be had, the plain note below says what happened.
    if (failure && wrapUp) break;
    if (failure && steered && !toolsRan && !signal.aborted && isToolChoiceViolation(failure.error)) {
      log.warn('model did not follow the tool choice; leaving the choice to it', { runId, step, error: errorMessage(failure.error) });
      unsteerable = true;
      step -= 1;
      continue;
    }
    if (failure) {
      // What a stalled call had shown so far is kept, as it is for a cancelled one.
      if (!digest && stalled && text.trim()) persist([{ role: 'assistant', content: [{ type: 'text', text }], text }]);
      // Nothing was shown and nothing ran, so the step can simply be attempted again.
      if (!produced && retries < config.agent.stepRetries && isTransient(failure.error)) {
        retries += 1;
        log.warn('model call failed transiently; retrying', { runId, step, retries, error: errorMessage(failure.error) });
        await pause(backoffMs({ retries: config.agent.stepRetries, baseMs: config.agent.retryBaseMs }, retries), signal);
        step -= 1;
        continue;
      }
      throw failure.error;
    }
    retries = 0;

    const finished = await stream.finalStep;
    const responseMessages = (await stream.responseMessages).filter(
      (m) => typeof m.content === 'string' || m.content.length > 0,
    );
    // Some models answer a "reply now" with nothing at all. Once more with the choice left to
    // the model; if that is empty too, the user is at least told that the turn is over.
    // (A message holding only the model's reasoning counts as nothing: the user sees none of it.)
    if (!text.trim() && !calledTool && !wrapUp) {
      if (!emptyRetried) {
        emptyRetried = true;
        unsteerable = true;
        log.warn('model returned an empty step; repeating it unsteered', { runId, step });
        step -= 1;
        continue;
      }
      persist([{ role: 'assistant', content: [{ type: 'text', text: EMPTY_REPLY }], text: digest ? '' : EMPTY_REPLY,
        origin: digest ? 'heartbeat' : undefined }]);
      return result('completed', finished.finishReason, step);
    }

    // The provider says which model actually answered; record that rather than what was asked for.
    const servedBy = finished.response.modelId ? `${model.providerId}/${finished.response.modelId}` : model.spec;
    // A card the app could not draw is fixed before the step is stored: the stored reply, which
    // replaces what was streamed, then has a working card (nothing stored is ever rewritten).
    if (!digest && text.includes('```widget')) {
      for (const m of responseMessages) {
        if (m.role !== 'assistant' || typeof m.content === 'string') continue;
        for (const part of m.content) {
          if (part.type === 'text' && part.text.includes('```widget')) {
            part.text = await repairCards(part.text, { model, sessionId: conversationId, log, signal });
          }
        }
      }
    }
    const stored = persist(
      responseMessages.map((m) => ({
        role: m.role,
        content: m.content,
        text: m.role === 'assistant' && !(digest && (calledTool || text.trim() === 'NOTHING_TO_SHARE')) ? assistantText(m.content) : '',
        origin: digest && m.role === 'assistant' ? 'heartbeat' : undefined,
        model: servedBy,
      })),
    );

    stepsStored += 1;

    const { inputTokens, outputTokens, inputTokenDetails } = finished.usage;
    usage.inputTokens += inputTokens ?? 0;
    usage.outputTokens += outputTokens ?? 0;
    usage.cacheReadTokens += inputTokenDetails?.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += inputTokenDetails?.cacheWriteTokens ?? 0;
    const assistant = stored.find((m) => m.role === 'assistant');
    if (inputTokens !== undefined && assistant) {
      conversations.setContextTokens(conversationId, inputTokens + (outputTokens ?? 0), assistant.seq);
    }
    log.debug('step finished', {
      runId,
      step,
      servedBy,
      upstream: upstreamOf(finished.providerMetadata as Record<string, Record<string, unknown>> | undefined),
      finishReason: finished.finishReason,
      inputTokens,
      outputTokens,
      cacheReadTokens: inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: inputTokenDetails?.cacheWriteTokens,
    });

    const called = stored.flatMap((m) => (m.role === 'assistant' ? toMessageDto(m).parts : [])).filter((p) => p.type === 'tool_call');
    previousTool = called.length === 1 ? called[0]!.name : undefined;
    const results = stored.flatMap((m) => (m.role === 'tool' ? toMessageDto(m).parts : [])).filter((p) => p.type === 'tool_result');
    const failed = results.some((p) => p.isError && ![declined, UNANSWERED, REPLY_ONLY].some((notAFailure) => p.output.includes(notAFailure)));
    failuresInARow = failed ? failuresInARow + 1 : 0;

    if (wrapUp) {
      if (digest || stored.some((m) => m.role === 'assistant' && m.text.trim())) return result('completed', 'step-limit', maxSteps);
      break;
    }
    const ranTools = stored.some((m) => m.role === 'tool');
    // The answer is given, but the user has said more in the meantime: the turn goes on with that.
    if (!ranTools && !helper && runLog.pendingSteers(runId).length > 0) continue;
    if (!ranTools) return result('completed', finished.finishReason, step);
  }

  persist([{ role: 'assistant', content: [{ type: 'text', text: STEP_LIMIT_NOTE }], text: digest ? '' : STEP_LIMIT_NOTE,
    origin: digest ? 'heartbeat' : undefined }]);
  return result('completed', 'step-limit', maxSteps);
}
