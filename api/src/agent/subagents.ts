import { endBrowserSession } from '../tools/browser-tools.ts';
import { newId } from '../util/ids.ts';
import { errorMessage } from '../util/log.ts';
import type { AgentDeps, TurnInput, TurnResult } from './agent.ts';
import type { AgentEvent, Emit, RunUsage } from './events.ts';

/** What a helper's work is done on behalf of: the turn that sent it. */
export interface HelperContext {
  /** The tool call the work is the result of. */
  toolCallId: string;
  /** The conversation whose turn it is. */
  parentId: string;
  /** The model of that turn; helpers use it unless `subagents.model` names another. */
  model: string;
  timeZone?: string;
  /** The parent run's signal: cancelling the run stops its helpers. */
  signal: AbortSignal;
  /** The parent run's event stream. */
  emit: Emit;
  /** The parent run's usage; what the helpers spend is added to it. */
  usage: RunUsage;
}

export interface DelegateInput extends HelperContext {
  /** One per helper; each is the whole of what that helper is told. */
  tasks: string[];
  /**
   * Whether these helpers may hand in a question instead of a result. Off unless the agent that
   * sends them says otherwise: a helper is meant to be sent and forgotten until it reports.
   */
  allowQuestions: boolean;
}

export interface MessageInput extends HelperContext {
  /** The id of a helper sent earlier from this conversation, as its report gave it. */
  helper: string;
  message: string;
}

interface Outcome {
  status: 'completed' | 'cancelled' | 'failed';
  report: string;
}

type Run = (deps: AgentDeps, input: TurnInput) => Promise<TurnResult>;

