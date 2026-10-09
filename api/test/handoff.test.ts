import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { ToolSet } from 'ai';
import type { PageView, Request, Response as BrowserResponse, Screen } from '../browser/protocol.ts';
import type { Run } from '../src/agent/runs.ts';
import { LocalComputer, type Computer, type ExecOptions, type ExecResult } from '../src/computer/computer.ts';
import type { PushMessage, PushResult, PushSender } from '../src/push/apns.ts';
import { BROWSER_HELD, createBrowserTools } from '../src/tools/browser-tools.ts';
import { createHelperTools, createTools } from '../src/tools/index.ts';
import { registryOf, TEST_API_KEY, testConfig, testSunnie, textStep, toolStep } from './helpers.ts';
import type { Sunnie } from '../src/app.ts';

/**
 * The browser handed to the user: the agent asks and waits, the app takes the page over, sees it
 * and acts on it, and hands it back. The browser daemon is scripted here (the real one is driven
 * in browser.test.ts); everything from the tool to the HTTP API is real.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
const screen = (over: Partial<Screen> = {}): Screen => ({ image: JPEG, width: 1280, height: 900, url: 'https://shop.example/login', title: 'Sign in — Shop', ...over });
const pageView = (outline: string): PageView => ({ url: 'https://shop.example/account', title: 'Your account', tabs: [], outline, offset: 0, outlineLength: outline.length, notes: [] });

/**
 * A computer whose browser answers from a script, and whose everything else is real: the
 * browser daemon is the one thing a test cannot have, and a turn touches more than the browser.
 */
function withScriptedBrowser(workspace: string, command: string, responses: BrowserResponse[]) {
  const real = new LocalComputer({ workspace });
  const browser: Array<Request['command']> = [];
  const computer: Computer = {
    workspace: real.workspace,
    describe: () => real.describe(),
    exec: async (cmd: string, opts: ExecOptions = {}): Promise<ExecResult> => {
      if (cmd !== command) return real.exec(cmd, opts);
      const request = JSON.parse(opts.stdin ?? '{}') as Request;
      browser.push(request.command);
      const stdout = JSON.stringify(responses.shift() ?? { ok: false, error: 'nothing scripted' });
      return { exitCode: 0, stdout, stderr: '', output: stdout, timedOut: false, aborted: false, truncated: false, durationMs: 1 };
    },
  };
  return { computer, browser };
}

class FakeSender implements PushSender {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  async send(_device: Parameters<PushSender['send']>[0], message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return 'sent';
  }
  close() {}
}

function setup(steps: ConstructorParameters<typeof MockLanguageModelV4>[0], responses: BrowserResponse[]) {
  const config = testConfig();
  const { computer, browser } = withScriptedBrowser(config.computer.workspace, config.browser.command, responses);
  const push = new FakeSender();
  const sunnie = testSunnie({}, { models: registryOf(new MockLanguageModelV4(steps)), computer, push });
  const conversationId = sunnie.deps.conversations.create().id;
  return { sunnie, browser, push, conversationId };
}

const api = (sunnie: Sunnie, path: string, init: { method?: string; body?: unknown } = {}) =>
  sunnie.app.request(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

// Responses are asserted on field by field, so an untyped body is fine here.
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), what);
}

async function eventsOf(sunnie: Sunnie, run: Run) {
  const events = [];
  for await (const e of sunnie.runs.subscribe(run.id)) events.push(e);
  return events;
}

const call = (tools: ToolSet, name: string, input: unknown): Promise<string> =>
  (tools[name]!.execute as (input: unknown, opts: unknown) => Promise<string>)(input, { toolCallId: 't', messages: [] });

