import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { CORE_BLOCKS, type CoreMemory } from '../memory/core-memory.ts';
import type { InterestStore } from '../memory/interests.ts';
import { MEMORY_KINDS, type MemoryStore } from '../memory/memory-store.ts';
import type { ConversationStore } from '../store/conversations.ts';

export interface MemoryToolDeps {
  memory: MemoryStore;
  interests?: InterestStore;
  core: CoreMemory;
  conversations: ConversationStore;
  conversationId: string;
}

const day = (iso: string) => iso.slice(0, 10);

export function createMemoryTools({ memory, interests, core, conversations, conversationId }: MemoryToolDeps): ToolSet {
  // The system prompt only carries a snapshot of core memory, so the result of an edit restates
  // the whole block: that is how the model sees its current contents.
  const coreResult = (id: string, content: string) =>
    `Core memory "${id}" updated (${content.length}/${core.blockLimit} characters). It now reads:\n${content || '(empty)'}`;
  const block = z.enum(CORE_BLOCKS).describe('"user": who the user is. "persona": how you behave for them.');

  return {
    memory_save: tool({
      description:
        'Save something to long-term archival memory so you can recall it in future conversations. ' +
        'The right next action when the user has just told you something durable about themselves ' +
        'or their life — a fact, a preference, a plan, a person — has settled a choice in something ' +
        'you are working on together (dates, a booking, the option they picked), or asks you to ' +
        'remember something, and it is not saved yet. ' +
        'Also use this for a clearly stated interest missing from interest_preferences, or a request to stop/resume updates, even if the fact is already remembered: set interest_action and interest_topic in this same call. ' +
        'For every other memory leave interest_action "none" and proactive_updates "unchanged". ' +
        'Write one self-contained statement per call, with names and dates spelled out — it will be ' +
        'read later without any of the current context.',
      inputSchema: z.object({
        content: z.string().min(1).max(2000),
        kind: z.enum(MEMORY_KINDS).optional().describe('Default "fact".'),
        // Some models fill in every argument they are offered, so "nothing to do" has to be a
        // value they can pick: left optional, each save came back with a topic to follow.
        interest_action: z.enum(['none', 'remember', 'mute', 'resume']).optional().describe('"none" (the default): an ordinary memory, nothing is followed. "remember": the user said in their own words that they like or follow a topic and would welcome news about it — not their school, employer, family, plans or tasks, and not a request for something at set times ("every Monday…"), which is a follow-up (task_add). "mute": the user rejects updates about a topic. "resume": only when the user explicitly asks to restart them.'),
        interest_topic: z.string().trim().max(120).optional().describe('Empty unless interest_action is "remember", "mute" or "resume": then the canonical topic name. Reuse a topic from interest_preferences for aliases.'),
        proactive_updates: z.enum(['unchanged', 'pause', 'resume']).optional().describe('"unchanged" (the default). "pause" or "resume" only when the user asks, in this message, to stop or restart ALL interest updates.'),
      }),
      execute: async (input) => {
        const { content, kind } = input;
        const interest_action = input.interest_action === 'none' ? undefined : input.interest_action;
        // A topic named next to "none" was only an argument filled in: an ordinary remember follows nothing.
        const interest_topic = input.interest_action === 'none' ? undefined : input.interest_topic || undefined;
        const proactive_updates = input.proactive_updates === 'unchanged' ? undefined : input.proactive_updates;
        if (interest_action && !interest_topic) throw new Error('Give interest_topic when changing updates for a topic.');
        const { memory: saved, created } = memory.add({ content, kind, source: 'agent', conversationId });
        if (proactive_updates) interests?.pause(proactive_updates === 'pause');
        const topic = interest_topic ? interests?.remember(interest_topic, saved.id, interest_action) : undefined;
        const preference = topic ? `; interest ${topic.topic}: ${topic.status}` : '';
        // Told here, at the one moment the model is looking at this memory, so that a changed
        // fact replaces the old one instead of standing next to it.
        const near = created ? memory.similar(saved.content, { exceptId: saved.id }) : [];
        const overlap = near.length === 0 ? '' :
          '\nSimilar memories already stored:\n' + near.map((m) => `${m.id} [${day(m.createdAt)}] ${m.content}`).join('\n') +
          '\nIf one of them says the same thing or is now out of date, remove it with memory_delete; otherwise leave them.';
        return (created ? `Saved as ${saved.id}` : `Already remembered as ${saved.id}`) + preference
          + (proactive_updates ? `; interest updates ${proactive_updates === 'pause' ? 'paused' : 'resumed'}` : '') + overlap;
      },
    }),

    memory_search: tool({
      description:
        'Search long-term archival memory by keywords. Relevant memories are already attached to ' +
        'each user message automatically; use this to dig further or with different wording.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(25).optional(),
      }),
      execute: async ({ query, limit }) => {
        const hits = memory.search(query, { limit: limit ?? 8 });
        if (hits.length === 0) return 'No matching memories.';
        memory.markRecalled(hits.map((h) => h.id));
        return hits.map((h) => `${h.id} [${h.kind}, ${day(h.createdAt)}] ${h.content}`).join('\n');
      },
    }),

    memory_update: tool({
      description: 'Correct or refine an archival memory that has become outdated or was wrong. For stopping or resuming interest updates use memory_save so the preference and schedule change together.',
      inputSchema: z.object({ id: z.string(), content: z.string().min(1).max(2000) }),
      execute: async ({ id, content }) => {
        if (!memory.update(id, { content })) throw new Error(`No memory with id ${id}`);
        return `Updated ${id}`;
      },
    }),

    memory_delete: tool({
      description: 'Delete an archival memory that is wrong or that the user asked you to forget.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        interests?.muteForMemory(id);
        if (!memory.delete(id)) throw new Error(`No memory with id ${id}`);
        return `Deleted ${id}`;
      },
    }),

    core_memory_append: tool({
      description:
        'Add a line to a core memory block. Core memory is always visible to you, so keep it for ' +
        'what matters in every conversation: who the user is, and how they want you to behave.',
      inputSchema: z.object({ block, text: z.string().min(1) }),
      execute: async ({ block, text }) => {
        return coreResult(block, core.append(block, text));
      },
    }),

    core_memory_replace: tool({
      description:
        'Edit a core memory block by replacing an exact piece of its text. Pass an empty new_text ' +
        'to delete. Use this to fix outdated details rather than appending contradictions.',
      inputSchema: z.object({ block, old_text: z.string().min(1), new_text: z.string() }),
      execute: async ({ block, old_text, new_text }) => {
        return coreResult(block, core.replace(block, old_text, new_text));
      },
    }),

    conversation_search: tool({
      description:
        'Search the full history of everything you and the user have said, across all conversations ' +
        'and including parts that have since been summarised away. The right next action when the ' +
        'user refers to something said, decided or planned before ("what did we settle", "remind me", ' +
        '"like last time") and the details are not in the conversation in front of you.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(25).optional(),
      }),
      execute: async ({ query, limit }) => {
        const hits = conversations.searchMessages(query, { limit: limit ?? 8 });
        if (hits.length === 0) return 'No matching messages.';
        return hits
          .map((h) => {
            const where = h.conversationId === conversationId ? 'this conversation' : (h.conversationTitle ?? h.conversationId);
            return `[${day(h.createdAt)}, ${where}] ${h.role}: ${h.snippet}`;
          })
          .join('\n');
      },
    }),
  };
}
