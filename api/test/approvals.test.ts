import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import type { Run } from '../src/agent/runs.ts';
import { createRiskFilter, type Sunnie } from '../src/app.ts';
import { JevRiskFilter, type RiskFilter, type RiskInput, type RiskVerdict } from '../src/router/risk.ts';
import type { StoredMessage } from '../src/store/conversations.ts';
import { createTools } from '../src/tools/index.ts';
import { createLogger } from '../src/util/log.ts';
import { simulateReadableStream } from 'ai';
import { eventSink, promptText, registryOf, TEST_API_KEY, testConfig, testSunnie, textStep, toolStep } from './helpers.ts';

// ── A scripted stand-in for api.typesafe.ai ───────────────────────────────────────────────

type Scripted = { status?: number; delayMs?: number; noul?: number };
const script: Scripted[] = [];
const received: Array<{ auth: string | undefined; body: any }> = [];

const typesafe = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    const next = script.shift() ?? {};
    setTimeout(() => {
      if (next.status && next.status !== 200) {
        res.writeHead(next.status, { 'content-type': 'application/json' }).end('{"error":"overloaded"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ model: 'jev-1.13.0', answers: { risk: { type: 'noul', noul: next.noul ?? 0.02 } } }),
      );
    }, next.delayMs ?? 0);
  });
});

