import { z } from 'zod';
import { evaluate, formulaNames, formulasIn, parseFormula, type StateValue } from './formula.ts';

// What a Home widget may be made of. The app draws these and nothing else, so this file is the
// contract: a new primitive or style is added here, in the `home_widget` description, in the
// README and in the app's `WidgetNode` together. The app skips a type it does not know.

/** Models write numbers where text is meant ("value": 8412); both are taken. */
const str = (max: number) =>
  z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(max));

export const COLOR_NAMES = [
  'primary', 'secondary', 'tertiary', 'accent', 'petal', 'white', 'black', 'gray',
  'red', 'orange', 'yellow', 'green', 'mint', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown',
] as const;

/** A name the app knows, or a hex colour: #RGB, #RRGGBB or #RRGGBBAA. */
const color = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (c) => (COLOR_NAMES as readonly string[]).includes(c) || /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(c),
    { message: `a colour is one of ${COLOR_NAMES.join(', ')}, or hex such as #1F6FEB` },
  );

/**
 * A file or folder in the user's Drive, as a `drive` card names it: relative to ~/Drive, no
 * leading slash, no parent segments. The app opens it through the Drive API, which enforces the
 * boundary; this only keeps obviously wrong paths out. An attachment's Drive copy reaches the
 * model as an absolute path (/home/…/Drive/Uploads/…), so everything up to the first `Drive/`
 * is dropped.
 */
const drivePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .transform((p) => p.replace(/^(?:~\/|\/(?:[^/]+\/)*?)?Drive\//, ''))
  .refine((p) => !p.startsWith('/') && !p.startsWith('~') && !/[\\\x00-\x1f\x7f]/.test(p) && p.split('/').every((s) => s && s !== '.' && s !== '..'), {
    message: 'a Drive path is relative to ~/Drive, such as Trips/ticket.pdf: no leading slash, no "..", no URL',
  });

export const widgetAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open_url'), url: z.url({ protocol: /^https$/ }).max(2000) }),
  z.object({ type: z.literal('open_chat'), conversationId: str(80) }),
  /** Opens a new chat with this in the composer; the user sends it. */
  z.object({ type: z.literal('ask'), prompt: str(1000) }),
  /** Opens a file or folder of the user's Drive in the app. */
  z.object({ type: z.literal('open_file'), path: drivePath }),
  /**
   * Sends these words as the user's message in the chat the card is in, as a quick reply does (the
   * user decided, 2026-10-08). Chat cards only: Home keeps to `ask`.
   */
  z.object({ type: z.literal('reply'), text: str(1000) }),
  /** Puts the words on the clipboard. */
  z.object({ type: z.literal('copy'), text: str(4000) }),
  /** Offers the event to the user's calendar, as an `event` card does. Times are "YYYY-MM-DD HH:MM", local. */
  z.object({
    type: z.literal('calendar'),
    title: str(200),
    start: str(40),
    end: str(40).optional(),
    place: str(200).optional(),
    note: str(400).optional(),
  }),
]);
export type WidgetAction = z.infer<typeof widgetAction>;

/** How any node may be dressed. Everything is optional; a bare node looks like plain iOS. */
const style = {
  /** Text, icon and accent colour of this node and what it holds. */
  color: color.optional(),
  background: color.optional(),
  /** Two or three colours; wins over `background`. */
  gradient: z.array(color).min(2).max(3).optional(),
  direction: z.enum(['down', 'right', 'diagonal']).optional(),
  padding: z.number().min(0).max(40).optional(),
  corner: z.number().min(0).max(40).optional(),
  border: color.optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** Where the node sits in the width it is given. */
  align: z.enum(['leading', 'center', 'trailing']).optional(),
  /** In a row: take only the width it needs instead of an equal share. */
  fit: z.boolean().optional(),
  height: z.number().min(1).max(480).optional(),
  /**
   * A picture from Drive behind the part, filling it and cropped to it. `background` or
   * `gradient` is drawn over it, so a translucent one keeps text on the picture readable.
   */
  backgroundImage: drivePath.optional(),
};

