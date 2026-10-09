import type { StoredMessage } from '../store/conversations.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import { askJev, buildState, clip, type JevEndpoint } from './jev.ts';

export interface RecallInput {
  /** The message the turn opens with. */
  text: string;
  /** Rolling summary of the compacted part of the conversation, if any. */
  summary: string | null;
  /** The live messages before the new one, oldest first. */
  messages: StoredMessage[];
  signal?: AbortSignal;
}

/**
 * Decides one thing: whether a new message calls for a recall — looking into long-term memory
 * and earlier conversations before the model answers. The recall itself is the agent loop's
 * job. Implementations must never throw: a filter that cannot judge says yes, because what is
 * recalled for nothing costs a few lines of context and what is not recalled costs the answer.
 */
export interface RecallFilter {
  readonly name: string;
  /**
   * Whether the filter judges the message itself. Only then does a recall reach beyond keyword
   * matches, to recent memories and earlier conversations: "the user is vegetarian" shares no
   * word with "what should I cook?".
   */
  readonly judges: boolean;
  needed(input: RecallInput): Promise<boolean>;
}

/** Every message gets its keyword matches, and nothing more. */
export const noRecallFilter: RecallFilter = {
  name: 'none',
  judges: false,
  needed: async () => true,
};

export interface JevRecallFilterOptions extends JevEndpoint {
  /** A recall happens when Jev's probability that the message needs one reaches this. */
  threshold: number;
  log: Logger;
}

const CLIP = { message: 4000 };

/**
 * The recall decision with TypeSafe's Jev: one yes/no (Noul) question per turn — "does answering
 * this need something from before?" — over the recent conversation.
 * https://docs.typesafe.ai/api
 */
export class JevRecallFilter implements RecallFilter {
  readonly name = 'jev';
  readonly judges = true;
  readonly baseURL: string;
  private readonly opts: JevRecallFilterOptions;

  constructor(opts: JevRecallFilterOptions) {
    this.opts = opts;
    this.baseURL = opts.baseURL;
  }

  async needed(input: RecallInput): Promise<boolean> {
    try {
      const answers = await askJev(
        this.opts,
        { ...buildState(input), new_message: clip(input.text, CLIP.message) },
        {
          recall: {
            type: 'noul',
            instructions:
              'An AI assistant that works for one user over months and years, with a long-term memory ' +
              'of that user and a searchable record of their earlier conversations, is about to respond ' +
              'to `new_message`. `conversation` is what was said before it in this conversation. Should ' +
              'the assistant first recall what it knows from before — its memories of the user and ' +
              'their earlier conversations?',
            criteria: {
              true:
                'Yes. The message refers to something said, decided or planned before that is not in ' +
                '`conversation` ("what did we settle", "like last time", "my trip", "remind me"); or it ' +
                'asks for something that what the assistant knows about the user should shape — who and ' +
                'where they are, their preferences, plans, people and standing instructions: a ' +
                'recommendation, a plan, a booking, something written on their behalf.',
              false:
                'No. The message can be handled fully from `conversation` and general knowledge: a ' +
                'factual question, a calculation, a command to carry out, small talk, the user telling ' +
                'the assistant something new, or a direct follow-up on what was just said.',
            },
          },
        },
        input.signal,
      );
      const p = (answers.recall as { noul?: unknown } | undefined)?.noul;
      if (typeof p !== 'number') throw new Error('TypeSafe API answered without a usable probability');
      this.opts.log.debug('recall decided', { probability: Number(p.toFixed(2)), recall: p >= this.opts.threshold });
      return p >= this.opts.threshold;
    } catch (err) {
      if (!input.signal?.aborted) {
        this.opts.log.warn('jev recall decision failed; recalling anyway', { error: errorMessage(err) });
      }
      return true;
    }
  }
}
