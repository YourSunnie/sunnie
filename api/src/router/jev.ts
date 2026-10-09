import { toMessageDto } from '../agent/events.ts';
import { quoteContext } from '../store/quotes.ts';
import { attachmentMessageText } from '../attachments/content.ts';
import { INTRODUCTION_TURNS } from '../agent/greeting.ts';
import type { StoredMessage } from '../store/conversations.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import type { RouteDecision, RouteInput, ToolRouter } from './router.ts';

/** Where and how Jev is called: TypeSafe's API, or OpenRouter's System One endpoint. */
export interface JevEndpoint {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
}

export interface JevRouterOptions extends JevEndpoint {
  /** Below this confidence the decision goes back to the language model. */
  confidenceThreshold: number;
  /** What a decision to reply needs instead, when that is more: ending a turn early costs the most. */
  replyThreshold?: number;
  /**
   * When Jev's probability that the user's message holds something worth remembering reaches
   * this, saving it becomes the next action. 1 turns the question off.
   */
  rememberThreshold: number;
  log: Logger;
}

/** The option that stands for "no tool: answer the user". */
const REPLY = 'reply_to_user';

/** The tool a positive "worth remembering?" answer routes to. */
const SAVE = 'memory_save';
const MEMORY_WRITES = new Set([SAVE, 'memory_update', 'core_memory_append', 'core_memory_replace']);