/**
 * Any part but a spacer may have a `key`: a name for it, so that its data can be changed later
 * (`applyValues`) without writing the widget again and losing how it looks.
 */
const PART_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const part = {
  ...style,
  key: z.string().trim().toLowerCase().regex(PART_KEY, { message: 'a key is a short name: lowercase letters, digits, "-" or "_"' }).optional(),
  /** A formula: the part is drawn only while it is true, e.g. `tab == 'frame'`. */
  when: z.string().trim().min(1).max(300).optional(),
};

/** A name in the widget's state, which inputs set and formulas read. */
const STATE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const stateName = z.string().trim().regex(STATE_NAME, { message: 'a state name is lowercase letters, digits and "_", starting with a letter, such as "people"' });

/** A number, or a formula that gives one ("{done / 8}", or without the braces). */
const amount = (min: number, max: number) => z.union([z.number().min(min).max(max), z.string().trim().min(1).max(300)]);

const TEXT_STYLES = ['largeTitle', 'title', 'title2', 'title3', 'headline', 'subheadline', 'body', 'callout', 'footnote', 'caption'] as const;

const leaves = [
  z.object({
    ...part,
    type: z.literal('text'),
    text: str(600),
    style: z.enum(TEXT_STYLES).optional(),
    /** A point size, for type larger or smaller than the named styles. */
    size: z.number().min(8).max(96).optional(),
    weight: z.enum(['light', 'regular', 'medium', 'semibold', 'bold', 'heavy']).optional(),
    /** "serif" is still read, from widgets written before the user ruled it out, and dropped. */
    design: z.enum(['default', 'rounded', 'serif', 'monospaced']).optional().transform((d) => (d === 'serif' ? undefined : d)),
    lines: z.number().int().min(1).max(20).optional(),
    /** Kept from the first version; `color` says the same. */
    tone: z.enum(['primary', 'secondary', 'accent']).optional(),
  }),
  z.object({ ...part, type: z.literal('markdown'), text: str(4000) }),
  z.object({
    ...part,
    type: z.literal('stat'),
    value: str(40),
    label: str(60).optional(),
    unit: str(20).optional(),
    caption: str(120).optional(),
    icon: str(60).optional(),
  }),
  z.object({ ...part, type: z.literal('fields'), items: z.array(z.object({ label: str(60), value: str(200) })).min(1).max(12) }),
  z.object({
    ...part,
    type: z.literal('list'),
    items: z
      .array(z.object({
        title: str(200),
        subtitle: str(200).optional(),
        value: str(40).optional(),
        icon: str(60).optional(),
        action: widgetAction.optional(),
      }))
      .min(1)
      .max(20),
  }),
  z.object({ ...part, type: z.literal('progress'), value: amount(0, 1), label: str(60).optional(), caption: str(120).optional() }),
  /** A ring that fills to `value`, with `label` in its middle. */
  z.object({
    ...part,
    type: z.literal('gauge'),
    value: amount(0, 1),
    label: str(20).optional(),
    caption: str(60).optional(),
    size: z.number().min(32).max(200).optional(),
  }),
  z.object({
    ...part,
    type: z.literal('chart'),
    kind: z.enum(['line', 'bar', 'area']).default('line'),
    values: z.array(z.number()).min(2).max(60),
    labels: z.array(str(20)).max(60).optional(),
    caption: str(120).optional(),
  }),
  z.object({ ...part, type: z.literal('icon'), name: str(60), size: z.number().min(8).max(96).optional(), tone: z.enum(['primary', 'secondary', 'accent']).optional() }),
  /** A short label in a tinted capsule. */
  z.object({ ...part, type: z.literal('badge'), text: str(40), icon: str(60).optional() }),
  /** A picture from the user's Drive. The app loads no image from anywhere else. */
  z.object({ ...part, type: z.literal('image'), path: drivePath, mode: z.enum(['fill', 'fit']).optional() }),
  /** A button: what a tap does is its `action`, which the user chose by asking for it. */
  z.object({
    ...part,
    type: z.literal('button'),
    text: str(60),
    icon: str(60).optional(),
    action: widgetAction,
    variant: z.enum(['filled', 'tinted', 'plain']).optional(),
  }),
  /** A file or folder of the user's Drive, as a row that opens it. */
  z.object({ ...part, type: z.literal('file'), path: drivePath, title: str(120).optional(), caption: str(120).optional() }),
  /** Counts down to (or up from) a moment, live on the screen. */
  z.object({
    ...part,
    type: z.literal('countdown'),
    to: z.iso.datetime({ offset: true }).transform((at) => new Date(at).toISOString()),
    label: str(60).optional(),
    style: z.enum(TEXT_STYLES).optional(),
  }),
  z.object({ ...part, type: z.literal('divider') }),
  // Inputs: each sets one name in the widget's state (`bind`), which formulas elsewhere read.
  // `value` is where it starts; the user's changes are kept.
  /** − and + buttons around a number. */
  z.object({
    ...part,
    type: z.literal('stepper'),
    bind: stateName,
    value: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    label: str(60).optional(),
    unit: str(20).optional(),
  }),
  z.object({
    ...part,
    type: z.literal('slider'),
    bind: stateName,
    value: z.number().optional(),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
    label: str(60).optional(),
    unit: str(20).optional(),
  }),
  z.object({ ...part, type: z.literal('toggle'), bind: stateName, value: z.boolean().optional(), label: str(80) }),
  /** One of a few choices, side by side: tabs, with `when` on the parts each one shows. */
  z.object({
    ...part,
    type: z.literal('segmented'),
    bind: stateName,
    options: z
      .array(z.union([str(30).transform((v) => ({ value: v, label: v })), z.object({ value: str(30), label: str(30).optional() })]))
      .min(2)
      .max(6)
      .transform((options) => options.map((o) => ({ value: o.value, label: o.label ?? o.value }))),
    value: str(30).optional(),
  }),
  /**
   * Things to tick off. Items with a `time` are drawn as a timeline. Its name in formulas is how
   * many are ticked.
   */
  z.object({
    ...part,
    type: z.literal('checklist'),
    bind: stateName,
    items: z.array(z.object({ title: str(200), detail: str(400).optional(), time: str(30).optional() })).min(1).max(30),
    caption: str(120).optional(),
    /** Which items start ticked, one true or false each. */
    value: z.array(z.boolean()).max(30).optional(),
  }),
  z.object({
    ...part,
    type: z.literal('table'),
    columns: z.array(str(40)).min(1).max(6),
    rows: z.array(z.array(str(200)).min(1).max(6)).max(30),
    caption: str(120).optional(),
  }),
  /** Pushes its neighbours apart in a row or stack. */
  z.object({ type: z.literal('spacer') }),
] as const;

