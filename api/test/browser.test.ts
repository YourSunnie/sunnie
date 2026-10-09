import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ToolSet } from 'ai';
import { describeElement, findInOutline, type PageView, type Request, type Response } from '../browser/protocol.ts';
import { LocalComputer, type Computer, type ExecOptions, type ExecResult } from '../src/computer/computer.ts';
import { openDatabase } from '../src/db/database.ts';
import { LoginStore } from '../src/logins/login-store.ts';
import { buildInstructions } from '../src/agent/prompt.ts';
import { BrowserHandoff } from '../src/browser/handoff.ts';
import { createBrowserTargets, createBrowserTools, endBrowserSession } from '../src/tools/browser-tools.ts';
import { createHelperTools, createTools } from '../src/tools/index.ts';
import { createLogger } from '../src/util/log.ts';
import { testConfig, testSunnie } from './helpers.ts';

const call = (tools: ToolSet, name: string, input: unknown): Promise<string> =>
  (tools[name]!.execute as (input: unknown, opts: unknown) => Promise<string>)(input, { toolCallId: 't', messages: [] });

const pageView = (over: Partial<PageView> = {}): PageView => ({
  url: 'https://github.com/login',
  title: 'Sign in',
  tabs: [{ index: 1, title: 'Sign in', url: 'https://github.com/login', current: true }],
  outline: '- textbox "Password" [ref=e7]',
  offset: 0,
  outlineLength: 29,
  notes: [],
  ...over,
});

/** A computer whose browser client is scripted: records what it was asked, answers from a queue. */
function scriptedComputer(responses: Response[]) {
  const calls: Array<{ command: string; request: Request }> = [];
  const computer: Computer = {
    workspace: '/home/test',
    describe: () => 'scripted',
    exec: async (command: string, opts: ExecOptions = {}): Promise<ExecResult> => {
      calls.push({ command, request: JSON.parse(opts.stdin ?? '{}') as Request });
      const stdout = JSON.stringify(responses.shift() ?? { ok: false, error: 'nothing scripted' });
      return { exitCode: 0, stdout, stderr: '', output: stdout, timedOut: false, aborted: false, truncated: false, durationMs: 1 };
    },
  };
  return { computer, calls };
}