const title = (task: string) => {
  const flat = task.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/**
 * The permission to come back with a question. It rides on the task, not in the system prompt,
 * which is the same for every helper (and so shares a cached prefix).
 */
const MAY_ASK =
  '[For this task you may come back with a question. If you cannot go on without something only the agent you ' +
  'report to or the user can settle, do everything that does not depend on it, then end your report with the one ' +
  'question that settles it. You will be sent the answer and carry on from where you stopped.]';

/** Helpers in the middle of a turn; a helper has one conversation and so does one thing at a time. */
const atWork = new Set<string>();

/**
 * One turn of a helper: `text` is its task, or a later message from the agent that sent it. The
 * turn is the ordinary loop in the helper's own conversation (kind `subagent`), so everything a
 * turn has — the router, the risk filter, retries, a stored transcript — a helper has too.
 * Never throws.
 */
async function work(
  deps: AgentDeps,
  run: Run,
  ctx: HelperContext,
  agentId: string,
  index: number,
  text: string,
  preamble?: string,
): Promise<Outcome> {
  const { config, conversations, computer, log } = deps;
  const { signal, emit } = ctx;
  atWork.add(agentId);
  emit({ type: 'subagent.started', toolCallId: ctx.toolCallId, agentId, index, task: text });

  let usedBrowser = false;
  // Of all a helper does, the client is told which tools it calls. A helper speaks to the agent
  // that sent it, never to the user: with no `confirm`, a held call is declined (see runTurn)
  // and comes back in the report.
  const forward = (event: AgentEvent) => {
    if (event.type !== 'tool.call') return;
    usedBrowser ||= event.name.startsWith('browser_');
    emit({ type: 'subagent.tool', agentId, name: event.name, input: event.input });
  };

  let outcome: Outcome;
  let steps = 0;
  let error: string | undefined;
  try {
    const result = await run(deps, { conversationId: agentId, runId: newId('run'), text, preamble, timeZone: ctx.timeZone, signal, emit: forward });
    steps = result.steps;
    for (const key of Object.keys(result.usage) as Array<keyof RunUsage>) ctx.usage[key] += result.usage[key];
    const last = conversations.listMessages(agentId, { limit: 1 })[0];
    const said = last?.role === 'assistant' ? last.text.trim() : '';
    outcome =
      result.status === 'cancelled'
        ? { status: 'cancelled', report: 'Stopped before it finished.' }
        : { status: 'completed', report: said || 'Finished without writing a report.' };
  } catch (err) {
    error = errorMessage(err);
    log.warn('helper failed', { agentId, error });
    outcome = { status: signal.aborted ? 'cancelled' : 'failed', report: `Could not do this: ${error}` };
  }
  // The helper's tabs would otherwise stay open until the browser idles out.
  if (usedBrowser) await endBrowserSession({ computer, config: config.browser }, agentId);
  atWork.delete(agentId);
  emit({ type: 'subagent.finished', agentId, status: outcome.status, steps, error });
  return outcome;
}

function capped(report: string, max: number): string {
  return report.length > max ? `${report.slice(0, max)} … [report cut: ${report.length - max} more characters]` : report;
}

/**
 * Sends one helper per task, at most `subagents.concurrency` at work at once, and returns their
 * reports as one text for the agent that sent them. Each report is headed by the helper's id,
 * which is what `messageHelper` answers it by. Throws only when not one helper came back with
 * anything.
 *
 * `run` is the turn loop, passed in because the turn loop is also what calls this.
 */
export async function runHelpers(deps: AgentDeps, run: Run, input: DelegateInput): Promise<string> {
  const { config, conversations } = deps;
  const { tasks, signal } = input;
  const limits = config.subagents;

  const ids = new Array<string>(tasks.length);
  const outcomes = new Array<Outcome>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !signal.aborted) {
      const index = next++;
      const task = tasks[index]!;
      ids[index] = conversations.create({
        kind: 'subagent',
        parentId: input.parentId,
        title: title(task),
        model: limits.model ?? input.model,
        reasoning: limits.model ? null : conversations.get(input.parentId)?.reasoning,
      }).id;
      outcomes[index] = await work(deps, run, input, ids[index]!, index, task, input.allowQuestions ? MAY_ASK : undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, tasks.length) }, worker));

  if (signal.aborted) throw new Error('The helpers were stopped because the run was cancelled.');
  const failed = outcomes.filter((o) => o.status !== 'completed');
  if (failed.length === outcomes.length) {
    throw new Error(
      `None of the helpers could do its task (${[...new Set(failed.map((o) => o.report))].join(' | ')}). ` +
        'Do the work yourself, a piece at a time.',
    );
  }

  const sections = outcomes.map(
    (o, i) =>
      `## Helper ${i + 1} (id: ${ids[i]})${o.status === 'completed' ? '' : ' (failed)'}\nTask: ${title(tasks[i]!)}\n\n` +
      capped(o.report, limits.maxReportChars),
  );
  const note =
    failed.length > 0
      ? `${failed.length} of ${outcomes.length} helpers did not finish; do those pieces yourself if the answer needs them.\n\n`
      : '';
  return `${note}${sections.join('\n\n')}`;
}

/**
 * The way back to a helper: the agent's answer to a question it reported with, or what it was
 * missing. It is the next message in the helper's own conversation, so the helper carries on
 * with everything it has already found. Answers with the helper's new report; errors are
 * written for the model.
 */
export async function messageHelper(deps: AgentDeps, run: Run, input: MessageInput): Promise<string> {
  const { conversations, config } = deps;
  const id = input.helper.trim();
  const helper = conversations.get(id);
  if (!helper || helper.kind !== 'subagent' || helper.parentId !== input.parentId) {
    const known = conversations.children(input.parentId).map((c) => `${c.id} (${c.title ?? 'untitled'})`);
    throw new Error(
      `There is no helper "${id}" in this conversation. ` +
        (known.length > 0 ? `Helpers that have reported here: ${known.join('; ')}.` : 'No helper has been sent yet; use delegate.'),
    );
  }
  if (atWork.has(id)) throw new Error(`Helper ${id} is still working. Wait for its report before sending it another message.`);

  const outcome = await work(deps, run, input, id, 0, input.message);
  if (input.signal.aborted) throw new Error('The helper was stopped because the run was cancelled.');
  if (outcome.status !== 'completed') throw new Error(`The helper did not finish. ${outcome.report} Do this piece yourself if the answer needs it.`);
  return `## Helper (id: ${id})\n\n${capped(outcome.report, config.subagents.maxReportChars)}`;
}