type Leaf = z.infer<(typeof leaves)[number]>;
type Style = { [K in keyof typeof part]?: z.infer<(typeof part)[K]> };
type Container = Style & { children: WidgetNode[]; spacing?: number; action?: WidgetAction; state?: Record<string, number | string | boolean> };
export type WidgetNode =
  | Leaf
  | (Container & { type: 'row'; valign?: 'top' | 'center' | 'bottom' | 'baseline' })
  | (Container & { type: 'stack' })
  | (Container & { type: 'layer'; anchor?: (typeof ANCHORS)[number] })
  | (Container & { type: 'grid'; columns?: number });

const ANCHORS = ['topLeading', 'top', 'topTrailing', 'leading', 'center', 'trailing', 'bottomLeading', 'bottom', 'bottomTrailing'] as const;

const node: z.ZodType<WidgetNode> = z.lazy(() => {
  /** A container may be tapped as a whole: a tile in a grid, a card in a row. */
  const container = {
    ...part,
    spacing: z.number().min(0).max(40).optional(),
    action: widgetAction.optional(),
    /** Names formulas read that no input sets, with where they start; read from the outermost part. */
    state: z.record(stateName, z.union([z.number(), z.string().max(200), z.boolean()])).optional(),
  };
  return z.discriminatedUnion('type', [
    ...leaves,
    z.object({ ...container, type: z.literal('row'), children: z.array(node).min(1).max(6), valign: z.enum(['top', 'center', 'bottom', 'baseline']).optional() }),
    z.object({ ...container, type: z.literal('stack'), children: z.array(node).min(1).max(16) }),
    /** Children drawn on top of each other, the first at the back. */
    z.object({ ...container, type: z.literal('layer'), children: z.array(node).min(1).max(6), anchor: z.enum(ANCHORS).optional() }),
    z.object({ ...container, type: z.literal('grid'), children: z.array(node).min(1).max(24), columns: z.number().int().min(2).max(4).optional() }),
  ]);
});

