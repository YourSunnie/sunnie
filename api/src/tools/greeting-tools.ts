import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ConversationStore } from '../store/conversations.ts';

/** Ends a new user's introduction. Always offered, so that the tool list never changes (invariant 7). */
export function createGreetingTools(conversations: ConversationStore): ToolSet {
  return {
    introduction_done: tool({
      description: 'Ends the introduction that opens a new user\'s first chat: until then the app shows them only that chat; after it, Home, Drive and Settings too. Use only while following <greeting> instructions, in the turn in which you tell the user what you set up for them; never in any other conversation.',
      inputSchema: z.object({}),
      execute: async () => conversations.finishIntroduction()
        ? 'The introduction is over. The app now shows the user its other tabs: Home, Drive and Settings.'
        : 'No introduction is going on; nothing changed.',
    }),
  };
}
