// The arithmetic a widget may do with its own values (the user decided, 2026-10-08): numbers,
// text, true/false, the widget's state names, + − × ÷ %, comparisons, && || !, `c ? a : b` and a
// few functions. No loops, no assignment, nothing that reaches outside the widget. The app has
// the same language in `Formula.swift`; the two must agree on every case in test/formula.test.ts.

export type FormulaValue = number | string | boolean;
/** What a widget's state may hold: a checklist keeps one true/false per item. */
export type StateValue = FormulaValue | boolean[];

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'name'; v: string }
  | { k: 'unary'; op: '-' | '!'; a: Node }
  | { k: 'binary'; op: string; a: Node; b: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

export const FORMULA_FUNCTIONS = ['min', 'max', 'round', 'floor', 'ceil', 'abs', 'if', 'clamp', 'fixed'] as const;
const MAX_LENGTH = 300;
const MAX_DEPTH = 32;

type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(i));
      if (!m) throw new Error(`"${ch}" is not a number`);
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) throw new Error('a text in quotes is not closed');
      tokens.push({ t: 'str', v: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!?:(),'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    // × and ÷ are what a person writes; models sometimes copy them.
    if (ch === '×') { tokens.push({ t: 'op', v: '*' }); i++; continue; }
    if (ch === '÷') { tokens.push({ t: 'op', v: '/' }); i++; continue; }
    throw new Error(`"${ch}" cannot be used in a formula`);
  }
  return tokens;
}

const BINARY: Array<string[]> = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];

/** Reads a formula, or throws an `Error` saying what is wrong, for whoever wrote it. */
export function parseFormula(source: string): Node {
  if (source.length > MAX_LENGTH) throw new Error(`a formula is at most ${MAX_LENGTH} characters`);
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const opIn = (ops: string[]) => { const t = peek(); return t?.t === 'op' && ops.includes(t.v); };
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}"`);
    pos++;
  };
  const expression = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new Error('the formula nests too deeply');
    const c = binary(0, depth);
    if (isOp('?')) {
      pos++;
      const a = expression(depth + 1);
      expect(':');
      const b = expression(depth + 1);
      return { k: 'cond', c, a, b };
    }
    return c;
  };
  const binary = (level: number, depth: number): Node => {
    if (level === BINARY.length) return unary(depth);
    let left = binary(level + 1, depth);
    while (opIn(BINARY[level]!)) {
      const op = (tokens[pos++] as { v: string }).v;
      left = { k: 'binary', op, a: left, b: binary(level + 1, depth) };
    }
    return left;
  };
  const unary = (depth: number): Node => {
    if (isOp('-') || isOp('!')) {
      const op = (tokens[pos++] as { v: '-' | '!' }).v;
      return { k: 'unary', op, a: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): Node => {
    const token = tokens[pos++];
    if (!token) throw new Error('the formula ends too early');
    if (token.t === 'num') return { k: 'num', v: token.v };
    if (token.t === 'str') return { k: 'str', v: token.v };
    if (token.t === 'id') {
      if (token.v === 'true' || token.v === 'false') return { k: 'bool', v: token.v === 'true' };
      if (isOp('(')) {
        if (!(FORMULA_FUNCTIONS as readonly string[]).includes(token.v)) {
          throw new Error(`"${token.v}" is not a function; there are ${FORMULA_FUNCTIONS.join(', ')}`);
        }
        pos++;
        const args: Node[] = [];
        if (!isOp(')')) {
          do args.push(expression(depth + 1));
          while (isOp(',') && ++pos);
        }
        expect(')');
        return { k: 'call', fn: token.v, args };
      }
      return { k: 'name', v: token.v };
    }
    if (token.v === '(') {
      const inner = expression(depth + 1);
      expect(')');
      return inner;
    }
    throw new Error(`"${token.v}" is out of place`);
  };
  const node = expression(0);
  if (pos < tokens.length) throw new Error(`"${(tokens[pos] as { v: unknown }).v}" is out of place`);
  return node;
}

/** The state names a formula reads. */
export function formulaNames(node: Node): string[] {
  const names = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'name') names.add(n.v);
    else if (n.k === 'unary') walk(n.a);
    else if (n.k === 'binary') { walk(n.a); walk(n.b); }
    else if (n.k === 'cond') { walk(n.c); walk(n.a); walk(n.b); }
    else if (n.k === 'call') n.args.forEach(walk);
  };
  walk(node);
  return [...names];
}

