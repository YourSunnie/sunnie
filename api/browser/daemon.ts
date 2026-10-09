import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright-core';
import {
  describeElement,
  findInOutline,
  hostMatches,
  socketPath,
  stateDir,
  type Command,
  type LaunchOptions,
  type PageView,
  type Request,
  type Response,
  type Screen,
  type UserInput,
  type Viewport,
} from './protocol.ts';

/**
 * The agent's browser: one long-lived Google Chrome with a persistent profile, driven by commands
 * arriving on a Unix socket (see client.ts). It exits when idle and comes back, signed in, on
 * the next command.
 *
 * Commands belong to a session. The main session is the agent itself; each helper working in
 * parallel has one of its own, with its own tabs, so that they do not steer each other's pages.
 * Within a session commands run one at a time; sessions run side by side.
 */

const NAVIGATION_MS = 30_000;
const ACTION_MS = 10_000;
/** How long to let a page go quiet after an action before reading it. */
const SETTLE_MS = 2_500;
/**
 * Nothing may hold the command queue for longer than this. It sits under the server's own limit
 * for a browser tool call, so the model hears from the daemon rather than from a killed client.
 */
const COMMAND_MS = 75_000;
const REF = /^(f\d+)?e\d+$/;
/** The agent's window. The user's screen replaces it while they hold the browser (`fit`). */
const DESKTOP = { width: 1280, height: 900 };
const BROWSER_GONE = /has been closed|Target closed|Browser closed|browser has disconnected|crashed/i;
const FLAKY_NETWORK = /ERR_(NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE)/;

interface Candidate {
  name: string;
  /** Chrome and Chromium keep separate profiles: neither reliably opens one written by a newer build of the other. */
  profile: string;
  options: { channel?: string; executablePath?: string };
}

/** Built from nosme.c by the Dockerfile. */
const NO_SME_SHIM = '/usr/local/lib/sunnie-nosme.so';

/** What goes wrong when a page cannot be opened, said so that the model can decide what to do next. */
const NETWORK_ERRORS: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED/, 'there is no site at that address (the name does not resolve). Check the spelling.'],
  [/ERR_CERT_|ERR_SSL_/, "the site's security certificate is not valid, so the browser refused to open it."],
  [/ERR_HTTP_RESPONSE_CODE_FAILURE/, 'the server answered with an error and no page.'],
  [/ERR_TOO_MANY_REDIRECTS/, 'the site redirects in a loop.'],
  [/ERR_INTERNET_DISCONNECTED|ERR_PROXY_|ERR_NETWORK_CHANGED/, 'your computer has no working internet connection right now.'],
  [
    /ERR_CONNECTION_|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE/,
    'the site could not be reached. It may be down or blocked on this network; try again later or use another source.',
  ],
];

const CHROME_PATHS = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
const CHROMIUM_PATHS = ['/usr/bin/chromium', '/usr/bin/chromium-browser'];

const launch = JSON.parse(process.argv[2] ?? '{}') as LaunchOptions;
const dir = stateDir();
const pidFile = join(dir, 'daemon.pid');
const sessionCookiesFile = join(dir, 'session-cookies.json');

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** An error whose message is meant for the model. */
class BrowserError extends Error {}

/** The session of the agent itself: the one whose pages stay open between turns. */
const MAIN = '';

interface Session {
  current?: Page;
  /** Things that happened on the session's pages since it was last shown one. */
  notes: string[];
}

let context: BrowserContext | undefined;
let browserName = 'Browser';
const sessions = new Map<string, Session>();
/** Which session a page belongs to; a page nobody claimed is the main session's. */
const owners = new WeakMap<Page, string>();
/** Values filled from the vault, so they can be kept out of anything read back from a page. */
const secrets = new Set<string>();
/** Pages laid out for the user's screen during a hand-off, and their session: `unfit` gives them back the desktop. */
const fitted = new Map<Page, string>();
/** The outline last shown for each page: paging through it must not shift under the reader. */
const outlines = new WeakMap<Page, string>();
/** Pages on which an upload command is waiting for the file picker it has just opened. */
const uploading = new WeakSet<Page>();