/**
 * A widget's whole content: one part. The brief's own `headline` and `weather` types are retired
 * (the user found them ugly, 2026-10-06): weather, when the user wants it, is a widget Sunnie designs.
 */
const body = node;
export type WidgetBody = z.infer<typeof body>;

export const NODE_TYPES = [
  'text', 'markdown', 'stat', 'fields', 'list', 'progress', 'gauge', 'chart', 'icon', 'badge', 'button', 'image', 'file', 'countdown',
  'divider', 'stepper', 'slider', 'toggle', 'segmented', 'checklist', 'table', 'spacer', 'row', 'stack', 'layer', 'grid',
] as const;

/** The parts a user changes; each sets its `bind` in the widget's state. */
export const INPUT_TYPES = ['stepper', 'slider', 'toggle', 'segmented', 'checklist'] as const;

const MAX_DEPTH = 8;
const MAX_NODES = 160;
const MAX_BYTES = 32_000;

function measure(n: unknown, depth = 1): { nodes: number; depth: number } {
  const children = (n as { children?: unknown[] }).children ?? [];
  return children.reduce<{ nodes: number; depth: number }>(
    (sum, child) => {
      const m = measure(child, depth + 1);
      return { nodes: sum.nodes + m.nodes, depth: Math.max(sum.depth, m.depth) };
    },
    { nodes: 1, depth },
  );
}

/**
 * Reads a widget body, given as JSON text or as a value. Throws an `Error` that says what is
 * wrong and where, for whoever wrote it — a model, or a program calling the API.
 */
export function parseWidgetBody(input: unknown): WidgetBody {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('The widget body is not valid JSON. Write one object, such as {"type":"text","text":"Hello"}.');
    }
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== 'string') {
    throw new Error(`A widget body is one object with a "type": ${NODE_TYPES.join(', ')}.`);
  }
  const result = body.safeParse(value);
  if (!result.success) {
    throw new Error(`The widget body is not right:\n${z.prettifyError(result.error)}\nTypes: ${NODE_TYPES.join(', ')}.`);
  }
  const { nodes, depth } = measure(result.data);
  if (depth > MAX_DEPTH) throw new Error(`The widget nests ${depth} levels deep; keep it to ${MAX_DEPTH}.`);
  if (nodes > MAX_NODES) throw new Error(`The widget has ${nodes} parts; keep it to ${MAX_NODES}.`);
  if (JSON.stringify(result.data).length > MAX_BYTES) throw new Error('The widget is too large; show less, and link to the rest.');
  const keys = widgetKeys(result.data);
  const twice = keys.find((key, i) => keys.indexOf(key) !== i);
  if (twice) throw new Error(`Two parts of the widget have the key "${twice}"; each key names one part.`);
  checkFormulas(result.data);
  return result.data;
}

/** Fields that name or point at something rather than show words: never formulas. */
const NOT_SHOWN = new Set(['type', 'key', 'bind', 'when', 'path', 'url', 'icon', 'name', 'style', 'weight', 'design', 'mode', 'kind',
  'valign', 'anchor', 'variant', 'to', 'direction', 'align', 'conversationId', 'backgroundImage', 'gradient', 'color', 'background', 'border', 'state']);

