import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { streamText } from 'ai';
import { createModelRegistry } from '../src/models/registry.ts';
import { startFakeProvider, type FakeProvider } from './fake-provider.ts';
import { testConfig } from './helpers.ts';

let provider: FakeProvider;
before(async () => {
  provider = await startFakeProvider();
});
after(() => provider.close());

/** Sends one request through the real provider SDK and returns the body that went over the wire. */
async function wireBody(providers: Record<string, unknown>, models: Record<string, unknown>, spec: string) {
  const config = testConfig({ providers, models, agent: { reasoning: 'low' } });
  const model = createModelRegistry(config, {}).resolve(spec);
  const result = streamText({
    model: model.model,
    instructions: 'system',
    prompt: 'hello',
    ...model.callOptions({ sessionId: 'conv_abc' }),
  });
  await result.consumeStream();
  return provider.requests.at(-1) as unknown as Record<string, unknown>;
}

test('the default model is one pinned model, and specs keep everything after the provider', () => {
  const config = testConfig();
  const registry = createModelRegistry(config, { OPENROUTER_API_KEY: 'sk-or-test' });
  assert.equal(registry.defaultSpec, 'openrouter/openai/gpt-6-luna');
  assert.equal(config.agent.reasoning, 'medium');
  const resolved = registry.resolve();
  assert.equal(resolved.providerId, 'openrouter');
  assert.equal(resolved.modelId, 'openai/gpt-6-luna');
  assert.equal(resolved.steer.byHint, false);
  // The same spec shares one steering state, so what one turn learns the next one knows.
  assert.equal(registry.resolve().steer, resolved.steer);

  assert.throws(() => createModelRegistry(config, {}).resolve(), /Set OPENROUTER_API_KEY/);
  assert.throws(() => registry.resolve('gpt-6.1-sol'), /<provider>\/<model-id>/);
});

test('OpenRouter requests pin the conversation for caching and carry the configured reasoning effort', async () => {
  const body = await wireBody(
    { openrouter: { type: 'openrouter', baseURL: provider.baseURL, apiKey: 'sk-or-test' } },
    {
      'openrouter/openai/gpt-6.1-sol': { reasoning: 'medium' },
      'openrouter/deepseek/deepseek-v4.1-flash': { providerOptions: { provider: { order: ['deepseek'] } } },
    },
    'openrouter/openai/gpt-6.1-sol',
  );
  assert.equal(body.model, 'openai/gpt-6.1-sol');
  // Same key on every request of a conversation → same upstream → the cached prefix is reused.
  assert.equal(body.session_id, 'conv_abc');
  assert.equal(body.prompt_cache_key, 'conv_abc');
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  // The per-model setting wins over agent.reasoning ("low").
  assert.deepEqual(body.reasoning, { effort: 'medium' });

  const routed = await wireBody(
    { openrouter: { type: 'openrouter', baseURL: provider.baseURL, apiKey: 'sk-or-test' } },
    { 'openrouter/deepseek/deepseek-v4.1-flash': { providerOptions: { provider: { order: ['deepseek'] } } } },
    'openrouter/deepseek/deepseek-v4.1-flash',
  );
  assert.equal(routed.model, 'deepseek/deepseek-v4.1-flash');
  // A model's own provider options are passed through untouched.
  assert.deepEqual(routed.provider, { order: ['deepseek'] });
  assert.deepEqual(routed.reasoning, { effort: 'low' });
});

test('other providers get the portable reasoning option and no OpenRouter fields', async () => {
  const body = await wireBody(
    { local: { type: 'openai-compatible', baseURL: provider.baseURL } },
    {},
    'local/some-model',
  );
  assert.equal(body.model, 'some-model');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.session_id, undefined);
  assert.equal(body.cache_control, undefined);
});

