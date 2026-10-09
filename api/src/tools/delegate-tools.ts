import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Config } from '../config.ts';

/** How the agent reaches its helpers. Supplied by the turn loop. */
export interface HelperCalls {
  /** Runs the tasks, one helper each, and answers with their reports. */
  delegate(tasks: string[], call: { toolCallId: string; allowQuestions: boolean }): Promise<string>;
  /** Sends a helper that has reported a further message, and answers with its new report. */
  message(helper: string, message: string, call: { toolCallId: string }): Promise<string>;
}

/** Some models send a list as one JSON string; that is still a list. */
function asList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return [value];
  }
}

export function createDelegateTools(helpers: HelperCalls, config: Config['subagents']): ToolSet {
  return {
    delegate: tool({
      description:
        'Hand independent pieces of work to helpers that do them at the same time, each with its own browser tab, ' +
        'and get their reports back. The right next action when a task splits into pieces that do not depend on ' +
        'each other and each takes several steps of looking things up: comparing hotels, flights or products across ' +
        'sites, areas or dates; checking a list of places; reading many sources. Not for a single lookup, not for ' +
        'steps that build on each other, and not for anything that is booked, sent or decided.',
      inputSchema: z.object({
        tasks: z
          .preprocess(asList, z.array(z.string().trim().min(1).max(4000)).min(1).max(config.maxTasks))
          .describe(
            `One entry per helper, up to ${config.maxTasks}. A helper knows nothing about this conversation, so each ` +
              'entry must stand alone: what to find, the exact dates, places, numbers and limits that apply, and ' +
              'what to send back.',
          ),
        allow_questions: z
          .boolean()
          .optional()
          .describe(
            'Default false: each helper works from its task alone, settles what is open by itself, reports once and is ' +
              'done. Set true only when a piece may hinge on something that only you or the user can settle; these ' +
              'helpers may then end a report with a question, which you answer with helper_message.',
          ),
      }),
      execute: ({ tasks, allow_questions }, { toolCallId }) =>
        helpers.delegate(tasks, { toolCallId, allowQuestions: allow_questions ?? false }),
    }),

    helper_message: tool({
      description:
        'Send a message to a helper that has already reported in this conversation, and get its next report. ' +
        'Rarely needed: a helper\'s report is normally final. The right next action only when a helper you allowed ' +
        'to ask ended its report with a question and you now have the answer, or when one helper should go deeper ' +
        'from where it stopped: it keeps everything it has found. For a new, separate piece of work use delegate.',
      inputSchema: z.object({
        helper: z.string().trim().min(1).max(100).describe('The helper\'s id, as given at the top of its report, e.g. "conv_…".'),
        message: z.string().trim().min(1).max(4000).describe('What the helper needs to go on: the answer, the decision, the next thing to do.'),
      }),
      execute: ({ helper, message }, { toolCallId }) => helpers.message(helper, message, { toolCallId }),
    }),
  };
}