function candidates(): Candidate[] {
  if (launch.executablePath) {
    return [{ name: 'Browser', profile: 'profile', options: { executablePath: launch.executablePath } }];
  }
  const chrome = (options: Candidate['options']): Candidate => ({ name: 'Google Chrome', profile: 'profile-chrome', options });
  const chromium = (options: Candidate['options']): Candidate => ({ name: 'Chromium', profile: 'profile', options });
  return [
    // The browser people actually use: sites treat it as one, where a test build of Chromium
    // gets blocked or served something different.
    chrome({ channel: 'chrome' }),
    ...CHROME_PATHS.filter(existsSync).map((executablePath) => chrome({ executablePath })),
    // Only for a computer without Chrome, so that the agent is not left without a browser.
    chromium({ channel: 'chromium' }),
    ...CHROMIUM_PATHS.filter(existsSync).map((executablePath) => chromium({ executablePath })),
  ];
}

/**
 * Chrome marks a profile as in use with a lock naming the host and process. A browser that was
 * killed leaves it behind, and in Docker a recreated container has a new host name, so Chrome
 * would refuse the profile for good. This daemon holds the pid file, so no other browser of ours
 * can be using the profile.
 */
function clearProfileLocks(profile: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    rmSync(join(profile, name), { force: true });
  }
}

/**
 * A window needs a screen, and a server has none: on Linux without a display the daemon brings its
 * own virtual one (Xvfb), which lives and dies with it. False when that is not possible.
 */
async function ensureDisplay(): Promise<boolean> {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  const display = await new Promise<string | undefined>((resolve) => {
    // Xvfb picks a free display number itself and reports it on fd 3.
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => resolve(undefined), 10_000);
    const done = (value: string | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };
    xvfb.on('error', () => done(undefined));
    xvfb.on('exit', () => done(undefined));
    xvfb.stdio[3]!.on('data', (chunk: Buffer) => done(`:${String(chunk).trim()}`));
    process.on('exit', () => xvfb.kill());
  });
  if (display) process.env.DISPLAY = display;
  return display !== undefined;
}

/** The environment Chrome starts in: the daemon's own, plus the SME workaround where it is needed (see nosme.c). */
function chromeEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'linux' || process.arch !== 'arm64') return process.env;
  let features: string[] = [];
  try {
    features = /^Features\s*:(.*)$/m.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1]?.trim().split(/\s+/) ?? [];
  } catch {
    return process.env;
  }
  if (!features.includes('sme') || features.includes('sve')) return process.env;
  if (!existsSync(NO_SME_SHIM)) {
    log(`this CPU has SME without SVE and ${NO_SME_SHIM} is missing: heavy pages may crash their tab`);
    return process.env;
  }
  return { ...process.env, LD_PRELOAD: NO_SME_SHIM };
}

async function launchBrowser(): Promise<{ context: BrowserContext; name: string }> {
  const failures: string[] = [];
  let headless = launch.headless;
  if (!headless && !(await ensureDisplay())) {
    log('no display and Xvfb could not be started; running headless');
    headless = true;
  }
  for (const candidate of candidates()) {
    const profile = join(dir, candidate.profile);
    clearProfileLocks(profile);
    try {
      const started = await chromium.launchPersistentContext(profile, {
        ...candidate.options,
        headless,
        env: chromeEnvironment(),
        viewport: DESKTOP,
        acceptDownloads: true,
        args: [
          // After a kill Chrome offers to restore the last session, over the page.
          '--hide-crash-restore-bubble',
          // Docker gives /dev/shm 64 MB, which Chrome outgrows on heavy pages.
          ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
        ],
      });
      if (failures.length > 0) log(`using ${candidate.name} after: ${failures.join(' | ')}`);
      return { context: started, name: candidate.name };
    } catch (err) {
      failures.push(`${candidate.name}: ${String((err as Error).message).split('\n')[0]!}`);
    }
  }
  throw new BrowserError(
    'No web browser could be started on this computer. Install Google Chrome, or set ' +
      `browser.executablePath in the server config. (${failures.join(' | ')})`,
  );
}

function sessionOf(key: string): Session {
  let session = sessions.get(key);
  if (!session) sessions.set(key, (session = { notes: [] }));
  return session;
}

const ownerOf = (page: Page): string => owners.get(page) ?? MAIN;

function pagesOf(key: string): Page[] {
  return context?.pages().filter((p) => ownerOf(p) === key) ?? [];
}

