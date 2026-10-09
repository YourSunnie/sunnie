import type { HomeStore, HomeWidget } from '../home/home-store.ts';
import { interestPreamble } from '../memory/interests.ts';
import type { Task } from '../tasks/task-store.ts';
import { describeWidget } from '../tools/home-tools.ts';
import { SIZE_BUDGETS } from '../home/widgets.ts';
import { badRequest, conflict, notFound } from '../util/errors.ts';
import { errorMessage } from '../util/log.ts';
import { AGENT_NAME } from '../config.ts';
import type { AgentDeps } from './agent.ts';
import type { Run, RunManager, StartRunInput } from './runs.ts';

export const HEARTBEAT_TITLE = 'Check-ins';

/** How the openers of the different check-ins begin; the Home screen tells them apart by it. */
export const INTERESTS_OPENER = 'Exploring your interests: ';
export const BRIEF_OPENER = 'Getting your Home ready';

/** Steps a Home brief may take: a few lookups, a look at follow-ups, a few widgets. */
export const BRIEF_STEPS = 10;

/** A brief asked for from the app no sooner than this after the last one. */
const BRIEF_COOLDOWN_MS = 15 * 60_000;

/** What the model is told at the top of a Home brief. Stored with the message, like any context. */
export function briefPreamble(widgets: HomeWidget[]): string {
  return `<home_brief>
This is your daily Home brief, started by your heartbeat, not a message from the user. Nobody is watching. The user's app opens on a Home screen made of widgets; keep it current with home_widget so that it is useful today. On Home now, top to bottom:
${widgets.map(describeWidget).join('\n') || '- nothing'}

1. Your user's widgets: they asked for them, so they are theirs. Leave their design, size, place and whether they are hidden alone. Refresh one only if what it shows is yours to look up and has gone stale, and only with action "update" on its keys, which changes what it shows and nothing else. Look each fact up (phone_data for their phone's health, calendar or location; task_list for your follow-ups; web_fetch for anything public — for weather, https://geocoding-api.open-meteo.com/v1/search?name=<city>&count=1 then https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto, no key needed). If you cannot find something, leave that widget as it is.
2. Notes: at most two, and only when they really help today: a heads-up about something due, how to prepare for an event, something from a recent conversation the user would want in front of them. Each is a widget of its own: an id such as "note-passport", a title (its name, not drawn), hours 48, body {"type":"markdown","text":"**Passport** — ..."} (its heading is part of the text), and a link if there is a page with more. No note is better than filler. Do not add a greeting, a summary of the day, or the weather unless they asked for it on Home.
Home shows only what helps the user: never write there what you could not do or reach ("calendar isn't connected").
Only look things up and write to Home: do not delegate, sign in, buy, send anything, write memories or add follow-ups.
Then reply with exactly NOTHING_TO_SHARE: Home is where this goes. Only if something needs the user's attention now, write them a short message instead.
</home_brief>`;
}

/** The widgets a brief writes for itself; everything else on Home is the user's. */
export function isBriefWidget(id: string): boolean {
  return id.startsWith('note-');
}

/**
 * What a brief may do to Home: anything to its own widgets and new ones, but only change the data
 * of the user's (`update`), so that a morning refresh never redesigns, moves, hides or removes
 * what the user set up. Throws a message for the model when the call would.
 */
export function checkBriefWidgetCall(home: HomeStore, input: unknown): void {
  const { action = 'set', id = '' } = (input ?? {}) as { action?: string; id?: string };
  const key = String(id).trim().toLowerCase();
  if (action === 'update' || isBriefWidget(key)) return;
  if (action === 'set' && !home.widgets().some((w) => w.id === key)) return;
  throw new Error(`"${key}" is the user's widget: a Home brief may only refresh what it shows, with action "update" on its keys, ` +
    'and leaves its design, size, place and visibility alone.');
}

/**
 * Starts today's Home brief in the Check-ins conversation. Throws `conflict` when it cannot:
 * briefs are off, a run is going there, or (when asked from the app) one started a moment ago.
 */