let baseURL = '';
before(async () => {
  await new Promise<void>((resolve) => typesafe.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(typesafe.address() as AddressInfo).port}/v1`;
});
after(() => {
  typesafe.closeAllConnections();
  typesafe.close();
});

const jev = (overrides: { threshold?: number; onError?: 'ask' | 'allow'; timeoutMs?: number } = {}) =>
  new JevRiskFilter({
    apiKey: 'apikey_test',
    baseURL,
    model: 'jev-latest',
    threshold: 0.5,
    onError: 'ask',
    timeoutMs: 2000,
    log: createLogger('silent'),
    ...overrides,
  });

const userMessage = (text: string): StoredMessage => ({
  id: 'm1',
  conversationId: 'c',
  origin: null,
  seq: 1,
  role: 'user',
  content: [{ type: 'text', text: '<context>injected, private</context>' }, { type: 'text', text }],
  text,
  model: null,
  runId: null,
  createdAt: '',
});

const riskInput = (command: string): RiskInput => ({
  summary: null,
  messages: [userMessage('Tidy up my home folder')],
  call: { toolCallId: 'c1', name: 'bash', input: { command } },
  tools: {},
});

// ── JevRiskFilter ─────────────────────────────────────────────────────────────────────────

test('Jev is asked one yes/no question about the proposed call, over the recent conversation', async () => {
  const sunnie = testSunnie();
  const tools = createTools({ ...sunnie.deps, conversationId: 'c' });
  script.push({ noul: 0.93 });

  const verdict = await jev().assess({ ...riskInput('rm -rf ~/Documents'), tools });
  assert.deepEqual(verdict, { confirm: true, risk: 0.93 });

  const { auth, body } = received.at(-1)!;
  assert.equal(auth, 'Bearer apikey_test');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state.conversation, [{ from: 'user', text: 'Tidy up my home folder' }]);
  assert.equal(body.state.proposed_action.tool, 'bash');
  assert.equal(body.state.proposed_action.with, '{"command":"rm -rf ~/Documents"}');
  assert.match(body.state.proposed_action.what_the_tool_does, /Run a bash command/);
  assert.equal(body.questions.risk.type, 'noul');
  assert.deepEqual(Object.keys(body.questions.risk.criteria).sort(), ['false', 'true']);
  await sunnie.close();
});

test('for a browser call Jev is shown the element behind the ref and the page it is on', async () => {
  script.push({ noul: 0.91 });
  const call = {
    toolCallId: 'c1',
    name: 'browser_click',
    input: { ref: 'f13e36' },
    target: { element: 'button "Submit for approval"', title: 'New expense report', url: 'https://hr.example/expenses/new' },
  };
  assert.deepEqual(await jev().assess({ ...riskInput(''), call }), { confirm: true, risk: 0.91 });
  const { proposed_action } = received.at(-1)!.body.state;
  assert.equal(proposed_action.with, '{"ref":"f13e36"}');
  assert.deepEqual(proposed_action.acts_on, {
    element: 'button "Submit for approval"',
    on_page: 'New expense report',
    url: 'https://hr.example/expenses/new',
  });
  assert.match(received.at(-1)!.body.questions.risk.instructions, /`acts_on`/);

  script.push({});
  await jev().assess(riskInput('ls'));
  assert.ok(!('acts_on' in received.at(-1)!.body.state.proposed_action), 'other calls are described as before');
});

test('the threshold decides; a call Jev cannot judge is held or let through as configured', async () => {
  script.push({ noul: 0.04 });
  assert.deepEqual(await jev().assess(riskInput('ls')), { confirm: false, risk: 0.04 });

  script.push({ noul: 0.3 });
  assert.deepEqual(await jev({ threshold: 0.25 }).assess(riskInput('git push')), { confirm: true, risk: 0.3 });

  // One failure is asked about once more before the user is bothered with a call nobody judged.
  script.push({ status: 529 }, { noul: 0.04 });
  let before = received.length;
  assert.deepEqual(await jev().assess(riskInput('ls')), { confirm: false, risk: 0.04 });
  assert.equal(received.length - before, 2);
  script.push({ delayMs: 500 }, { noul: 0.8 });
  assert.deepEqual(await jev({ timeoutMs: 100 }).assess(riskInput('rm -rf x')), { confirm: true, risk: 0.8 });

  script.push({ status: 529 }, { status: 529 });
  before = received.length;
  assert.deepEqual(await jev().assess(riskInput('ls')), { confirm: true, reason: 'filter-unavailable' });
  assert.equal(received.length - before, 2, 'and no more than once');

  script.push({ status: 529 }, { status: 529 });
  assert.deepEqual(await jev({ onError: 'allow' }).assess(riskInput('ls')), { confirm: false });

  script.push({ delayMs: 500 }, { delayMs: 500 });
  assert.deepEqual(await jev({ timeoutMs: 50 }).assess(riskInput('ls')), { confirm: true, reason: 'filter-unavailable' });

  // A caller that has given up is not asked again.
  const gone = new AbortController();
  gone.abort();
  before = received.length;
  await jev().assess({ ...riskInput('ls'), signal: gone.signal });
  assert.ok(received.length - before <= 1);
});

test('the risk filter reaches Jev the way the router does, and has its own off switch', () => {
  const log = createLogger('silent');
  const endpoint = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv) => {
    const filter = createRiskFilter(testConfig(raw), log, env);
    return filter instanceof JevRiskFilter ? filter.baseURL : filter.name;
  };
  const on = { approvals: { type: 'jev' } };

  assert.equal(endpoint(on, { TYPESAFE_API_KEY: 'apikey_x', OPENROUTER_API_KEY: 'sk-or-x' }), 'https://api.typesafe.ai/v1');
  // The tool router being off (as it is in testConfig) does not switch approvals off.
  assert.equal(endpoint(on, { OPENROUTER_API_KEY: 'sk-or-x' }), 'https://openrouter.ai/api/v1');
  assert.equal(endpoint(on, {}), 'none');
  assert.equal(endpoint({}, { TYPESAFE_API_KEY: 'apikey_x' }), 'none', 'approvals.type "none" wins');
});

// ── Approvals inside a run ────────────────────────────────────────────────────────────────

/** Holds every `bash` call whose command mentions rm; lets everything else through. */
function scriptedFilter(): RiskFilter & { seen: RiskInput[] } {
  return {
    name: 'scripted',
    seen: [],
    async assess(input): Promise<RiskVerdict> {
      this.seen.push(input);
      const command = (input.call.input as { command?: string }).command ?? '';
      return /\brm\b/.test(command) ? { confirm: true, risk: 0.97 } : { confirm: false, risk: 0.01 };
    },
  };
}

function setup(steps: ConstructorParameters<typeof MockLanguageModelV4>[0]) {
  const model = new MockLanguageModelV4(steps);
  const risk = scriptedFilter();
  const sunnie = testSunnie({}, { models: registryOf(model), risk });
  const conv = sunnie.deps.conversations.create();
  return { model, risk, sunnie, conversationId: conv.id, workspace: join(sunnie.deps.config.computer.workspace, 'Drive') };
}

async function waitForApproval(run: Run): Promise<void> {
  for (let i = 0; i < 200 && run.pendingApprovals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(run.pendingApprovals.length, 1, 'the run should be waiting for an approval');
}

async function eventsOf(sunnie: Sunnie, run: Run) {
  const events = [];
  for await (const e of sunnie.runs.subscribe(run.id)) events.push(e);
  return events;
}

test('a high-risk call waits for the user and runs once allowed; other calls are not held', async () => {
  const { model, risk, sunnie, conversationId, workspace } = setup({
    doStream: [
      toolStep('bash', { command: 'touch keep.txt' }, 'c1'),
      toolStep('bash', { command: 'touch gone.txt && rm keep.txt' }, 'c2'),
      textStep('Removed it.'),
    ],
  });

  const run = sunnie.runs.start({ conversationId, text: 'Make keep.txt, then delete it' });
  await waitForApproval(run);
  assert.deepEqual(run.pendingApprovals, [
    { toolCallId: 'c2', name: 'bash', input: { command: 'touch gone.txt && rm keep.txt' } },
  ]);
  assert.equal(run.status, 'running');
  assert.ok(existsSync(join(workspace, 'keep.txt')), 'the low-risk call ran without asking');
  assert.ok(!existsSync(join(workspace, 'gone.txt')), 'the held call has not run');

  assert.equal(sunnie.runs.resolveApproval(run.id, 'c2', true), true);
  assert.equal(sunnie.runs.resolveApproval(run.id, 'c2', true), false, 'an approval is answered once');
  await run.done;
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.pendingApprovals, []);
  assert.ok(existsSync(join(workspace, 'gone.txt')) && !existsSync(join(workspace, 'keep.txt')));

  // The filter saw every call, each with the conversation the model was answering.
  assert.deepEqual(risk.seen.map((s) => s.call.toolCallId), ['c1', 'c2']);
  assert.equal(risk.seen[1]!.messages.at(-1)!.role, 'tool');

  const events = await eventsOf(sunnie, run);
  const approvals = events.filter((e) => e.type.startsWith('tool.approval.')).map(({ seq: _seq, ...e }) => e);
  assert.deepEqual(approvals, [
    {
      type: 'tool.approval.requested',
      toolCallId: 'c2',
      name: 'bash',
      input: { command: 'touch gone.txt && rm keep.txt' },
      risk: 0.97,
      reason: undefined,
    },
    { type: 'tool.approval.resolved', toolCallId: 'c2', approved: true },
  ]);
  const index = (type: string, id: string) =>
    events.findIndex((e) => e.type === type && 'toolCallId' in e && e.toolCallId === id);
  assert.ok(index('tool.approval.resolved', 'c2') < index('tool.result', 'c2'));
  // Gating wraps execution only: the tools the model is offered are the ungated ones.
  assert.deepEqual(
    model.doStreamCalls[0]!.tools!.map((t) => t.name),
    Object.keys(createTools({ ...sunnie.deps, conversationId, helpers: { delegate: async () => '', message: async () => '' }, askHandoff: async () => ({ outcome: 'declined' }) })),
  );
  await sunnie.close();
});

test('a browser click is judged, and shown to the user, by the element it clicks; one nobody could name is held', async () => {
  // A stand-in for the browser client: describes two buttons, cannot describe a third, logs what it ran.
  const dir = mkdtempSync(join(tmpdir(), 'sunnie-fake-browser-'));
  const ran = join(dir, 'ran.log');
  const client = join(dir, 'browser.mjs');
  writeFileSync(
    client,
    `import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const { command } = JSON.parse(raw);
  const page = { title: 'New expense report', url: 'https://hr.example/expenses/new' };
  const names = { e35: 'button "Save draft"', e36: 'button "Submit for approval"' };
  let answer;
  if (command.cmd !== 'describe') {
    appendFileSync(${JSON.stringify(ran)}, command.ref + '\\n');
    answer = { ok: true, page: { ...page, tabs: [], outline: '- heading "Done"', offset: 0, outlineLength: 16, notes: [] } };
  } else if (command.ref === 'e77') answer = { ok: false, error: 'no answer' };
  else answer = { ok: true, target: { element: names[command.ref], ...page } };
  process.stdout.write(JSON.stringify(answer));
});
`,
  );
  const seen: RiskInput[] = [];
  const risk: RiskFilter = {
    name: 'scripted',
    async assess(input) {
      seen.push(input);
      return /Submit/.test(input.call.target?.element ?? '') ? { confirm: true, risk: 0.9 } : { confirm: false, risk: 0.1 };
    },
  };
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('browser_click', { ref: 'e35' }, 'c1'),
      toolStep('browser_click', { ref: 'e36' }, 'c2'),
      toolStep('browser_click', { ref: 'e77' }, 'c3'),
      textStep('Submitted.'),
    ],
  });
  const sunnie = testSunnie(
    { browser: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(client)}` } },
    { models: registryOf(model), risk },
  );
  const run = sunnie.runs.start({ conversationId: sunnie.deps.conversations.create().id, text: 'File the expense report' });
  const clicked = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []);
  const target = { element: 'button "Submit for approval"', title: 'New expense report', url: 'https://hr.example/expenses/new' };

  await waitForApproval(run);
  // What waits is the submit, and the user is told which button it is; the draft was saved unasked.
  assert.deepEqual(run.pendingApprovals, [{ toolCallId: 'c2', name: 'browser_click', input: { ref: 'e36' }, target }]);
  assert.deepEqual(clicked(), ['e35']);
  sunnie.runs.resolveApproval(run.id, 'c2', true);

  for (let i = 0; i < 200 && run.pendingApprovals[0]?.toolCallId !== 'c3'; i++) await new Promise((r) => setTimeout(r, 10));
  // The browser could not say what e77 is: held without asking the filter, since a bare ref reads as harmless.
  assert.deepEqual(run.pendingApprovals, [{ toolCallId: 'c3', name: 'browser_click', input: { ref: 'e77' } }]);
  assert.deepEqual(clicked(), ['e35', 'e36']);
  sunnie.runs.resolveApproval(run.id, 'c3', false);
  await run.done;
  assert.deepEqual(clicked(), ['e35', 'e36'], 'the declined click did not run');

  assert.deepEqual(seen.map((s) => [s.call.toolCallId, s.call.target?.element]), [
    ['c1', 'button "Save draft"'],
    ['c2', 'button "Submit for approval"'],
  ]);
  const requested = (await eventsOf(sunnie, run)).filter((e) => e.type === 'tool.approval.requested');
  assert.deepEqual(requested.map(({ seq: _seq, ...e }) => e), [
    { type: 'tool.approval.requested', toolCallId: 'c2', name: 'browser_click', input: { ref: 'e36' }, target, risk: 0.9, reason: undefined },
    { type: 'tool.approval.requested', toolCallId: 'c3', name: 'browser_click', input: { ref: 'e77' }, risk: undefined, reason: 'filter-unavailable' },
  ]);
  // None of it changes what the model sees: the tool call and its input are stored as written.
  assert.doesNotMatch(JSON.stringify(model.doStreamCalls.at(-1)!.prompt), /Submit for approval/);
  await sunnie.close();
});

