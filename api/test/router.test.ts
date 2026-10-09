import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { createRouter } from '../src/app.ts';
import { buildState, JevRouter } from '../src/router/jev.ts';
import { applyRoute, type RouteDecision, type ToolRouter } from '../src/router/router.ts';
import type { StoredMessage } from '../src/store/conversations.ts';
import { createTools } from '../src/tools/index.ts';
import { createLogger } from '../src/util/log.ts';
import { eventSink, promptText, registryOf, testConfig, testSunnie, textStep, toolStep } from './helpers.ts';

// ── A scripted stand-in for api.typesafe.ai ───────────────────────────────────────────────

type Scripted = { status?: number; delayMs?: number; choice?: string; confidence?: number; remember?: number };
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
      const asked = received.at(-1)!.body.questions;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            ...(asked.remember && next.remember !== undefined ? { remember: { type: 'noul', noul: next.remember } } : {}),
            next: {
              type: 'choice',
              choice: next.choice ?? 'reply_to_user',
              probabilities: { [next.choice ?? 'reply_to_user']: 1 },
              confidence: next.confidence ?? 0.95,
            },
          },
          usage: { input_tokens: 900, output_tokens: 20 },
        }),
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

const jev = (overrides: { confidenceThreshold?: number; replyThreshold?: number; rememberThreshold?: number; timeoutMs?: number } = {}) =>
  new JevRouter({
    apiKey: 'apikey_test',
    baseURL,
    model: 'jev-latest',
    confidenceThreshold: 0.7,
    rememberThreshold: 0.7,
    timeoutMs: 2000,
    log: createLogger('silent'),
    ...overrides,
  });

let seq = 0;
const stored = (role: StoredMessage['role'], content: unknown, text = ''): StoredMessage => ({
  id: `m${++seq}`,
  conversationId: 'c',
  origin: null,
  seq,
  role,
  content: content as StoredMessage['content'],
  text,
  model: null,
  runId: null,
  createdAt: '',
});
const user = (text: string) =>
  stored('user', [{ type: 'text', text: '<context>injected, private</context>' }, { type: 'text', text }], text);

// ── JevRouter ─────────────────────────────────────────────────────────────────────────────

test('Jev is asked one Choice question: every tool, plus replying, over the recent conversation', async () => {
  const sunnie = testSunnie();
  const tools = createTools({ ...sunnie.deps, conversationId: 'c' });
  script.push({ choice: 'bash', confidence: 0.91 });

  const decision = await jev({ rememberThreshold: 1 }).route({
    summary: 'Earlier the user set up a notes folder.',
    messages: [user('What is in my notes folder?')],
    tools,
  });
  assert.deepEqual(decision, { kind: 'tool', tool: 'bash', confidence: 0.91 });

  const { auth, body } = received.at(-1)!;
  assert.equal(auth, 'Bearer apikey_test');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, {
    earlier_in_the_conversation: 'Earlier the user set up a notes folder.',
    conversation: [{ from: 'user', text: 'What is in my notes folder?' }],
  });
  const question = body.questions.next;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), ['reply_to_user', ...Object.keys(tools)].sort());
  assert.match(question.criteria.bash, /Run a bash command/);
  await sunnie.close();
});

test('Jev decisions map to respond / tool, and anything unsure or broken falls back to the model', async () => {
  const input = { summary: null, messages: [user('hello')], tools: {} };

  script.push({ choice: 'reply_to_user', confidence: 0.99 });
  assert.deepEqual(await jev().route(input), { kind: 'respond', confidence: 0.99 });

  script.push({ choice: 'memory_search', confidence: 0.38 });
  assert.deepEqual(await jev().route(input), {
    kind: 'auto',
    reason: 'low-confidence',
    leaning: 'memory_search',
    confidence: 0.38,
  });

  // Ending the turn asks for more confidence than a tool does: in between, the model decides.
  const careful = { replyThreshold: 0.8 };
  script.push({ choice: 'reply_to_user', confidence: 0.75 });
  assert.deepEqual(await jev(careful).route(input), { kind: 'auto', reason: 'low-confidence', leaning: 'reply_to_user', confidence: 0.75 });
  script.push({ choice: 'bash', confidence: 0.75 });
  assert.deepEqual(await jev(careful).route(input), { kind: 'tool', tool: 'bash', confidence: 0.75 });
  script.push({ choice: 'reply_to_user', confidence: 0.8 });
  assert.deepEqual(await jev(careful).route(input), { kind: 'respond', confidence: 0.8 });
  // It is a floor on top of the general threshold, never a way under it.
  script.push({ choice: 'reply_to_user', confidence: 0.6 });
  assert.equal((await jev({ replyThreshold: 0.5 }).route(input)).kind, 'auto');
  assert.equal(testConfig().router.replyThreshold, 0.8);

  script.push({ status: 529 });
  assert.deepEqual(await jev().route(input), { kind: 'auto', reason: 'error' });

  script.push({ delayMs: 500 });
  assert.deepEqual(await jev({ timeoutMs: 50 }).route(input), { kind: 'auto', reason: 'error' });
});

