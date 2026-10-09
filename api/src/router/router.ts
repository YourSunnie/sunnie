import type { ToolChoice, ToolSet } from 'ai';
import type { StoredMessage } from '../store/conversations.ts';

/**
 * What the agent should do at the next step, as decided *before* the language model is
 * called. `auto` hands the decision back to the language model.
 */
export type RouteDecision =
  | { kind: 'tool'; tool: string; confidence: number }
  | { kind: 'respond'; confidence: number }
  | {
      kind: 'auto';
      reason: 'disabled' | 'low-confidence' | 'error' | 'repeat' | 'after-failure' | 'not-followed';
      /** What the router would have picked, had it been sure enough. */
      leaning?: string;
      confidence?: number;
    };

export interface RouteInput {
  /** Rolling summary of the compacted part of the conversation, if any. */
  summary: string | null;
  /** The live messages, oldest first, ending with whatever the agent must react to. */
  messages: StoredMessage[];
  tools: ToolSet;
  /** What long-term memory already holds that bears on this turn: core blocks, recalled memories. */
  known?: string[];
  signal?: AbortSignal;
}

/**
 * Decides which tool — if any — the agent uses next. The router chooses; the language model
 * only fills in the arguments (or writes the reply). Implementations must never throw:
 * a router that cannot decide returns `auto`.
 */
export interface ToolRouter {
  readonly name: string;
  route(input: RouteInput): Promise<RouteDecision>;
}

/** The language model picks its own tools. */
export const noRouter: ToolRouter = {
  name: 'none',
  route: async () => ({ kind: 'auto', reason: 'disabled' }),
};

export type RouteMode = 'tool-choice' | 'active-tools';

/**
 * Translates a decision into model-call settings.
 *  - `tool-choice` keeps the tool list identical on every call (so provider prompt caches stay
 *    warm) and steers with `toolChoice`.
 *  - `active-tools` instead offers only the chosen tool. Use it for models that reject a forced
 *    tool choice; it costs the cache, because the tool list changes from step to step.
 */
export function applyRoute(
  decision: RouteDecision,
  mode: RouteMode,
  tools: ToolSet,
): { toolChoice?: ToolChoice<ToolSet>; activeTools?: string[] } {
  if (decision.kind === 'auto') return {};
  if (decision.kind === 'tool' && !(decision.tool in tools)) return {};

  if (mode === 'active-tools') {
    return { activeTools: decision.kind === 'tool' ? [decision.tool] : [] };
  }
  return { toolChoice: decision.kind === 'tool' ? { type: 'tool', toolName: decision.tool } : 'none' };
}
