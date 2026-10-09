import { generateText } from 'ai';
import { widgetBlocks } from '../home/cards.ts';
import { parseWidgetBody } from '../home/widgets.ts';
import type { ResolvedModel } from '../models/registry.ts';
import { errorMessage, type Logger } from '../util/log.ts';

const REPAIR_TIMEOUT_MS = 25_000;

const INSTRUCTIONS = `You fix one card that a chat reply draws: a JSON widget body for the app. You are given the JSON and what is wrong with it. Answer with the corrected JSON object only — no code fence, no words — keeping everything the card shows and does, and changing only what the problem needs. If a formula names something nothing sets, add an input or a "state" entry on the outermost part for it, or drop the formula.`;

/**
 * Common slips a model makes in JSON, fixed without asking anyone: trailing commas, a missing
 * closing bracket at the very end.
 */
function tidy(json: string): string {
  let out = json.trim();
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (!inString) out += stack.reverse().join('');
  return out.replace(/,\s*([}\]])/g, '$1');
}

function problem(json: string): string | null {
  try { parseWidgetBody(json); return null; }
  catch (err) { return errorMessage(err); }
}

/**
 * The reply's text with every widget block the app could not draw fixed, before the step is
 * stored: first the slips anyone can fix, then one short call to the conversation's model per
 * broken card. A card that still does not read is left as it was (the app shows what it can).
 * Never throws.
 */
export async function repairCards(text: string, opts: { model: ResolvedModel; sessionId: string; log: Logger; signal?: AbortSignal }): Promise<string> {
  const blocks = widgetBlocks(text);
  if (!blocks.length) return text;
  let out = text;
  // From the last block back, so earlier offsets stay right.
  for (const block of [...blocks].reverse()) {
    const wrong = problem(block.json);
    if (!wrong) continue;
    let fixed: string | null = null;
    const tidied = tidy(block.json);
    if (!problem(tidied)) fixed = tidied;
    else {
      try {
        const { text: answer } = await generateText({
          model: opts.model.model,
          instructions: INSTRUCTIONS,
          prompt: `The card:\n${block.json.slice(0, 32_000)}\n\nWhat is wrong:\n${wrong.slice(0, 2000)}`,
          abortSignal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(REPAIR_TIMEOUT_MS)]),
          ...opts.model.callOptions({ sessionId: opts.sessionId }),
        });
        const candidate = answer.trim().replace(/^```(?:json|widget)?\s*\n?|\n?```$/g, '').trim();
        if (!problem(candidate)) fixed = JSON.stringify(JSON.parse(candidate));
        else opts.log.warn('a card could not be repaired; kept as written', { error: wrong.slice(0, 300) });
      } catch (err) {
        if (!opts.signal?.aborted) opts.log.warn('card repair failed; kept as written', { error: errorMessage(err) });
      }
    }
    if (fixed !== null) out = out.slice(0, block.start) + fixed + out.slice(block.end);
  }
  return out;
}