/**
 * Where the widget's state starts: the outermost part's `state`, then each input's own `value`
 * (or its natural start: the minimum, off, the first option, nothing ticked).
 */
export function initialState(body: WidgetBody): Record<string, StateValue> {
  const state: Record<string, StateValue> = { ...((body as { state?: Record<string, StateValue> }).state ?? {}) };
  const walk = (n: unknown) => {
    const p = n as Record<string, unknown> & { children?: unknown[] };
    const bind = p.bind as string | undefined;
    if (bind && !(bind in state)) {
      switch (p.type) {
        case 'stepper': case 'slider': state[bind] = (p.value as number | undefined) ?? (p.min as number | undefined) ?? 0; break;
        case 'toggle': state[bind] = (p.value as boolean | undefined) ?? false; break;
        case 'segmented': state[bind] = (p.value as string | undefined) ?? (p.options as Array<{ value: string }>)[0]!.value; break;
        case 'checklist': {
          const ticks = p.value as boolean[] | undefined;
          state[bind] = (p.items as unknown[]).map((_, i) => ticks?.[i] ?? false);
          break;
        }
      }
    }
    p.children?.forEach(walk);
  };
  walk(body);
  return state;
}

/**
 * Every formula reads, and names only what the widget has: an input's `bind` or the outermost
 * `state`. Throws an `Error` that says which formula and what to do, for the model.
 */
function checkFormulas(body: WidgetBody): void {
  const known = new Set(Object.keys(initialState(body)));
  const nested = (n: unknown, root: boolean): void => {
    const p = n as { state?: unknown; children?: unknown[] };
    if (!root && p.state) throw new Error('Only the outermost part of a widget may have "state"; move it there.');
    p.children?.forEach((c) => nested(c, false));
  };
  nested(body, true);
  const check = (source: string, where: string) => {
    let names: string[];
    try { names = formulaNames(parseFormula(source)); }
    catch (err) { throw new Error(`The formula "${source}" in ${where} does not read: ${err instanceof Error ? err.message : String(err)}. Formulas use numbers, 'text', the widget's names, + - * / %, comparisons, && || !, c ? a : b and min, max, round(x, digits), floor, ceil, abs, clamp, if, fixed(x, digits).`); }
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length) {
      throw new Error(`The formula "${source}" in ${where} uses ${unknown.map((u) => `"${u}"`).join(', ')}, which nothing in the widget sets. ` +
        (known.size ? `Its names: ${[...known].join(', ')}. ` : '') +
        'A name comes from an input\'s "bind" (stepper, slider, toggle, segmented, checklist) or from "state" on the outermost part.');
    }
  };
  const walk = (value: unknown, where: string, field?: string): void => {
    if (typeof value === 'string') {
      if (field && NOT_SHOWN.has(field)) return;
      for (const source of formulasIn(value)) check(source, where);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, where, field)); return; }
    if (!value || typeof value !== 'object') return;
    const p = value as Record<string, unknown>;
    const here = typeof p.type === 'string' ? `a ${p.type} part${p.key ? ` ("${p.key}")` : ''}` : where;
    if (typeof p.when === 'string') check(p.when, `${here}'s "when"`);
    if ((p.type === 'progress' || p.type === 'gauge') && typeof p.value === 'string') check(unbraced(p.value), `${here}'s value`);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'children') (v as unknown[]).forEach((c) => walk(c, here));
      else if (!((p.type === 'progress' || p.type === 'gauge') && k === 'value')) walk(v, here, k);
    }
  };
  walk(body, 'the widget');
}

/** A number field's formula, with or without its braces. */
export const unbraced = (source: string) => source.trim().replace(/^\{([\s\S]*)\}$/, '$1');

