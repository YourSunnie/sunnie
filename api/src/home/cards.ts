import { display, interpolate, type StateValue } from './formula.ts';
import { initialState, parseWidgetBody, type WidgetBody } from './widgets.ts';

// The `widget` blocks in a reply's text: what the app draws as interactive cards. A reply's text is
// never rewritten once stored (invariant 4), so a card is addressed by its message and its place
// among that message's widget blocks, and what the user changes in it is kept beside it.

export interface WidgetBlock {
  /** Its place among the message's widget blocks, from 0. */
  index: number;
  json: string;
  /** Where the block's JSON starts and ends in the text. */
  start: number;
  end: number;
}

/** The ```widget blocks in a text, in order, as the app's Markdown reader finds them. */
export function widgetBlocks(text: string): WidgetBlock[] {
  const blocks: WidgetBlock[] = [];
  const fence = /^[ \t]*```[ \t]*widget[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (const m of text.matchAll(fence)) {
    const start = m.index + m[0].indexOf(m[1]!);
    blocks.push({ index: blocks.length, json: m[1]!.replace(/\r?\n$/, ''), start, end: start + m[1]!.replace(/\r?\n$/, '').length });
  }
  return blocks;
}

/** The card's body, or null when the block is not a widget the app would draw. */
export function cardBody(text: string, index: number): WidgetBody | null {
  const block = widgetBlocks(text)[index];
  if (!block) return null;
  try { return parseWidgetBody(block.json); }
  catch { return null; }
}

interface InputPart { type: string; bind: string; min?: number; max?: number; options?: Array<{ value: string }>; items?: Array<{ title: string }>; label?: string }

function inputs(body: WidgetBody): InputPart[] {
  const found: InputPart[] = [];
  const walk = (n: unknown) => {
    const p = n as InputPart & { children?: unknown[] };
    if (p.bind) found.push(p);
    p.children?.forEach(walk);
  };
  walk(body);
  return found;
}

/**
 * The state the app sent, checked against the card: only names the card has, each of the kind its
 * input sets and within its range. Throws an `Error` saying what is wrong.
 */
export function checkCardState(body: WidgetBody, state: Record<string, unknown>): Record<string, StateValue> {
  const start = initialState(body);
  const byName = new Map(inputs(body).map((p) => [p.bind, p]));
  const out: Record<string, StateValue> = {};
  for (const [name, value] of Object.entries(state)) {
    if (!(name in start)) throw new Error(`The card has no value named "${name}".`);
    const input = byName.get(name);
    const was = start[name];
    if (Array.isArray(was)) {
      if (!Array.isArray(value) || value.length !== was.length || !value.every((v) => typeof v === 'boolean')) {
        throw new Error(`"${name}" is a checklist of ${was.length} items: one true or false each.`);
      }
    } else if (typeof value !== typeof was) {
      throw new Error(`"${name}" is a ${typeof was}.`);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || (input?.min !== undefined && value < input.min) || (input?.max !== undefined && value > input.max)) {
        throw new Error(`"${name}" is outside its range.`);
      }
    } else if (typeof value === 'string') {
      if (input?.options && !input.options.some((o) => o.value === value)) throw new Error(`"${name}" is not one of its choices.`);
      if (value.length > 200) throw new Error(`"${name}" is too long.`);
    }
    out[name] = value as StateValue;
  }
  return out;
}

/** What the user did with a card, in words for the model: "people: 6; done: 3 of 8 (Prepare the lamb, …)". */
export function describeCardState(body: WidgetBody, state: Record<string, StateValue>): string {
  const byName = new Map(inputs(body).map((p) => [p.bind, p]));
  return Object.entries(state).map(([name, value]) => {
    const input = byName.get(name);
    const label = input?.label ? `${name} (${input.label})` : name;
    if (Array.isArray(value)) {
      const ticked = (input?.items ?? []).filter((_, i) => value[i]).map((item) => item.title);
      return `${label}: ${ticked.length} of ${value.length} ticked${ticked.length ? ` (${ticked.join('; ')})` : ''}`;
    }
    return `${label}: ${display(value)}`;
  }).join('; ');
}

/**
 * A card as it stands, ready to be a Home widget: each input starts where the user left it, a
 * name no input sets keeps its value in "state", and a "reply" (which needs the card's chat)
 * becomes an "ask", which opens a chat with the words ready to send.
 */
export function pinnable(body: WidgetBody, state: Record<string, StateValue>): { body: WidgetBody; title: string } {
  const out = structuredClone(body) as Record<string, unknown>;
  const bound = new Set<string>();
  let title = '';
  const walk = (n: unknown) => {
    const p = n as Record<string, unknown> & { children?: unknown[]; items?: Array<Record<string, unknown>> };
    const bind = p.bind as string | undefined;
    if (bind) {
      bound.add(bind);
      if (bind in state) p.value = state[bind];
    }
    if (!title && (p.type === 'text' || p.type === 'stat')) title = interpolate(String(p.type === 'text' ? p.text : (p.label ?? p.value)), state);
    const swap = (holder: Record<string, unknown>) => {
      const a = holder.action as { type?: string; text?: string } | undefined;
      if (a?.type === 'reply') holder.action = { type: 'ask', prompt: a.text };
    };
    swap(p);
    p.items?.forEach(swap);
    p.children?.forEach(walk);
  };
  walk(out);
  const loose = Object.fromEntries(Object.entries(state).filter(([name, value]) => !bound.has(name) && !Array.isArray(value)));
  if (Object.keys(loose).length) out.state = { ...((out.state as object | undefined) ?? {}), ...loose };
  return { body: parseWidgetBody(out), title: title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Pinned card' };
}
