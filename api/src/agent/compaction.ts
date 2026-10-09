import { generateText } from 'ai';
import { quoteContext } from '../store/quotes.ts';
import { attachmentMessageText } from '../attachments/content.ts';
import { AGENT_NAME, type Config } from '../config.ts';
import type { CoreMemory } from '../memory/core-memory.ts';
import { MEMORY_KINDS, type MemoryKind, type MemoryStore } from '../memory/memory-store.ts';
import type { ModelRegistry, ResolvedModel } from '../models/registry.ts';
import type { Conversation, ConversationStore, StoredMessage } from '../store/conversations.ts';
import type { Logger } from '../util/log.ts';
import { toolOutputText, type Emit } from './events.ts';
import { withTransientRetry } from './retry.ts';
import { estimateMessageTokens, estimateTokens } from './tokens.ts';

export interface CompactionDeps {
  config: Config;
  conversations: ConversationStore;
  memory: MemoryStore;
  core: CoreMemory;
  models: ModelRegistry;
  log: Logger;
}

export interface CompactionResult {
  summarizedMessages: number;
  memoriesSaved: number;
  summary: string;
}

/** How many tokens of context a conversation may occupy before it must be compacted. */
export function contextBudget(config: Config, model: ResolvedModel): number {
  return Math.min(
    Math.floor(model.contextWindow * config.compaction.threshold),
    config.compaction.maxContextTokens,
  );
}

/**
 * Size of the context the next model call would send. Anchored on the provider's own count
 * from the last call when there is one, with only the messages since then estimated.
 */
export function estimateContextTokens(
  conversation: Conversation,
  live: StoredMessage[],
  instructions: string,
): number {
  const { contextTokens, contextTokensSeq } = conversation;
  if (contextTokens !== null && contextTokensSeq !== null) {
    return live
      .filter((m) => m.seq > contextTokensSeq)
      .reduce((sum, m) => sum + estimateMessageTokens(m), contextTokens);
  }
  return live.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    estimateTokens(instructions) + estimateTokens(conversation.summary ?? ''),
  );
}

/** Tools whose result is a document the agent works from: fetched again, at full price, if summarised away. */
const LONG_READ_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'read_file']);

/** A read at least this long is worth keeping whole rather than as a line of the summary. */
const LONG_READ_CHARS = 4000;

/** Whether a stored message holds a long, successful read of a page or a file. */
function holdsLongRead(m: StoredMessage): boolean {
  if (m.role !== 'tool' || !Array.isArray(m.content)) return false;
  return (m.content as Array<Record<string, unknown>>).some((part) => {
    if (part.type !== 'tool-result' || !LONG_READ_TOOLS.has(String(part.toolName))) return false;
    const { text, isError } = toolOutputText(part.output);
    return !isError && text.length >= LONG_READ_CHARS;
  });
}

const tokensFrom = (messages: StoredMessage[], index: number) =>
  messages.slice(index).reduce((sum, m) => sum + estimateMessageTokens(m), 0);

/**
 * Picks where to cut: messages before the returned index get summarised, the rest stay verbatim.
 * The cut never separates a tool call from its result, and prefers the start of a user turn.
 * The latest long read (a page, a file) is kept whole, from the step that made it, when keeping
 * it costs no more than `reachTokens`: summarised to a line, it is read again and the context
 * is straight back over the line (seen live, two compactions ninety seconds apart).
 * Returns 0 when there is nothing worth compacting.
 */