test('the state sent for routing is the human-visible conversation, newest kept when trimming', () => {
  const state = buildState({
    summary: null,
    messages: [
      user('How much disk is free?'),
      stored('assistant', [{ type: 'tool-call', toolCallId: 't', toolName: 'bash', input: { command: 'df -h' } }]),
      stored('tool', [{ type: 'tool-result', toolCallId: 't', toolName: 'bash', output: { type: 'text', value: '36G free' } }]),
    ],
  });
  assert.deepEqual(state, {
    conversation: [
      { from: 'user', text: 'How much disk is free?' },
      { from: 'assistant', called_tool: 'bash', with: '{"command":"df -h"}' },
      { from: 'tool', tool: 'bash', result: '36G free' },
    ],
  });

  const long = buildState({
    summary: null,
    messages: Array.from({ length: 12 }, (_, i) => user(`message ${i} ${'x'.repeat(3900)}`)),
  }) as { conversation: Array<{ text: string }> };
  assert.ok(JSON.stringify(long).length <= 24_100);
  assert.match(long.conversation.at(-1)!.text, /^message 11 /);
});

test('applyRoute steers with toolChoice by default and with the tool list in active-tools mode', () => {
  const tools = createTools({ ...testSunnie().deps, conversationId: 'c' });
  const tool: RouteDecision = { kind: 'tool', tool: 'bash', confidence: 0.9 };
  const respond: RouteDecision = { kind: 'respond', confidence: 0.9 };

  assert.deepEqual(applyRoute(tool, 'tool-choice', tools), { toolChoice: { type: 'tool', toolName: 'bash' } });
  assert.deepEqual(applyRoute(respond, 'tool-choice', tools), { toolChoice: 'none' });
  assert.deepEqual(applyRoute(tool, 'active-tools', tools), { activeTools: ['bash'] });
  assert.deepEqual(applyRoute(respond, 'active-tools', tools), { activeTools: [] });
  assert.deepEqual(applyRoute({ kind: 'auto', reason: 'low-confidence' }, 'tool-choice', tools), {});
  // A router naming a tool that does not exist must not break the model call.
  assert.deepEqual(applyRoute({ kind: 'tool', tool: 'teleport', confidence: 1 }, 'tool-choice', tools), {});
});

test('Jev is reached through TypeSafe when its key is set, otherwise through OpenRouter, otherwise not at all', () => {
  const config = testConfig({ router: { type: 'jev' } });
  const log = createLogger('silent');
  const endpoint = (env: NodeJS.ProcessEnv) => {
    const router = createRouter(config, log, env);
    return router instanceof JevRouter ? router.baseURL : router.name;
  };

  assert.equal(endpoint({ TYPESAFE_API_KEY: 'apikey_x', OPENROUTER_API_KEY: 'sk-or-x' }), 'https://api.typesafe.ai/v1');
  assert.equal(endpoint({ OPENROUTER_API_KEY: 'sk-or-x' }), 'https://openrouter.ai/api/v1');
  assert.equal(endpoint({}), 'none');
  assert.equal(createRouter(testConfig(), log, { TYPESAFE_API_KEY: 'apikey_x' }).name, 'none', 'router.type "none" wins');
});