/** A number field's value now: a number as it is, a formula evaluated and kept within 0…1. */
export function amountOf(value: number | string, state: Record<string, StateValue>): number {
  if (typeof value === 'number') return value;
  try {
    const v = Number(evaluate(parseFormula(unbraced(value)), state));
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
  } catch { return 0; }
}

/** Every part's `key`, top to bottom. */
export function widgetKeys(body: WidgetBody): string[] {
  const keys: string[] = [];
  const walk = (n: unknown) => {
    const part = n as { key?: string; children?: unknown[] };
    if (part.key) keys.push(part.key);
    part.children?.forEach(walk);
  };
  walk(body);
  return keys;
}

/**
 * What a part shows, as opposed to how it looks: the only fields `applyValues` may change. Its
 * type, layout, colours, sizes and children stay as they were designed.
 */
export const DATA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  text: ['text'],
  markdown: ['text'],
  stat: ['value', 'label', 'unit', 'caption', 'icon'],
  fields: ['items'],
  list: ['items'],
  progress: ['value', 'label', 'caption'],
  gauge: ['value', 'label', 'caption'],
  chart: ['values', 'labels', 'caption'],
  icon: ['name'],
  badge: ['text', 'icon'],
  image: ['path'],
  button: ['text', 'action'],
  file: ['path', 'title', 'caption'],
  countdown: ['to', 'label'],
  checklist: ['items', 'caption'],
  table: ['columns', 'rows', 'caption'],
};

/**
 * The body with a key on every part that shows data, so that any widget can be refreshed without
 * being written again: a part the writer named keeps its key, any other is named after its type
 * ("stat", then "stat-2", …), top to bottom.
 */
export function withKeys(body: WidgetBody): WidgetBody {
  const next = structuredClone(body) as WidgetBody;
  const taken = new Set(widgetKeys(next));
  const walk = (n: unknown) => {
    const part = n as Record<string, unknown> & { key?: string; children?: unknown[] };
    if (!part.key && DATA_FIELDS[part.type as string]) {
      let key = part.type as string;
      for (let i = 2; taken.has(key); i++) key = `${part.type as string}-${i}`;
      taken.add(key);
      part.key = key;
    }
    part.children?.forEach(walk);
  };
  walk(next);
  return next;
}

/** New data for a widget's keyed parts: key → the fields that change (null clears an optional one). */
export type WidgetValues = Record<string, Record<string, unknown>>;

/**
 * A widget with new data and the same design: each part named in `values` takes the fields
 * given, which must be data (`DATA_FIELDS`), and the result is checked like any body. Throws an
 * `Error` that says what to do instead, for whoever wrote it.
 */
export function applyValues(body: WidgetBody, values: WidgetValues): WidgetBody {
  const next = structuredClone(body) as WidgetBody;
  const parts = new Map<string, Record<string, unknown>>();
  const walk = (n: unknown) => {
    const part = n as Record<string, unknown> & { key?: string; children?: unknown[] };
    if (part.key) parts.set(part.key, part);
    part.children?.forEach(walk);
  };
  walk(next);
  const named = Object.keys(values);
  if (!named.length) throw new Error('"update" needs `values`: the key of each part to change and its new fields, such as {"steps":{"value":"9,120"}}.');
  for (const key of named) {
    const part = parts.get(key.trim().toLowerCase());
    if (!part) {
      throw new Error(parts.size
        ? `This widget has no part with the key "${key}". Its keys: ${[...parts.keys()].join(', ')}.`
        : 'This widget has no keyed parts, so its data cannot be changed apart from its design. Write it again with "set", the same design and a "key" on each part whose content changes.');
    }
    const fields = values[key];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(`The values for "${key}" are an object of fields, such as {"value":"9,120"}.`);
    const allowed = DATA_FIELDS[part.type as string] ?? [];
    for (const [field, value] of Object.entries(fields)) {
      if (!allowed.includes(field)) {
        throw new Error(allowed.length
          ? `"${field}" is part of how "${key}" looks, not what it shows, so "update" leaves it alone. A ${part.type as string} part's data is: ${allowed.join(', ')}. To change its look, the user has to ask for that, and "set" writes the widget again.`
          : `"${key}" is a ${part.type as string}, which holds no data of its own; key the parts inside it instead.`);
      }
      if (value === null) delete part[field];
      else part[field] = value;
    }
  }
  return parseWidgetBody(next);
}