export function chooseCut(messages: StoredMessage[], keepRecentTokens: number, reachTokens = keepRecentTokens): number {
  let kept = 0;
  let start = messages.length;
  while (start > 0) {
    const cost = estimateMessageTokens(messages[start - 1]!);
    if (kept + cost > keepRecentTokens) break;
    kept += cost;
    start -= 1;
  }
  if (start === 0) return 0;

  const read = messages.findLastIndex(holdsLongRead);
  if (read >= 0) {
    // Back to the assistant message that made the call, so the call stays with its result.
    let from = read;
    while (from > 0 && messages[from]!.role === 'tool') from -= 1;
    if (messages[from]!.role === 'assistant' && tokensFrom(messages, from) <= reachTokens) {
      // Better still, the whole user turn the read belongs to.
      let turn = from;
      while (turn > 0 && messages[turn]!.role !== 'user') turn -= 1;
      return turn > 0 && messages[turn]!.role === 'user' && tokensFrom(messages, turn) <= reachTokens ? turn : from;
    }
  }

  // Snap forward to a turn boundary...
  let cut = start;
  while (cut < messages.length && messages[cut]!.role !== 'user') cut += 1;
  if (cut === messages.length) {
    // ...or, inside one very long turn, to any point that is not between a call and its result.
    cut = start;
    while (cut < messages.length && messages[cut]!.role === 'tool') cut += 1;
  }
  // Never summarise away a user message that has not been answered yet.
  if (cut === messages.length && messages.at(-1)?.role === 'user') cut -= 1;
  return cut;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)} [… ${text.length - max} more characters]` : text;

/** Renders a stored message as plain transcript text for the summariser. */
export function renderForSummary(m: StoredMessage): string {
  if (m.role === 'user') return `USER: ${attachmentMessageText({ ...m, text: clip(m.text, 6000) }, true)}\n${clip(quoteContext(m.quotes), 6000)}`;
  if (typeof m.content === 'string') return `ASSISTANT: ${clip(m.content, 6000)}`;

  const lines: string[] = [];
  for (const part of m.content as Array<Record<string, unknown>>) {
    if (part.type === 'text' && part.text) {
      lines.push(`ASSISTANT: ${clip(part.text as string, 6000)}`);
    } else if (part.type === 'tool-call') {
      lines.push(`ASSISTANT called ${String(part.toolName)}: ${clip(JSON.stringify(part.input), 800)}`);
    } else if (part.type === 'tool-result') {
      const { text, isError } = toolOutputText(part.output);
      lines.push(`TOOL ${isError ? 'ERROR' : 'RESULT'} (${String(part.toolName)}): ${clip(text, 1500)}`);
    }
  }
  return lines.join('\n');
}

function buildInstructions(name: string): string {
  return `You are the memory-consolidation process of ${name}, a long-running personal AI agent. You will be given an earlier stretch of a conversation between ${name} and its user. That stretch is about to be removed from ${name}'s working context, so whatever you do not carry forward is lost to it.

Produce exactly two sections.

<summary>
A briefing ${name} can continue from, written in second person ("You ...", "The user ..."). Cover, as far as they apply:
- What the user wanted, including the exact wording of any request still in progress.
- Decisions made, conclusions reached, and things the user approved or rejected.
- Work done on the computer: files and paths, commands that mattered, results, errors and how they were resolved.
- Open threads: what is unfinished, promised, or waiting on the user.
- Where things stood at the very end.
If a previous summary is supplied, merge it in: keep what still matters, drop what is superseded. Be specific — names, numbers, paths — and stay under about 500 words.
</summary>

