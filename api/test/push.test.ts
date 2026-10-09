import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { Sunnie } from '../src/app.ts';
import { ApnsSender, payload, type PushMessage, type PushResult, type PushSender } from '../src/push/apns.ts';
import type { PushDevice } from '../src/push/devices.ts';
import { previewText } from '../src/push/notifier.ts';
import type { RiskFilter } from '../src/router/risk.ts';
import { createLogger } from '../src/util/log.ts';
import { registryOf, TEST_API_KEY, testSunnie, textStep, toolStep } from './helpers.ts';

const TOKEN = 'a'.repeat(64);

// ── A scripted stand-in for Apple's push service (HTTP/2 without TLS) ────────────────────

const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const answers: Array<{ status: number; reason?: string }> = [];
const received: Array<{ headers: IncomingHttpHeaders; body: any }> = [];
let apple: Http2Server;
let endpoint = '';

before(async () => {
  apple = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      const answer = answers.shift() ?? { status: 200 };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
    });
  });
  await new Promise<void>((resolve) => apple.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(apple.address() as AddressInfo).port}`;
});
after(() => apple.close());

const device = (environment: PushDevice['environment'] = 'sandbox'): PushDevice => ({ token: TOKEN, environment, createdAt: '', updatedAt: '' });
const message: PushMessage = { title: 'Flight to Tokyo', body: 'Found one for $842.', threadId: 'conv_1', data: { conversationId: 'conv_1', runId: 'run_1', kind: 'reply' } };
const apns = () => new ApnsSender({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: pem, topic: 'com.yoursunnie.Sunnie', endpoint, timeoutMs: 2000, log: createLogger('silent') });

test('a notification goes to APNs signed with the team key, for the app, with the chat to open', async () => {
  received.length = 0;
  const sender = apns();
  try {
    assert.equal(await sender.send(device(), message), 'sent');
    assert.equal(await sender.send(device(), message), 'sent');
  } finally {
    sender.close();
  }
  const [first, second] = received;
  assert.equal(first!.headers[':path'], `/3/device/${TOKEN}`);
  assert.equal(first!.headers['apns-topic'], 'com.yoursunnie.Sunnie');
  assert.equal(first!.headers['apns-push-type'], 'alert');
  assert.deepEqual(first!.body, {
    aps: { alert: { title: 'Flight to Tokyo', body: 'Found one for $842.' }, sound: 'default', 'thread-id': 'conv_1' },
    conversationId: 'conv_1',
    runId: 'run_1',
    kind: 'reply',
  });

  const jwt = String(first!.headers.authorization).replace(/^bearer /, '');
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss, 'TEAM123456');
  assert.ok(
    verify('sha256', Buffer.from(`${header}.${claims}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')),
    'the provider token is signed with the key',
  );
  assert.equal(second!.headers.authorization, first!.headers.authorization, 'the provider token is reused, as Apple asks');
});

test('a token Apple no longer accepts is reported as gone; other refusals as failed', async () => {
  const sender = apns();
  try {
    answers.push({ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }, { status: 500, reason: 'InternalServerError' }, { status: 429, reason: 'TooManyRequests' });
    assert.equal(await sender.send(device(), message), 'gone');
    assert.equal(await sender.send(device(), message), 'gone');
    assert.equal(await sender.send(device(), message), 'failed');
    assert.equal(await sender.send(device(), message), 'failed');
  } finally {
    sender.close();
  }
  const closed = new ApnsSender({ teamId: 'T', keyId: 'K', key: pem, topic: 't', endpoint: 'http://127.0.0.1:9', timeoutMs: 500, log: createLogger('silent') });
  assert.equal(await closed.send(device(), message), 'failed', 'an unreachable APNs is a failure, not an exception');
  closed.close();
});