/** Every action in a widget: on its parts, its list items and the widget itself. */
export function actionsOf(widget: { body: WidgetBody; action?: WidgetAction | null }): WidgetAction[] {
  const found: WidgetAction[] = [];
  const walk = (n: unknown) => {
    const part = n as { action?: WidgetAction; children?: unknown[]; items?: Array<{ action?: WidgetAction }> };
    if (part.action) found.push(part.action);
    part.items?.forEach((item) => item.action && found.push(item.action));
    part.children?.forEach(walk);
  };
  walk(widget.body);
  if (widget.action) found.push(widget.action);
  return found;
}

/** Every Drive path a widget points at: `image` and `file` nodes, background pictures and `open_file` actions. */
export function drivePaths(widget: { body: WidgetBody; action?: WidgetAction | null }): string[] {
  const found = new Set<string>();
  const take = (action: unknown) => {
    const a = action as WidgetAction | null | undefined;
    if (a?.type === 'open_file') found.add(a.path);
  };
  const walk = (n: unknown) => {
    const part = n as { type?: string; path?: string; backgroundImage?: string; action?: unknown; children?: unknown[]; items?: Array<{ action?: unknown }> };
    if ((part.type === 'image' || part.type === 'file') && part.path) found.add(part.path);
    if (part.backgroundImage) found.add(part.backgroundImage);
    take(part.action);
    part.items?.forEach((item) => take(item.action));
    part.children?.forEach(walk);
  };
  walk(widget.body);
  take(widget.action);
  return [...found];
}

/**
 * What a widget of each width may hold, so that a small one stays a glance and is never a full
 * widget squeezed into a tile. `parts` counts what shows (not spacers, dividers or the containers
 * that lay parts out), `items` the lines of a list or fields, `chars` the words and numbers shown.
 * Full width keeps only the body limits above.
 */
export const SIZE_BUDGETS: Readonly<Record<1 | 2 | 3, { name: string; parts: number; items: number; chars: number; line: number; buttons: number; banned: readonly string[] }>> = {
  // A small tile is about 56 points inside its padding: some ten characters of caption-size text a line.
  1: { name: 'Small', parts: 3, items: 0, chars: 30, line: 10, buttons: 0, banned: ['list', 'fields', 'chart', 'button', 'markdown', 'file', 'grid', 'row', 'stepper', 'slider', 'toggle', 'segmented', 'checklist', 'table'] },
  2: { name: 'Medium', parts: 5, items: 3, chars: 120, line: Infinity, buttons: 1, banned: ['grid', 'markdown', 'checklist', 'table', 'slider'] },
  3: { name: 'Large', parts: 8, items: 5, chars: 260, line: Infinity, buttons: 2, banned: [] },
};

/** The sizes in words, for the model: the same budgets `checkFits` enforces. */
export const SIZE_RULES =
  'Small (1 column, a square tile about 80 points wide): one glanceable thing — one number with a word under it (the stat\'s caption; a stat\'s label is drawn above it, so none), one icon, or one ring — ' +
  `at most ${SIZE_BUDGETS[1].parts} parts, ${SIZE_BUDGETS[1].chars} characters in all and ${SIZE_BUDGETS[1].line} on any line (so "Steps", not "Steps today"; ` +
  `"of 10k", not "goal 10,000"), never a heading or title (the word goes under the number), and no ${SIZE_BUDGETS[1].banned.join(', ')}. ` +
  'Medium (2 columns, about 170 points): one focal value (a stat, a gauge or a tiny chart) with a line or two of context, ' +
  `at most ${SIZE_BUDGETS[2].parts} parts, ${SIZE_BUDGETS[2].items} list or field lines, ${SIZE_BUDGETS[2].chars} characters and ${SIZE_BUDGETS[2].buttons} button. ` +
  `Large (3 columns, about 260 points): a heading, a focal value and a little detail — at most ${SIZE_BUDGETS[3].parts} parts, ` +
  `${SIZE_BUDGETS[3].items} list or field lines, ${SIZE_BUDGETS[3].chars} characters and ${SIZE_BUDGETS[3].buttons} buttons. ` +
  'Full width (4 columns): room for more, still a few things shown well. When the data does not fit, show less of it — the part that matters most — never smaller type to squeeze it in.';

