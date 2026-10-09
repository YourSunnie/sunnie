import type { AgentEvent } from '../agent/events.ts';
import type { ConversationStore } from '../store/conversations.ts';
import { errorMessage, type Logger } from '../util/log.ts';
import type { PushMessage, PushSender } from './apns.ts';
import type { DeviceStore } from './devices.ts';

/** What the notifier needs to know about a run besides its events. */
export interface NotifyRun {
  id: string;
  conversationId: string;
  /** Set for runs nobody asked for in the chat: check-ins and the Home brief. */
  origin?: string | null;
  brief?: boolean;
}

/** How much of a reply a notification shows; the rest is in the app. */
const PREVIEW_CHARS = 180;

/**
 * Turns run events into notifications on the user's phone: when a run is waiting for the user's
 * OK, when it has an answer, and when it failed. Helpers and the Home brief never notify, and a
 * check-in that found nothing to say stays silent, as it does in the chat.
 */
export class Notifier {
  private readonly devices: DeviceStore;
  private readonly sender: PushSender;
  private readonly conversations: ConversationStore;
  private readonly log: Logger;
  /** Sends in flight, so tests and shutdown can wait for them. */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: { devices: DeviceStore; sender: PushSender; conversations: ConversationStore; log: Logger }) {
    this.devices = opts.devices;
    this.sender = opts.sender;
    this.conversations = opts.conversations;
    this.log = opts.log;
  }

  get enabled(): boolean {
    return this.sender.name !== 'none';
  }

  /** Called for every event of every run. Never throws and never waits. */
  observe(run: NotifyRun, event: AgentEvent): void {
    if (!this.enabled) return;
    try {
      const message = this.messageFor(run, event);
      if (message) this.track(this.deliver(message));
    } catch (err) {
      this.log.warn('could not prepare a notification', { runId: run.id, error: errorMessage(err) });
    }
  }

  /** Resolves once every notification started so far has been sent or given up on. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private messageFor(run: NotifyRun, event: AgentEvent): PushMessage | null {
    if (!['tool.approval.requested', 'browser.handoff.requested', 'run.completed', 'run.failed'].includes(event.type)) return null;
    const conversation = this.conversations.get(run.conversationId);
    if (!conversation || conversation.kind === 'subagent' || run.brief) return null;

    const base = {
      title: conversation.title?.trim() || 'Sunnie',
      threadId: conversation.id,
      data: { conversationId: conversation.id, runId: run.id },
    };
    if (event.type === 'tool.approval.requested') {
      // The call itself stays off the lock screen; the app shows it behind Allow and Deny.
      return {
        ...base,
        body: 'Sunnie needs your OK to continue.',
        collapseId: `approval-${run.id}`,
        data: { ...base.data, kind: 'approval' },
      };
    }
    if (event.type === 'browser.handoff.requested') {
      return {
        ...base,
        body: `Sunnie needs you in the browser: ${previewText(event.reason, 120) || 'take over for a moment'}`,
        collapseId: `handoff-${run.id}`,
        data: { ...base.data, kind: 'handoff' },
      };
    }
    if (event.type === 'run.failed') {
      if (run.origin) return null;
      return { ...base, body: 'Sunnie could not finish this. Open the chat to see what happened.', data: { ...base.data, kind: 'failed' } };
    }
    const reply = this.conversations
      .messagesForRun(run.id)
      .filter((m) => m.conversationId === conversation.id && m.role === 'assistant' && m.text.trim())
      .at(-1);
    if (!reply) return null;
    return { ...base, body: previewText(reply.text) || 'Sunnie replied.', data: { ...base.data, kind: 'reply' } };
  }

  private async deliver(message: PushMessage): Promise<void> {
    for (const device of this.devices.list()) {
      const result = await this.sender.send(device, message);
      if (result === 'gone') {
        this.devices.remove(device.token);
        this.log.info('forgot a device that no longer takes notifications');
      }
    }
  }

  private track(work: Promise<void>): void {
    const settled = work
      .catch((err: unknown) => this.log.warn('notification failed', { error: errorMessage(err) }))
      .finally(() => this.pending.delete(settled));
    this.pending.add(settled);
  }
}

/**
 * A reply as one short line of plain text. Card blocks (```event …```) and Markdown marks are
 * for the app's renderer, not a lock screen.
 */
export function previewText(text: string, limit = PREVIEW_CHARS): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > limit * 0.6 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}
