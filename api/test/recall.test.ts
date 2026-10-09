import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { createRecallFilter } from '../src/app.ts';
import { JevRecallFilter, type RecallFilter, type RecallInput } from '../src/router/recall.ts';
import type { ToolRouter } from '../src/router/router.ts';
import { createLogger } from '../src/util/log.ts';
import { eventSink, promptText, registryOf, testConfig, testSunnie, textStep } from './helpers.ts';

// ── A scripted stand-in for api.typesafe.ai ───────────────────────────────────────────────

/** `noul` answers the `recall` question; without it the question goes unanswered. */
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
      const answers = next.noul === undefined ? {} : { recall: { type: 'noul', noul: next.noul } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'jev-1.13.0', answers }));
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

const jev = (overrides: { threshold?: number; timeoutMs?: number } = {}) =>
  new JevRecallFilter({
    apiKey: 'apikey_test',
    baseURL,
    model: 'jev-latest',
    threshold: 0.5,
    timeoutMs: 2000,
    log: createLogger('silent'),
    ...overrides,
  });

const recallInput = (overrides: Partial<RecallInput> = {}): RecallInput => ({
  text: 'What should I cook for dinner tonight?',
  summary: null,
  messages: [],
  ...overrides,
});

// ── JevRecallFilter ───────────────────────────────────────────────────────────────────────

test('Jev is asked one yes/no question per message: does it call for a recall?', async () => {
  script.push({ noul: 0.9 });
  assert.equal(await jev().needed(recallInput()), true);

  const { auth, body } = received.at(-1)!;
  assert.equal(auth, 'Bearer apikey_test');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { conversation: [], new_message: 'What should I cook for dinner tonight?' });
  assert.deepEqual(Object.keys(body.questions), ['recall']);
  assert.equal(body.questions.recall.type, 'noul');
  assert.deepEqual(Object.keys(body.questions.recall.criteria).sort(), ['false', 'true']);

  script.push({ noul: 0.2 });
  assert.equal(await jev().needed(recallInput({ text: 'What is 17% of 2,340?' })), false);
  script.push({ noul: 0.2 });
  assert.equal(await jev({ threshold: 0.15 }).needed(recallInput()), true);
});

test('a recall filter that cannot judge says yes instead of failing the turn', async () => {
  script.push({ status: 529 });
  assert.equal(await jev().needed(recallInput()), true);

  script.push({ delayMs: 500, noul: 0.1 });
  assert.equal(await jev({ timeoutMs: 50 }).needed(recallInput()), true);

  // An unanswered question is treated like an outage.
  script.push({});
  assert.equal(await jev().needed(recallInput()), true);
});

test('the recall filter reaches Jev the way the router does, and has its own off switch', () => {
  const log = createLogger('silent');
  const endpoint = (config: ReturnType<typeof testConfig>, env: NodeJS.ProcessEnv) => {
    const filter = createRecallFilter(config, log, env);
    return filter instanceof JevRecallFilter ? filter.baseURL : filter.name;
  };
  const on = testConfig({ memory: { recall: { type: 'jev' } } });

  assert.equal(endpoint(on, { TYPESAFE_API_KEY: 'apikey_x', OPENROUTER_API_KEY: 'sk-or-x' }), 'https://api.typesafe.ai/v1');
  // The tool router being off (as it is in testConfig) does not switch the filter off.
  assert.equal(endpoint(on, { OPENROUTER_API_KEY: 'sk-or-x' }), 'https://openrouter.ai/api/v1');
  assert.equal(endpoint(on, {}), 'none');
  assert.equal(endpoint(testConfig(), { TYPESAFE_API_KEY: 'apikey_x' }), 'none');
});

// ── The filter inside a turn ──────────────────────────────────────────────────────────────