function watch(page: Page): void {
  const notes = () => sessionOf(ownerOf(page)).notes;
  // A link that opens a new tab, or a sign-in pop-up: follow it, as a person would — in the
  // session whose page opened it. A tab opened for a session is claimed by `page()` instead.
  void page.opener().then((opener) => {
    if (!opener || owners.has(page)) return;
    owners.set(page, ownerOf(opener));
    sessionOf(ownerOf(opener)).current = page;
  });
  page.on('close', () => {
    const session = sessions.get(ownerOf(page));
    if (session?.current === page) session.current = pagesOf(ownerOf(page)).at(-1);
  });
  page.on('crash', () => {
    notes().push('The page crashed, most likely because it was too heavy, and its tab was closed.');
    void page.close().catch(() => {});
  });
  page.on('dialog', (dialog) => {
    notes().push(`The page showed a ${dialog.type()} dialog saying "${dialog.message()}"; it was accepted.`);
    void dialog.accept().catch(() => {});
  });
  // With nobody listening Chrome would open its own file window, which no command can reach.
  page.on('filechooser', (chooser) => {
    if (uploading.has(page)) return;
    notes().push('That opened a file picker, and nothing was chosen. To attach a file, call browser_upload with the ref of the file field or of that button.');
    void chooser.setFiles([]).catch(() => {});
  });
  page.on('download', (download) => {
    const target = join(homedir(), 'Drive', 'Downloads', download.suggestedFilename());
    notes().push(`A download started; it is being saved to ${target}.`);
    void download.saveAs(target).catch((err) => log(`download failed: ${(err as Error).message}`));
  });
}

/**
 * Chrome drops session cookies when it exits, and many sites keep a sign-in in exactly those.
 * They are saved here and put back at the next start, so an idle shutdown does not sign the
 * agent out.
 */
async function saveSessionCookies(): Promise<void> {
  if (!context) return;
  try {
    const session = (await context.cookies()).filter((c) => c.expires === -1);
    writeFileSync(sessionCookiesFile, JSON.stringify(session), { mode: 0o600 });
  } catch (err) {
    log(`could not save session cookies: ${(err as Error).message}`);
  }
}

let starting: Promise<BrowserContext> | undefined;

/** Sessions arrive together; the profile can only be opened by one browser. */
function ensureBrowser(): Promise<BrowserContext> {
  if (context) return Promise.resolve(context);
  starting ??= startBrowser().finally(() => (starting = undefined));
  return starting;
}

async function startBrowser(): Promise<BrowserContext> {
  const { context: started, name } = await launchBrowser();
  browserName = name;
  started.setDefaultTimeout(ACTION_MS);
  started.setDefaultNavigationTimeout(NAVIGATION_MS);
  if (existsSync(sessionCookiesFile)) {
    try {
      await started.addCookies(JSON.parse(readFileSync(sessionCookiesFile, 'utf8')) as Cookie[]);
    } catch (err) {
      log(`could not restore session cookies: ${(err as Error).message}`);
    }
  }
  for (const page of started.pages()) watch(page);
  started.on('page', watch);
  // A crash, or the last window being closed: forget it, so the next command starts a new one.
  started.on('close', () => {
    if (context !== started) return;
    context = undefined;
    sessions.clear();
    log('browser closed');
  });
  context = started;
  log(`browser started: ${name} ${started.browser()?.version() ?? 'unknown version'}`);
  return started;
}

/** The page a session is on. A session with none gets a tab of its own. */
async function page(key: string): Promise<Page> {
  const ctx = await ensureBrowser();
  const session = sessionOf(key);
  if (!session.current || session.current.isClosed()) {
    session.current = pagesOf(key).at(-1);
    if (!session.current) {
      session.current = await ctx.newPage();
      owners.set(session.current, key);
    }
  }
  return session.current;
}

async function locate(p: Page, ref: string) {
  if (!REF.test(ref)) {
    throw new BrowserError(`"${ref}" is not a ref. Use one from the page outline, such as e12.`);
  }
  const target = p.locator(`aria-ref=${ref}`);
  // Checked up front: acting on a ref that is gone would otherwise wait out the whole timeout.
  if ((await target.count().catch(() => 0)) === 0) {
    throw new BrowserError(
      `Ref ${ref} is not on the page any more. Refs are only valid for the most recent outline; call browser_read for a fresh one.`,
    );
  }
  return target;
}

