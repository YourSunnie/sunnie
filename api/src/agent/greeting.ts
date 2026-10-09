import { AGENT_NAME } from '../config.ts';
import { conflict } from '../util/errors.ts';
import type { AgentDeps } from './agent.ts';
import type { Run, RunManager } from './runs.ts';

/** What the hidden message that opens the greeting says; the app does not draw it. */
export const GREETING_OPENER = 'Connected for the first time';
export const GREETING_TITLE = 'Getting to know you';

/**
 * What the model is told when it meets its user. Stored with the opening message, so the later
 * turns of the introduction (the user's name, what they do) still have it in view.
 */
export function greetingPreamble(opts: { skills: boolean }): string {
  const skills = opts.skills
    ? `   - Look for one to three Agent Skills that would help with that work. Look in the open skills directory first, as your Agent Skills instructions say, read the SKILL.md and its licence, and pick only ones whose licence lets the user use them here, from a publisher you can tell is real. Give each install your reason in plain words (its why): the user is shown what the skill is and why you chose it, and approves it when it needs approval. If nothing published fits, write one small skill yourself with skill_write for the work they will most often bring you (for example a weekly report for an employee, or turning lecture notes into revision cards for a student).
`
    : '';
  return `<greeting>
Your user has just connected the app to you for the first time. You have never met: they have not written anything yet, and you speak first. This conversation is how you get to know them, one short message at a time.

1. Now: say hello and introduce yourself as ${AGENT_NAME}, their own assistant. Say that you are happy to meet them and would like to get to know them, then ask what you should call them. Two or three short sentences, no list of what you can do. For example: "Hi! I'm ${AGENT_NAME}, and I'm so happy we get to meet ^^ I'd like to get to know you a little. What should I call you?"
2. When they tell you their name, write it to the user block of your core memory, greet them by it, say that as their assistant you can help with a lot, and ask which of these describes them best, with a choices block: Student, Employee, Business owner, Artist.
3. Then ask the one follow-up that fits their answer, so that you can set things up for them: a student, what and where they study; an employee, which company they work for and their role; a business owner, what the business does; an artist, what they make. For anything else, what they do day to day. Say that you will set things up for them. Offer a choices block whenever the likely answers are few.
4. Once you know what they do, set yourself up for it:
   - Write who they are to your core memory, and the details with memory_save.
${skills}   - Then tell them in a few lines what you set up, and two or three things they could ask you today that fit their work, and call introduction_done in the same turn: until then the app shows them only this chat. No question is needed.
For this introduction you may be a little more cheerful than usual. Ask one thing at a time, never a form. If they would rather not say, or ask for something else, let it go and help them with that: you will learn the rest as you go. These steps are for this introduction only.
</greeting>`;
}

/**
 * Typed replies an introduction lasts at most, and hours: past either, it is over even if the agent
 * never said so, so that nobody is kept in it. The router keeps the greeting in view as long.
 */
export const INTRODUCTION_TURNS = 5;
const INTRODUCTION_HOURS = 24;

/** Whether the introduction is going on: the app then shows the user only its chat. */
export function introducing(deps: AgentDeps, now: Date = new Date()): boolean {
  const intro = deps.conversations.introduction();
  if (!intro || intro.finishedAt) return false;
  if (now.getTime() - Date.parse(intro.startedAt) > INTRODUCTION_HOURS * 3_600_000) return false;
  return deps.conversations.typedCount(intro.conversationId) <= INTRODUCTION_TURNS;
}

/**
 * The greeting each run manager has started. Its opening message is stored only once the turn
 * gets going, so until then this is what keeps a second request from greeting twice.
 */
const started = new WeakMap<RunManager, string>();

/** The user skipped the rest of the introduction (the app's menu). */
export function finishIntroduction(deps: AgentDeps): void {
  deps.conversations.finishIntroduction();
}

/** Whether a client should start the greeting: nobody has met this user yet. */
export function greetingPending(deps: AgentDeps, runs: RunManager): boolean {
  const greeting = started.get(runs);
  if (greeting && runs.get(greeting)?.status === 'running') return false;
  return !deps.conversations.hasMetUser();
}

/**
 * Opens the user's first chat: a new conversation in which the agent speaks first. Throws
 * `conflict` once the agent has met them, so a second device or a retry cannot greet twice.
 */
export function startGreeting(deps: AgentDeps, runs: RunManager, opts: { timeZone?: string } = {}): { conversationId: string; run: Run } {
  if (!greetingPending(deps, runs)) throw conflict(`${AGENT_NAME} has already met you`);
  const conversation = deps.conversations.create({ kind: 'chat', title: GREETING_TITLE });
  const run = runs.start({
    conversationId: conversation.id,
    text: GREETING_OPENER,
    preamble: greetingPreamble({ skills: deps.config.skills.enabled }),
    origin: 'greeting',
    timeZone: opts.timeZone,
  });
  started.set(runs, run.id);
  deps.conversations.startIntroduction(conversation.id);
  return { conversationId: conversation.id, run };
}