test('the routing request also asks whether the message is worth remembering; a confident yes routes to memory_save', async () => {
  const sunnie = testSunnie();
  const tools = createTools({ ...sunnie.deps, conversationId: 'c' });
  const message = user("I'm vegetarian by the way. What should I cook tonight?");
  const input = { summary: null, messages: [message], tools, known: ['Name: Aditya', ''] };

  // A confident "reply" would otherwise leave the model no step in which to save.
  script.push({ choice: 'reply_to_user', confidence: 0.95, remember: 0.94 });
  assert.deepEqual(await jev().route(input), { kind: 'tool', tool: 'memory_save', confidence: 0.94 });
  const { body } = received.at(-1)!;
  assert.equal(body.questions.remember.type, 'noul');
  assert.deepEqual(Object.keys(body.questions.remember.criteria).sort(), ['false', 'true']);
  assert.deepEqual(body.state.already_remembered, ['Name: Aditya']);
  assert.ok(body.questions.next, 'still one request: the routing question rides along');

  script.push({ choice: 'reply_to_user', confidence: 0.95, remember: 0.2 });
  assert.deepEqual(await jev().route(input), { kind: 'respond', confidence: 0.95 });

  // An unanswered question is not a reason to drop the routing decision.
  script.push({ choice: 'bash', confidence: 0.9 });
  assert.deepEqual(await jev().route(input), { kind: 'tool', tool: 'bash', confidence: 0.9 });

  const notAsked = async (route: Parameters<JevRouter['route']>[0], router = jev()) => {
    script.push({ choice: 'reply_to_user', confidence: 0.95, remember: 0.99 });
    assert.deepEqual(await router.route(route), { kind: 'respond', confidence: 0.95 });
    assert.equal(received.at(-1)!.body.questions.remember, undefined);
    assert.equal(received.at(-1)!.body.state.already_remembered, undefined);
  };
  // Once the assistant has written to memory in this turn, so a wrong yes costs one save at most.
  await notAsked({
    ...input,
    messages: [
      message,
      stored('assistant', [{ type: 'tool-call', toolCallId: 't', toolName: 'core_memory_append', input: {} }]),
      stored('tool', [{ type: 'tool-result', toolCallId: 't', toolName: 'core_memory_append', output: { type: 'text', value: 'ok' } }]),
    ],
  });
  // A turn the system opened was not said by the user.
  await notAsked({ ...input, messages: [{ ...message, origin: 'heartbeat' as StoredMessage['origin'] }] });
  await notAsked(input, jev({ rememberThreshold: 1 }));
  await notAsked({ ...input, tools: {} });
  await sunnie.close();
});

// ── The router inside the agent loop ──────────────────────────────────────────────────────

function scriptedRouter(decisions: RouteDecision[]): ToolRouter & { calls: number } {
  return {
    name: 'scripted',
    calls: 0,
    async route() {
      return decisions[this.calls++] ?? { kind: 'auto', reason: 'disabled' };
    },
  };
}

async function routedTurn(mode: 'tool-choice' | 'active-tools') {
  const model = new MockLanguageModelV4({
    doStream: [toolStep('bash', { command: 'echo routed' }), textStep('It printed "routed".')],
  });
  const router = scriptedRouter([
    { kind: 'tool', tool: 'bash', confidence: 0.92 },
    { kind: 'respond', confidence: 0.98 },
  ]);
  const sunnie = testSunnie({ router: { type: 'none', mode } }, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  await runTurn(sunnie.deps, {
    conversationId: conv.id,
    runId: 'run_test',
    text: 'Run echo routed',
    signal: new AbortController().signal,
    emit: sink.emit,
  });
  await sunnie.close();
  return { model, router, sink };
}

test('the router decides each step; the model is only asked to carry the decision out', async () => {
  const { model, router, sink } = await routedTurn('tool-choice');

  assert.equal(router.calls, 2, 'asked once per model step');
  assert.deepEqual(model.doStreamCalls[0]!.toolChoice, { type: 'tool', toolName: 'bash' });
  assert.deepEqual(model.doStreamCalls[1]!.toolChoice, { type: 'none' });
  // The tool list itself never changes, which keeps provider prompt caches valid.
  assert.equal(model.doStreamCalls[0]!.tools!.length, model.doStreamCalls[1]!.tools!.length);

  const routes = sink.events.filter((e) => e.type === 'route');
  assert.deepEqual(routes, [
    { type: 'route', router: 'scripted', decision: 'tool', tool: 'bash', confidence: 0.92, reason: undefined },
    { type: 'route', router: 'scripted', decision: 'respond', tool: undefined, confidence: 0.98, reason: undefined },
  ]);
  assert.deepEqual(sink.types().filter((t) => t !== 'text.delta'), [
    'message', 'route', 'tool.call', 'tool.result', 'message', 'message', 'route', 'message',
  ]);
});

test('active-tools mode offers the model only the routed tool', async () => {
  const { model } = await routedTurn('active-tools');
  assert.deepEqual(model.doStreamCalls[0]!.tools!.map((t) => t.name), ['bash']);
  assert.equal(model.doStreamCalls[1]!.tools?.length ?? 0, 0);
});

test('the router may not send the agent to the tool it has just used; the model decides instead', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('bash', { command: 'echo one' }, 'call-1'),
      toolStep('bash', { command: 'echo two' }, 'call-2'),
      textStep('Done.'),
    ],
  });
  const router = scriptedRouter([
    { kind: 'tool', tool: 'bash', confidence: 0.95 },
    { kind: 'tool', tool: 'bash', confidence: 0.95 },
    { kind: 'tool', tool: 'bash', confidence: 0.95 },
  ]);
  const sunnie = testSunnie({}, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'go', signal: new AbortController().signal, emit: sink.emit });

  assert.deepEqual(model.doStreamCalls[0]!.toolChoice, { type: 'tool', toolName: 'bash' });
  // Not forced the second and third time: the model was free to call it again, and to stop.
  assert.equal(model.doStreamCalls[1]!.toolChoice?.type ?? 'auto', 'auto');
  assert.equal(model.doStreamCalls[2]!.toolChoice?.type ?? 'auto', 'auto');
  const routes = sink.events.filter((e) => e.type === 'route');
  assert.deepEqual(routes[1], { type: 'route', router: 'scripted', decision: 'auto', tool: 'bash', confidence: 0.95, reason: 'repeat' });
  await sunnie.close();
});