test('the agent asks for the browser and waits; the user takes it in the app, acts on the page and hands it back', async () => {
  const { sunnie, browser, push, conversationId } = setup(
    { doStream: [toolStep('browser_handoff', { reason: 'Solve the CAPTCHA, then sign in with your account.' }, 'c1'), textStep('Thanks — you are signed in.')] },
    [
      { ok: true, screen: screen() },
      { ok: true, screen: screen({ width: 390, height: 640 }) },
      { ok: true, screen: screen({ url: 'https://shop.example/login?step=2', title: 'Sign in — Shop', focus: { secret: true, label: 'Password' } }) },
      { ok: true, screen: screen() },
      { ok: true, page: pageView('- heading "Welcome back, Adit" [ref=e1]') },
    ],
  );
  // A device to notify, so the request reaches the phone like a held approval does.
  await api(sunnie, '/v1/devices', { body: { token: 'a'.repeat(64), environment: 'sandbox' } });
  assert.deepEqual((await json(api(sunnie, '/v1/info'))).browser, { enabled: true, handoff: true });
  assert.deepEqual(await json(api(sunnie, '/v1/browser/handoff')), { handoff: null });

  const run = sunnie.runs.start({ conversationId, text: 'Sign in to the shop and check my order' });
  await waitFor(() => sunnie.deps.handoff.state?.status === 'requested', 'the run should be waiting for the user to take the browser');
  const requested = (await json(api(sunnie, '/v1/browser/handoff'))).handoff;
  assert.equal(requested.status, 'requested');
  assert.equal(requested.reason, 'Solve the CAPTCHA, then sign in with your account.');
  assert.deepEqual([requested.conversationId, requested.runId, requested.toolCallId, requested.takenAt], [conversationId, run.id, 'c1', null]);
  assert.match(requested.id, /^hand_/);
  assert.equal(run.status, 'running');
  // Nothing is pictured before the user has taken the browser: the page is not theirs yet.
  assert.equal((await api(sunnie, '/v1/browser/handoff/screen')).status, 409);
  assert.equal(browser.length, 0, 'asking touched no page');

  const taken = (await json(api(sunnie, '/v1/browser/handoff', { body: {} }))).handoff;
  assert.deepEqual([taken.id, taken.status], [requested.id, 'active']);
  assert.ok(taken.takenAt);
  assert.equal((await json(api(sunnie, '/v1/browser/handoff', { body: {} }))).handoff.id, requested.id, 'taking it again changes nothing');

  // The page as the user sees it, with where it is in the headers.
  const picture = await api(sunnie, '/v1/browser/handoff/screen');
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await picture.arrayBuffer()).toString('base64'), JPEG);
  assert.deepEqual(
    ['x-screen-width', 'x-screen-height', 'x-page-url', 'x-page-title', 'cache-control'].map((h) => picture.headers.get(h)),
    ['1280', '900', encodeURIComponent('https://shop.example/login'), encodeURIComponent('Sign in — Shop'), 'no-store'],
  );
  assert.deepEqual(browser.at(-1), { cmd: 'screenshot' });
  // The app says how big its screen is, so the page is laid out for a phone rather than shrunk.
  const phone = await api(sunnie, '/v1/browser/handoff/screen?width=390&height=640.5');
  assert.deepEqual([phone.status, phone.headers.get('x-screen-width')], [200, '390']);
  assert.deepEqual(browser.at(-1), { cmd: 'screenshot', viewport: { width: 390, height: 640.5 } });
  assert.equal((await api(sunnie, '/v1/browser/handoff/screen?width=390')).status, 400, 'both sides or neither');
  assert.equal((await api(sunnie, '/v1/browser/handoff/screen?width=wide&height=640')).status, 400);

  // A tap and typing land on the page as a mouse and a keyboard would; each answers with the page afterwards.
  const tapped = await api(sunnie, '/v1/browser/handoff/input', { body: { kind: 'tap', x: 640.5, y: 412 } });
  assert.equal(tapped.status, 200);
  assert.equal(tapped.headers.get('x-page-url'), encodeURIComponent('https://shop.example/login?step=2'));
  // The tap landed in a password field: the app is told, so it can offer a hidden keyboard.
  assert.deepEqual([tapped.headers.get('x-focus-secret'), tapped.headers.get('x-focus-label')], ['1', 'Password']);
  assert.equal(picture.headers.get('x-focus-label'), null, 'no field, no header');
  assert.deepEqual(browser.at(-1), { cmd: 'input', input: { kind: 'tap', x: 640.5, y: 412 } });
  assert.equal((await api(sunnie, '/v1/browser/handoff/input', { body: { kind: 'text', text: 'hunter2', secret: true } })).status, 200);
  assert.deepEqual(browser.at(-1), { cmd: 'input', input: { kind: 'text', text: 'hunter2', secret: true } });
  assert.equal((await api(sunnie, '/v1/browser/handoff/input', { body: { kind: 'swipe', x: 1, y: 2 } })).status, 400);
  assert.equal((await api(sunnie, '/v1/browser/handoff/input', { body: { kind: 'tap', x: -1, y: 2 } })).status, 400);

  // Meanwhile the run is still waiting, and the phone was told.
  assert.equal(run.status, 'running');
  await sunnie.notifier.idle();
  assert.deepEqual(push.sent.map((m) => [m.body, m.data.kind, m.collapseId]), [
    ['Sunnie needs you in the browser: Solve the CAPTCHA, then sign in with your account.', 'handoff', `handoff-${run.id}`],
  ]);

  // Handing back answers the agent's call with the page as the user left it.
  assert.equal((await api(sunnie, '/v1/browser/handoff/end', { body: { note: 'done, signed in' } })).status, 204);
  assert.deepEqual(await json(api(sunnie, '/v1/browser/handoff')), { handoff: null });
  assert.equal((await api(sunnie, '/v1/browser/handoff/end', { body: {} })).status, 404, 'nothing left to end');
  await run.done;
  assert.equal(run.status, 'completed');
  assert.deepEqual(browser.at(-1), { cmd: 'read' });

  const events = await eventsOf(sunnie, run);
  const handoffs = events.filter((e) => e.type.startsWith('browser.handoff.')).map(({ seq: _seq, ...e }) => e);
  assert.deepEqual(handoffs, [
    { type: 'browser.handoff.requested', toolCallId: 'c1', handoffId: requested.id, reason: 'Solve the CAPTCHA, then sign in with your account.' },
    { type: 'browser.handoff.resolved', toolCallId: 'c1', handoffId: requested.id, outcome: 'done' },
  ]);
  const result = events.find((e) => e.type === 'tool.result' && e.toolCallId === 'c1');
  assert.ok(result && result.type === 'tool.result' && !result.isError);
  assert.match(result.output, /^The user took the browser over and handed it back\. They said: "done, signed in"\. This is the page as they left it:\nPage: Your account\nURL: https:\/\/shop\.example\/account\n/);
  assert.match(result.output, /Welcome back, Adit/);
  const index = (type: string) => events.findIndex((e) => e.type === type);
  assert.ok(index('browser.handoff.requested') < index('browser.handoff.resolved') && index('browser.handoff.resolved') < index('tool.result'));
  await sunnie.close();
});