export function startBrief(deps: AgentDeps, runs: RunManager, opts: { now?: Date; fromApp?: boolean } = {}): Run {
  const { config, conversations, home } = deps;
  const now = opts.now ?? new Date();
  if (!config.heartbeat.enabled || !config.heartbeat.brief) throw conflict('Home briefs are turned off on this server');
  const { lastBriefAt, timeZone } = home.state();
  if (opts.fromApp && lastBriefAt && now.getTime() - Date.parse(lastBriefAt) < BRIEF_COOLDOWN_MS) {
    throw conflict('Home was refreshed a few minutes ago');
  }
  const conversation =
    conversations.findByKind('heartbeat') ?? conversations.create({ kind: 'heartbeat', title: HEARTBEAT_TITLE });
  if (runs.isBusy(conversation.id)) throw conflict('A check-in is in progress; try again when it is done');
  return runs.start({
    conversationId: conversation.id,
    text: BRIEF_OPENER,
    preamble: briefPreamble(home.widgets(now)),
    brief: true,
    briefAt: now.toISOString(),
    origin: 'heartbeat',
    model: config.heartbeat.model,
    timeZone: timeZone ?? undefined,
  });
}

/** Steps a resize may take: one rewrite, and one more if the first is refused. */
export const RESIZE_STEPS = 3;

/** What the model is told when the user picks a new width for a widget on Home. */
export function resizePreamble(widget: HomeWidget, from: number, to: number): string {
  const name = widget.title || widget.id;
  return `<home_resize>
The user changed the width of their Home widget "${name}" (id "${widget.id}") from ${from} to ${to} of Home's 4 columns, right on the Home screen. It is already ${to} columns wide, still drawn for ${from}. Nobody is watching. Redesign it for its new width with home_widget, action "set", id "${widget.id}", and nothing else.
Keep its aesthetics: the same colours, gradient or picture, type styles and weights, icons, keys, data and taps. Change only the layout, and what it shows only if it no longer fits: ${to < from ? 'leave out what is least important, not what the widget is about' : 'use the room for what it already says, or a little more of the same data'}. It must fit the ${to < 4 ? SIZE_BUDGETS[to as 1 | 2 | 3].name : 'Full width'} budget in home_widget's size rules${to < 4 ? ` (at most ${SIZE_BUDGETS[to as 1 | 2 | 3].parts} parts and ${SIZE_BUDGETS[to as 1 | 2 | 3].chars} characters${SIZE_BUDGETS[to as 1 | 2 | 3].banned.length ? `, no ${SIZE_BUDGETS[to as 1 | 2 | 3].banned.join(', ')}` : ''})` : ''}: a smaller widget shows less, never the same squeezed in${to === 1 ? '; a small one has no heading and words of a few letters' : ''}.
The widget now:
${JSON.stringify(widget.body)}
Do not look anything up. Then reply with exactly NOTHING_TO_SHARE.
</home_resize>`;
}

/**
 * Starts the run that redesigns a widget for the width the user picked, after setting that width
 * at once. Throws `conflict` while another check-in or brief is going (they share a conversation).
 */
export function startResize(deps: AgentDeps, runs: RunManager, input: { id: string; columns: number; now?: Date }): { widget: HomeWidget; run: Run } {
  const { config, conversations, home } = deps;
  const now = input.now ?? new Date();
  const id = input.id.trim().toLowerCase();
  const widget = home.widgets(now).find((w) => w.id === id);
  if (!widget) throw notFound('Widget');
  if (!Number.isInteger(input.columns) || input.columns < 1 || input.columns > 4) throw badRequest('A widget is 1 to 4 columns wide.');
  if (widget.columns === input.columns) throw conflict(`It is already ${input.columns} column${input.columns === 1 ? '' : 's'} wide`);
  const conversation =
    conversations.findByKind('heartbeat') ?? conversations.create({ kind: 'heartbeat', title: HEARTBEAT_TITLE });
  if (runs.isBusy(conversation.id)) throw conflict(`${AGENT_NAME} is busy with Home right now; try again in a moment`);
  const run = runs.start({
    conversationId: conversation.id,
    text: `Resizing “${widget.title || widget.id}”`,
    preamble: resizePreamble(widget, widget.columns, input.columns),
    resize: { widgetId: id, columns: input.columns },
    origin: 'heartbeat',
    model: config.heartbeat.model,
    timeZone: home.state().timeZone ?? undefined,
  });
  return { widget: home.resize(id, input.columns, run.id, now), run };
}