/** Turns Playwright's errors into something the model can act on. */
function explain(err: unknown, ref?: string): BrowserError {
  if (err instanceof BrowserError) return err;
  const message = String((err as Error).message ?? err).split('\nCall log')[0]!.trim();
  if (BROWSER_GONE.test(message)) {
    return new BrowserError(
      context
        ? 'The page crashed or was closed while doing that. Call browser_read to see what is open now.'
        : 'The browser closed unexpectedly while doing that. It starts again on the next call: open the page again with browser_open and check whether the action took effect.',
    );
  }
  if (/Timeout \d+ms exceeded/.test(message)) {
    return new BrowserError(
      `The page did not respond in time${ref ? ` (ref ${ref} may be hidden, disabled or covered by something)` : ''}. ` +
        'Call browser_read to see the current state.',
    );
  }
  return new BrowserError(message);
}

async function settle(p: Page): Promise<void> {
  // An action may have started a navigation that has not committed yet.
  await p.waitForTimeout(150).catch(() => {});
  await p.waitForLoadState('domcontentloaded', { timeout: ACTION_MS }).catch(() => {});
  await p.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
}

/** How long the page gets to react to the user's input before it is pictured. */
const REACT_MS: Record<UserInput['kind'], number> = { tap: 300, scroll: 120, text: 120, key: 200 };

/**
 * The page as the user sees it in the app while they hold the browser. Pictured as it is, with
 * no waiting for it to settle: a page mid-animation is still worth showing, and the app asks again.
 */
async function screen(p: Page): Promise<Screen> {
  const size = p.viewportSize() ?? DESKTOP;
  const picture = () => p.screenshot({ type: 'jpeg', quality: 60, scale: 'css', caret: 'initial', timeout: ACTION_MS });
  const image = await picture().catch(async () => {
    // A tap that started a navigation: one more try once the new page has something to show.
    await p.waitForLoadState('domcontentloaded', { timeout: ACTION_MS }).catch(() => {});
    return picture();
  });
  const focus = await focusedField(p);
  return { image: image.toString('base64'), width: size.width, height: size.height, url: p.url(), title: await p.title().catch(() => ''), ...(focus ? { focus } : {}) };
}

/**
 * The text field the page has the focus on, if any, so that the app can offer its keyboard for it:
 * whether it is a password, and what the page calls it. Looks at the top document only.
 */
async function focusedField(p: Page): Promise<Screen['focus'] | undefined> {
  // As a string: the daemon is compiled without the DOM types, and this runs in the page anyway.
  const script = `(() => {
    const el = document.activeElement;
    if (!el) return null;
    const type = (el.type || '').toLowerCase();
    const buttonish = ['button', 'submit', 'checkbox', 'radio', 'file', 'range', 'color', 'reset', 'image', 'hidden'];
    const editable = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !buttonish.includes(type)) || el.isContentEditable === true;
    if (!editable) return null;
    const label = el.getAttribute('aria-label') || el.placeholder || (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('name') || '';
    return { secret: type === 'password', label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 60) };
  })()`;
  const found = await p.evaluate<{ secret: boolean; label: string } | null>(script).catch(() => null);
  return found ?? undefined;
}

/**
 * Lays the page out for the user's screen, the way their own browser would: a site with a phone
 * layout shows it, rather than a desktop page shrunk to unreadable. The keyboard coming up makes
 * the screen shorter; the field being typed in is kept in view, as a phone's browser does.
 */
async function fit(p: Page, key: string, viewport: Viewport): Promise<void> {
  const width = Math.round(Math.min(DESKTOP.width, Math.max(320, viewport.width)));
  const height = Math.round(Math.min(2000, Math.max(200, viewport.height)));
  const now = p.viewportSize();
  if (now?.width === width && now.height === height) return;
  await p.setViewportSize({ width, height });
  fitted.set(p, key);
  await p
    .evaluate(`(() => { const el = document.activeElement; if (el && el !== document.body) el.scrollIntoView({ block: 'nearest' }); })()`)
    .catch(() => {});
}

/** The session's pages get the agent's window back before it acts on them again: its outlines and clicks assume it. */
async function unfit(key: string): Promise<void> {
  for (const [p, owner] of fitted) {
    if (owner !== key) continue;
    fitted.delete(p);
    if (!p.isClosed()) await p.setViewportSize(DESKTOP).catch(() => {});
  }
}