test('the user may decline, and a stopped run takes its request with it', async () => {
  const { sunnie, conversationId } = setup(
    {
      doStream: [
        toolStep('browser_handoff', { reason: 'Enter the code from your SMS.' }, 'c1'),
        textStep('No problem; the code is still needed.'),
        toolStep('browser_handoff', { reason: 'Approve the sign-in.' }, 'c2'),
        textStep('Never sent.'),
      ],
    },
    [],
  );

  const first = sunnie.runs.start({ conversationId, text: 'Sign in' });
  await waitFor(() => sunnie.deps.handoff.state?.status === 'requested', 'waiting');
  // Declining needs no taking over first.
  assert.equal((await api(sunnie, '/v1/browser/handoff/end', { body: { outcome: 'declined', note: 'later' } })).status, 204);
  await first.done;
  const events = await eventsOf(sunnie, first);
  const result = events.find((e) => e.type === 'tool.result' && e.toolCallId === 'c1');
  assert.ok(result && result.type === 'tool.result' && result.isError);
  assert.match(result.output, /^The user did not take the browser over\. They said: "later"\. Do not ask again in this turn/);
  assert.deepEqual(events.filter((e) => e.type === 'browser.handoff.resolved').map((e) => e.type === 'browser.handoff.resolved' && e.outcome), ['declined']);
  assert.equal(sunnie.deps.handoff.state, null);

  const second = sunnie.runs.start({ conversationId, text: 'Try again' });
  await waitFor(() => sunnie.deps.handoff.state?.toolCallId === 'c2', 'waiting again');
  sunnie.runs.cancel(second.id);
  await second.done;
  assert.equal(second.status, 'cancelled');
  assert.equal(sunnie.deps.handoff.state, null, 'the request went with the run');
  const types = (await eventsOf(sunnie, second)).map((e) => e.type);
  assert.ok(types.includes('browser.handoff.requested') && !types.includes('browser.handoff.resolved'), 'a stopped run reports no decision of the user');
  await sunnie.close();
});