test('Anthropic requests think adaptively at the configured effort, survive an edited prefix, and mark the cache', async () => {
  const config = testConfig({
    providers: { anthropic: { type: 'anthropic', baseURL: provider.baseURL, apiKey: 'sk-ant-test' } },
    models: { 'anthropic/claude-haiku-5-5': { reasoning: 'none' } },
    agent: { reasoning: 'low' },
  });
  const model = createModelRegistry(config, {}).resolve('anthropic/claude-haiku-5-5');
  assert.ok(model.cacheMarks, 'Anthropic caches only where asked, so the agent needs marks to place');
  assert.equal(model.maxOutputTokens, 16_000);

  const result = streamText({
    model: model.model,
    instructions: { role: 'system', content: 'system', providerOptions: model.cacheMarks.system },
    messages: [{ role: 'user', content: 'hello', providerOptions: model.cacheMarks.message }],
    maxOutputTokens: model.maxOutputTokens,
    ...model.callOptions({ sessionId: 'conv_abc' }),
  });
  await result.consumeStream();
  const body = provider.requests.at(-1) as unknown as Record<string, unknown>;

  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 16_000);
  // Thinking cannot be turned off on current Claude models: "none" becomes the least effort.
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.match(String(provider.lastHeaders['anthropic-beta']), /thinking-binding-controls/);
  assert.equal(provider.lastHeaders['x-api-key'], 'sk-ant-test');
  // The system prompt is kept for an hour; the tail of the history for the next step.
  const system = body.system as Array<Record<string, unknown>>;
  assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral', ttl: '1h' });
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages.at(-1)!.content.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(body.temperature, undefined);

  // The usage the provider reports comes back as the standard cache figures.
  const usage = await result.usage;
  assert.equal(usage.inputTokenDetails?.cacheReadTokens, 100);

  // A model's own provider options win, as everywhere.
  const tuned = createModelRegistry(
    testConfig({
      providers: { anthropic: { type: 'anthropic', baseURL: provider.baseURL, apiKey: 'sk-ant-test' } },
      models: { 'anthropic/claude-opus-5-5': { reasoning: 'xhigh', providerOptions: { thinking: { type: 'adaptive' } } } },
    }),
    {},
  ).resolve('anthropic/claude-opus-5-5');
  const options = tuned.callOptions({ sessionId: 'conv_abc' }).providerOptions!.anthropic!;
  assert.deepEqual(options.thinking, { type: 'adaptive' });
  assert.equal(options.effort, 'xhigh');
});

test('an Anthropic model takes notes as system messages, a turn budget, and an advisor when configured', async () => {
  const config = testConfig({
    providers: { anthropic: { type: 'anthropic', baseURL: provider.baseURL, apiKey: 'sk-ant-test' } },
    models: { 'anthropic/claude-haiku-5-5': { advisor: { model: 'claude-opus-5-5', maxUses: 2, maxTokens: 2048 } } },
    agent: { reasoning: 'low', turnBudgetTokens: 30_000 },
  });
  const model = createModelRegistry(config, {}).resolve('anthropic/claude-haiku-5-5');
  assert.deepEqual(model.systemNotes, { anthropic: { clearAt: 'next_user_message' } });
  assert.ok(model.providerTools?.advisor, 'the advisor is a tool the provider runs');

  const result = streamText({
    model: model.model,
    instructions: 'system',
    allowSystemInMessages: true,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'system', content: '[Automatic note] reply now', providerOptions: model.systemNotes },
    ],
    tools: model.providerTools,
    ...model.callOptions({ sessionId: 'conv_abc' }),
  });
  await result.consumeStream();
  const body = provider.requests.at(-1) as unknown as Record<string, unknown>;
  assert.deepEqual(body.output_config, { effort: 'low', task_budget: { type: 'tokens', total: 30_000 } });
  // The note travels as a turn-scoped system message after the user's words, not inside them.
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.role, 'system');
  assert.equal(messages[1]!.clear_at, 'next_user_message');
  assert.match(String(provider.lastHeaders['anthropic-beta']), /mid-conversation-system-clear-at/);
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools[0], { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_uses: 2, max_tokens: 2048 });

  // Elsewhere the advisor is refused up front rather than sent as a tool nobody can run.
  const elsewhere = testConfig({
    providers: { local: { type: 'openai-compatible', baseURL: provider.baseURL } },
    models: { 'local/some-model': { advisor: { model: 'claude-opus-5-5' } } },
  });
  assert.throws(() => createModelRegistry(elsewhere, {}).resolve('local/some-model'), /no advisor tool/);
});