test('browser tools talk to the browser on the computer, and vault values stay out of commands and results', async () => {
  const config = testConfig().browser;
  const logins = new LoginStore(openDatabase(':memory:'));
  logins.create({ name: 'github', site: 'github.com', username: 'adit', password: 'hunter2-pass', totpSecret: 'GEZDGNBVGY3TQOJQ' });
  logins.create({ name: 'bank', site: 'bank.example', username: 'a', password: 'other-secret' });

  const { computer, calls } = scriptedComputer([
    { ok: true, page: pageView() },
    // A daemon that failed to hide the value: the tool must still not pass it on.
    { ok: true, page: pageView({ outline: '- textbox "Password" [ref=e7]: hunter2-pass' }) },
    { ok: true, page: pageView() },
    { ok: false, error: 'This page is on github.com, but that login belongs to bank.example.' },
    { ok: true, page: pageView({ outline: 'x'.repeat(100), offset: 200, outlineLength: 900 }) },
  ]);
  const tools = createBrowserTools({ computer, logins, config });

  const opened = await call(tools, 'browser_open', { url: 'https://github.com/login' });
  assert.equal(calls[0]!.command, config.command);
  assert.deepEqual(calls[0]!.request.command, { cmd: 'open', url: 'https://github.com/login' });
  assert.equal(calls[0]!.request.maxChars, config.maxOutputChars);
  assert.match(opened, /^Page: Sign in\nURL: https:\/\/github\.com\/login\n/);
  assert.match(opened, /Saved logins for this site: "github" \(username adit, password, one-time code\)/);
  assert.doesNotMatch(opened, /bank/, 'logins for other sites are not advertised');
  assert.doesNotMatch(opened, /Tabs:/, 'a single tab is not listed');

  const filled = await call(tools, 'browser_fill_login', { ref: 'e7', login: 'GitHub', field: 'password' });
  assert.deepEqual(calls[1]!.request.command, { cmd: 'fill_secret', ref: 'e7', value: 'hunter2-pass', site: 'github.com', redact: true });
  assert.doesNotMatch(calls[1]!.command, /hunter2/, 'the value travels on stdin, never in the command line');
  assert.match(filled, /^Filled the password of "github" into e7\./);
  assert.match(filled, /textbox "Password" \[ref=e7\]: \[hidden\]/);
  assert.doesNotMatch(filled, /hunter2/);

  await call(tools, 'browser_fill_login', { ref: 'e9', login: 'github', field: 'code' });
  const code = calls[2]!.request.command as { value: string; redact: boolean };
  assert.match(code.value, /^\d{6}$/);
  assert.equal(code.redact, false);

  await assert.rejects(call(tools, 'browser_fill_login', { ref: 'e7', login: 'bank', field: 'password' }), /belongs to bank\.example/);
  await assert.rejects(
    call(tools, 'browser_fill_login', { ref: 'e7', login: 'gitlab', field: 'password' }),
    /no saved login named "gitlab"\. Saved logins: "bank" \(bank\.example\), "github" \(github\.com\)/,
  );
  await assert.rejects(call(tools, 'browser_fill_login', { ref: 'e7', login: 'bank', field: 'code' }), /no one-time-code secret saved/);
  assert.equal(calls.length, 4, 'a login that cannot be filled never reaches the browser');

  const paged = await call(tools, 'browser_read', { offset: 200 });
  assert.match(paged, /\[showing characters 200–300 of 900; call browser_read with offset=300 for more, or with find/);
});

test('find locates text in a long outline: matching lines with their neighbours and where to read on', async () => {
  const outline = Array.from({ length: 400 }, (_, i) =>
    i === 120 ? '    - button "Add to cart" [ref=e120]' : i === 300 ? '  - heading "Cart summary" [ref=e300]' : `  - link "Item ${i}" [ref=e${i}]`,
  ).join('\n');

  const cart = findInOutline(outline, 'CART', 2000);
  assert.equal(cart.matches, 2);
  assert.equal(cart.shown, 2);
  assert.match(cart.text, /^\[at character \d+\]\n {2}- link "Item 118" \[ref=e118\]\n {2}- link "Item 119"[^\n]*\n {4}- button "Add to cart" \[ref=e120\]\n[^\n]*Item 121[^\n]*\n[^\n]*Item 122[^\n]*\n\n\[at character/);
  const at = Number(/\[at character (\d+)\]/.exec(cart.text)![1]);
  assert.ok(outline.slice(at).startsWith('  - link "Item 118"'), 'the offset is one browser_read can continue from');

  // No line holds the phrase: lines holding every word still count. Nothing at all is said plainly.
  assert.equal(findInOutline(outline, 'summary cart', 2000).matches, 1);
  assert.deepEqual(findInOutline(outline, 'checkout', 2000), { text: '', matches: 0, shown: 0 });
  // A sentence broken up by a link is found across the lines it was split into.
  const split = '- paragraph [ref=e1]:\n  - text: the world\'s largest\n  - link "archipelagic state" [ref=e2]\n  - text: and more';
  assert.equal(findInOutline(split, 'largest archipelagic', 2000).matches, 1);
  assert.match(findInOutline(split, 'largest archipelagic', 2000).text, /largest\n {2}- link "archipelagic state" \[ref=e2\]/);
  // A common word is capped, and says how many there were.
  const many = findInOutline(outline, 'item', 600);
  assert.equal(many.matches, 398);
  assert.ok(many.shown < 30 && many.text.length <= 700);

  const { computer, calls } = scriptedComputer([
    { ok: true, page: pageView({ outline: cart.text, outlineLength: outline.length, found: { query: 'cart', matches: 2, shown: 2 } }) },
    { ok: true, page: pageView({ outline: '', outlineLength: outline.length, found: { query: 'checkout', matches: 0, shown: 0 } }) },
  ]);
  const tools = createBrowserTools({ computer, logins: new LoginStore(openDatabase(':memory:')), config: testConfig().browser });
  const found = await call(tools, 'browser_read', { find: ' cart ' });
  assert.deepEqual(calls[0]!.request.command, { cmd: 'read', find: 'cart' });
  assert.match(found, /2 lines of the page match "cart"\. To read on from a match, call browser_read with offset/);
  assert.match(found, /button "Add to cart" \[ref=e120\]/);
  assert.match(await call(tools, 'browser_read', { find: 'checkout' }), /Nothing on this page matches "checkout"/);
});

test('a ref is described by its line of the outline: role and name, a link by where it goes, a nameless element by what is in it', () => {
  const outline = [
    '- generic [ref=e1]:',
    '  - link "Expenses" [ref=e3] [cursor=pointer]:',
    '    - /url: /expenses',
    '  - textbox "Title" [active] [ref=e9]: Berlin trip',
    '  - checkbox "I have read the travel policy" [checked] [ref=e11]',
    '  - generic [ref=e12] [cursor=pointer]:',
    '    - img [ref=e13]',
    '    - text: Next page',
    '  - button "Save draft" [ref=e35]',
    '  - button "Submit for approval" [ref=e36] [cursor=pointer]',
    '  - iframe [ref=e40]:',
    '    - button "Send for review" [ref=f1e3]',
  ].join('\n');

  assert.equal(describeElement(outline, 'e36'), 'button "Submit for approval"');
  assert.equal(describeElement(outline, 'e35'), 'button "Save draft"');
  assert.equal(describeElement(outline, 'e3'), 'link "Expenses" (to /expenses)');
  assert.equal(describeElement(outline, 'e11'), 'checkbox "I have read the travel policy" [checked]');
  assert.equal(describeElement(outline, 'e9'), 'textbox "Title": Berlin trip');
  assert.equal(describeElement(outline, 'e12'), 'generic containing img, text: Next page');
  assert.equal(describeElement(outline, 'f1e3'), 'button "Send for review"');
  // A ref is matched whole: e3 is not e35 or e36, and one that is not in the outline has no description.
  assert.equal(describeElement(outline, 'e99'), undefined);
  assert.equal(describeElement('', 'e1'), undefined);
  // Without a ref: whatever has the focus, unless that is the page itself.
  assert.equal(describeElement(outline), 'textbox "Title": Berlin trip');
  assert.equal(describeElement('- generic [active] [ref=e1]:\n  - button "Go" [ref=e2]'), undefined);
  assert.ok(describeElement(`- button "${'x'.repeat(900)}" [ref=e2]`, 'e2')!.length < 320, 'a long name is cut');
});

test('what a browser call acts on is asked of the browser, never guessed: the element and its page, with vault values hidden', async () => {
  const config = testConfig().browser;
  const logins = new LoginStore(openDatabase(':memory:'));
  logins.create({ name: 'github', site: 'github.com', username: 'adit', password: 'hunter2-pass' });
  const target = { element: 'button "Submit for approval"', title: 'New expense report', url: 'https://hr.example/expenses/new' };
  const { computer, calls } = scriptedComputer([
    { ok: true, target },
    { ok: true, target: { ...target, element: 'textbox "Password": hunter2-pass' } },
    { ok: true, target: { ...target, element: 'textbox "Search"' } },
    { ok: true },
    { ok: true, info: 'not running' },
    { ok: false, error: 'The browser daemon did not start.' },
  ]);
  const targetOf = createBrowserTargets({ computer, logins, config, session: 'conv_helper' });

  assert.deepEqual(await targetOf({ name: 'browser_click', input: { ref: 'e36' } }), target);
  assert.deepEqual(calls[0]!.request.command, { cmd: 'describe', ref: 'e36' });
  assert.equal(calls[0]!.request.session, 'conv_helper');
  assert.equal((await targetOf({ name: 'browser_fill_login', input: { ref: 'e7', login: 'github', field: 'password' } }))!.element, 'textbox "Password": [hidden]');
  // A key press goes to whatever has the focus.
  assert.equal((await targetOf({ name: 'browser_key', input: { key: 'Enter' } }))!.element, 'textbox "Search"');
  assert.deepEqual(calls[2]!.request.command, { cmd: 'describe' });

  // The browser knows no such element, or is not running: the call is about to fail by itself.
  assert.equal(await targetOf({ name: 'browser_click', input: { ref: 'e99' } }), undefined);
  assert.equal(await targetOf({ name: 'browser_click', input: { ref: 'e36' } }), undefined);
  // The browser could not be asked: the element stays unknown, which is not the same as harmless.
  assert.equal(await targetOf({ name: 'browser_click', input: { ref: 'e36' } }), null);
  const broken: Computer = { workspace: '/home/test', describe: () => 'broken', exec: async () => { throw new Error('exec failed'); } };
  assert.equal(await createBrowserTargets({ computer: broken, logins, config })({ name: 'browser_type', input: { ref: 'e1', text: 'x' } }), null);

  // Uploads: one path per line or a JSON list, relative ones from ~/Drive, and never more than ten.
  const up = scriptedComputer([{ ok: true, page: pageView() }, { ok: true, page: pageView() }]);
  const uploader = createBrowserTools({ computer: up.computer, logins, config });
  await call(uploader, 'browser_upload', { ref: 'e4', files: ' Trip/hotel.png \n\n~/notes/cv.pdf\n/tmp/x.txt' });
  assert.deepEqual(up.calls[0]!.request.command, { cmd: 'upload', ref: 'e4', paths: ['/home/test/Drive/Trip/hotel.png', '/home/test/notes/cv.pdf', '/tmp/x.txt'] });
  await call(uploader, 'browser_upload', { ref: 'e4', files: '["a.png", "b.png"]' });
  assert.deepEqual((up.calls[1]!.request.command as { paths: string[] }).paths, ['/home/test/Drive/a.png', '/home/test/Drive/b.png']);
  assert.throws(() => call(uploader, 'browser_upload', { ref: 'e4', files: Array.from({ length: 11 }, (_, i) => `f${i}`).join('\n') }), /At most 10 files/);
  assert.equal(up.calls.length, 2);
  assert.ok(!('browser_upload' in createBrowserTools({ computer: up.computer, logins, config, upload: false })));

  // Calls that name no element are not asked about at all.
  const before = calls.length;
  for (const other of [
    { name: 'browser_open', input: { url: 'https://example.com' } },
    { name: 'browser_read', input: {} },
    { name: 'browser_control', input: { action: 'back' } },
    { name: 'bash', input: { command: 'ls', ref: 'e1' } },
  ]) {
    assert.equal(await targetOf(other), undefined);
  }
  assert.equal(calls.length, before);
});

test('a helper drives tabs of its own: its commands name its session, and the vault is not offered to it', async () => {
  const sunnie = testSunnie();
  const { logins, config } = sunnie.deps;
  logins.create({ name: 'github', site: 'github.com', username: 'adit', password: 'hunter2-pass' });
  const { computer, calls } = scriptedComputer([{ ok: true, page: pageView() }, { ok: true, info: 'closed 1 tab' }]);

  const tools = createHelperTools({ config, computer, logins, skills: sunnie.deps.skills, conversationId: 'conv_helper' });
  assert.ok(!('browser_fill_login' in tools));
  assert.doesNotMatch(String(tools.browser_type!.description), /browser_fill_login/);
  const opened = await call(tools, 'browser_open', { url: 'https://github.com/login' });
  assert.equal(calls[0]!.request.session, 'conv_helper');
  assert.doesNotMatch(opened, /Saved logins/);

  await endBrowserSession({ computer, config: config.browser }, 'conv_helper');
  assert.deepEqual([calls[1]!.request.command, calls[1]!.request.session], [{ cmd: 'end' }, 'conv_helper']);
  // The agent itself stays in the main session.
  const main = scriptedComputer([{ ok: true, page: pageView() }]);
  await call(createBrowserTools({ computer: main.computer, logins, config: config.browser }), 'browser_read', {});
  assert.equal(main.calls[0]!.request.session, undefined);
  await sunnie.close();
});

test('a browser that cannot be reached is reported as a tool error the model can read', async () => {
  const computer: Computer = {
    workspace: '/home/test',
    describe: () => 'broken',
    exec: async () => ({ exitCode: 127, stdout: '', stderr: 'node: command not found', output: '', timedOut: false, aborted: false, truncated: false, durationMs: 1 }),
  };
  const tools = createBrowserTools({ computer, logins: new LoginStore(openDatabase(':memory:')), config: testConfig().browser });
  await assert.rejects(call(tools, 'browser_read', {}), /could not be reached on your computer \(node: command not found\)/);
  await assert.rejects(call(tools, 'browser_fill_login', { ref: 'e1', login: 'x', field: 'password' }), /No logins are saved yet/);
});

test('with the browser disabled, neither its tools nor its prompt section exist', async () => {
  const toolNames = async (raw: Record<string, unknown>) => {
    const sunnie = testSunnie(raw);
    const names = Object.keys(createTools({ ...sunnie.deps, conversationId: 'conv_x' }));
    await sunnie.close();
    return names.filter((name) => name.startsWith('browser_'));
  };
  assert.deepEqual(await toolNames({}), [
    'browser_open',
    'browser_read',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_fill_login',
    'browser_upload',
    'browser_key',
    'browser_control',
  ]);
  assert.deepEqual(await toolNames({ browser: { enabled: false } }), []);

  const computer: Computer = { workspace: '/home/test', describe: () => 'test', exec: async () => assert.fail('not used') };
  const prompt = (browser: boolean) => buildInstructions({ name: 'Sunnie', computer, browser, blocks: {} });
  assert.match(prompt(true), /# Your browser\n[\s\S]*browser_fill_login[\s\S]*# Your memory/);
  assert.doesNotMatch(prompt(false), /browser/i);
});

// ── The real thing: Chrome on a real LocalComputer, against a site served from this process ──

const SECRET = 's3cret-Pa55word';
const posted: string[] = [];
const uploaded: string[] = [];
let site: Server | undefined;
let stopBrowser: (() => Promise<unknown>) | undefined;

after(async () => {
  await stopBrowser?.();
  site?.close();
});

function startSite(): Promise<string> {
  site = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const signedIn = /sid=ok/.test(req.headers.cookie ?? '');
      if (req.method === 'POST' && req.url === '/upload') {
        uploaded.push(...[...body.matchAll(/name="(\w+)"; filename="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`));
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<title>Sent</title><h1>Received</h1>');
      }
      if (req.method === 'POST') {
        posted.push(body);
        // A session cookie (no expiry): the kind Chrome forgets when it exits.
        const ok = body.includes(`password=${SECRET}`);
        res.writeHead(302, ok ? { 'set-cookie': 'sid=ok; HttpOnly; Path=/', location: '/home' } : { location: '/login' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/upload') {
        return res.end(
          '<title>Apply</title><form method="post" action="/upload" enctype="multipart/form-data">' +
            '<label>Receipts <input name="receipts" type="file" multiple></label>' +
            '<label>Photo <input name="photo" type="file"></label>' +
            '<input name="cv" type="file" id="cv" hidden><button type="button" onclick="cv.click()">Attach CV</button>' +
            '<button>Send</button></form>',
        );
      }
      if (req.url === '/home') {
        return res.end(`<title>Home</title><h1>${signedIn ? 'Welcome back, adit' : 'You are signed out'}</h1>`);
      }
      res.end(
        '<title>Sign in</title><h1>Sign in</h1><form method="post" action="/login">' +
          '<label>Email <input name="email"></label><label>Password <input name="password" type="password"></label>' +
          '<select name="plan" aria-label="Plan"><option>Free</option><option>Pro</option></select>' +
          '<button>Sign in</button></form><a href="/home" target="_blank">Home in a new tab</a>',
      );
    });
  });
  return new Promise((resolve) => {
    site!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(site!.address() as AddressInfo).port}`));
  });
}

test('the real browser signs in from the vault, hides the password, and stays signed in across a restart', async (t) => {
  const config = { ...testConfig().browser, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH, idleMinutes: 5 };
  const computer = new LocalComputer({ workspace: mkdtempSync(join(tmpdir(), 'sunnie-browser-')) });
  const logins = new LoginStore(openDatabase(':memory:'));
  const tools = createBrowserTools({ computer, logins, config });

  const control = async (cmd: 'status' | 'shutdown'): Promise<Response> => {
    const request: Request = { launch: { headless: true, browsersPath: config.browsersPath, idleMinutes: 5 }, command: { cmd }, maxChars: 1000 };
    const res = await computer.exec(config.command, { stdin: JSON.stringify(request), timeoutMs: 60_000 });
    return JSON.parse(res.stdout) as Response;
  };
  const status = await control('status');
  if (!status.ok) return t.skip(`no browser on this machine: ${status.error}`);
  // Chromium is only the fallback for a machine without Chrome.
  if (existsSync('/Applications/Google Chrome.app') || existsSync('/opt/google/chrome/chrome')) {
    assert.match(status.info ?? '', /^Google Chrome \d+\./);
  }
  stopBrowser = () => control('shutdown');

  const base = await startSite();
  logins.create({ name: 'testsite', site: '127.0.0.1', username: 'adit@example.com', password: SECRET });
  logins.create({ name: 'elsewhere', site: 'example.com', username: 'x', password: 'not-for-this-site' });
  const refOf = (outline: string, pattern: string) => {
    const match = new RegExp(`${pattern}[^\\n]*\\[ref=(\\w+)\\]`).exec(outline);
    assert.ok(match, `expected ${pattern} in:\n${outline}`);
    return match[1]!;
  };

  const opened = await call(tools, 'browser_open', { url: `${base}/login` });
  assert.match(opened, /Page: Sign in/);
  assert.match(opened, /Saved logins for this site: "testsite" \(username adit@example\.com, password\)/);

  await assert.rejects(
    call(tools, 'browser_fill_login', { ref: refOf(opened, 'textbox "Password"'), login: 'elsewhere', field: 'password' }),
    /belongs to example\.com/,
  );
  await assert.rejects(call(tools, 'browser_click', { ref: 'e999' }), /not on the page any more/);

  await call(tools, 'browser_fill_login', { ref: refOf(opened, 'textbox "Email"'), login: 'testsite', field: 'username' });
  const withPassword = await call(tools, 'browser_fill_login', { ref: refOf(opened, 'textbox "Password"'), login: 'testsite', field: 'password' });
  assert.doesNotMatch(withPassword, new RegExp(SECRET));
  assert.match(withPassword, /textbox "Password"[^\n]*: \[hidden\]/);
  assert.match(withPassword, /adit@example\.com/, 'a username is not a secret');

  const picked = await call(tools, 'browser_type', { ref: refOf(opened, 'combobox "Plan"'), text: 'Pro' });
  assert.match(picked, /option "Pro" \[selected\]/);

  // Before a click is allowed, the browser can say what the ref stands for — without touching the page.
  const targetOf = createBrowserTargets({ computer, logins, config });
  const signIn = refOf(picked, 'button "Sign in"');
  assert.deepEqual(await targetOf({ name: 'browser_click', input: { ref: signIn } }), {
    element: 'button "Sign in"',
    title: 'Sign in',
    url: `${base}/login`,
  });
  const password = await targetOf({ name: 'browser_fill_login', input: { ref: refOf(picked, 'textbox "Password"') } });
  assert.equal(password!.element, 'textbox "Password": [hidden]');
  assert.equal(await targetOf({ name: 'browser_click', input: { ref: 'e999' } }), undefined);
  assert.equal(posted.length, 0, 'describing an element acts on nothing');

  const home = await call(tools, 'browser_click', { ref: signIn });
  assert.match(home, /URL: http:\/\/127\.0\.0\.1:\d+\/home/);
  assert.match(home, /Welcome back, adit/);
  assert.equal(posted[0], `email=adit%40example.com&password=${SECRET}&plan=Pro`);
  assert.doesNotMatch(posted.join(), /not-for-this-site/);

  // find works against the live page, and the refs it returns can be acted on.
  const located = await call(tools, 'browser_read', { find: 'welcome' });
  assert.match(located, /1 line of the page matches "welcome"/);
  assert.match(located, /heading "Welcome back, adit"/);

  // A link that opens a new tab is followed, and the tab can be closed again.
  const login = await call(tools, 'browser_open', { url: `${base}/login` });
  const newTab = await call(tools, 'browser_click', { ref: refOf(login, 'link "Home in a new tab"') });
  assert.match(newTab, /Tabs:\n {2}1\. Sign in\n {2}2\. Home \(current\)/);
  const closed = await call(tools, 'browser_control', { action: 'close_tab' });
  assert.match(closed, /Page: Sign in/);
  assert.match(await call(tools, 'browser_control', { action: 'back' }), /Welcome back, adit/);

  // Files go from the computer into a page: into a file field, and through the picker a button opens.
  mkdirSync(join(computer.workspace, 'Drive', 'Trip'), { recursive: true });
  for (const name of ['Trip/hotel.png', 'Trip/taxi.png', 'cv.pdf']) writeFileSync(join(computer.workspace, 'Drive', name), `file ${name}`);
  const form = await call(tools, 'browser_open', { url: `${base}/upload` });
  const attached = await call(tools, 'browser_upload', { ref: refOf(form, 'button "Receipts"'), files: 'Trip/hotel.png\n~/Drive/Trip/taxi.png' });
  assert.match(attached, /Note: Chosen for upload: hotel\.png, taxi\.png\./);
  assert.deepEqual(await targetOf({ name: 'browser_upload', input: { ref: refOf(form, 'button "Receipts"'), files: 'x' } }), {
    element: 'button "Receipts"', title: 'Apply', url: `${base}/upload`,
  });
  await call(tools, 'browser_upload', { ref: refOf(attached, 'button "Attach CV"'), files: join(computer.workspace, 'Drive', 'cv.pdf') });
  await assert.rejects(call(tools, 'browser_upload', { ref: refOf(attached, 'button "Photo"'), files: 'Trip/hotel.png\nTrip/taxi.png' }), /one file at a time/);
  await assert.rejects(call(tools, 'browser_upload', { ref: refOf(attached, 'button "Photo"'), files: 'Trip/missing.png' }), /There is no file at .*missing\.png/);
  // A plain click on a file button opens no window nobody can close: the agent is told what to do instead.
  const fresh = await call(tools, 'browser_open', { url: `${base}/upload` });
  assert.match(await call(tools, 'browser_click', { ref: refOf(fresh, 'button "Attach CV"') }), /Note: That opened a file picker, and nothing was chosen\. To attach a file, call browser_upload/);
  await call(tools, 'browser_upload', { ref: refOf(fresh, 'button "Receipts"'), files: '["Trip/hotel.png", "Trip/taxi.png"]' });
  await call(tools, 'browser_upload', { ref: refOf(fresh, 'button "Attach CV"'), files: 'cv.pdf' });
  assert.match(await call(tools, 'browser_click', { ref: refOf(fresh, 'button "Send"') }), /Received/);
  assert.deepEqual(uploaded.filter((f) => !f.endsWith('=')), ['receipts=hotel.png', 'receipts=taxi.png', 'cv=cv.pdf']);
  await call(tools, 'browser_open', { url: `${base}/home` });

  // A screenshot is the page as a picture: JPEG bytes for the model, a line of text for everyone else.
  const picture = await (tools.browser_screenshot!.execute as (input: unknown, opts: unknown) => Promise<{ url: string; width: number; data: string }>)({}, { toolCallId: 't', messages: [] });
  assert.equal(picture.url, `${base}/home`);
  assert.ok(picture.width > 0 && picture.data.startsWith('/9j/'), 'a base64 JPEG');
  const shown = tools.browser_screenshot!.toModelOutput!({ output: picture, toolCallId: 't', input: {} } as never) as { value: Array<{ type: string; mediaType?: string }> };
  assert.deepEqual(shown.value.map((part) => part.type), ['text', 'file']);
  assert.equal(shown.value[1]!.mediaType, 'image/jpeg');
  // A model that cannot see pictures is told so, without a browser command.
  const blind = createBrowserTools({ computer, logins, config, images: false });
  await assert.rejects(call(blind, 'browser_screenshot', {}), /cannot be shown pictures/);

  // Helpers get tabs of their own in the same browser: they work at the same time, see only
  // their own tabs, share the sign-in, and leave the agent's page where it was.
  const helperA = createBrowserTools({ computer, logins, config, session: 'helper-a', vault: false });
  const helperB = createBrowserTools({ computer, logins, config, session: 'helper-b', vault: false });
  const [a, b] = await Promise.all([
    call(helperA, 'browser_open', { url: `${base}/home` }),
    call(helperB, 'browser_open', { url: `${base}/login` }),
  ]);
  assert.match(a, /Page: Home[\s\S]*Welcome back, adit/);
  assert.match(b, /Page: Sign in/);
  assert.doesNotMatch(a + b, /Tabs:|Saved logins/);
  const popped = await call(helperB, 'browser_click', { ref: refOf(b, 'link "Home in a new tab"') });
  assert.match(popped, /Tabs:\n {2}1\. Sign in\n {2}2\. Home \(current\)/);
  assert.match(await call(helperA, 'browser_read', {}), /Page: Home/);
  const mine = await call(tools, 'browser_read', {});
  assert.match(mine, /Welcome back, adit/);
  assert.doesNotMatch(mine, /Tabs:/, "helpers' tabs are not the agent's");
  await endBrowserSession({ computer, config }, 'helper-a');
  await endBrowserSession({ computer, config }, 'helper-b');
  assert.doesNotMatch(await call(tools, 'browser_read', {}), /Tabs:/);
  assert.match(await call(helperA, 'browser_read', {}), /Page: \(untitled\)\nURL: about:blank/, 'a session that ended starts from a new tab');
  await endBrowserSession({ computer, config }, 'helper-a');

  // The user takes the page over from the app: it is pictured as they would see it, and their
  // taps and typing land on it as a mouse's and a keyboard's would. What they type as a secret
  // stays out of the outline the agent reads afterwards.
  await call(tools, 'browser_open', { url: `${base}/login` });
  const handoff = new BrowserHandoff({ computer, config, log: createLogger('silent') });
  await assert.rejects(handoff.screen(), /Take the browser over first/);
  handoff.take();
  const shot = await handoff.screen();
  assert.deepEqual([shot.width, shot.height, shot.url, shot.title], [1280, 900, `${base}/login`, 'Sign in']);
  assert.equal(Buffer.from(shot.image, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'a JPEG');
  const blank = await handoff.input({ kind: 'tap', x: 640, y: 860 });
  assert.equal(blank.focus, undefined, 'nothing has the focus');
  const email = await handoff.input({ kind: 'key', key: 'Tab' });
  assert.deepEqual(email.focus, { secret: false, label: 'Email' }, 'the app is told which field has the focus');
  await handoff.input({ kind: 'text', text: 'hush-Value-99', secret: true });
  assert.ok(handoff.end({ outcome: 'done' }));
  const typed = await call(tools, 'browser_read', {});
  assert.match(typed, /textbox "Email"[^\n]*: \[hidden\]/);
  assert.doesNotMatch(typed, /hush-Value/);
  handoff.take();
  await handoff.input({ kind: 'key', key: 'ControlOrMeta+A' });
  await handoff.input({ kind: 'text', text: 'adit@example.com' });
  const passwordField = await handoff.input({ kind: 'key', key: 'Tab' });
  assert.deepEqual(passwordField.focus, { secret: true, label: 'Password' });
  await handoff.input({ kind: 'text', text: SECRET, secret: true });
  await handoff.input({ kind: 'key', key: 'Enter' });
  let after = await handoff.screen();
  for (let i = 0; i < 20 && !after.url.endsWith('/home'); i++) after = await handoff.screen();
  assert.equal(after.url, `${base}/home`, 'the form the user filled in was submitted');
  // Laid out for the phone that holds it; the agent's next command gets its own window back.
  const phone = await handoff.screen(undefined, { width: 390, height: 640 });
  assert.deepEqual([phone.width, phone.height, phone.url], [390, 640, `${base}/home`]);
  assert.ok(handoff.end({ outcome: 'done', note: 'signed in' }));
  assert.equal(posted.at(-1), `email=adit%40example.com&password=${SECRET}&plan=Free`);
  assert.match(await call(tools, 'browser_read', {}), /Welcome back, adit/);
  handoff.take();
  assert.deepEqual([(await handoff.screen()).width, (await handoff.screen()).height], [1280, 900], 'the desktop window is back');
  assert.ok(handoff.end({ outcome: 'done' }));

  // The browser goes away (idle, or a server restart) and comes back still signed in — even when
  // the last one was killed: a profile lock naming another host, and a pid file whose number now
  // belongs to some other process, as after a container restart.
  assert.equal((await control('shutdown')).ok, true);
  const state = join(computer.workspace, '.sunnie', 'browser');
  for (const profile of ['profile', 'profile-chrome']) {
    if (existsSync(join(state, profile))) symlinkSync('another-host-4242', join(state, profile, 'SingletonLock'));
  }
  // Asking about an element is no reason to start a browser: with none running there is nothing to say.
  assert.equal(await targetOf({ name: 'browser_click', input: { ref: signIn } }), undefined);
  assert.ok(!existsSync(join(state, 'daemon.pid')), 'no daemon was started');
  writeFileSync(join(state, 'daemon.pid'), String(process.pid));
  const again = await call(tools, 'browser_open', { url: `${base}/home` });
  assert.match(again, /Welcome back, adit/);

  // The browser dies under the daemon (a crash, the OOM killer): the next page still opens.
  await computer.exec(`pkill -9 -f ${JSON.stringify(state)}`);
  await new Promise((r) => setTimeout(r, 500));
  const revived = await call(tools, 'browser_open', { url: `${base}/home` });
  assert.match(revived, /Welcome back, adit/);
});
