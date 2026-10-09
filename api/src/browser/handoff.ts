import type { Screen, UserInput, Viewport } from '../../browser/protocol.ts';
import type { Computer } from '../computer/computer.ts';
import type { Config } from '../config.ts';
import { browserCommand } from '../tools/browser-tools.ts';
import { conflict } from '../util/errors.ts';
import { newId, nowIso } from '../util/ids.ts';
import type { Logger } from '../util/log.ts';

/**
 * The browser handed to the user for a moment: they see the page in the app, act on it as if
 * their finger were the mouse, and hand it back. For the CAPTCHA, the sign-in that no saved
 * login fits, the code only they received.
 *
 * There is one browser, so at most one hand-off at a time. It begins either with the agent
 * asking (`browser_handoff`, which waits for the user) or with the user taking the browser on
 * their own; while the user holds it, the agent's own browser calls are refused.
 */

export type HandoffOutcome =
  /** The user handed the browser back, possibly with a word about what they did. */
  | { outcome: 'done'; note?: string }
  /** The user would not or could not take over right now. */
  | { outcome: 'declined'; note?: string }
  /** The run was stopped while waiting. */
  | { outcome: 'cancelled' }
  /** A check-in gave up waiting (see `RunManager.giveUpWaiting`): nobody's decision. */
  | { outcome: 'unanswered' };

export interface HandoffAskInput {
  toolCallId: string;
  /** What the user should do on the page, in the agent's words. */
  reason: string;
}

/** Asks the user to take the browser over and waits for them. Rejects when the browser is already spoken for. */
export type HandoffAsk = (input: HandoffAskInput) => Promise<HandoffOutcome>;

export interface HandoffState {
  id: string;
  /** `requested`: the agent is waiting for the user to take over; `active`: the user holds the browser. */
  status: 'requested' | 'active';
  /** The agent's reason, when it asked; null for a hand-off the user began. */
  reason: string | null;
  conversationId: string | null;
  runId: string | null;
  toolCallId: string | null;
  startedAt: string;
  /** When the user took the browser; null until they do. */
  takenAt: string | null;
}

interface Current extends HandoffState {
  /** Tells the waiting `browser_handoff` call how it went; absent for a hand-off the user began. */
  settle?: (outcome: HandoffOutcome) => void;
}

/** Covers a cold start of the browser; the pictures themselves take well under a second. */
const SCREEN_MS = 30_000;

export class BrowserHandoff {
  private current: Current | null = null;
  private readonly computer: Computer;
  private readonly config: Config['browser'];
  private readonly log: Logger;

  constructor(opts: { computer: Computer; config: Config['browser']; log: Logger }) {
    this.computer = opts.computer;
    this.config = opts.config;
    this.log = opts.log;
  }

  get state(): HandoffState | null {
    if (!this.current) return null;
    const { settle: _settle, ...visible } = this.current;
    return visible;
  }

  /** True while the user holds the browser: the agent's own browser calls must not run. */
  get held(): boolean {
    return this.current?.status === 'active';
  }

  /**
   * The agent asks. `settle` is called once, when the user hands the browser back, declines, or
   * the run is stopped. A hand-off the user already began takes the request on: the user is
   * simply told what is wanted, and handing back answers the call.
   */
  request(input: HandoffAskInput & { runId: string; conversationId: string }, settle: (outcome: HandoffOutcome) => void): HandoffState {
    if (this.current?.settle) {
      throw new Error(
        this.current.runId === input.runId
          ? 'The browser is already handed over for this run; wait for that to finish.'
          : 'The browser is already handed to the user for another conversation. Carry on without it for now and ask again later.',
      );
    }
    const now = nowIso();
    this.current = {
      id: this.current?.id ?? newId('hand'),
      status: this.current?.status ?? 'requested',
      reason: input.reason,
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      startedAt: this.current?.startedAt ?? now,
      takenAt: this.current?.takenAt ?? null,
      settle,
    };
    return this.state!;
  }

  /**
   * The user takes the browser: the agent's request becomes active, or a hand-off of the user's
   * own begins. Taking it again is harmless.
   */
  take(): HandoffState {
    if (!this.config.enabled) throw conflict('The browser is turned off on this server');
    if (!this.current) {
      const now = nowIso();
      this.current = { id: newId('hand'), status: 'active', reason: null, conversationId: null, runId: null, toolCallId: null, startedAt: now, takenAt: now };
    } else if (this.current.status === 'requested') {
      this.current.status = 'active';
      this.current.takenAt = nowIso();
    }
    return this.state!;
  }

  /** The user hands the browser back (`done`) or will not take it (`declined`). Null when there is no hand-off. */
  end(result: { outcome: 'done' | 'declined'; note?: string }): HandoffState | null {
    const ended = this.current;
    if (!ended) return null;
    this.current = null;
    const note = result.note?.trim() || undefined;
    ended.settle?.(note ? { outcome: result.outcome, note } : { outcome: result.outcome });
    return this.visible(ended);
  }

  /** The run that asked is over (stopped, or a check-in that gave up waiting): the request goes with it. */
  cancel(toolCallId: string, how: 'cancelled' | 'unanswered'): void {
    const current = this.current;
    if (!current?.settle || current.toolCallId !== toolCallId) return;
    // A hand-off the user holds stays theirs; only the agent's part in it ends.
    if (current.status === 'active') {
      this.current = { ...current, reason: null, conversationId: null, runId: null, toolCallId: null, settle: undefined };
    } else {
      this.current = null;
    }
    current.settle({ outcome: how });
  }

  /** The page as the user sees it, laid out for their screen when its size is given. Only while they hold the browser. */
  screen(signal?: AbortSignal, viewport?: Viewport): Promise<Screen> {
    return this.picture(viewport ? { cmd: 'screenshot', viewport } : { cmd: 'screenshot' }, signal);
  }

  /** The user's touch or typing on the page; answers with the page afterwards. */
  input(input: UserInput, signal?: AbortSignal): Promise<Screen> {
    return this.picture({ cmd: 'input', input }, signal);
  }

  private async picture(command: { cmd: 'screenshot'; viewport?: Viewport } | { cmd: 'input'; input: UserInput }, signal?: AbortSignal): Promise<Screen> {
    if (!this.held) throw conflict('Take the browser over first');
    // A picture is far bigger than any outline: the command's output cap must let it through whole.
    const response = await browserCommand({ computer: this.computer, config: this.config }, command, { timeoutMs: SCREEN_MS, signal, maxOutputChars: 16_000_000 });
    if (!response.ok) throw new Error(response.error);
    if (!response.screen) throw new Error('The browser sent no picture of the page.');
    return response.screen;
  }

  private visible(current: Current): HandoffState {
    const { settle: _settle, ...visible } = current;
    return visible;
  }
}