test('a message that calls for a recall gets memories and earlier conversations; one that does not gets neither', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('Try a mushroom risotto.'), textStep('397.8'), textStep('The 15th to the 19th.')] });
  const seen: RecallInput[] = [];
  let answer = true;
  const recall: RecallFilter = {
    name: 'scripted',
    judges: true,
    async needed(input) {
      seen.push(input);
      return answer;
    },
  };
  const known: Array<string[] | undefined> = [];
  const router: ToolRouter = {
    name: 'scripted',
    async route(input) {
      known.push(input.known);
      return { kind: 'auto', reason: 'disabled' };
    },
  };
  const sunnie = testSunnie({ memory: { recallLimit: 2 } }, { models: registryOf(model), recall, router });
  const { conversations, memory, core } = sunnie.deps;
  core.set('user', 'Name: Aditya');
  const matched = memory.add({ content: 'The user likes to cook on Sundays', source: 'agent' }).memory;
  const recent = memory.add({ content: 'The user is vegetarian', source: 'agent' }).memory;
  // An earlier conversation, about a trip.
  const earlier = conversations.create({ title: 'LA trip' });
  conversations.appendMessages(earlier.id, [
    { role: 'user', content: [{ type: 'text', text: 'go with the 15th out' }], text: 'go with the 15th out, back on the 19th for the LA trip' },
    { role: 'assistant', content: [{ type: 'text', text: 'Locked in.' }], text: 'Locked in: LA trip 15–19 October, staying at the Wayfarer.' },
  ]);
  const conv = conversations.create();
  const run = (text: string) =>
    runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text, signal: new AbortController().signal, emit: eventSink().emit });

  await run('What should I cook tonight?');
  assert.equal(seen[0]!.text, 'What should I cook tonight?');
  assert.deepEqual(seen[0]!.messages, []);
  // The keyword match first, topped up with a recent memory that shares no word with the message.
  let prompt = promptText(model.doStreamCalls[0]);
  assert.match(prompt, /likes to cook on Sundays[\s\S]*The user is vegetarian/);
  assert.equal(memory.get(matched.id)!.recallCount, 1);
  // A top-up rides along for being recent, which is not a recall.
  assert.equal(memory.get(recent.id)!.recallCount, 0);
  // The router is told what memory already holds, so it does not ask for a second save of it.
  assert.deepEqual(known[0], ['Name: Aditya', '', 'The user likes to cook on Sundays', 'The user is vegetarian']);

  // No recall: nothing rides along, and nothing counts as recalled.
  answer = false;
  await run('What is 17% of 2,340?');
  prompt = JSON.stringify((model.doStreamCalls[1] as { prompt: unknown[] }).prompt.at(-1));
  assert.doesNotMatch(prompt, /vegetarian|earlier conversations/);
  assert.equal(memory.get(matched.id)!.recallCount, 1);

  // A question about something settled elsewhere brings the passages of that conversation along.
  answer = true;
  await run('remind me, which dates did we settle for the LA trip?');
  prompt = JSON.stringify((model.doStreamCalls[2] as { prompt: unknown[] }).prompt.at(-1));
  assert.match(prompt, /From earlier conversations/);
  assert.match(prompt, /\(\d{4}-\d\d-\d\d, \\"LA trip\\"\) you: Locked in: LA trip 15–19 October, staying at the Wayfarer\./);
  assert.match(prompt, /the user: go with the 15th out, back on the 19th/);
  assert.doesNotMatch(prompt, /What should I cook tonight/, 'this conversation is already in view and is not quoted back');
  await sunnie.close();
});

test('with nothing to recall, the decision is not even asked for', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('Hello!')] });
  let asked = 0;
  const recall: RecallFilter = { name: 'scripted', judges: true, needed: async () => (asked++, true) };
  const sunnie = testSunnie({}, { models: registryOf(model), recall });
  const conv = sunnie.deps.conversations.create();
  await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text: 'Hello there', signal: new AbortController().signal, emit: eventSink().emit });
  assert.equal(asked, 0);
  await sunnie.close();
});

test('without a filter that judges the message, only keyword matches are attached', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('Hello!')] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  sunnie.deps.memory.add({ content: 'The user is vegetarian', source: 'agent' });
  const conv = sunnie.deps.conversations.create();
  await runTurn(sunnie.deps, {
    conversationId: conv.id,
    runId: 'run_test',
    text: 'What should I cook tonight?',
    signal: new AbortController().signal,
    emit: eventSink().emit,
  });
  assert.doesNotMatch(promptText(model.doStreamCalls[0]), /vegetarian/);
  await sunnie.close();
});