/** The user's touch or typing, delivered to the page as a mouse and a keyboard would. */
async function act(p: Page, input: UserInput): Promise<void> {
  switch (input.kind) {
    case 'tap':
      await p.mouse.click(input.x, input.y);
      break;
    case 'scroll':
      await p.mouse.move(input.x, input.y);
      await p.mouse.wheel(input.dx, input.dy);
      break;
    case 'text':
      // What they typed as a password is theirs: it must not come back in an outline the model reads.
      if (input.secret && input.text.length >= 4) secrets.add(input.text);
      await p.keyboard.type(input.text);
      break;
    case 'key':
      await p.keyboard.press(input.key).catch((err) => {
        throw new BrowserError(`"${input.key}" is not a key. (${explain(err).message})`);
      });
      break;
  }
  await p.waitForTimeout(REACT_MS[input.kind]).catch(() => {});
}

function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[hidden]');
  return out;
}

async function view(key: string, maxChars: number, offset = 0, find?: string): Promise<PageView> {
  const p = await page(key);
  const session = sessionOf(key);
  let outline = offset > 0 ? outlines.get(p) : undefined;
  if (outline === undefined) {
    try {
      outline = redact(await p.ariaSnapshot({ mode: 'ai', timeout: ACTION_MS }));
    } catch (err) {
      // Reading in the middle of a navigation fails; one more try once it has landed.
      await settle(p);
      outline = redact(await p.ariaSnapshot({ mode: 'ai', timeout: ACTION_MS }).catch(() => ''));
      if (!outline) session.notes.push(`The page could not be read: ${explain(err).message}`);
    }
    outlines.set(p, outline);
  }
  const pages = pagesOf(key);
  const tabs = await Promise.all(
    pages.map(async (tab, i) => ({
      index: i + 1,
      title: await tab.title().catch(() => ''),
      url: tab.url(),
      current: tab === p,
    })),
  );
  const view: PageView = {
    url: p.url(),
    title: await p.title().catch(() => ''),
    tabs,
    outline: outline.slice(offset, offset + maxChars),
    offset,
    outlineLength: outline.length,
    notes: [...session.notes],
  };
  if (find?.trim()) {
    const found = findInOutline(outline, find, maxChars);
    view.outline = found.text;
    view.offset = 0;
    view.found = { query: find.trim(), matches: found.matches, shown: found.shown };
  }
  session.notes.length = 0;
  return view;
}