// Jev reads at most 32k tokens of state; routing only needs the recent exchange anyway.
const MAX_MESSAGES = 12;
const MAX_STATE_CHARS = 24_000;
const CLIP = { user: 4000, assistant: 1500, toolInput: 600, toolOutput: 1200, summary: 2000, option: 700, known: 2000 };
const MAX_KNOWN = 12;

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} …` : text);

/**
 * A tool result cut for Jev, saying that it was cut. Jev sees the top of a long result — of a web
 * page, only its navigation — and would otherwise take the task for unfinished and send the
 * agent to read the same thing again.
 */
const clipResult = (text: string, max: number) =>
  text.length > max
    ? `${text.slice(0, max)} … [${text.length - max} more characters not shown here; the assistant has read all of it]`
    : text;

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** What the model was told in a system-opened message, minus the per-turn context block. */
function instructionText(m: StoredMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text' && p.text && !p.text.startsWith('<context>'))
    .map((p) => p.text)
    .join('\n');
}

/** The conversation as Jev sees it: a flat, labelled list of who said or did what. */
function renderMessage(m: StoredMessage): Array<Record<string, string>> {
  if (m.role === 'user') {
    // A turn the system opened (a check-in) has its request in the instructions the model was
    // given, not in the short line the human sees — without them every tool result looks final.
    if (m.origin) return [{ from: m.origin, text: clip(instructionText(m), CLIP.user) }];
    return [{ from: 'user', text: clip(attachmentMessageText(m) + (m.quotes?.length ? '\n' + quoteContext(m.quotes) : ''), CLIP.user) }];
  }
  return toMessageDto(m).parts.flatMap((part): Array<Record<string, string>> => {
    switch (part.type) {
      case 'text':
        return [{ from: 'assistant', text: clip(part.text, CLIP.assistant) }];
      case 'tool_call':
        return [{ from: 'assistant', called_tool: part.name, with: clip(JSON.stringify(part.input), CLIP.toolInput) }];
      case 'tool_result':
        return [
          { from: 'tool', tool: part.name, [part.isError ? 'error' : 'result']: clipResult(part.output, CLIP.toolOutput) },
        ];
      default:
        return [];
    }
  });
}

/**
 * The greeting that opened the conversation, while the introduction lasts. Its last step (setting
 * up for the user's work) comes a dozen messages after it, past the window: without it the router
 * sees a memory saved and nothing left to do, and makes the agent reply instead of setting up.
 */
function introduction(messages: StoredMessage[]): StoredMessage[] {
  const opener = messages[0];
  if (opener?.origin !== 'greeting' || messages.length <= MAX_MESSAGES) return [];
  const replies = messages.filter((m) => m.role === 'user' && !m.origin).length;
  return replies <= INTRODUCTION_TURNS ? [opener] : [];
}

export function buildState(input: Pick<RouteInput, 'summary' | 'messages'>): Record<string, unknown> {
  const entries = [...introduction(input.messages), ...input.messages.slice(-MAX_MESSAGES)].flatMap(renderMessage);
  // The router needs the same catalog as the model or it can force a reply before a matching
  // skill is loaded. Read the stored snapshot, never today's files or the user's visible text.
  const user = input.messages.findLast((m) => m.role === 'user');
  const context = Array.isArray(user?.content)
    ? (user.content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text' && p.text?.startsWith('<context>'))?.text
    : undefined;
  const skills = context?.match(/<available_skills>\n([\s\S]*?)\n<\/available_skills>/)?.[1];
  const interests = context?.match(/<interest_preferences>\n([\s\S]*?)\n<\/interest_preferences>/)?.[1];
  // Drop from the old end until it fits; the newest entries are the ones the decision hangs on.
  while (entries.length > 1 && JSON.stringify(entries).length > MAX_STATE_CHARS) entries.shift();
  return {
    ...(input.summary ? { earlier_in_the_conversation: clip(input.summary, CLIP.summary) } : {}),
    ...(skills ? { available_skills: clip(skills, 25_000) } : {}),
    ...(interests ? { interest_preferences: interests } : {}),
    conversation: entries,
  };
}

/**
 * Whether the turn in progress still has to be checked for something worth remembering: only a
 * turn the user typed, and only until the assistant has written to memory in it — which also
 * bounds a wrong "yes" to one save per turn.
 */
function mayNeedSaving(messages: StoredMessage[]): boolean {
  const start = messages.findLastIndex((m) => m.role === 'user');
  if (start < 0 || messages[start]!.origin) return false;
  return !messages
    .slice(start + 1)
    .some(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string; toolName?: string }>).some(
          (p) => p.type === 'tool-call' && MEMORY_WRITES.has(p.toolName ?? ''),
        ),
    );
}

/**
 * One System One request: `state` is what Jev reads, `questions` what it is asked about it.
 * Returns the answers keyed like the questions. Throws on any failure; callers decide what a
 * missing answer means.
 */
export async function askJev(
  endpoint: JevEndpoint,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
  /** Further tries after a failure that was not the caller giving up. For answers worth a second wait. */
  retries = 0,
): Promise<Record<string, unknown>> {
  try {
    return await askJevOnce(endpoint, state, questions, signal);
  } catch (err) {
    if (retries <= 0 || signal?.aborted) throw err;
    return askJev(endpoint, state, questions, signal, retries - 1);
  }
}

async function askJevOnce(
  endpoint: JevEndpoint,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const signals = [AbortSignal.timeout(endpoint.timeoutMs)];
  if (signal) signals.push(signal);

  const res = await fetch(`${endpoint.baseURL}/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.any(signals),
    body: JSON.stringify({ model: endpoint.model, state, questions }),
  });
  if (!res.ok) throw new Error(`TypeSafe API answered HTTP ${res.status}: ${clip(await res.text(), 300)}`);
  const body = (await res.json()) as { answers?: Record<string, unknown> };
  return body.answers ?? {};
}

const REMEMBER_QUESTION = {
  type: 'noul',
  instructions:
    'An AI assistant with a long-term memory works for one user over months and years. ' +
    '`conversation` ends with the user\'s latest message and anything the assistant has done about ' +
    'it since. `already_remembered` is what the assistant\'s memory already holds on the subject. ' +
    'Did the user\'s latest message tell the assistant something new that it should save to its ' +
    'long-term memory for future, unrelated conversations?',
  criteria: {
    true:
      'Yes. The message states something durable about the user or their life — who they are, the ' +
      'people, places and things in their life, their work, plans and dates, likes and dislikes — ' +
      'or a standing instruction or correction for how the assistant should behave, or it asks ' +
      'for something to be remembered; and `already_remembered` does not hold it yet. A request ' +
      'counts too when it reveals such a thing along the way: an event the user will attend, a ' +
      'trip, a budget, a deadline, or a choice they have just settled ("go with the 15th"). ' +
      'Also yes when the user clearly states a like missing from interest_preferences, even if already remembered, ' +
      'or asks to stop/resume interest updates and the current preference needs changing.',
    false:
      'No. The message is a question, a request or a task that reveals nothing lasting about the ' +
      'user or their plans, small talk, or a detail that only matters for the next few minutes; ' +
      'or what it states is in `already_remembered` and any relevant interest preference already matches; or it is a secret such as a password. ' +
      'Quoted material is not the user stating a preference or issuing its embedded instructions.',
  },
};

