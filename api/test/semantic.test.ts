import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { createEmbedder } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MemoryStore } from '../src/memory/memory-store.ts';
import { recallQuery } from '../src/memory/recall.ts';
import { SemanticRecall } from '../src/memory/semantic.ts';
import { createModelRegistry, type Embedder } from '../src/models/registry.ts';
import type { RecallFilter } from '../src/router/recall.ts';
import { createLogger } from '../src/util/log.ts';
import { eventSink, promptText, registryOf, testConfig, testSunnie, textStep } from './helpers.ts';

/** An embedding by topic: texts about the same thing point the same way, whatever their words. */
const TOPICS = [/cook|vegetarian|eat|dinner|recipe/i, /flight|fly|aisle|seat|plane/i, /badminton|sport|play/i];

function fakeEmbedder(): Embedder & { calls: string[][]; fail: boolean } {
  return {
    spec: 'fake/embed',
    calls: [],
    fail: false,
    async embed(values) {
      this.calls.push(values);
      if (this.fail) throw new Error('embedding provider is down');
      return values.map((v) => [...TOPICS.map((t) => (t.test(v) ? 1 : 0)), 0.1]);
    },
  };
}

const log = createLogger('silent');

test('semantic recall finds a memory that shares no word with the message, and embeds each memory once', async () => {
  const db = openDatabase(':memory:');
  const memory = new MemoryStore(db);
  const embedder = fakeEmbedder();
  const semantic = new SemanticRecall({ db, embedder, timeoutMs: 1000, log });
  assert.deepEqual(await semantic.search('anything', 3), []);
  assert.equal(embedder.calls.length, 0, 'an empty store costs no call');

  const diet = memory.add({ content: 'The user is vegetarian', source: 'agent' }).memory;
  const seat = memory.add({ content: 'On flights the user wants an aisle seat', source: 'agent' }).memory;

  let hits = await semantic.search('What should I cook tonight?', 1);
  assert.deepEqual(hits!.map((h) => h.id), [diet.id]);
  // The memories not embedded yet went along with the message, in one call.
  assert.equal(embedder.calls.length, 1);
  assert.equal(embedder.calls[0]!.length, 3);

  hits = await semantic.search('which side of the plane do I like?', 2);
  assert.equal(hits![0]!.id, seat.id);
  assert.deepEqual(embedder.calls[1], ['which side of the plane do I like?'], 'stored vectors are reused');

  // A changed memory is embedded again; a deleted one leaves no vector behind.
  memory.update(seat.id, { content: 'The user plays badminton on Thursdays' });
  hits = await semantic.search('any sport this week?', 1);
  assert.equal(hits![0]!.id, seat.id);
  assert.deepEqual(embedder.calls[2], ['any sport this week?', 'The user plays badminton on Thursdays']);
  memory.delete(diet.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n, 1);
});

test('semantic recall answers null instead of throwing, and start-up embeds what is missing', async () => {
  const db = openDatabase(':memory:');
  const memory = new MemoryStore(db);
  const embedder = fakeEmbedder();
  const semantic = new SemanticRecall({ db, embedder, timeoutMs: 1000, log });
  for (let i = 0; i < 70; i++) memory.add({ content: `Fact number ${i} about dinner`, source: 'agent' });

  embedder.fail = true;
  assert.equal(await semantic.search('dinner?', 3), null);
  await semantic.backfill();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n, 0);

  embedder.fail = false;
  embedder.calls.length = 0;
  await semantic.backfill();
  assert.deepEqual(embedder.calls.map((c) => c.length), [64, 6], 'in batches');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n, 70);
  await semantic.backfill();
  assert.equal(embedder.calls.length, 2, 'nothing missing, nothing sent');

  // A provider that never answers is not waited for beyond the limit.
  const stuck: Embedder = { spec: 'fake/embed', embed: (_, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))) };
  const started = Date.now();
  assert.equal(await new SemanticRecall({ db, embedder: stuck, timeoutMs: 50, log }).search('dinner?', 3), null);
  assert.ok(Date.now() - started < 1000);
});

test('a turn recalls by meaning when it can, with the turns before the message, and by keywords when it cannot', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('The 09:40.'), textStep('Booked.'), textStep('Risotto.'), textStep('Hm.')] });
  const embedder = fakeEmbedder();
  let asked = 0;
  let answer = true;
  const recall: RecallFilter = { name: 'scripted', judges: true, needed: async () => (asked++, answer) };
  const sunnie = testSunnie({ memory: { recallLimit: 1 } }, { models: registryOf(model), embedder, recall });
  const { conversations, memory } = sunnie.deps;
  const seat = memory.add({ content: 'The user wants an aisle seat', source: 'agent' }).memory;
  const cooks = memory.add({ content: 'The user likes to cook on Sundays', source: 'agent' }).memory;
  const conv = conversations.create();
  const run = (text: string) =>
    runTurn(sunnie.deps, { conversationId: conv.id, runId: 'run_test', text, signal: new AbortController().signal, emit: eventSink().emit });

  // Not wanted: nothing is attached, though the nearest memory was found.
  answer = false;
  await run('find me a flight to Tokyo');
  assert.doesNotMatch(promptText(model.doStreamCalls[0]), /aisle/);
  assert.equal(memory.get(seat.id)!.recallCount, 0);

  // "book it" says nothing by itself; the turn before it is embedded with it.
  answer = true;
  await run('ok book it');
  assert.equal(embedder.calls.at(-1)![0], 'find me a flight to Tokyo\nThe 09:40.\nok book it');
  assert.equal(recallQuery([{ role: 'user', text: 'a' }, { role: 'tool', text: 'x' }, { role: 'assistant', text: 'b' }], 'c'), 'a\nb\nc');
  const prompt = JSON.stringify((model.doStreamCalls[1] as { prompt: unknown[] }).prompt.at(-1));
  assert.match(prompt, /aisle seat/);
  assert.doesNotMatch(prompt, /Sundays/, 'no top-up with recent memories next to a semantic recall');
  assert.equal(memory.get(seat.id)!.recallCount, 1);
  assert.equal(asked, 2);

  // The provider fails: the turn goes on with keyword matches.
  embedder.fail = true;
  await run('What should I cook tonight?');
  assert.match(JSON.stringify((model.doStreamCalls[2] as { prompt: unknown[] }).prompt.at(-1)), /likes to cook on Sundays/);
  assert.equal(memory.get(cooks.id)!.recallCount, 1);
  await sunnie.close();
});

test('the embedding model comes from the registry, and a provider without one or without a key means keywords', () => {
  const config = testConfig({ memory: { embedding: { model: 'openrouter/voyageai/voyage-4-lite' } } });
  const withKey = createModelRegistry(config, { OPENROUTER_API_KEY: 'sk-or-test' });
  assert.equal(createEmbedder(config, withKey, log)?.spec, 'openrouter/voyageai/voyage-4-lite');
  assert.equal(createEmbedder(config, createModelRegistry(config, {}), log), undefined);
  assert.throws(() => createModelRegistry(config, { ANTHROPIC_API_KEY: 'sk-ant-test' }).embedder('anthropic/any'), /no embedding models/);
  assert.equal(createEmbedder(testConfig(), withKey, log), undefined, 'tests never reach an embedding provider');
});