/** A resize may only write the widget it was started for, at the width the user picked. */
export function checkResizeWidgetCall(resize: { widgetId: string; columns: number }, input: unknown): void {
  const { action = 'set', id = '', columns } = (input ?? {}) as { action?: string; id?: string; columns?: number };
  if (action !== 'set' || String(id).trim().toLowerCase() !== resize.widgetId) {
    throw new Error(`This resize may only write widget "${resize.widgetId}" again, with action "set".`);
  }
  if (columns !== undefined && columns !== resize.columns) {
    throw new Error(`The user chose ${resize.columns} columns; leave \`columns\` out or set it to ${resize.columns}.`);
  }
}

/** What the user sees in place of a typed message at the top of a check-in. */
export function heartbeatText(due: Task[]): string {
  const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
  return `Check-in on ${due.length === 1 ? 'a follow-up' : `${due.length} follow-ups`}:\n${due.map((t) => `- ${clip(t.content)}`).join('\n')}`;
}

/** What the model is told at the top of a check-in. Stored with the message, like any context. */
export function heartbeatPreamble(due: Task[]): string {
  const lines = due.map((t) => {
    const note = t.note ? ` — note: ${t.note}` : '';
    const seen = t.checks > 0 ? ` (looked at ${t.checks} time${t.checks === 1 ? '' : 's'} before)` : '';
    return `- ${t.id}: ${t.content}${note}${seen}`;
  });
  return `<heartbeat>
This is a scheduled check-in, not a message from the user. Nobody is watching right now; the user reads this conversation later. These follow-ups of yours are due:
${lines.join('\n')}

For each one, do what can be done now with your tools. When this check-in ends, each of them is closed automatically. So if one has to be looked at again — it is not finished, or it repeats — move it to its next time with task_update before you finish, with a note on where you got to.
Finish with a short message for the user only if there is something they should know: a result, a reminder that is now due, a question, something blocking you. If there is nothing, reply with just "Nothing to report."
</heartbeat>`;
}

/**
 * The agent's own clock. Due follow-ups take priority, otherwise active interests can start
 * a check-in that decides whether to share anything. With neither, a tick calls no model.
 */
