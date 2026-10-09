import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything in `browser/` runs on the agent's computer, as the agent's user — never inside the
 * server process. The server reaches it only by running `client.ts` through `Computer.exec`.
 */

export interface LaunchOptions {
  headless: boolean;
  /** A specific browser binary. Unset: the installed Google Chrome, and Chromium only where there is none. */
  executablePath?: string;
  /** Where Playwright's browsers were installed, when not in the user's cache directory. */
  browsersPath?: string;
  /** The daemon closes the browser and exits after this long without a command. */
  idleMinutes: number;
}

export type Command =
  | { cmd: 'status' }
  | { cmd: 'shutdown' }
  /** Closes the tabs of the request's session. Does nothing for the main session. */
  | { cmd: 'end' }
  | { cmd: 'open'; url: string }
  /** With `find`, the outline lines containing that text come back instead of a slice of the outline. */
  | { cmd: 'read'; offset?: number; find?: string }
  /**
   * What a ref stands for in the outline the session was last given, or — without a ref — the
   * element that has the focus. Looks only at what is already known: starts no browser, reads no page.
   */
  | { cmd: 'describe'; ref?: string }
  | { cmd: 'click'; ref: string }
  | { cmd: 'type'; ref: string; text: string; submit?: boolean }
  /** Puts files of the agent's computer (absolute paths) into a file field, or into the picker a button opens. */
  | { cmd: 'upload'; ref: string; paths: string[] }
  /** `site` is the host the value belongs to; the daemon refuses to fill it anywhere else. */
  | { cmd: 'fill_secret'; ref: string; value: string; site: string; redact: boolean }
  | { cmd: 'key'; key: string }
  | { cmd: 'control'; action: 'back' | 'forward' | 'reload' | 'switch_tab' | 'close_tab'; tab?: number }
  /**
   * The page as a person would see it (see `Screen`). Takes no outline, so refs stay as they are.
   * `viewport`: the size of the user's screen in CSS pixels; the page is laid out for it until the
   * agent's next command, so that a phone gets the site's phone layout rather than a shrunk desktop.
   */
  | { cmd: 'screenshot'; viewport?: Viewport }
  /** The user acting on the page from the app, as a mouse and a keyboard would; answers with the page afterwards. */
  | { cmd: 'input'; input: UserInput };

export interface Viewport {
  width: number;
  height: number;
}

/** What the user does on the page while they hold the browser. Coordinates are CSS pixels of the viewport. */
export type UserInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** `secret`: a password or the like, kept out of anything read back from a page afterwards. */
  | { kind: 'text'; text: string; secret?: boolean }
  | { kind: 'key'; key: string };

/** A picture of the viewport, for the app: JPEG in base64, its size in CSS pixels, and where it is. */
export interface Screen {
  image: string;
  width: number;
  height: number;
  url: string;
  title: string;
  /** The text field that has the focus, when one does: the app brings up its keyboard for it. */
  focus?: { secret: boolean; label: string };
}

export interface Request {
  launch: LaunchOptions;
  command: Command;
  /**
   * Whose tabs the command acts on. Each session has its own current page and sees only its own
   * tabs, and sessions work side by side; they share the profile, so also the sign-ins. Unset is
   * the main session, the one that outlives a turn.
   */
  session?: string;
  /** Cap on the page outline returned by one command. */
  maxChars: number;
}

export interface TabInfo {
  index: number;
  title: string;
  url: string;
  current: boolean;
}

export interface PageView {
  url: string;
  title: string;
  tabs: TabInfo[];
  /** A slice of the page outline, starting at `offset`. */
  outline: string;
  offset: number;
  outlineLength: number;
  /** Set when `outline` holds search results rather than a slice: what was looked for, and how many lines matched. */
  found?: { query: string; matches: number; shown: number };
  /** Things that happened on the way: downloads, dialogs, a slow load. */
  notes: string[];
}

/** The element a command would act on, in the words of the page outline, and the page it is on. */
export interface Target {
  /** Role, name and state as the outline has them, e.g. `button "Submit for approval"`. */
  element: string;
  title: string;
  url: string;
}

export type Response = { ok: true; page?: PageView; info?: string; target?: Target; screen?: Screen } | { ok: false; error: string };

export function stateDir(): string {
  return join(homedir(), '.sunnie', 'browser');
}

