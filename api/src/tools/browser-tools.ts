import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { hostMatches, type Command, type PageView, type Request, type Response, type Target } from '../../browser/protocol.ts';
import type { HandoffAsk } from '../browser/handoff.ts';
import type { Computer } from '../computer/computer.ts';
import type { Config } from '../config.ts';
import { totp, type LoginStore } from '../logins/login-store.ts';
import { filePathOn } from './computer-tools.ts';

/** Covers a cold start of the browser plus a slow page; the daemon has its own shorter limits. */
const TIMEOUT_MS = 90_000;

export interface BrowserToolDeps {
  computer: Computer;
  logins: LoginStore;
  config: Config['browser'];
  /** The browser session to act in: a helper's own tabs. Unset is the agent's main session. */
  session?: string;
  /** False leaves out the login vault: no `browser_fill_login`, no mention of saved logins. */
  vault?: boolean;
  /** False leaves out `browser_upload`: a helper looks things up, it does not hand the user's files to a site. */
  upload?: boolean;
  /** Whether the model can be shown pictures; without it `browser_screenshot` says so instead of trying. */
  images?: boolean;
  /**
   * Handing the browser to the user: `held` says whether they hold it right now (then no call of
   * the agent's own may run), `ask` asks them to take it over and waits. Without `ask` there is
   * no `browser_handoff` tool: a helper's tabs are its own, and nobody is asked for them.
   */
  handoff?: { held(): boolean; ask?: HandoffAsk };
}

function requestFor(config: Config['browser'], command: Command, session?: string): Request {
  return {
    launch: {
      headless: config.headless,
      executablePath: config.executablePath,
      browsersPath: config.browsersPath,
      idleMinutes: config.idleMinutes,
    },
    command,
    session,
    maxChars: config.maxOutputChars,
  };
}

/**
 * One command to the browser on the agent's computer. The browser lives there; the only way to
 * it is a command run there, and the request travels on stdin so that a vault value never
 * appears in a command line. Throws when the browser could not be reached at all.
 */
export async function browserCommand(
  deps: Pick<BrowserToolDeps, 'computer' | 'config' | 'session'>,
  command: Command,
  opts: { timeoutMs?: number; signal?: AbortSignal; maxOutputChars?: number } = {},
): Promise<Response> {
  const request = requestFor(deps.config, command, deps.session);
  const res = await deps.computer.exec(deps.config.command, {
    stdin: JSON.stringify(request),
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    maxOutputChars: opts.maxOutputChars,
    signal: opts.signal,
  });
  try {
    return JSON.parse(res.stdout) as Response;
  } catch {
    const detail = res.timedOut ? 'it timed out' : res.stderr.trim() || `exit code ${res.exitCode}`;
    throw new Error(`The browser could not be reached on your computer (${detail}).`);
  }
}