test('a tool result cut for routing says that it was cut', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'read it' }], text: 'read it' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'browser_open', input: { url: 'https://example.com' } }], text: '' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'browser_open', output: { type: 'text', value: 'nav '.repeat(1000) } }], text: '' },
  ].map((m, i) => ({ id: `m${i}`, conversationId: 'c', seq: i + 1, runId: null, model: null, origin: null, createdAt: '2026-10-01T00:00:00Z', ...m }));
  const state = buildState({ summary: null, messages: messages as never });
  const result = (state.conversation as Array<Record<string, string>>).at(-1)!.result!;
  assert.match(result, /\[2800 more characters not shown here; the assistant has read all of it\]$/);
});

test('after a failed step the router cannot end the turn until the attempts are used up', async () => {
  const fail = (id: string) => toolStep('read_file', { path: `/nope/${id}` }, id);
  const model = new MockLanguageModelV4({ doStream: [fail('a'), fail('b'), textStep('I could not read it; I tried twice.')] });
  const respond: RouteDecision = { kind: 'respond', confidence: 0.98 };
  const router = scriptedRouter([{ kind: 'auto', reason: 'low-confidence' }, respond, respond]);
  const sunnie = testSunnie({ agent: { maxAttempts: 2 } }, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'read it', signal: new AbortController().signal, emit: sink.emit });

  // One failure so far: the model decides, and tries again. Two: the router's "reply" stands.
  assert.equal(model.doStreamCalls[1]!.toolChoice?.type ?? 'auto', 'auto');
  assert.deepEqual(model.doStreamCalls[2]!.toolChoice, { type: 'none' });
  const routes = sink.events.filter((e) => e.type === 'route').map((e) => [e.decision, e.reason]);
  assert.deepEqual(routes, [['auto', 'low-confidence'], ['auto', 'after-failure'], ['respond', undefined]]);
  await sunnie.close();
});

test('a model that calls a tool although told to reply does not get it run', async () => {
  // What Gemini does through OpenRouter: toolChoice "none" is ignored.
  const model = new MockLanguageModelV4({
    doStream: [toolStep('bash', { command: 'echo should-not-run > ran.txt' }), textStep('Here is what I have.')],
  });
  const router = scriptedRouter([{ kind: 'respond', confidence: 0.95 }, { kind: 'respond', confidence: 0.95 }]);
  const sunnie = testSunnie({}, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  const result = await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'hi', signal: new AbortController().signal, emit: sink.emit });

  const refused = sink.events.find((e) => e.type === 'tool.result');
  assert.ok(refused?.type === 'tool.result' && refused.isError);
  assert.match(refused.output, /No tool can be used in this step/);
  assert.equal((await sunnie.deps.computer.exec('ls ran.txt')).exitCode !== 0, true, 'the command never ran');
  // The refusal is not a failure to work around: the router's next "reply" is not handed back.
  assert.deepEqual(model.doStreamCalls[1]!.toolChoice, { type: 'none' });
  assert.equal(result.steps, 2);
  await sunnie.close();
});