/**
 * The socket lives in the temp directory rather than next to the profile: Unix socket paths are
 * limited to about 100 bytes, and a home directory can be deeper than that.
 */
export function socketPath(): string {
  const id = createHash('sha256').update(stateDir()).digest('hex').slice(0, 16);
  return join(tmpdir(), `sunnie-browser-${id}.sock`);
}

/** Lines of context shown around a line that matches. */
const FIND_CONTEXT = 2;

/**
 * The lines of `outline` that contain `query` (case-insensitive; when no line holds the whole
 * phrase, lines — then runs of adjacent lines — holding every word), each with its neighbours
 * and the character offset to read on from.
 */
export function findInOutline(outline: string, query: string, maxChars: number): { text: string; matches: number; shown: number } {
  const lines = outline.split('\n');
  const lower = lines.map((line) => line.toLowerCase());
  const phrase = query.trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(Boolean);
  let hits = lower.flatMap((line, i) => (phrase && line.includes(phrase) ? [i] : []));
  if (hits.length === 0 && words.length > 1) {
    hits = lower.flatMap((line, i) => (words.every((word) => line.includes(word)) ? [i] : []));
  }
  if (hits.length === 0 && words.length > 1) {
    // A sentence with a link in it is spread over several outline lines: look across neighbours.
    for (let i = 0; i < lower.length; i++) {
      const window = lower.slice(i, i + FIND_CONTEXT + 1).join('\n');
      if (words.some((word) => lower[i]!.includes(word)) && words.every((word) => window.includes(word))) {
        hits.push(i);
        i += FIND_CONTEXT;
      }
    }
  }
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const blocks: string[] = [];
  let shown = 0;
  let used = 0;
  let covered = -1;
  for (const hit of hits) {
    // A match inside the context already shown for the one before it is not printed twice.
    if (hit <= covered) {
      shown += 1;
      continue;
    }
    const from = Math.max(covered + 1, hit - FIND_CONTEXT);
    const to = Math.min(lines.length - 1, hit + FIND_CONTEXT);
    const block = `[at character ${offsets[from]}]\n${lines.slice(from, to + 1).join('\n')}`;
    if (used + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    used += block.length + 2;
    covered = to;
    shown += 1;
  }
  return { text: blocks.join('\n\n'), matches: hits.length, shown };
}

const TARGET_CHARS = 300;
const CHILD_LINES = 3;

/** An outline line as a phrase: no list dash, no ref, none of the markers that say nothing about what it is. */
const phrase = (line: string) =>
  line
    .trim()
    .replace(/^- /, '')
    .replace(/ \[(?:ref=[^\]]*|cursor=[^\]]*|active)\]/g, '')
    .replace(/:$/, '')
    .trim();

/**
 * What `ref` stands for in `outline` — the line that carries it, as a phrase such as
 * `button "Submit for approval"`. An element with no name of its own is described by what is
 * inside it, and a link by where it goes. Without a ref: the element that has the focus, unless
 * that is the page itself. Undefined when the outline does not hold it.
 */
export function describeElement(outline: string, ref?: string): string | undefined {
  const lines = outline.split('\n');
  const marker = ref ? `[ref=${ref}]` : '[active]';
  const at = lines.findIndex((line) => line.includes(marker));
  if (at < 0 || (!ref && at === 0)) return undefined;
  const indent = (line: string) => line.length - line.trimStart().length;
  const own = phrase(lines[at]!);
  const inside: string[] = [];
  for (let i = at + 1; i < lines.length && indent(lines[i]!) > indent(lines[at]!); i++) inside.push(phrase(lines[i]!));
  const url = inside.find((line) => line.startsWith('/url:'));
  const named = /"|: /.test(own);
  const rest = inside.filter((line) => !line.startsWith('/')).slice(0, CHILD_LINES);
  const described = named
    ? own + (url ? ` (${url.replace('/url: ', 'to ')})` : '')
    : own + (rest.length > 0 ? ` containing ${rest.join(', ')}` : '');
  return described.length > TARGET_CHARS ? `${described.slice(0, TARGET_CHARS)} …` : described;
}

/** True when `host` is `site` or one of its subdomains. */
export function hostMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase().replace(/^www\./, '');
  return s.length > 0 && (h === s || h.endsWith(`.${s}`));
}