async function run(key: string, command: Command, maxChars: number): Promise<Response> {
  const { notes } = sessionOf(key);
  if (fitted.size > 0 && !['screenshot', 'input', 'status', 'shutdown'].includes(command.cmd)) await unfit(key);
  switch (command.cmd) {
    case 'status': {
      const ctx = await ensureBrowser();
      return { ok: true, info: `${browserName} ${ctx.browser()?.version() ?? ''}`.trim() };
    }
    case 'shutdown':
      return { ok: true, info: 'stopped' };
    case 'end': {
      const mine = key === MAIN ? [] : pagesOf(key);
      // Closing a window's last tab closes the browser, and with it everybody else's sign-in flow.
      if (mine.length > 0 && mine.length === context?.pages().length) await context.newPage();
      await Promise.all(mine.map((p) => p.close().catch(() => {})));
      if (key !== MAIN) sessions.delete(key);
      return { ok: true, info: `closed ${mine.length} tab${mine.length === 1 ? '' : 's'}` };
    }
    case 'open': {
      const p = await page(key);
      const before = p.url();
      try {
        const go = () => p.goto(command.url, { waitUntil: 'domcontentloaded' });
        const response = await go().catch(async (err) => {
          if (!FLAKY_NETWORK.test(String((err as Error).message))) throw err;
          await p.waitForTimeout(1_000).catch(() => {});
          return go();
        });
        if (response && response.status() >= 400) notes.push(`The server answered HTTP ${response.status()}.`);
        const type = (response?.headers()['content-type'] ?? '').split(';')[0]!.trim();
        if (type && !/html|xml|^text\/|json/i.test(type)) {
          notes.push(
            `This address is a file (${type}), not a web page, so there may be nothing to read here. ` +
              'Download it with curl in the shell and work on the file there.',
          );
        }
      } catch (err) {
        const message = String((err as Error).message);
        if (/Download is starting/.test(message)) {
          // The download handler has already noted where the file is going.
        } else if (/Timeout \d+ms exceeded/.test(message)) {
          // Nothing arrived at all: reading the page would only wait out more timeouts.
          if (p.url() === before || !/^https?:/.test(p.url())) {
            // Left pending, the navigation would make the page that is still shown unreadable.
            await within(
              p.context().newCDPSession(p).then((cdp) => cdp.send('Page.stopLoading').finally(() => cdp.detach())),
              3_000,
            ).catch(() => {});
            throw new BrowserError(
              `Could not open ${command.url}: the site did not answer within ${NAVIGATION_MS / 1000} seconds. ` +
                'It may be down or blocked on this network; try again later or use another source.',
            );
          }
          notes.push(`The page was still loading after ${NAVIGATION_MS / 1000} seconds; this is what it shows so far.`);
        } else if (BROWSER_GONE.test(message)) {
          throw err;
        } else {
          const known = NETWORK_ERRORS.find(([pattern]) => pattern.test(message))?.[1];
          throw new BrowserError(`Could not open ${command.url}: ${known ?? message.split('\n')[0]}`);
        }
      }
      await settle(await page(key));
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'describe': {
      // Asked before a command is allowed to run: it must not start a browser, open a tab or
      // take a new snapshot (which would change what the refs stand for).
      const p = context ? sessions.get(key)?.current : undefined;
      if (!p || p.isClosed()) return { ok: true };
      const element = describeElement(outlines.get(p) ?? '', command.ref);
      return { ok: true, target: element ? { element, title: await p.title().catch(() => ''), url: p.url() } : undefined };
    }
    case 'read':
      return { ok: true, page: await view(key, maxChars, command.find?.trim() ? 0 : (command.offset ?? 0), command.find) };
    case 'click': {
      const p = await page(key);
      await (await locate(p, command.ref))
        .click()
        .catch((err) => {
          throw explain(err, command.ref);
        });
      await settle(await page(key));
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'type':
    case 'fill_secret': {
      const p = await page(key);
      const target = await locate(p, command.ref);
      const value = command.cmd === 'type' ? command.text : command.value;
      if (command.cmd === 'fill_secret') {
        const host = new URL(p.url()).hostname;
        if (!hostMatches(host, command.site)) {
          throw new BrowserError(
            `This page is on ${host || 'an unknown site'}, but that login belongs to ${command.site}. ` +
              'It was not filled in. If the site is wrong, tell the user rather than trying another login.',
          );
        }
        if (command.redact) secrets.add(value);
      }
      try {
        const tag = await target.evaluate((el) => el.tagName);
        if (tag === 'SELECT' && command.cmd === 'type') {
          await target.selectOption({ label: value }).catch(() => target.selectOption(value));
        } else {
          // Rich-text editors and custom widgets are not fillable; typing reaches them.
          await target.fill(value).catch(async (err) => {
            if (!/not an <input>|cannot be filled|contenteditable/i.test(String((err as Error).message))) throw err;
            await target.click();
            await target.pressSequentially(value);
          });
        }
        if (command.cmd === 'type' && command.submit) await target.press('Enter');
      } catch (err) {
        throw explain(err, command.ref);
      }
      await settle(await page(key));
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'upload': {
      const p = await page(key);
      const target = await locate(p, command.ref);
      for (const path of command.paths) {
        if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
          throw new BrowserError(`There is no file at ${path}. Nothing was uploaded; check the path (ls) and try again.`);
        }
      }
      try {
        const isFileField = await target.evaluate((el) => el.tagName === 'INPUT' && (el as { type?: string }).type === 'file');
        if (isFileField) {
          await target.setInputFiles(command.paths);
        } else {
          // A styled button in front of a hidden field: clicking it opens the picker, which is answered here.
          uploading.add(p);
          const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: ACTION_MS }), target.click()]);
          await chooser.setFiles(command.paths);
        }
      } catch (err) {
        const message = String((err as Error).message ?? err);
        if (/Non-multiple file input/i.test(message)) {
          throw new BrowserError('This field takes one file at a time. Nothing was uploaded; call browser_upload once per file, or look for an "add another" control.');
        }
        if (/Timeout \d+ms exceeded/.test(message) && uploading.has(p)) {
          throw new BrowserError(`Ref ${command.ref} did not open a file picker, so nothing was uploaded. Use the ref of the file field or of the button that attaches files; call browser_read to look again.`);
        }
        throw explain(err, command.ref);
      } finally {
        uploading.delete(p);
      }
      await settle(await page(key));
      const names = command.paths.map((path) => path.split('/').at(-1));
      sessionOf(key).notes.push(`Chosen for upload: ${names.join(', ')}. Check on the page that it shows ${names.length === 1 ? 'the file' : 'them'}; many forms only send files when the form is submitted.`);
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'key': {
      const p = await page(key);
      await p.keyboard.press(command.key).catch((err) => {
        throw new BrowserError(
          `"${command.key}" is not a key. Use names like Enter, Escape, Tab, ArrowDown, PageDown, or a combination like Control+A. (${explain(err).message})`,
        );
      });
      await settle(await page(key));
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'control': {
      const p = await page(key);
      const pages = pagesOf(key);
      const tab = command.tab === undefined ? undefined : pages[command.tab - 1];
      if (command.action === 'back') {
        if (!(await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null))) notes.push('There was no page to go back to.');
      } else if (command.action === 'forward') {
        if (!(await p.goForward({ waitUntil: 'domcontentloaded' }).catch(() => null))) notes.push('There was no page to go forward to.');
      } else if (command.action === 'reload') {
        await p.reload({ waitUntil: 'domcontentloaded' }).catch((err) => notes.push(explain(err).message));
      } else {
        if (command.tab !== undefined && !tab) {
          throw new BrowserError(`There is no tab ${command.tab}; ${pages.length} tab${pages.length === 1 ? ' is' : 's are'} open.`);
        }
        if (command.action === 'switch_tab') {
          if (!tab) throw new BrowserError('switch_tab needs a tab number from the Tabs list.');
          sessionOf(key).current = tab;
          await tab.bringToFront().catch(() => {});
        } else {
          await (tab ?? p).close();
        }
      }
      await settle(await page(key));
      return { ok: true, page: await view(key, maxChars) };
    }
    case 'screenshot':
    case 'input': {
      // The user holds the page: what they do is not waited out or outlined, only pictured.
      const p = await page(key);
      try {
        if (command.cmd === 'screenshot' && command.viewport) await fit(p, key, command.viewport);
        if (command.cmd === 'input') await act(p, command.input);
        return { ok: true, screen: await screen(await page(key)) };
      } catch (err) {
        throw explain(err);
      }
    }
  }
}