const num = (v: FormulaValue): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v) || 0);
const truthy = (v: FormulaValue): boolean => (typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : typeof v === 'string' ? v !== '' : v);

/**
 * Evaluates a parsed formula. A name the state does not have is 0; a checklist's name is how many
 * of its items are ticked. Never throws.
 */
export function evaluate(node: Node, state: Record<string, StateValue>): FormulaValue {
  switch (node.k) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'name': {
      const value = state[node.v];
      return Array.isArray(value) ? value.filter(Boolean).length : (value ?? 0);
    }
    case 'unary': {
      const a = evaluate(node.a, state);
      return node.op === '-' ? -num(a) : !truthy(a);
    }
    case 'cond': return truthy(evaluate(node.c, state)) ? evaluate(node.a, state) : evaluate(node.b, state);
    case 'binary': {
      if (node.op === '&&') { const a = evaluate(node.a, state); return truthy(a) ? evaluate(node.b, state) : a; }
      if (node.op === '||') { const a = evaluate(node.a, state); return truthy(a) ? a : evaluate(node.b, state); }
      const a = evaluate(node.a, state);
      const b = evaluate(node.b, state);
      switch (node.op) {
        // Text joins text; everything else is arithmetic.
        case '+': return typeof a === 'string' || typeof b === 'string' ? display(a) + display(b) : num(a) + num(b);
        case '-': return num(a) - num(b);
        case '*': return num(a) * num(b);
        case '/': return num(b) === 0 ? 0 : num(a) / num(b);
        case '%': return num(b) === 0 ? 0 : num(a) % num(b);
        case '==': return typeof a === 'string' || typeof b === 'string' ? display(a) === display(b) : num(a) === num(b);
        case '!=': return typeof a === 'string' || typeof b === 'string' ? display(a) !== display(b) : num(a) !== num(b);
        case '<': return num(a) < num(b);
        case '<=': return num(a) <= num(b);
        case '>': return num(a) > num(b);
        case '>=': return num(a) >= num(b);
      }
      return 0;
    }
    case 'call': {
      const args = node.args.map((n) => evaluate(n, state));
      const n = args.map(num);
      switch (node.fn) {
        case 'min': return n.length ? Math.min(...n) : 0;
        case 'max': return n.length ? Math.max(...n) : 0;
        case 'round': return roundTo(n[0] ?? 0, n[1] ?? 0);
        case 'floor': return Math.floor(n[0] ?? 0);
        case 'ceil': return Math.ceil(n[0] ?? 0);
        case 'abs': return Math.abs(n[0] ?? 0);
        case 'clamp': return Math.min(Math.max(n[0] ?? 0, n[1] ?? -Infinity), n[2] ?? Infinity);
        case 'if': return truthy(args[0] ?? false) ? (args[1] ?? 0) : (args[2] ?? 0);
        // Always this many decimals, as text: "2.50".
        case 'fixed': return (n[0] ?? 0).toFixed(Math.min(Math.max(Math.trunc(n[1] ?? 0), 0), 6));
      }
      return 0;
    }
  }
}

function roundTo(value: number, digits: number): number {
  const d = Math.min(Math.max(Math.trunc(digits), 0), 6);
  const f = 10 ** d;
  // Half away from zero, as people round and as Swift's .toNearestOrAwayFromZero does.
  return (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
}

/**
 * A value as the widget shows it: whole numbers plainly, others with at most two decimals,
 * thousands grouped with commas; true/false as words.
 */
export function display(value: FormulaValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) return '0';
  const rounded = roundTo(value, 2);
  const [whole, fraction] = Math.abs(rounded).toString().split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${rounded < 0 ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** The `{…}` formulas in a piece of text, in order. `{{` is a literal brace. */
export function formulasIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.replace(/\{\{/g, '').matchAll(/\{([^{}]*)\}/g)) found.push(m[1]!);
  return found;
}

/** The text with each `{formula}` replaced by its value; a formula that does not read shows "—". */
export function interpolate(text: string, state: Record<string, StateValue>): string {
  return text.replace(/\{\{|\{([^{}]*)\}/g, (whole, source: string | undefined) => {
    if (source === undefined) return '{';
    try { return display(evaluate(parseFormula(source), state)); }
    catch { return '—'; }
  });
}