test('while the user holds the browser, the agent is refused its own browser calls; its request then rides on their hand-off', async () => {
  const { sunnie, browser, conversationId } = setup(
    {
      doStream: [
        toolStep('browser_open', { url: 'https://shop.example/' }, 'c1'),
        toolStep('browser_handoff', { reason: 'Sign in, then hand back.' }, 'c2'),
        textStep('Signed in.'),
      ],
    },
    [{ ok: true, screen: screen() }, { ok: true, page: pageView('- heading "Welcome" [ref=e1]') }],
  );

  // The user takes the browser on their own, with no run going.
  const own = (await json(api(sunnie, '/v1/browser/handoff', { body: {} }))).handoff;
  assert.deepEqual([own.status, own.reason, own.runId, own.toolCallId], ['active', null, null, null]);
  assert.equal((await api(sunnie, '/v1/browser/handoff/screen')).status, 200);

  const run = sunnie.runs.start({ conversationId, text: 'Open the shop' });
  await waitFor(() => sunnie.deps.handoff.state?.toolCallId === 'c2', 'the request should join the hand-off the user holds');
  const joined = (await json(api(sunnie, '/v1/browser/handoff'))).handoff;
  assert.deepEqual([joined.id, joined.status, joined.reason, joined.runId], [own.id, 'active', 'Sign in, then hand back.', run.id]);
  assert.deepEqual(browser.map((c) => c.cmd), ['screenshot'], 'the agent\'s open never reached the browser');

  assert.equal((await api(sunnie, '/v1/browser/handoff/end', { body: {} })).status, 204);
  await run.done;
  const events = await eventsOf(sunnie, run);
  const refused = events.find((e) => e.type === 'tool.result' && e.toolCallId === 'c1');
  assert.ok(refused && refused.type === 'tool.result' && refused.isError);
  assert.equal(refused.output, BROWSER_HELD);
  const back = events.find((e) => e.type === 'tool.result' && e.toolCallId === 'c2');
  assert.ok(back && back.type === 'tool.result' && !back.isError);
  assert.match(back.output, /^The user took the browser over and handed it back\. This is the page/);
  await sunnie.close();
});

test('a second request while one waits is refused, and helpers neither ask nor are held back', async () => {
  const sunnie = testSunnie();
  const { handoff } = sunnie.deps;
  const settled: string[] = [];
  handoff.request({ toolCallId: 'c1', reason: 'A', runId: 'run_a', conversationId: 'conv_a' }, (o) => settled.push(`a:${o.outcome}`));
  assert.throws(() => handoff.request({ toolCallId: 'c2', reason: 'B', runId: 'run_b', conversationId: 'conv_b' }, () => {}), /already handed to the user for another conversation/);
  assert.throws(() => handoff.request({ toolCallId: 'c3', reason: 'C', runId: 'run_a', conversationId: 'conv_a' }, () => {}), /already handed over for this run/);
  // A check-in that gives up waiting ends the request as nobody's decision.
  handoff.cancel('c9', 'unanswered');
  assert.equal(handoff.state?.toolCallId, 'c1', 'another call\'s id ends nothing');
  handoff.cancel('c1', 'unanswered');
  assert.deepEqual([settled, handoff.state], [['a:unanswered'], null]);
  // A hand-off the user holds outlives the agent's part in it.
  handoff.take();
  handoff.request({ toolCallId: 'c4', reason: 'D', runId: 'run_d', conversationId: 'conv_d' }, (o) => settled.push(`d:${o.outcome}`));
  handoff.cancel('c4', 'cancelled');
  assert.deepEqual([settled.at(-1), handoff.state?.status, handoff.state?.reason, handoff.state?.runId], ['d:cancelled', 'active', null, null]);
  assert.ok(handoff.end({ outcome: 'done' }));

  // Only the agent's own tools know about hand-offs: a helper has tabs of its own.
  const deps = { ...sunnie.deps, conversationId: 'conv_h', askHandoff: async () => ({ outcome: 'declined' as const }) };
  assert.ok('browser_handoff' in createTools(deps));
  assert.ok(!('browser_handoff' in createHelperTools(deps)));
  assert.ok(!('browser_handoff' in createTools({ ...deps, askHandoff: undefined })), 'a turn that cannot ask has no tool to ask with');
  const held = createBrowserTools({ computer: sunnie.deps.computer, logins: sunnie.deps.logins, config: sunnie.deps.config.browser, handoff: { held: () => true } });
  await assert.rejects(call(held, 'browser_read', {}), new RegExp(BROWSER_HELD.slice(0, 40)));
  assert.ok(!('browser_handoff' in held));
  await sunnie.close();
});