const LAYOUT_TYPES = new Set(['row', 'stack', 'layer', 'grid', 'spacer', 'divider']);
const SHOWN_TEXT = ['text', 'value', 'label', 'unit', 'caption', 'title', 'subtitle'];

const FOCAL_TYPES = new Set(['stat', 'gauge', 'progress', 'countdown', 'icon', 'image', 'chart', 'badge']);

/**
 * Whether a widget shows a line of text above what it is about: a heading, or a stat's `label`
 * (the app draws it above the number).
 */
function hasHeading(body: WidgetBody): boolean {
  const shown: string[] = [];
  let labelled = false;
  const walk = (n: unknown) => {
    const part = n as { type: string; label?: string; children?: unknown[] };
    if (part.type === 'stat' && part.label) labelled = true;
    if (part.children) part.children.forEach(walk);
    else if (!LAYOUT_TYPES.has(part.type)) shown.push(part.type);
  };
  walk(body);
  if (labelled) return true;
  return (shown[0] === 'text' || shown[0] === 'markdown') && shown.slice(1).some((t) => FOCAL_TYPES.has(t));
}

/**
 * Throws, saying what to cut, when a body holds more than a widget `columns` wide may (`SIZE_BUDGETS`).
 */
export function checkFits(body: WidgetBody, columns: number): void {
  if (columns >= 4) return;
  const budget = SIZE_BUDGETS[columns as 1 | 2 | 3];
  let parts = 0, items = 0, chars = 0, buttons = 0;
  const banned = new Set<string>();
  const long: string[] = [];
  const count = (o: Record<string, unknown>) => {
    for (const field of SHOWN_TEXT) {
      if (typeof o[field] !== 'string') continue;
      const text = o[field] as string;
      chars += text.length;
      if (text.length > budget.line) long.push(`"${text}"`);
    }
  };
  const walk = (n: unknown) => {
    const part = n as Record<string, unknown> & { type: string; children?: unknown[]; items?: Array<Record<string, unknown>> };
    if (budget.banned.includes(part.type)) banned.add(part.type);
    if (!LAYOUT_TYPES.has(part.type)) parts++;
    if (part.type === 'button') buttons++;
    count(part);
    if (part.items) {
      items += part.items.length;
      part.items.forEach(count);
    }
    part.children?.forEach(walk);
  };
  walk(body);
  const over = [
    columns === 1 && hasHeading(body) ? 'no heading, title or stat label (a small widget is its number, ring or icon: the word goes under it, as the stat\'s caption)' : '',
    banned.size ? `no ${[...banned].join(', ')}` : '',
    parts > budget.parts ? `at most ${budget.parts} parts (it has ${parts})` : '',
    items > budget.items ? `at most ${budget.items} list or field lines (it has ${items})` : '',
    chars > budget.chars ? `at most ${budget.chars} characters of text (it has ${chars})` : '',
    buttons > budget.buttons ? `at most ${budget.buttons} button${budget.buttons === 1 ? '' : 's'} (it has ${buttons})` : '',
    long.length ? `at most ${budget.line} characters on a line (${long.join(', ')} would wrap)` : '',
  ].filter(Boolean);
  if (over.length) {
    throw new Error(`This is too much for a ${budget.name.toLowerCase()} widget (${columns} column${columns === 1 ? '' : 's'}): ${over.join('; ')}. ` +
      'Show only what matters most at this size, or make it wider.');
  }
}