test('a denied call does not run; the model is told, and the turn carries on', async () => {
  const { model, sunnie, conversationId, workspace } = setup({
    doStream: [toolStep('bash', { command: 'touch gone.txt && rm -rf notes' }, 'c1'), textStep('Okay, I left it alone.')],
  });

  const run = sunnie.runs.start({ conversationId, text: 'Clean up' });
  await waitForApproval(run);
  sunnie.runs.resolveApproval(run.id, 'c1', false);
  await run.done;

  assert.equal(run.status, 'completed');
  assert.ok(!existsSync(join(workspace, 'gone.txt')));
  assert.match(promptText(model.doStreamCalls[1]), /The user declined this action/);

  const events = await eventsOf(sunnie, run);
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result?.type === 'tool.result' && result.isError);
  assert.match(result.output, /declined/);
  // The stored step is whole: the call and its (declined) result.
  const roles = sunnie.deps.conversations.listMessages(conversationId).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  await sunnie.close();
});

test('cancelling a run that is waiting ends it without running the call or storing half a step', async () => {
  const { sunnie, conversationId, workspace } = setup({
    doStream: [toolStep('bash', { command: 'touch gone.txt && rm -rf notes' }, 'c1')],
  });

  const run = sunnie.runs.start({ conversationId, text: 'Clean up' });
  await waitForApproval(run);
  sunnie.runs.cancel(run.id);
  await run.done;

  assert.equal(run.status, 'cancelled');
  assert.deepEqual(run.pendingApprovals, []);
  assert.ok(!existsSync(join(workspace, 'gone.txt')));
  assert.deepEqual(sunnie.deps.conversations.listMessages(conversationId).map((m) => m.role), ['user']);
  const types = (await eventsOf(sunnie, run)).map((e) => e.type);
  assert.ok(!types.includes('tool.approval.resolved'), 'a cancellation is not reported as the user answering');
  assert.equal(types.at(-1), 'run.cancelled');
  await sunnie.close();
});

