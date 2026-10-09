import type { MessageOrigin, StoredMessage } from '../store/conversations.ts';
import type { MessageQuote } from '../store/quotes.ts';
import type { Attachment } from '../store/attachments.ts';

/** The client-facing shape of a message. `content` (the raw model view) is never exposed. */
export interface MessageDto {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  /** Plain text of the message, for simple clients. */
  text: string;
  /** Original uploads, absent on messages without attachments. */
  attachments?: Attachment[];
  quotes?: MessageQuote[];
  /** "heartbeat" on the opening message and on assistant messages of an interest digest; otherwise null. */
  origin: MessageOrigin | null;
  parts: MessagePart[];
  model: string | null;
  runId: string | null;
  createdAt: string;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; name: string; output: string; isError: boolean };

export interface RunUsage {
  /** All input tokens, cached or not. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Everything a client can observe about a run, in order. Sent over SSE as `event: <type>`. */
export type AgentEvent =
  | { type: 'run.started'; runId: string; conversationId: string; model: string }
  | { type: 'message'; message: MessageDto }
  | {
      /** The router's decision for the model call that follows. */
      type: 'route';
      router: string;
      decision: 'tool' | 'respond' | 'auto';
      tool?: string;
      confidence?: number;
      reason?: string;
    }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool.result'; toolCallId: string; name: string; output: string; isError: boolean }
  | {
      /**
       * A tool call is held until the user allows or denies it. `risk` is the filter's
       * probability that the call is high risk; `reason` is set when the call is held for
       * another cause (`filter-unavailable`: the filter could not judge it).
       */
      type: 'tool.approval.requested';
      toolCallId: string;
      name: string;
      input: unknown;
      /** For a browser call that names an element by ref: what the element is, and its page. */
      target?: { element: string; title: string; url: string };
      /**
       * For a skill install: what the skill is, why it was chosen, what it helps with and what it
       * can reach, in plain words (Markdown), and whether the screen found something (`caution`).
       */
      review?: { summary: string; caution: boolean; checked: boolean };
      risk?: number;
      /**
       * Why the call is held when that is not the risk filter's own judgement: `filter-unavailable`,
       * `flagged` (the model's provider judged the call dangerous; `explanation` says why, in its
       * words), `untrusted-skill-source`, `skill-caution`.
       */
      reason?: string;
      explanation?: string;
    }
  /** `reason: "unanswered"`: nobody answered a check-in's request in time, which counts as a no. */
  | { type: 'tool.approval.resolved'; toolCallId: string; approved: boolean; reason?: 'unanswered' }
  /**
   * The agent asks the user to take the browser over (`browser_handoff`) and waits: `reason` is
   * what they should do on the page. The app takes it with `POST /v1/browser/handoff`.
   */
  | { type: 'browser.handoff.requested'; toolCallId: string; handoffId: string; reason: string }
  /** `done`: the user handed the browser back; `declined`: they would not take it; `unanswered`: as for approvals. */
  | { type: 'browser.handoff.resolved'; toolCallId: string; handoffId: string; outcome: 'done' | 'declined' | 'unanswered' }
  | {
      /**
       * A helper sent by the `delegate` call `toolCallId` has begun. `agentId` is the id of the
       * conversation that holds its transcript; `index` its place among that call's tasks.
       */
      type: 'subagent.started';
      toolCallId: string;
      agentId: string;
      index: number;
      task: string;
    }
  | { /** A helper called a tool. */ type: 'subagent.tool'; agentId: string; name: string; input: unknown }
  | {
      type: 'subagent.finished';
      agentId: string;
      status: 'completed' | 'cancelled' | 'failed';
      steps: number;
      error?: string;
    }
  | { type: 'compaction.started'; contextTokens: number }
  | { type: 'compaction.completed'; summarizedMessages: number; memoriesSaved: number }
  | { type: 'compaction.failed'; error: string }
  | { type: 'run.completed'; finishReason: string; steps: number; usage: RunUsage }
  | { type: 'run.cancelled' }
  | { type: 'run.failed'; error: string };

export type Emit = (event: AgentEvent) => void;

type Json = Record<string, unknown>;

/** Flattens an AI SDK tool-result `output` union into the text the model effectively saw. */
export function toolOutputText(output: unknown): { text: string; isError: boolean } {
  if (typeof output === 'string') return { text: output, isError: false };
  const o = (output ?? {}) as Json;
  const isError = o.type === 'error-text' || o.type === 'error-json' || o.type === 'execution-denied';
  switch (o.type) {
    case 'text':
    case 'error-text':
      return { text: String(o.value), isError };
    case 'execution-denied':
      return { text: String(o.reason ?? 'Execution denied'), isError };
    case 'content':
      return {
        text: (o.value as Json[]).map((p) => (p.type === 'text' ? String(p.text) : p.type === 'file' || p.type === 'media' ? '[image]' : `[${String(p.type)}]`)).join('\n'),
        isError,
      };
    default:
      return { text: JSON.stringify('value' in o ? o.value : output), isError };
  }
}

export function toMessageDto(m: StoredMessage): MessageDto {
  const parts: MessagePart[] = [];
  if (m.role === 'user' || typeof m.content === 'string') {
    // For user messages `text` is what was typed; `content` also carries injected context.
    if (m.role === 'user' || !m.origin || m.text) parts.push({ type: 'text', text: m.text });
  } else {
    for (const raw of m.content as Json[]) {
      if (raw.type === 'text' && raw.text && !(m.origin && !m.text)) {
        parts.push({ type: 'text', text: raw.text as string });
      } else if (raw.type === 'reasoning' && raw.text) {
        parts.push({ type: 'reasoning', text: raw.text as string });
      } else if (raw.type === 'tool-call') {
        parts.push({
          type: 'tool_call',
          toolCallId: raw.toolCallId as string,
          name: raw.toolName as string,
          input: raw.input,
        });
      } else if (raw.type === 'tool-result') {
        const { text, isError } = toolOutputText(raw.output);
        parts.push({
          type: 'tool_result',
          toolCallId: raw.toolCallId as string,
          name: raw.toolName as string,
          output: text,
          isError,
        });
      }
    }
  }
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    role: m.role,
    text: m.text,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.quotes?.length ? { quotes: m.quotes } : {}),
    origin: m.origin,
    parts,
    model: m.model,
    runId: m.runId,
    createdAt: m.createdAt,
  };
}