test('a long reply is cut to fit the payload limit; the routing data is kept', () => {
  const built = payload({ ...message, body: 'x'.repeat(10_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(built)) <= 4096);
  assert.equal(built.conversationId, 'conv_1');
  assert.match((built.aps as any).alert.body, /…$/);
});

test('a preview is one plain line: no card blocks, no Markdown marks, cut at a word', () => {
  assert.equal(previewText('**Done.** Your _flight_ is [booked](https://x.example).'), 'Done. Your flight is booked.');
  assert.equal(previewText('Here it is:\n\n```event\ntitle: Concert\nstart: 2026-10-17 20:00\n```\n\n- Doors at 7'), 'Here it is: Doors at 7');
  assert.equal(previewText('# Plan\n1. Fly Thursday\n2. Hotel'), 'Plan Fly Thursday Hotel');
  const long = previewText('word '.repeat(100));
  assert.ok(long.length <= 180 && long.endsWith('…') && !long.endsWith(' …'));
});

// ── What the notifier sends, through the whole stack ─────────────────────────────────────

class FakeSender implements PushSender {
  readonly name = 'fake';
  readonly sent: Array<{ token: string; message: PushMessage }> = [];
  result: PushResult = 'sent';
  async send(d: PushDevice, m: PushMessage): Promise<PushResult> {
    this.sent.push({ token: d.token, message: m });
    return this.result;
  }
  close() {}
}

function setup(steps: ConstructorParameters<typeof MockLanguageModelV4>[0], risk?: RiskFilter) {
  const push = new FakeSender();
  const sunnie = testSunnie({}, { models: registryOf(new MockLanguageModelV4(steps)), push, ...(risk ? { risk } : {}) });
  sunnie.deps.conversations.create();
  return { push, sunnie };
}

// Responses are asserted on field by field, so an untyped body is fine here.
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

const api = (sunnie: Sunnie, path: string, init: { method?: string; body?: unknown } = {}) =>
  sunnie.app.request(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

const deviceCount = (sunnie: Sunnie) => (sunnie.db.prepare('SELECT count(*) AS n FROM push_devices').get() as { n: number }).n;

async function finish(sunnie: Sunnie, run: { done: Promise<void> }) {
  await run.done;
  await sunnie.notifier.idle();
}

test('devices register through the API, and /v1/info says whether notifications are on', async () => {
  const off = testSunnie();
  const { sunnie } = setup({ doStream: [] });
  try {
    assert.equal((await json(api(off, '/v1/info'))).push.enabled, false);
    assert.equal((await json(api(sunnie, '/v1/info'))).push.enabled, true);

    assert.equal((await api(sunnie, '/v1/devices', { body: { token: 'not-hex', environment: 'sandbox' } })).status, 400);
    assert.equal((await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'staging' } })).status, 400);
    const res = await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'sandbox' } });
    assert.deepEqual(await res.json(), { token: TOKEN, environment: 'sandbox', pushEnabled: true });
    await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'production' } });
    assert.deepEqual(sunnie.db.prepare('SELECT token, environment FROM push_devices').all().map((r) => ({ ...r })), [{ token: TOKEN, environment: 'production' }], 'registering again updates the device');

    assert.equal((await api(sunnie, `/v1/devices/${TOKEN}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(sunnie, `/v1/devices/${TOKEN}`, { method: 'DELETE' })).status, 204, 'removing twice is fine');
    assert.equal(deviceCount(sunnie), 0);
  } finally {
    await off.close();
    await sunnie.close();
  }
});

test('a finished run sends its reply, as plain text, to every device', async () => {
  const { push, sunnie } = setup({ doStream: [textStep('**Found it.** The Friday flight is $842.')] });
  try {
    await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'sandbox' } });
    await api(sunnie, '/v1/devices', { body: { token: 'b'.repeat(64), environment: 'production' } });
    const conversation = sunnie.deps.conversations.create({ title: 'Flight to Tokyo' });
    const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Find me a flight' });
    await finish(sunnie, run);

    assert.equal(push.sent.length, 2);
    assert.deepEqual(push.sent[0]!.message, {
      title: 'Flight to Tokyo',
      body: 'Found it. The Friday flight is $842.',
      threadId: conversation.id,
      data: { conversationId: conversation.id, runId: run.id, kind: 'reply' },
    });
  } finally {
    await sunnie.close();
  }
});

test('a held tool call notifies without showing the call; a device Apple rejects is forgotten', async () => {
  const risk: RiskFilter = { name: 'hold', assess: async () => ({ confirm: true, risk: 0.9 }) };
  const { push, sunnie } = setup({ doStream: [toolStep('bash', { command: 'rm -rf old' }, 'c1'), textStep('Done.')] }, risk);
  try {
    await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'sandbox' } });
    const conversation = sunnie.deps.conversations.create();
    const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Clean up' });
    for (let i = 0; i < 200 && run.pendingApprovals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await sunnie.notifier.idle();

    assert.equal(push.sent.length, 1);
    const held = push.sent[0]!.message;
    assert.equal(held.title, 'Clean up', 'titled like the chat');
    assert.equal(held.body, 'Sunnie needs your OK to continue.');
    assert.equal(held.data.kind, 'approval');
    assert.ok(!JSON.stringify(held).includes('rm -rf'), 'the command stays off the lock screen');

    push.result = 'gone';
    sunnie.runs.resolveApproval(run.id, 'c1', false);
    await finish(sunnie, run);
    assert.equal(push.sent.at(-1)!.message.data.kind, 'reply');
    assert.equal(deviceCount(sunnie), 0);
  } finally {
    await sunnie.close();
  }
});

test('helpers, the Home brief and check-ins that fail send nothing; a failed chat run does', async () => {
  const { push, sunnie } = setup({
    doStream: async () => {
      throw Object.assign(new Error('The model refused the request.'), { statusCode: 400 });
    },
  });
  try {
    await api(sunnie, '/v1/devices', { body: { token: TOKEN, environment: 'sandbox' } });
    const { conversations } = sunnie.deps;

    const helper = conversations.create({ kind: 'subagent' });
    await finish(sunnie, sunnie.runs.start({ conversationId: helper.id, text: 'Look this up' }));
    const checkIns = conversations.create({ kind: 'heartbeat', title: 'Check-ins' });
    await finish(sunnie, sunnie.runs.start({ conversationId: checkIns.id, text: 'Getting your Home ready', brief: true, origin: 'heartbeat' }));
    await finish(sunnie, sunnie.runs.start({ conversationId: checkIns.id, text: 'Checking in', origin: 'heartbeat' }));
    assert.equal(push.sent.length, 0);

    const chat = conversations.create({ title: 'Internet bill' });
    const run = sunnie.runs.start({ conversationId: chat.id, text: 'Lower my bill' });
    await finish(sunnie, run);
    assert.equal(run.status, 'failed');
    assert.deepEqual(push.sent.map((s) => [s.message.title, s.message.data.kind]), [['Internet bill', 'failed']]);
  } finally {
    await sunnie.close();
  }
});
