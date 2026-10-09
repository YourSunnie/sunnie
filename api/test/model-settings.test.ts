import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createSunnie } from '../src/app.ts';
import { runTurn } from '../src/agent/agent.ts';
import { createModelRegistry } from '../src/models/registry.ts';
import { TEST_API_KEY, registryOf, testConfig, testSunnie, textStep } from './helpers.ts';

test('new-chat defaults survive restart and do not change existing chats or check-ins', async () => {
  const config = testConfig({
    agent: { defaultModel: 'local/original', reasoning: 'low' },
    providers: { local: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1' } },
  });
  let sunnie = createSunnie(config);
  const api = (path: string, method = 'GET', body?: unknown, authenticated = true) => sunnie.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${TEST_API_KEY}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const old = sunnie.deps.conversations.create();
    const checkIn = sunnie.deps.conversations.create({ kind: 'heartbeat' });
    assert.equal((await api('/v1/settings/model', 'PATCH', { model: 'local/next', reasoning: 'high' }, false)).status, 401);
    for (const invalid of [
      { model: 'missing/model', reasoning: 'high' },
      { model: 'local/next', reasoning: 'invalid' },
      { model: 'local/ next', reasoning: 'low' },
    ]) assert.equal((await api('/v1/settings/model', 'PATCH', invalid)).status, 400);
    assert.equal(sunnie.deps.conversations.modelDefaults(), null);
    assert.equal((await api('/v1/settings/model', 'PATCH', { model: 'local/next', reasoning: 'high' })).status, 200);
    const first = await (await api('/v1/conversations', 'POST', {})).json() as any;
    assert.equal(first.model, 'local/next');
    assert.equal(first.reasoning, 'high');
    await api('/v1/settings/model', 'PATCH', { model: 'local/later', reasoning: 'none' });
    assert.equal(sunnie.deps.conversations.get(first.id)?.model, 'local/next');
    assert.equal(sunnie.deps.conversations.get(first.id)?.reasoning, 'high');
    assert.equal(sunnie.deps.conversations.get(old.id)?.model, null);
    assert.equal(sunnie.deps.conversations.get(checkIn.id)?.model, null);
    assert.equal(sunnie.deps.models.defaultSpec, 'local/original');
    await sunnie.close();
    sunnie = createSunnie(config);
    assert.deepEqual(await (await api('/v1/settings/model')).json(), { model: 'local/later', reasoning: 'none' });
    const next = await (await api('/v1/conversations', 'POST', {})).json() as any;
    assert.equal(next.model, 'local/later');
    assert.equal(next.reasoning, 'none');
    const explicit = await (await api('/v1/conversations', 'POST', { model: 'local/custom' })).json() as any;
    assert.equal(explicit.model, 'local/custom');
    assert.equal(explicit.reasoning, 'low');
  } finally { await sunnie.close(); }
});

test('reasoning overrides are isolated between resolutions and preserve session cache options', () => {
  const config = testConfig({
    providers: { openrouter: { type: 'openrouter', apiKey: 'test-only' } },
    models: { 'openrouter/vendor/model': { reasoning: 'medium', providerOptions: { reasoning: { effort: 'low' } } } },
  });
  const models = createModelRegistry(config, {});
  const high = models.resolve('openrouter/vendor/model', 'high');
  const none = models.resolve('openrouter/vendor/model', 'none');
  const options = high.callOptions({ sessionId: 'conversation' }).providerOptions?.openrouter;
  assert.deepEqual(options?.reasoning, { effort: 'high' });
  assert.equal(options?.session_id, 'conversation');
  assert.equal(options?.prompt_cache_key, 'conversation');
  assert.deepEqual(none.callOptions({ sessionId: 'other' }).providerOptions?.openrouter?.reasoning, { effort: 'none' });
  assert.deepEqual(models.resolve('openrouter/vendor/model').callOptions({ sessionId: 'old' }).providerOptions?.openrouter?.reasoning, { effort: 'low' });
});

test('the ordinary turn resolves the reasoning saved on its conversation', async (t) => {
  const registry = registryOf(new MockLanguageModelV4({ doStream: textStep('Hello') }));
  const seen: unknown[] = [];
  const sunnie = testSunnie({}, { models: {
    ...registry,
    resolve(spec, reasoning) { seen.push(reasoning); return registry.resolve(spec); },
  } });
  t.after(() => sunnie.close());
  const conversation = sunnie.deps.conversations.create({ reasoning: 'high' });
  await runTurn(sunnie.deps, {
    conversationId: conversation.id, runId: 'run_reasoning', text: 'Hello',
    signal: new AbortController().signal, emit() {},
  });
  assert.equal(seen[0], 'high');
});
