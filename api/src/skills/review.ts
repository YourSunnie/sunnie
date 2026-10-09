import { generateText } from 'ai';
import type { InspectedSkill } from '../../skills/protocol.ts';
import type { ResolvedModel } from '../models/registry.ts';
import { skillPrograms, type SkillScreening } from '../router/skill-screen.ts';
import { AGENT_NAME } from '../config.ts';
import { errorMessage, type Logger } from '../util/log.ts';

/** What the person deciding on an install is shown: plain words, not a repository and a path. */
export interface SkillReview {
  /** Markdown: what it is, why it was chosen, what it helps with, what it can reach. */
  summary: string;
  /** Jev found it unsuitable, harmful or untrustworthy, or could not check it. */
  caution: boolean;
  /** Whether Jev looked at it at all. */
  checked: boolean;
}

const EXPLAIN_TIMEOUT_MS = 30_000;

const INSTRUCTIONS = `You explain an add-on, called a skill, to someone who is not technical, so that they can decide whether ${AGENT_NAME}, their personal assistant, may add it. A skill is a set of written instructions, sometimes with small helper programs, that ${AGENT_NAME} follows for one kind of task.

Write four short parts, each starting on its own line with its label in bold, and nothing else:
**What it is** — one sentence.
**Why ${AGENT_NAME} picked it** — one sentence, from the reason given, addressed to the user ("you").
**What it helps with** — one sentence with an everyday example.
**What it can reach** — one or two sentences, from the facts given only: adding it only copies it to ${AGENT_NAME}'s own computer and runs nothing; when ${AGENT_NAME} uses it, it can do no more than ${AGENT_NAME} already can, and anything that acts for the user (sending, buying, deleting) still asks them first. Say so if it comes with helper programs.
When the check found a problem, add a fifth part, **Heads-up**, saying in one sentence what it is.

Plain, warm, short: no technical words (no repository, GitHub, code, script, file names, commit, install path), under 110 words in all. Use only the facts given; never invent what the skill does.`;

/** The facts the explanation is written from, so that the model has nothing to guess. */
function facts(skill: InspectedSkill, why: string, screening: SkillScreening): string {
  const programs = skillPrograms(skill);
  const owner = /^https:\/\/[^/]+\/([^/]+)/.exec(skill.source.repository)?.[1] ?? skill.source.repository;
  const check = !screening.judged
    ? (screening.failed ? 'The safety check could not be done this time.' : 'No safety check is set up.')
    : [
        screening.suitable < 0.5 ? 'It may not fit this user.' : 'It fits this user.',
        screening.harmful >= 0.5 ? 'It may be harmful: it could reach beyond its task or put private data at risk.' : 'Nothing harmful was found.',
        screening.trustworthy < 0.5 ? 'Its publisher could not be trusted.' : 'Its publisher looks trustworthy.',
      ].join(' ');
  return [
    `Skill name: ${skill.name}`,
    `What it says it does: ${skill.description}`,
    `${AGENT_NAME}'s reason for choosing it: ${why || '(none given)'}`,
    `Published by: ${owner}`,
    `Helper programs: ${programs.length ? `${programs.length}, which ${AGENT_NAME} could run on its own computer when following it` : 'none: written instructions only'}`,
    `Safety check: ${check}`,
    `Its instructions begin:\n${skill.content.slice(0, 3000)}`,
  ].join('\n');
}

/** Said without a model: the same parts, from the facts alone. */
function plainFallback(skill: InspectedSkill, why: string, screening: SkillScreening, caution: boolean): string {
  const programs = skillPrograms(skill).length > 0;
  return [
    `**What it is** — A skill called “${skill.name}”: ${skill.description}`,
    `**Why ${AGENT_NAME} picked it** — ${why || 'It looked useful for what you do.'}`,
    `**What it can reach** — Adding it only copies it to ${AGENT_NAME}'s own computer${programs ? ', with a few helper programs' : ''}; nothing runs. It can do no more than ${AGENT_NAME} already can, and anything that acts for you still asks you first.`,
    ...(caution ? [`**Heads-up** — ${screening.judged ? 'The safety check found something that needs a look before you allow it.' : 'It could not be checked this time.'}`] : []),
  ].join('\n');
}

/** Writes the review shown with an install approval. Never throws: without a model, the plain fallback. */
export async function explainSkill(opts: {
  model: ResolvedModel;
  skill: InspectedSkill;
  why: string;
  screening: SkillScreening;
  caution: boolean;
  /** The conversation it is for: the provider's cache key, as for any call in it. */
  sessionId: string;
  log: Logger;
  signal?: AbortSignal;
}): Promise<SkillReview> {
  const { skill, why, screening, caution } = opts;
  const checked = screening.judged;
  try {
    const { text } = await generateText({
      model: opts.model.model,
      instructions: INSTRUCTIONS,
      prompt: facts(skill, why, screening),
      abortSignal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(EXPLAIN_TIMEOUT_MS)]),
      ...opts.model.callOptions({ sessionId: opts.sessionId }),
    });
    if (!text.trim()) throw new Error('the model wrote nothing');
    return { summary: text.trim().slice(0, 2000), caution, checked };
  } catch (err) {
    if (!opts.signal?.aborted) opts.log.warn('could not write the skill review; using the plain one', { skill: skill.name, error: errorMessage(err) });
    return { summary: plainFallback(skill, why, screening, caution), caution, checked };
  }
}