test('with nobody to ask, a held call is declined', async () => {
  const { sunnie, conversationId, workspace } = setup({
    doStream: [toolStep('bash', { command: 'touch gone.txt && rm -rf notes' }, 'c1'), textStep('Not done.')],
  });
  const sink = eventSink();
  const result = await runTurn(sunnie.deps, {
    conversationId,
    runId: 'run_test',
    text: 'Clean up',
    signal: new AbortController().signal,
    emit: sink.emit,
  });
  assert.equal(result.status, 'completed');
  assert.ok(!existsSync(join(workspace, 'gone.txt')));
  assert.deepEqual(sink.events.find((e) => e.type === 'tool.approval.resolved'), {
    type: 'tool.approval.resolved',
    toolCallId: 'c1',
    approved: false,
  });
  await sunnie.close();
});

test('the API shows what a run is waiting for and takes the answer', async () => {
  const { sunnie, conversationId, workspace } = setup({
    doStream: [toolStep('bash', { command: 'touch gone.txt && rm -rf notes' }, 'c1'), textStep('Done.')],
  });
  const api = (path: string, body?: unknown) =>
    sunnie.app.request(path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

  // Responses are asserted on field by field, so an untyped body is fine here.
  const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

  assert.deepEqual((await json(api('/v1/info'))).approvals, { type: 'scripted' });

  const run = sunnie.runs.start({ conversationId, text: 'Clean up' });
  await waitForApproval(run);
  const waiting = await json(api(`/v1/runs/${run.id}`));
  assert.deepEqual(waiting.pendingApprovals, [
    { toolCallId: 'c1', name: 'bash', input: { command: 'touch gone.txt && rm -rf notes' } },
  ]);

  assert.equal((await api(`/v1/runs/${run.id}/approvals/nope`, { approved: true })).status, 404);
  assert.equal((await api(`/v1/runs/${run.id}/approvals/c1`, { approved: 'yes' })).status, 400);
  assert.equal((await api('/v1/runs/run_missing/approvals/c1', { approved: true })).status, 404);
  assert.ok(!existsSync(join(workspace, 'gone.txt')));

  const answered = await api(`/v1/runs/${run.id}/approvals/c1`, { approved: true });
  assert.equal(answered.status, 200);
  assert.deepEqual((await json(answered)).pendingApprovals, []);
  await run.done;
  assert.ok(existsSync(join(workspace, 'gone.txt')));
  assert.equal((await api(`/v1/runs/${run.id}/approvals/c1`, { approved: true })).status, 404, 'already answered');
  await sunnie.close();
});

// ── The provider's own verdict ────────────────────────────────────────────────────────────

/** A step whose provider judges the call it asked for, in a raw chunk after the call, as Anthropic does. */
function judgedStep(command: string, toolCallId: string, outcome: 'flagged' | 'not_flagged' | 'none') {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call' as const, toolCallId, toolName: 'bash', input: JSON.stringify({ command }) },
        ...(outcome === 'none' ? [] : [{ type: 'raw' as const, rawValue: { verdicts: { [toolCallId]: outcome } } }]),
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
        },
      ],
    }),
  };
}