test('a provider that refuses a tool choice is steered by notes from then on, and the turn goes through', async () => {
  // Z.AI and Meta accept nothing but "auto"; the request fails before the model sees it.
  const script = [toolStep('bash', { command: 'echo hi' }), textStep('It printed hi.'), textStep('Again.')];
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push(options.toolChoice?.type ?? 'auto');
      if (options.toolChoice && options.toolChoice.type !== 'auto') throw new Error('[Meta] only `"auto"` is supported for `tool_choice`.');
      return script.shift()!;
    },
  });
  const router = scriptedRouter([
    { kind: 'tool', tool: 'bash', confidence: 0.95 },
    { kind: 'tool', tool: 'bash', confidence: 0.95 },
    { kind: 'respond', confidence: 0.95 },
    { kind: 'respond', confidence: 0.95 },
  ]);
  const sunnie = testSunnie({}, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  const run = (text: string) =>
    runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text, signal: new AbortController().signal, emit: sink.emit });
  const result = await run('say hi');

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2, 'the refused attempt does not use up a step');
  // Refused once; after that no tool choice is sent at all.
  assert.deepEqual(seen, ['tool', 'auto', 'auto']);
  // The decision travels as a note behind the user's message instead — sent, never stored.
  assert.match(promptText(model.doStreamCalls[1]), /chosen for you: call the `bash` tool now/);
  assert.match(promptText(model.doStreamCalls[2]), /chosen for you: reply to the user now/);
  const stored = sunnie.deps.conversations.listMessages(conv.id);
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.doesNotMatch(JSON.stringify(stored.map((m) => m.content)), /Automatic note/);
  // The router's decisions are still its own: nothing was handed back to the model.
  assert.deepEqual(sink.events.filter((e) => e.type === 'route').map((e) => e.decision), ['tool', 'tool', 'respond']);

  // The next turn does not pay for the refusal again.
  await run('and again');
  assert.deepEqual(seen.slice(3), ['auto']);
  await sunnie.close();
});

test('a model steered by notes that calls a tool after "reply now" does not get it run', async () => {
  const model = new MockLanguageModelV4({ doStream: [toolStep('bash', { command: 'echo no > ran.txt' }), textStep('Here it is.')] });
  const router = scriptedRouter([{ kind: 'respond', confidence: 0.95 }, { kind: 'respond', confidence: 0.95 }]);
  const sunnie = testSunnie({}, { models: registryOf(model, 128_000, true), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'hi', signal: new AbortController().signal, emit: sink.emit });
  assert.equal(model.doStreamCalls[0]!.toolChoice?.type ?? 'auto', 'auto');
  const refused = sink.events.find((e) => e.type === 'tool.result');
  assert.ok(refused?.type === 'tool.result' && refused.isError && /No tool can be used in this step/.test(refused.output));
  assert.notEqual((await sunnie.deps.computer.exec('ls ran.txt')).exitCode, 0);
  await sunnie.close();
});

test('a model that answers without the tool it was forced to gets the choice back for that turn', async () => {
  const violation = Object.assign(new Error("Model response did not contain a call to the required tool 'web_fetch'."), { name: 'AI_ToolChoiceViolationError' });
  const script = [textStep('Done.')];
  const seen: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push(options.toolChoice?.type ?? 'auto');
      if (options.toolChoice?.type === 'tool') throw violation;
      return script.shift()!;
    },
  });
  const router = scriptedRouter([{ kind: 'tool', tool: 'web_fetch', confidence: 0.9 }, { kind: 'tool', tool: 'web_fetch', confidence: 0.9 }]);
  const sunnie = testSunnie({}, { models: registryOf(model), router });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  const result = await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'hi', signal: new AbortController().signal, emit: sink.emit });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['tool', 'auto']);
  assert.equal(sink.events.filter((e) => e.type === 'route').at(-1)!.reason, 'not-followed');
  assert.equal(sunnie.deps.models.resolve(null).steer.byHint, false, 'one disobedient answer does not change how the model is steered');
  await sunnie.close();
});

test('an empty answer to "reply now" is asked for again, and never left as silence', async () => {
  const empty = () => ({
    stream: simulateReadableStream({
      chunks: [{ type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } } }],
    }),
  });
  const run = async (steps: Array<() => unknown>) => {
    const model = new MockLanguageModelV4({ doStream: async () => steps.shift()!() as never });
    const router = scriptedRouter([{ kind: 'respond', confidence: 0.95 }, { kind: 'respond', confidence: 0.95 }]);
    const sunnie = testSunnie({}, { models: registryOf(model), router });
    const conv = sunnie.deps.conversations.create();
    await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'hello', signal: new AbortController().signal, emit: () => {} });
    const texts = sunnie.deps.conversations.listMessages(conv.id).map((m) => m.text);
    await sunnie.close();
    return { texts, model };
  };

  const recovered = await run([empty, () => textStep('Hello!')]);
  assert.deepEqual(recovered.texts, ['hello', 'Hello!']);
  assert.deepEqual(recovered.model.doStreamCalls[0]!.toolChoice, { type: 'none' });
  assert.equal(recovered.model.doStreamCalls[1]!.toolChoice?.type ?? 'auto', 'auto');

  const silent = await run([empty, empty]);
  assert.match(silent.texts.at(-1)!, /without writing a reply/);
});
