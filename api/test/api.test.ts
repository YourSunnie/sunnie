import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Sunnie } from '../src/app.ts';
import { startFakeProvider, type FakeProvider } from './fake-provider.ts';
import { TEST_API_KEY, testSunnie } from './helpers.ts';

/**
 * End to end over the real stack: HTTP API → run manager → agent loop → AI SDK
 * openai-compatible provider → a scripted fake model server. Only the model is fake.
 */
let provider: FakeProvider;
let sunnie: Sunnie;

before(async () => {
  provider = await startFakeProvider();
  sunnie = testSunnie({
    agent: { defaultModel: 'fake/test-model' },
    providers: { fake: { type: 'openai-compatible', baseURL: provider.baseURL, apiKey: 'sk-fake' } },
  });
});

after(async () => {
  await sunnie.close();
  await provider.close();
});

const api = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
  sunnie.app.request(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TEST_API_KEY}` }),
      'content-type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

// Responses are asserted on field by field, so an untyped body is fine here.
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, any>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.includes('data:'))
    .map((block) => {
      const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, 'm').exec(block)?.[1] ?? '';
      return { id: Number(field('id')), event: field('event'), data: JSON.parse(field('data')) };
    });
}

const newConversation = async () => (await json(api('/v1/conversations', { body: {} }))).id as string;

test('health is public; everything under /v1 needs the bearer token', async () => {
  assert.equal((await api('/health', { token: null })).status, 200);
  assert.equal((await api('/v1/info', { token: null })).status, 401);
  assert.equal((await api('/v1/info', { token: 'wrong' })).status, 401);

  const info = await json(api('/v1/info'));
  assert.equal(info.name, 'Sunnie');
  assert.equal(info.defaultModel, 'fake/test-model');
});

test('sending a message streams the turn, tool use included, and persists it', async () => {
  const id = await newConversation();
  const res = await api(`/v1/conversations/${id}/messages`, { body: { text: 'run: echo sunshine', timezone: 'Asia/Jakarta' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);

  const events = parseSse(await res.text());
  assert.deepEqual(events.map((e) => e.id), events.map((_, i) => i + 1), 'events are numbered for resume');
  const kinds = events.map((e) => e.event);
  assert.equal(kinds[0], 'run.started');
  assert.equal(kinds.at(-1), 'run.completed');
  assert.ok(kinds.indexOf('tool.call') < kinds.indexOf('tool.result'));

  const toolResult = events.find((e) => e.event === 'tool.result')!;
  assert.match(toolResult.data.output, /^sunshine/);
  const answer = events.filter((e) => e.event === 'text.delta').map((e) => e.data.text).join('');
  assert.equal(answer, 'Tool said: sunshine');
  assert.deepEqual(events.at(-1)!.data.usage, { inputTokens: 240, outputTokens: 24, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const { messages } = await json(api(`/v1/conversations/${id}/messages`));
  assert.deepEqual(messages.map((m: any) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(messages[0].parts, [{ type: 'text', text: 'run: echo sunshine' }], 'injected context stays server-side');
  assert.equal(messages[1].parts[0].type, 'tool_call');
  assert.equal(messages[2].parts[0].type, 'tool_result');
  assert.equal(messages[3].text, 'Tool said: sunshine');

  // What actually went over the wire to the provider.
  const request = provider.requests.at(-1)!;
  assert.equal(request.model, 'test-model');
  assert.equal(request.messages[0]!.role, 'system');
  assert.ok(request.tools!.length >= 10);

  // A finished run can still be replayed, from any point.
  const runId = events[0]!.data.runId;
  const replay = parseSse(await (await api(`/v1/runs/${runId}/events?after=${events.length - 2}`)).text());
  assert.deepEqual(replay.map((e) => e.id), [events.length - 1, events.length]);
});

test('stream:false waits for the turn and returns its messages', async () => {
  const id = await newConversation();
  const res = await api(`/v1/conversations/${id}/messages`, { body: { text: 'hi', stream: false } });
  const reply = await json(res);
  assert.equal(reply.run.status, 'completed');
  assert.deepEqual(reply.messages.map((m: any) => m.text), ['hi', 'Echo: hello there']);

  const conversation = await json(api(`/v1/conversations/${id}`));
  assert.equal(conversation.title, 'hi');
  assert.equal(conversation.activeRunId, null);
});

test('a run outlives its request, blocks a second one, and can be cancelled', async () => {
  const id = await newConversation();
  const res = await api(`/v1/conversations/${id}/messages`, { body: { text: 'slow please' } });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const runId = parseSse(first)[0]!.data.runId as string;

  // The client walks away; the run keeps going.
  await reader.cancel();
  assert.equal((await json(api(`/v1/runs/${runId}`))).status, 'running');
  assert.equal((await json(api(`/v1/conversations/${id}`))).activeRunId, runId);

  const second = await api(`/v1/conversations/${id}/messages`, { body: { text: 'me too' } });
  assert.equal(second.status, 409);

  assert.equal((await api(`/v1/runs/${runId}/cancel`, { method: 'POST' })).status, 200);
  const tail = parseSse(await (await api(`/v1/runs/${runId}/events`)).text());
  assert.equal(tail.at(-1)!.event, 'run.cancelled');
  assert.equal((await json(api(`/v1/runs/${runId}`))).status, 'cancelled');
});

test('bad input is rejected with a useful error', async () => {
  const id = await newConversation();
  assert.equal((await api(`/v1/conversations/${id}/messages`, { body: { text: '   ' } })).status, 400);
  assert.equal((await api('/v1/conversations/conv_nope/messages', { body: { text: 'hi' } })).status, 404);

  const unknownModel = await api(`/v1/conversations/${id}/messages`, { body: { text: 'hi', model: 'nope/model' } });
  assert.equal(unknownModel.status, 400);
  assert.match((await json(unknownModel)).error.message, /Unknown model provider "nope"/);

  const tooBig = await api(`/v1/conversations/${id}/messages`, { body: { text: 'x'.repeat(1_100_000) } });
  assert.equal(tooBig.status, 413);
  assert.equal((await json(tooBig)).error.code, 'payload_too_large');
});

test('manual compaction folds old messages into a summary', async () => {
  const id = await newConversation();
  const filler = 'lorem ipsum dolor '.repeat(400);
  sunnie.deps.conversations.appendMessages(
    id,
    Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: [{ type: 'text' as const, text: filler }],
      text: filler,
    })),
  );

  const result = await json(api(`/v1/conversations/${id}/compact`, { method: 'POST' }));
  assert.equal(result.compacted, true);
  assert.ok(result.summarizedMessages >= 2);
  assert.equal((await json(api(`/v1/conversations/${id}`))).hasSummary, true);
  assert.equal(sunnie.deps.conversations.get(id)!.summary, 'A compact summary of earlier talk.');
});

test('memory can be read and curated through the API', async () => {
  const created = await api('/v1/memories', { body: { content: 'Aditya lives in Jakarta', kind: 'fact' } });
  assert.equal(created.status, 201);
  const memory = await json(created);
  assert.equal(memory.source, 'api');
  assert.equal((await api('/v1/memories', { body: { content: 'Aditya lives in Jakarta' } })).status, 200);

  const found = await json(api('/v1/memories?q=jakarta'));
  assert.equal(found.memories[0].id, memory.id);

  const patched = await api(`/v1/memories/${memory.id}`, { method: 'PATCH', body: { content: 'Aditya lives in Bali' } });
  assert.equal((await json(patched)).content, 'Aditya lives in Bali');
  assert.equal((await api(`/v1/memories/${memory.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/v1/memories/${memory.id}`, { method: 'DELETE' })).status, 404);

  const put = await api('/v1/core-memory/user', { method: 'PUT', body: { content: 'Name: Aditya' } });
  assert.equal(put.status, 200);
  assert.equal((await json(api('/v1/core-memory'))).blocks.user, 'Name: Aditya');
  assert.equal((await api('/v1/core-memory/bogus', { method: 'PUT', body: { content: 'x' } })).status, 400);
});

test('logins are write-only for secrets: saved and edited through the API, never read back', async () => {
  assert.equal((await json(api('/v1/info'))).browser.enabled, true);

  const created = await api('/v1/logins', {
    body: { site: 'https://www.github.com/login', username: 'adit', password: 'hunter2-pass', totpSecret: 'gezd gnbv gy3t qojq' },
  });
  assert.equal(created.status, 201);
  const login = await json(created);
  assert.deepEqual(
    { ...login, createdAt: '', updatedAt: '' },
    { id: login.id, name: 'github.com', site: 'github.com', username: 'adit', hasPassword: true, hasTotp: true, createdAt: '', updatedAt: '' },
  );

  assert.equal((await api('/v1/logins', { body: { site: 'github.com' } })).status, 409);
  assert.equal((await api('/v1/logins', { body: { username: 'no site' } })).status, 400);
  assert.equal((await api('/v1/logins', { body: { name: 'bad code', site: 'x.example', totpSecret: '123' } })).status, 400);

  const patched = await api(`/v1/logins/${login.id}`, { method: 'PATCH', body: { name: 'GitHub', totpSecret: '' } });
  assert.deepEqual(
    (({ name, hasPassword, hasTotp }) => ({ name, hasPassword, hasTotp }))(await json(patched)),
    { name: 'GitHub', hasPassword: true, hasTotp: false },
  );
  assert.equal(sunnie.deps.logins.get(login.id)!.password, 'hunter2-pass', 'a patch without a password keeps it');

  const listed = await (await api('/v1/logins')).text();
  assert.match(listed, /"name":"GitHub"/);
  assert.doesNotMatch(listed, /hunter2|GEZD/i);

  assert.equal((await api('/v1/logins/login_missing', { method: 'PATCH', body: { username: 'x' } })).status, 404);
  assert.equal((await api(`/v1/logins/${login.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/v1/logins/${login.id}`, { method: 'DELETE' })).status, 404);
});

test('API: the usage allowance is relayed from the hosting service, and absent without one', async () => {
  // The shared server has no usage service.
  assert.equal((await json(api('/v1/info'))).usage.enabled, false);
  assert.equal((await api('/v1/usage')).status, 404);

  const seen: Array<string | undefined> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { used: 2_500_000, limit: 10_000_000, resetsAt: '2026-11-01T00:00:00Z' } };
  const service = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/gateway/v1/usage`;
  const hosted = testSunnie({ usage: { url, apiKey: 'sgw_test' } });
  const ask = (path: string) => hosted.app.request(path, { headers: { authorization: `Bearer ${TEST_API_KEY}` } });
  try {
    assert.equal(((await (await ask('/v1/info')).json()) as any).usage.enabled, true);
    const usage = await (await ask('/v1/usage')).json();
    assert.deepEqual(usage, { used: 2_500_000, limit: 10_000_000, percent: 25, resetsAt: '2026-11-01T00:00:00Z' });
    // The service's token is the server's business: the app only ever presents its own key.
    assert.deepEqual(seen, ['Bearer sgw_test']);

    answer = { status: 200, body: { used: 3, limit: 0 } };
    assert.equal(((await (await ask('/v1/usage')).json()) as any).percent, 100);
    answer = { status: 503, body: { error: 'down' } };
    assert.equal((await ask('/v1/usage')).status, 502);
    answer = { status: 200, body: { nonsense: true } };
    assert.equal((await ask('/v1/usage')).status, 400);
  } finally {
    await hosted.close();
    service.close();
  }
});