export class Heartbeat {
  private readonly deps: AgentDeps;
  private readonly runs: RunManager;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: AgentDeps, runs: RunManager) {
    this.deps = deps;
    this.runs = runs;
  }

  start(): void {
    const { enabled, intervalMinutes } = this.deps.config.heartbeat;
    if (!enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts a check-in run if anything is due. Never throws: a bad tick must not stop the clock. */
  tick(now: Date = new Date()): Run | null {
    const { config, tasks, conversations, log } = this.deps;
    try {
      if (!config.heartbeat.enabled) return null;
      const due = tasks.due(now, config.heartbeat.maxTasksPerRun);
      if (!due.length && config.heartbeat.brief && this.deps.home.briefDue(now, config.heartbeat.briefHour)) {
        const conversation = conversations.findByKind('heartbeat');
        if (conversation && this.runs.isBusy(conversation.id)) return null;
        const run = startBrief(this.deps, this.runs, { now });
        log.info('heartbeat: Home brief started', { runId: run.id });
        return run;
      }
      const interests = due.length ? [] : this.deps.interests.forHeartbeat(now, config.heartbeat.interestMinutes);
      if (due.length === 0 && interests.length === 0) return null;

      const conversation =
        conversations.findByKind('heartbeat') ?? conversations.create({ kind: 'heartbeat', title: HEARTBEAT_TITLE });
      // The user may be talking there, or the last check-in is still going. The tasks stay due
      // and are picked up by a later tick.
      if (this.runs.isBusy(conversation.id)) {
        // Unless that check-in only waits for a go-ahead nobody has given: then a reminder due
        // now would wait behind it for as long as the user is away. After a while it gives way.
        // Not for its own follow-ups coming due again — that would only ask the same thing anew.
        const held = this.runs.waitingCheckIn(conversation.id);
        const others = held ? due.filter((t) => !held.woken.includes(t.id)) : [];
        if (held && others.length > 0 && now.getTime() - held.since >= config.heartbeat.approvalWaitMinutes * 60_000) {
          // What was waiting behind it starts as soon as it has ended, not a whole interval later.
          void this.runs.activeFor(conversation.id)?.done.then(() => this.tick());
          this.runs.giveUpWaiting(held.runId);
          log.info('heartbeat: a check-in waiting for approval gave way to other follow-ups', { runId: held.runId, waiting: others.length });
        }
        return null;
      }

      const timeZone = due.find((t) => t.timeZone)?.timeZone ?? undefined;
      const { recheckMinutes } = config.heartbeat;
      const run = this.runs.start({
        conversationId: conversation.id,
        text: interests.length ? `${INTERESTS_OPENER}${interests.map((i) => i.topic).join(', ')}` : heartbeatText(due),
        preamble: interests.length ? interestPreamble(interests) : heartbeatPreamble(due),
        interestIds: interests.length ? interests.map((i) => i.id) : undefined,
        interestCheckAt: interests.length ? now.toISOString() : undefined,
        origin: 'heartbeat',
        model: config.heartbeat.model,
        timeZone,
        woken: due.map((t) => ({ id: t.id, updatedAt: t.updatedAt })),
      });
      // Only once the run exists: a tick that could not start one must leave the tasks due.
      // This is also when they come back if the check-in fails or is stopped.
      tasks.markChecked(due.map((t) => t.id), new Date(now.getTime() + recheckMinutes * 60_000));
      log.info('heartbeat: check-in started', { runId: run.id, tasks: due.length });
      void run.done.then(() => {
        this.settle(run, due);
        this.settleInterests(run, interests.map((i) => i.id));
      });
      return run;
    } catch (err) {
      log.error('heartbeat tick failed', { error: errorMessage(err) });
      return null;
    }
  }

  /** Takes over a check-in that an earlier process started, so that it still closes what it was woken for. */
  adopt(run: Run, input: StartRunInput): void {
    const woken = input.woken;
    if (input.origin === 'heartbeat') void run.done.then(() => {
      if (woken) this.settle(run, woken);
      this.settleInterests(run, input.interestIds ?? []);
    });
  }

  private settleInterests(run: Run, ids: string[]): void {
    if (!ids.length || run.status !== 'completed') return;
    try {
      const text = this.deps.conversations.messagesForRun(run.id)
        .filter((m) => m.role === 'assistant' && m.origin === 'heartbeat').map((m) => m.text).filter(Boolean).join('\n');
      this.deps.interests.recordReport(ids, text);
    } catch (err) {
      this.deps.log.error('heartbeat: could not record interest findings', { error: errorMessage(err) });
    }
  }

  /**
   * A check-in that ran to its end has dealt with what it was woken for: every task the agent
   * did not move or edit is closed. Closing is the default, rather than a tool call the agent
   * has to remember, because a forgotten one would repeat the same check-in (and the same
   * message to the user) every `recheckMinutes`. A failed, stopped or cut-short run closes nothing.
   */
  private settle(run: Run, woken: Array<Pick<Task, 'id' | 'updatedAt'>>): void {
    const { tasks, log } = this.deps;
    // Nor does one whose request for a go-ahead went unanswered: what it was woken for is not done.
    if (run.status !== 'completed' || run.finishReason === 'step-limit' || run.unanswered) return;
    try {
      for (const before of woken) {
        const task = tasks.get(before.id);
        if (task?.status === 'open' && task.updatedAt === before.updatedAt) tasks.update(task.id, { status: 'done' });
      }
    } catch (err) {
      log.error('heartbeat: could not settle tasks', { runId: run.id, error: errorMessage(err) });
    }
  }
}