<memories>
Durable knowledge about the user worth keeping for future, unrelated conversations — one per line as "- [kind] statement", where kind is one of: ${MEMORY_KINDS.join(', ')}. Each statement must stand alone (full names, absolute dates). Skip anything already in the known memory shown to you, anything transient, and any secret. Write "none" if there is nothing.
</memories>`;
}

function parseOutput(text: string): { summary: string; memories: Array<{ kind: MemoryKind; content: string }> } {
  const summaryMatch = /<summary>([\s\S]*?)(?:<\/summary>|<memories>|$)/i.exec(text);
  const memoriesMatch = /<memories>([\s\S]*?)(?:<\/memories>|$)/i.exec(text);
  // A model that ignored the format still produced a usable summary; keep all of it.
  const summary = (summaryMatch?.[1] ?? text.replace(/<memories>[\s\S]*$/i, '')).trim();

  const memories: Array<{ kind: MemoryKind; content: string }> = [];
  for (const line of (memoriesMatch?.[1] ?? '').split('\n')) {
    const m = /^\s*[-*]\s*(?:\[(\w+)\]\s*)?(.+)$/.exec(line);
    if (!m || !m[2]) continue;
    const kind = (MEMORY_KINDS as readonly string[]).includes(m[1] ?? '') ? (m[1] as MemoryKind) : 'fact';
    memories.push({ kind, content: m[2].trim() });
  }
  return { summary, memories };
}

/**
 * Folds the older part of a conversation into its rolling summary and extracts durable
 * memories from it on the way out. Returns null if there was nothing to compact.
 */
export async function compactConversation(
  deps: CompactionDeps,
  conversation: Conversation,
  model: ResolvedModel,
  opts: { signal?: AbortSignal; emit?: Emit; contextTokens?: number } = {},
): Promise<CompactionResult | null> {
  const { config, conversations, memory, core, log } = deps;
  const live = conversations.liveMessages(conversation);
  // On small-context models the configured tail could be most of the budget; cap it.
  const keepRecent = Math.min(
    config.compaction.keepRecentTokens,
    Math.floor(contextBudget(config, model) * 0.4),
  );
  // How far past that tail the latest long read may be kept whole, so that the context after
  // compaction still leaves room for work.
  const reach = Math.min(keepRecent * 3, Math.floor(contextBudget(config, model) * 0.6));
  const cut = chooseCut(live, keepRecent, reach);
  if (cut === 0) return null;

  const doomed = live.slice(0, cut);
  const summariser = config.compaction.model ? deps.models.resolve(config.compaction.model) : model;
  opts.emit?.({ type: 'compaction.started', contextTokens: opts.contextTokens ?? 0 });

  // A stretch too long for one call is folded chunk by chunk into a running summary.
  const chunkBudget = Math.max(8_000, Math.min(Math.floor(contextBudget(config, summariser) / 2), 48_000));
  const chunks: string[][] = [[]];
  let size = 0;
  for (const rendered of doomed.map(renderForSummary).filter(Boolean)) {
    const cost = estimateTokens(rendered);
    if (size + cost > chunkBudget && chunks.at(-1)!.length > 0) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(rendered);
    size += cost;
  }

  const known = core.all();
  // What the agent saved while this stretch was said is what the summariser would save again, reworded.
  const saved = memory.fromConversation(conversation.id).map((m) => `- ${m.content}`);
  let summary = conversation.summary ?? '';
  let memoriesSaved = 0;
  for (const chunk of chunks) {
    const prompt = [
      `<known_memory>\n${[known.user, ...saved].filter(Boolean).join('\n') || '(nothing yet)'}\n</known_memory>`,
      summary ? `<previous_summary>\n${summary}\n</previous_summary>` : '',
      `<transcript>\n${chunk.join('\n\n')}\n</transcript>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const { text } = await withTransientRetry(
      () =>
        generateText({
          model: summariser.model,
          instructions: buildInstructions(AGENT_NAME),
          prompt,
          // A summariser that goes quiet must not hold the turn that is waiting for it.
          abortSignal: AbortSignal.any([
            ...(opts.signal ? [opts.signal] : []),
            AbortSignal.timeout(config.agent.stallTimeoutMs * 2),
          ]),
          ...summariser.callOptions({ sessionId: conversation.id }),
        }),
      {
        retries: config.agent.stepRetries,
        baseMs: config.agent.retryBaseMs,
        signal: opts.signal,
        log,
        what: 'compaction',
      },
    );
    const parsed = parseOutput(text);
    if (!parsed.summary) throw new Error('Compaction produced an empty summary');
    summary = parsed.summary;
    for (const m of parsed.memories) {
      const { created } = memory.add({ ...m, source: 'compaction', conversationId: conversation.id });
      if (created) memoriesSaved += 1;
    }
  }

  const uptoSeq = doomed.at(-1)!.seq;
  conversations.setSummary(conversation.id, summary, uptoSeq);
  // The cached prefix is void from here on, so this is the moment to pick up core-memory edits.
  conversations.setCoreSnapshot(conversation.id, core.all());
  conversations.recordCompaction({
    conversationId: conversation.id,
    fromSeq: doomed[0]!.seq,
    uptoSeq,
    summary,
    tokensBefore: opts.contextTokens ?? 0,
    memoriesSaved,
    model: summariser.spec,
  });
  log.info('compacted conversation', {
    conversationId: conversation.id,
    summarizedMessages: doomed.length,
    memoriesSaved,
  });
  opts.emit?.({ type: 'compaction.completed', summarizedMessages: doomed.length, memoriesSaved });
  return { summarizedMessages: doomed.length, memoriesSaved, summary };
}