/** Closes the tabs a session opened. Never throws: tabs left behind go when the browser idles out. */
export async function endBrowserSession(deps: Pick<BrowserToolDeps, 'computer' | 'config'>, session: string): Promise<void> {
  await browserCommand({ ...deps, session }, { cmd: 'end' }, { timeoutMs: 20_000 }).catch(() => {});
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const MAX_UPLOADS = 10;

/** One path per line; a model that sends a JSON list instead is understood too. */
function uploadPaths(files: string): string[] {
  const text = files.trim();
  if (text.startsWith('[')) {
    try {
      const list: unknown = JSON.parse(text);
      if (Array.isArray(list)) return list.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
    } catch {
      // Not JSON after all: a file name may begin with a bracket.
    }
  }
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** How long a held-or-not decision waits to learn what a ref stands for; without it the call is judged as before. */
const DESCRIBE_MS = 10_000;

/** No vault value leaves in anything read off a page, whatever the daemon let through. */
function redactor(logins: LoginStore): (text: string) => string {
  return (text) => {
    let out = text;
    for (const login of logins.list()) {
      for (const secret of [login.password, login.totpSecret]) {
        if (secret.length >= 4) out = out.split(secret).join('[hidden]');
      }
    }
    return out;
  };
}

/**
 * What a browser call is about to act on: the element behind its ref (for `browser_key`, the one
 * with the focus) and the page it is on. A ref says nothing by itself, so without this neither
 * the risk filter nor the user can tell "Save draft" from "Submit". Never throws, and never
 * starts a browser. Undefined for any other call, and when the browser knows no such element
 * (the call is then about to fail); null when the browser could not be asked, so that the
 * element stays unknown.
 */
export function createBrowserTargets({ computer, logins, config, session }: Omit<BrowserToolDeps, 'vault' | 'upload'>) {
  const redact = redactor(logins);
  return async (call: { name: string; input: unknown }, signal?: AbortSignal): Promise<Target | undefined | null> => {
    const input = (call.input ?? {}) as { ref?: unknown };
    const ref = typeof input.ref === 'string' ? input.ref : undefined;
    if (!call.name.startsWith('browser_') || (ref === undefined && call.name !== 'browser_key')) return undefined;
    try {
      const response = await browserCommand({ computer, config, session }, { cmd: 'describe', ref }, { timeoutMs: DESCRIBE_MS, signal });
      if (!response.ok) return null;
      if (!response.target) return undefined;
      const { element, title, url } = response.target;
      return { element: redact(element), title: redact(title), url: redact(url) };
    } catch {
      return null;
    }
  };
}

/** What the model is told when it reaches for the browser while the user holds it. */
export const BROWSER_HELD =
  'The user has taken the browser over from the app and has not handed it back yet, so this call was not run. ' +
  'Do not try again now: tell the user in a line that you will carry on once they hand the browser back, and end your turn.';

/** A picture is far bigger than any outline: the command's output cap must let it through whole. */
const SCREENSHOT_CHARS = 16_000_000;

export function createBrowserTools({ computer, logins, config, session, vault = true, upload = true, images, handoff }: BrowserToolDeps): ToolSet {
  const send = (command: Command, signal?: AbortSignal): Promise<Response> => {
    // While the user holds the page, a click of the agent's would land on top of theirs.
    if (handoff?.held()) throw new Error(BROWSER_HELD);
    // JSON escaping can make the outline several times longer than its character count.
    return browserCommand({ computer, config, session }, command, { signal, maxOutputChars: config.maxOutputChars * 8 + 20_000 });
  };

  /** The second line of defence after the daemon's own: no vault value leaves in a tool result. */
  const redact = redactor(logins);

  const render = (page: PageView, lead?: string): string => {
    const lines: string[] = [];
    if (lead) lines.push(lead);
    lines.push(`Page: ${page.title || '(untitled)'}`, `URL: ${page.url}`);
    if (page.tabs.length > 1) {
      lines.push('Tabs:', ...page.tabs.map((t) => `  ${t.index}. ${t.title || t.url}${t.current ? ' (current)' : ''}`));
    }
    for (const note of page.notes) lines.push(`Note: ${note}`);
    const host = hostOf(page.url);
    const saved = vault ? logins.list().filter((l) => hostMatches(host, l.site)) : [];
    if (saved.length > 0) {
      const described = saved.map((l) => {
        const has = [l.username && `username ${l.username}`, l.password && 'password', l.totpSecret && 'one-time code'];
        return `"${l.name}" (${has.filter(Boolean).join(', ')})`;
      });
      lines.push(`Saved logins for this site: ${described.join('; ')} — fill them with browser_fill_login.`);
    }
    if (page.found) {
      const { query, matches, shown } = page.found;
      if (matches === 0) {
        lines.push('', `Nothing on this page matches "${query}". Try a shorter or different word, or read the page with browser_read.`);
      } else {
        const some = shown < matches ? ` (the first ${shown} shown; use a more specific text to narrow it down)` : '';
        lines.push(
          '',
          `${matches} line${matches === 1 ? ' of the page matches' : 's of the page match'} "${query}"${some}. ` +
            'To read on from a match, call browser_read with offset set to its character position.',
          '',
          page.outline,
        );
      }
      return redact(lines.join('\n'));
    }
    lines.push('', page.outline || '(the page is empty)');
    const end = page.offset + page.outline.length;
    if (page.offset > 0 || end < page.outlineLength) {
      const more =
        end < page.outlineLength
          ? `; call browser_read with offset=${end} for more, or with find to jump to the part you need`
          : '';
      lines.push('', `[showing characters ${page.offset}–${end} of ${page.outlineLength}${more}]`);
    }
    return redact(lines.join('\n'));
  };

  const act = async (command: Command, signal?: AbortSignal, lead?: string): Promise<string> => {
    const response = await send(command, signal);
    if (!response.ok) throw new Error(redact(response.error));
    return response.page ? render(response.page, lead) : (response.info ?? 'Done.');
  };

  const ref = z.string().describe('Element ref from the most recent page outline, e.g. "e12".');

  const tools: ToolSet = {
    browser_open: tool({
      description:
        'Open a URL in your web browser and get the page back as an outline whose interactive elements ' +
        'carry refs. The right choice when a page needs JavaScript or a signed-in session, or when you ' +
        'are going to click or type on it. For just reading a public page, web_fetch is cheaper.',
      inputSchema: z.object({ url: z.url({ protocol: /^https?$/ }) }),
      execute: ({ url }, { abortSignal }) => act({ cmd: 'open', url }, abortSignal),
    }),

    browser_read: tool({
      description:
        'Get the outline of the page your browser is on right now: to see what changed after waiting, ' +
        'to refresh stale refs, or with offset to continue a page that was cut off. With find, returns ' +
        'only the lines containing that text, with their refs — the right way to locate a button, a ' +
        'field or a fact on a long page instead of paging through all of it.',
      inputSchema: z.object({
        offset: z.number().int().min(0).optional().describe('Character offset to continue from. Default 0.'),
        find: z.string().max(200).optional().describe('Text to look for on the page, e.g. "Add to cart" or "population".'),
      }),
      execute: ({ offset, find }, { abortSignal }) => act({ cmd: 'read', offset, find: find?.trim() || undefined }, abortSignal),
    }),

    browser_screenshot: tool({
      description:
        'See the current browser page as a picture, the way a person sees it: to check how a page or a chart looks, ' +
        'to read a picture or a diagram on it, or when the outline does not explain what is going on. Refs stay as ' +
        'they are. For reading text and finding what to click, browser_read is cheaper.',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        if (images === false) {
          throw new Error('The model in use cannot be shown pictures. Read the page with browser_read instead, or ask the user to look.');
        }
        if (handoff?.held()) throw new Error(BROWSER_HELD);
        const response = await browserCommand({ computer, config, session }, { cmd: 'screenshot' }, { signal: abortSignal, maxOutputChars: SCREENSHOT_CHARS });
        if (!response.ok) throw new Error(redact(response.error));
        if (!response.screen) throw new Error('The browser sent no picture of the page. Try browser_read.');
        const { image, width, height, url, title } = response.screen;
        return { url: redact(url), title: redact(title), width, height, kilobytes: Math.round((image.length * 0.75) / 1024), data: image };
      },
      // The model gets the picture; everyone else (the app, the router) gets the line of text.
      toModelOutput: ({ output }) => ({
        type: 'content',
        value: [
          { type: 'text', text: `${output.title || '(untitled)'} — ${output.url} (${output.width}×${output.height}, image/jpeg, ${output.kilobytes} KB)` },
          { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: output.data } },
        ],
      }),
    }),

    browser_click: tool({
      description:
        'Click an element on the current browser page by its ref: a link, button, checkbox, tab or menu item. ' +
        'Returns the page as it is afterwards.',
      inputSchema: z.object({ ref }),
      execute: ({ ref }, { abortSignal }) => act({ cmd: 'click', ref }, abortSignal),
    }),

    browser_type: tool({
      description:
        'Type text into a field on the current browser page by its ref, replacing what is there; on a ' +
        'dropdown, picks the option with that label. Set submit to press Enter afterwards.' +
        (vault ? ' For a saved username, password or one-time code use browser_fill_login instead.' : ''),
      inputSchema: z.object({
        ref,
        text: z.string(),
        submit: z.boolean().optional().describe('Press Enter after typing. Default false.'),
      }),
      execute: ({ ref, text, submit }, { abortSignal }) => act({ cmd: 'type', ref, text, submit }, abortSignal),
    }),

    browser_fill_login: tool({
      description:
        "Fill a field on the current browser page from the user's saved logins: the username, the password, " +
        'or the current one-time code. The value goes straight into the page and is never shown to you. ' +
        'Use this whenever a site asks you to sign in or to confirm with an authenticator code.',
      inputSchema: z.object({
        ref,
        login: z.string().describe('Name of the saved login, as listed under "Saved logins for this site".'),
        field: z.enum(['username', 'password', 'code']),
      }),
      execute: async ({ ref, login: name, field }, { abortSignal }) => {
        const login = logins.byName(name);
        if (!login) {
          const names = logins.list().map((l) => `"${l.name}" (${l.site})`);
          throw new Error(
            names.length > 0
              ? `There is no saved login named "${name}". Saved logins: ${names.join(', ')}.`
              : 'No logins are saved yet. Ask the user to add one in the app (Settings → Logins); do not ask for the password in chat.',
          );
        }
        const value = field === 'username' ? login.username : field === 'password' ? login.password : login.totpSecret && totp(login.totpSecret);
        if (!value) {
          const what = field === 'code' ? 'one-time-code secret' : field;
          throw new Error(
            `The login "${login.name}" has no ${what} saved. Ask the user to add it in the app (Settings → Logins)` +
              (field === 'code' ? ', or to tell you the code they received.' : '.'),
          );
        }
        return act(
          { cmd: 'fill_secret', ref, value, site: login.site, redact: field === 'password' },
          abortSignal,
          `Filled the ${field === 'code' ? 'one-time code' : field} of "${login.name}" into ${ref}.`,
        );
      },
    }),

    browser_upload: tool({
      description:
        'Attach files from your computer to the current browser page: receipts on an expense form, a CV, a ' +
        'photo. Give the ref of the file field, or of the button that opens the file picker, and the files. ' +
        'The right action whenever a form asks for a document you have; clicking such a field does nothing useful.',
      inputSchema: z.object({
        ref,
        files: z.string().min(1).describe('The files to attach, one path per line. Relative paths start in ~/Drive, like the file tools.'),
      }),
      execute: ({ ref, files }, { abortSignal }) => {
        const paths = uploadPaths(files).map((path) => filePathOn(computer, path));
        if (paths.length === 0) throw new Error('Give at least one file path.');
        if (paths.length > MAX_UPLOADS) throw new Error(`At most ${MAX_UPLOADS} files per call; attach the rest with another call.`);
        return act({ cmd: 'upload', ref, paths }, abortSignal);
      },
    }),

    browser_key: tool({
      description:
        'Press a keyboard key on the current browser page, for what clicking and typing cannot do: ' +
        'Enter, Escape, Tab, ArrowDown, PageDown, or a combination such as Control+A.',
      inputSchema: z.object({ key: z.string().min(1).max(40) }),
      execute: ({ key }, { abortSignal }) => act({ cmd: 'key', key }, abortSignal),
    }),

    browser_control: tool({
      description:
        'Steer the browser itself rather than the page: go back or forward in history, reload, switch to ' +
        'another tab, or close a tab.',
      inputSchema: z.object({
        action: z.enum(['back', 'forward', 'reload', 'switch_tab', 'close_tab']),
        tab: z.number().int().positive().optional().describe('Tab number from the Tabs list. Required for switch_tab; close_tab defaults to the current tab.'),
      }),
      execute: ({ action, tab }, { abortSignal }) => act({ cmd: 'control', action, tab }, abortSignal),
    }),

    browser_handoff: tool({
      description:
        'Hand the browser to the user for a moment: they see the current page in the app, act on it themselves ' +
        'and hand it back, and you get the page back as they left it. The right action when a page shows a ' +
        'CAPTCHA, asks for a sign-in that no saved login fits, or wants a code or a confirmation that only the ' +
        'user has. Say what they should do there.',
      inputSchema: z.object({
        reason: z.string().trim().min(1).max(500).describe('What the user should do on the page, in one or two plain sentences, e.g. "Solve the CAPTCHA, then sign in with your account."'),
      }),
      execute: async ({ reason }, { toolCallId, abortSignal }) => {
        const ask = handoff?.ask;
        if (!ask) throw new Error('Nobody can take the browser over in this conversation. Carry on without it, and say what is waiting.');
        const result = await ask({ toolCallId, reason });
        const said = 'note' in result && result.note ? ` They said: "${result.note}".` : '';
        switch (result.outcome) {
          case 'done':
            return act({ cmd: 'read' }, abortSignal, `The user took the browser over and handed it back.${said} This is the page as they left it:`);
          case 'declined':
            throw new Error(
              `The user did not take the browser over.${said} Do not ask again in this turn: tell them what is waiting on the page, and carry on with what you can do without it.`,
            );
          case 'unanswered':
            throw new Error(
              'Nobody took the browser over in time, and other reminders were waiting, so this was not done. Tell the user briefly what is waiting on the page; do not retry.',
            );
          case 'cancelled':
            throw new Error('The run was stopped while the browser was handed over.');
        }
      },
    }),
  };
  if (!vault) delete tools.browser_fill_login;
  if (!upload) delete tools.browser_upload;
  if (!handoff?.ask) delete tools.browser_handoff;
  return tools;
}