class Unresponsive extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Unresponsive()), ms)));
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Runs a command so that neither a dead nor a frozen browser is the end of the story. */
async function runSafely(key: string, request: Request): Promise<Response> {
  const { command, maxChars } = request;
  try {
    return await within(
      run(key, command, maxChars).catch((err) => {
        // Opening a page has no effect to lose, so a browser that died under it is simply
        // started again. Anything else may already have happened on the page: the model is told.
        const repeatable = command.cmd === 'open' || command.cmd === 'status';
        if (!repeatable || context || !BROWSER_GONE.test(String((err as Error).message))) throw err;
        log('browser was gone; starting it again');
        sessionOf(key).notes.push('The browser had closed unexpectedly and was started again; pages that were open are gone.');
        return run(key, command, maxChars);
      }),
      COMMAND_MS,
    );
  } catch (err) {
    if (!(err instanceof Unresponsive)) throw err;
    // With other tabs open, one page that hangs is not yet the browser: only its tab is given
    // up, if it lets go. Otherwise everybody working beside it would lose their page too.
    const stuck = sessions.get(key)?.current;
    if (stuck && !stuck.isClosed() && (context?.pages().length ?? 0) > 1) {
      if (await within(stuck.close(), 5_000).then(() => true, () => false)) {
        log(`page unresponsive during ${command.cmd}; closed its tab`);
        throw new BrowserError(
          'The page stopped responding and its tab was closed. Open the page again with browser_open, or use another source.',
        );
      }
    }
    log(`browser unresponsive during ${command.cmd}; closing it`);
    const frozen = context;
    context = undefined;
    sessions.clear();
    // With no browser left the daemon exits after answering, which takes a frozen Chrome with it.
    await within(frozen?.close() ?? Promise.resolve(), 5_000).catch(() => {});
    throw new BrowserError(
      'The browser stopped responding and was closed. It starts again on the next call: open the page again with browser_open.',
    );
  }
}