test("a call the model's provider flags is held like one the filter holds, with the provider's reason", async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      judgedStep('touch fine.txt', 'c1', 'not_flagged'),
      judgedStep('touch bad.txt', 'c2', 'flagged'),
      judgedStep('touch unjudged.txt', 'c3', 'none'),
      textStep('Done.'),
    ],
  });
  // The registry reads the verdict off the chunk; the agent only knows that there is one.
  const verdicts = {
    fromRaw: (raw: unknown) => {
      const chunk = raw as { verdicts?: Record<string, string> };
      if (!chunk.verdicts) return undefined;
      return new Map(Object.entries(chunk.verdicts).map(([id, outcome]) => [id, { flagged: outcome === 'flagged', explanation: outcome === 'flagged' ? 'Nobody asked for this.' : undefined }]));
    },
  };
  const risk = scriptedFilter();
  const sunnie = testSunnie({}, { models: registryOf(model, 128_000, false, { verdicts }), risk });
  const conv = sunnie.deps.conversations.create();
  const workspace = join(sunnie.deps.config.computer.workspace, 'Drive');

  const run = sunnie.runs.start({ conversationId: conv.id, text: 'Make three files' });
  await waitForApproval(run);
  assert.deepEqual(run.pendingApprovals.map((a) => a.toolCallId), ['c2']);
  assert.ok(existsSync(join(workspace, 'fine.txt')), 'a call the provider cleared ran');
  assert.ok(!existsSync(join(workspace, 'bad.txt')), 'the flagged call waits');
  sunnie.runs.resolveApproval(run.id, 'c2', false);
  await run.done;
  assert.equal(run.status, 'completed');
  assert.ok(!existsSync(join(workspace, 'bad.txt')) && existsSync(join(workspace, 'unjudged.txt')), 'a call nobody judged is the filter\'s alone');

  const events = await eventsOf(sunnie, run);
  const requested = events.find((e) => e.type === 'tool.approval.requested') as Extract<typeof events[number], { type: 'tool.approval.requested' }>;
  assert.equal(requested.toolCallId, 'c2');
  assert.equal(requested.reason, 'flagged');
  assert.equal(requested.explanation, 'Nobody asked for this.');
  // The filter still saw every call: the provider is a second opinion, not a replacement.
  assert.deepEqual(risk.seen.map((s) => s.call.toolCallId), ['c1', 'c2', 'c3']);
  await sunnie.close();
});
