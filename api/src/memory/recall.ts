import type { MemoryHit, MemoryStore } from './memory-store.ts';

/** How much of the conversation before a message helps to say what the message is about. */
const CONTEXT_MESSAGES = 3;
const CONTEXT_CHARS = 400;

/** The few messages before a new one, newest first, each cut short. */
function turnsBefore(before: Array<{ role: string; text: string }>): string[] {
  return before
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-CONTEXT_MESSAGES)
    .reverse()
    .map((m) => m.text.trim().slice(0, CONTEXT_CHARS));
}

/**
 * What was said just before a message, as keyword-search context: "book it" names nothing, the
 * turn before it does. Newest first because only the first words make it into the query.
 */
export function recallContext(before: Array<{ role: string; text: string }>): string {
  return turnsBefore(before).join('\n');
}

/** The same turns in the order they were said, then the message: what an embedding places by meaning. */
export function recallQuery(before: Array<{ role: string; text: string }>, text: string): string {
  return [...turnsBefore(before).reverse(), text].join('\n');
}

/**
 * The memories to attach to a message: its best matches, topped up (when asked) with the most
 * recently touched ones, which keywords alone would miss. `matched` says how many of them are
 * matches rather than top-ups.
 */
export function recallMemories(
  memory: MemoryStore,
  input: { text: string; context?: string; limit: number; topUp: boolean },
): { memories: MemoryHit[]; matched: number } {
  const memories = memory.search(input.text, { limit: input.limit, context: input.context });
  const matched = memories.length;
  if (input.topUp) {
    const have = new Set(memories.map((m) => m.id));
    for (const m of memory.list({ limit: input.limit })) {
      if (memories.length >= input.limit) break;
      if (!have.has(m.id)) memories.push({ ...m, score: 0 });
    }
  }
  return { memories, matched };
}