// One command at a time per session — a session has one current page — and sessions side by side.
const tails = new Map<string, Promise<void>>();
/** Commands being worked on right now. Their promises never reject. */
const running = new Set<Promise<void>>();
/** Set while the daemon waits for the commands at work before it closes; new ones are turned away. */
let draining = false;
let idleTimer: NodeJS.Timeout | undefined;
let stopping = false;

/**
 * Closes the browser and stops listening. The profile is released before the socket goes away,
 * so a client that finds nothing listening can safely start a new daemon.
 */
async function closeDown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  await within(saveSessionCookies(), 5_000).catch(() => {});
  await within(context?.close() ?? Promise.resolve(), 10_000).catch(() => {});
  rmSync(pidFile, { force: true });
  server.close();
  rmSync(socketPath(), { force: true });
}

/** Lets the commands at work finish, then closes down and exits. */
async function stop(reason: string): Promise<void> {
  draining = true;
  await Promise.all(running);
  await closeDown(reason);
  process.exit(0);
}

function touch(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop('idle'), Math.max(1, launch.idleMinutes ?? 30) * 60_000);
}

async function handle(socket: Socket, line: string): Promise<void> {
  // The client retries a dropped connection, by which time a fresh daemon can take over.
  if (stopping || draining) return void socket.destroy();
  touch();
  let finish!: () => void;
  const me = new Promise<void>((resolve) => (finish = resolve));
  running.add(me);
  try {
    let response: Response;
    let command: Command | undefined;
    try {
      const request = JSON.parse(line) as Request;
      command = request.command;
      response = await runSafely(request.session ?? MAIN, request);
    } catch (err) {
      if (!(err instanceof BrowserError)) log(`command failed: ${(err as Error).stack ?? err}`);
      response = { ok: false, error: explain(err).message };
    }
    // Without a browser there is nothing to keep alive; the next command tries again. Commands
    // of other sessions are answered first: a client whose connection drops sends its command
    // again, and a click must not happen twice. If one of them brought the browser back, stay.
    if ((command?.cmd === 'shutdown' || !context) && !draining) {
      draining = true;
      await Promise.all([...running].filter((other) => other !== me));
      if (command?.cmd === 'shutdown' || !context) {
        await closeDown(command?.cmd === 'shutdown' ? 'asked to' : 'no browser');
        socket.end(JSON.stringify(response), () => process.exit(0));
        return;
      }
      draining = false;
    }
    if (context) await within(saveSessionCookies(), 5_000).catch(() => {});
    socket.end(JSON.stringify(response));
  } finally {
    running.delete(me);
    finish();
  }
}

const server = createServer((socket) => {
  let data = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    data += chunk;
    const newline = data.indexOf('\n');
    if (newline === -1) return;
    const line = data.slice(0, newline);
    data = '';
    let key = MAIN;
    try {
      key = (JSON.parse(line) as Request).session ?? MAIN;
    } catch {
      // `handle` answers a request that cannot be read.
    }
    const job = (tails.get(key) ?? Promise.resolve())
      .then(() => handle(socket, line))
      .catch((err) => log(`command loop failed: ${(err as Error).stack ?? err}`));
    tails.set(key, job);
    void job.then(() => {
      if (tails.get(key) === job) tails.delete(key);
    });
  });
});

/** True when another daemon already answers on the socket. */
function alreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath());
    probe.on('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
  });
}

/**
 * Whether `pid` is a browser daemon. A pid file outlives a container restart, after which its
 * number may belong to some unrelated process; trusting it would leave the agent without a browser.
 */
function isDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('daemon.ts');
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (await alreadyRunning()) return;
  // Two clients can race to start a daemon; the pid file lets only the first one through.
  try {
    writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    if (isDaemon(Number(readFileSync(pidFile, 'utf8')))) return;
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  }
  // A stray rejection from a page event must not take the browser, and its open pages, down.
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));
  rmSync(socketPath(), { force: true });
  process.umask(0o077);
  server.listen(socketPath(), () => log(`listening on ${socketPath()}`));
  touch();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void stop(signal));
  }
}

void main();