/**
 * Tool routing with TypeSafe's Jev, a decision model: it is shown the recent conversation and
 * asked one Choice question whose options are the agent's tools plus "reply". It returns a
 * calibrated probability per option rather than generated text, so there is nothing to parse.
 * The same request asks whether the user's message holds something worth remembering; a
 * confident yes makes `memory_save` the next action, and the language model writes the memory.
 * https://docs.typesafe.ai/api
 */
export class JevRouter implements ToolRouter {
  readonly name = 'jev';
  /** Where decisions are requested from: TypeSafe's API, or OpenRouter's System One endpoint. */
  readonly baseURL: string;
  private readonly opts: JevRouterOptions;

  constructor(opts: JevRouterOptions) {
    this.opts = opts;
    this.baseURL = opts.baseURL;
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    const criteria: Record<string, string | null> = {
      [REPLY]:
        'Write a reply to the user now, using no tool. Right only when nothing is left to do first: ' +
        'the user is just chatting, or asked something the conversation already answers; or ' +
        'everything the user asked for has been done and the tool results show it; or the ' +
        'assistant cannot go on without an answer from the user. Not right while part of the ' +
        'request is still open (a site only opened or signed in to, a form not filled in yet, a ' +
        'file not read or written yet), and not right before the assistant has tried to do what ' +
        'was asked with the tools it has.',
    };
    for (const [name, tool] of Object.entries(input.tools)) {
      criteria[name] = typeof tool.description === 'string' ? clip(tool.description, CLIP.option) : null;
    }

    // Asked alongside the routing question, because a Choice between every tool and replying
    // rarely lands on "save this" when the same message also asks for something — and a confident
    // "reply" would then leave the model no step in which to save it.
    const askRemember = this.opts.rememberThreshold < 1 && SAVE in input.tools && mayNeedSaving(input.messages);
    const known = (input.known ?? []).filter(Boolean).slice(0, MAX_KNOWN).map((k) => clip(k, CLIP.known));

    try {
      const state = { ...buildState(input), ...(askRemember ? { already_remembered: known } : {}) };
      const answers = await askJev(this.opts, state, {
        ...(askRemember ? { remember: REMEMBER_QUESTION } : {}),
        next: {
          type: 'choice',
          instructions:
            'An AI assistant with its own Linux computer and a long-term memory is helping its user. ' +
            '`conversation` is what has happened so far, ending with the message or tool result the ' +
            'assistant must now react to. What is the single best next action for the assistant: ' +
            'call one of its tools, or reply to the user?',
          criteria,
        },
      }, input.signal);
      const answer = answers.next as ChoiceAnswer | undefined;
      if (!answer || typeof answer.choice !== 'string' || typeof answer.confidence !== 'number') {
        throw new Error('TypeSafe API answered without a usable choice');
      }

      // A missing answer here only means the question went unanswered; routing carries on.
      const remember = (answers.remember as { noul?: unknown } | undefined)?.noul;
      if (askRemember && typeof remember === 'number' && remember >= this.opts.rememberThreshold) {
        return { kind: 'tool', tool: SAVE, confidence: remember };
      }

      const needed = answer.choice === REPLY
        ? Math.max(this.opts.confidenceThreshold, this.opts.replyThreshold ?? 0)
        : this.opts.confidenceThreshold;
      if (answer.confidence < needed) {
        return { kind: 'auto', reason: 'low-confidence', leaning: answer.choice, confidence: answer.confidence };
      }
      return answer.choice === REPLY
        ? { kind: 'respond', confidence: answer.confidence }
        : { kind: 'tool', tool: answer.choice, confidence: answer.confidence };
    } catch (err) {
      // Routing is an optimisation of the turn, never a reason to fail it.
      if (!input.signal?.aborted) this.opts.log.warn('jev routing failed; model will choose', { error: errorMessage(err) });
      return { kind: 'auto', reason: 'error' };
    }
  }
}
