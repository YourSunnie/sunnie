import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createSunnie, type Sunnie } from '../src/app.ts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_PREVIEW_BYTES, MAX_MESSAGE_ATTACHMENTS, type Attachment } from '../src/store/attachments.ts';
import { TEST_API_KEY, promptText, registryOf, testConfig, testSunnie, textStep } from './helpers.ts';

const headers = { authorization: `Bearer ${TEST_API_KEY}` };
const send = (sunnie: Sunnie, path: string, body: Record<string, unknown>) => sunnie.app.request(path, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const upload = (sunnie: Sunnie, data = 'A useful detail.', requestId = 'upload-1', filename = 'Notes résumé.txt') => sunnie.app.request('/v1/attachments', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'text/plain', 'x-filename': encodeURIComponent(filename), 'x-request-id': requestId },
  body: data,
});

test('uploads are authenticated, immutable, downloadable, and idempotent independently of sends', async () => {
  const sunnie = testSunnie();
  try {
    const unauthorized = await sunnie.app.request('/v1/attachments', { method: 'POST', body: 'private' });
    assert.equal(unauthorized.status, 401);
    const created = await upload(sunnie);
    assert.equal(created.status, 201);
    const attachment = await created.json() as Attachment;
    assert.equal(attachment.filename, 'Notes résumé.txt');
    assert.equal(attachment.mediaType, 'text/plain');
    assert.equal(attachment.sizeBytes, Buffer.byteLength('A useful detail.'));
    assert.deepEqual(Object.keys(attachment).sort(), ['createdAt', 'drivePath', 'filename', 'id', 'mediaType', 'sizeBytes']);
    assert.equal(attachment.drivePath, `Uploads/${attachment.id}/${attachment.filename}`);
    const retried = await upload(sunnie);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), attachment);
    assert.equal((await upload(sunnie, 'Changed under the same ID')).status, 409);

    const content = await sunnie.app.request(`/v1/attachments/${attachment.id}/content`, { headers });
    assert.equal(await content.text(), 'A useful detail.');
    assert.match(content.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''Notes%20r%C3%A9sum%C3%A9.txt$/);
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(content.headers.get('cache-control'), 'no-store');
    assert.equal((await sunnie.app.request(`/v1/attachments/${attachment.id}/content`)).status, 401);
    const metadata = await sunnie.app.request(`/v1/attachments/${attachment.id}`, { headers });
    assert.deepEqual(await metadata.json(), attachment);
  } finally {
    await sunnie.close();
  }
});

test('upload and message validation preserve the ordinary JSON size limit', async () => {
  const model = new MockLanguageModelV4({ doStream: [] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  try {
    assert.equal((await sunnie.app.request('/v1/attachments', { method: 'POST', headers, body: 'x' })).status, 400);
    assert.equal((await sunnie.app.request('/v1/attachments', { method: 'POST', headers: { ...headers, 'x-filename': '%' }, body: 'x' })).status, 400);
    const tooLarge = await sunnie.app.request('/v1/attachments', {
      method: 'POST', headers: { ...headers, 'x-filename': 'large.txt', 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }, body: 'x',
    });
    assert.equal(tooLarge.status, 413);
    const conversation = sunnie.deps.conversations.create();
    const path = `/v1/conversations/${conversation.id}/messages`;
    assert.equal((await send(sunnie, path, { text: ' ' })).status, 400);
    assert.equal((await send(sunnie, path, { text: 'Hello', wait: false })).status, 400);
    assert.equal((await send(sunnie, path, { attachmentIds: ['missing'], stream: false })).status, 404);
    assert.equal((await send(sunnie, path, { attachmentIds: Array(MAX_MESSAGE_ATTACHMENTS + 1).fill('missing') })).status, 400);
    const largeJson = await send(sunnie, path, { text: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(largeJson.status, 413);
    assert.equal(model.doStreamCalls.length, 0);
  } finally {
    await sunnie.close();
  }
});

test('an image interpretation preview is immutable and never changes the original download', async () => {
  const sunnie = testSunnie();
  try {
    const original = Buffer.from('Original HEIC bytes are kept exactly as uploaded.');
    const attachment = sunnie.deps.attachments.create({ filename: 'Photo.heic', mediaType: 'image/heic', data: original }).attachment;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
    const put = (bytes = png, mediaType = 'image/png') => sunnie.app.request(`/v1/attachments/${attachment.id}/preview`, {
      method: 'PUT', headers: { ...headers, 'content-type': mediaType }, body: bytes,
    });
    assert.equal((await sunnie.app.request(`/v1/attachments/${attachment.id}/preview`, { method: 'PUT', body: png })).status, 401);
    assert.equal((await put()).status, 201);
    assert.equal((await put()).status, 200);
    assert.equal((await put(Buffer.concat([png, Buffer.from('different')]))).status, 409);
    assert.equal((await put(png, 'image/jpeg')).status, 409);
    const preview = sunnie.deps.attachments.getPreview(attachment.id)!;
    assert.equal(preview.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(preview.data), png);
    assert.deepEqual(sunnie.deps.attachments.get(attachment.id), attachment);
    const response = await sunnie.app.request(`/v1/attachments/${attachment.id}/content`, { headers });
    assert.equal(response.headers.get('content-type'), 'image/heic');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);

    const oversized = await sunnie.app.request(`/v1/attachments/${attachment.id}/preview`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'image/png', 'content-length': String(MAX_ATTACHMENT_PREVIEW_BYTES + 1) }, body: png,
    });
    assert.equal(oversized.status, 413);
    const document = sunnie.deps.attachments.create({ filename: 'Notes.txt', mediaType: 'text/plain', data: Buffer.from('Text.') }).attachment;
    assert.equal((await sunnie.app.request(`/v1/attachments/${document.id}/preview`, { method: 'PUT', headers: { ...headers, 'content-type': 'image/png' }, body: png })).status, 400);
    const otherImage = sunnie.deps.attachments.create({ filename: 'Other.heic', mediaType: 'image/heic', data: original }).attachment;
    assert.equal((await sunnie.app.request(`/v1/attachments/${otherImage.id}/preview`, { method: 'PUT', headers: { ...headers, 'content-type': 'image/png' }, body: 'not a PNG' })).status, 400);
  } finally {
    await sunnie.close();
  }
});

test('an attachment-only send is acknowledged before its answer and survives a request retry', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = new MockLanguageModelV4({ doStream: async () => { await held; return textStep('I have your notes.'); } });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  try {
    const attachment = await (await upload(sunnie)).json() as Attachment;
    const conversation = sunnie.deps.conversations.create();
    const path = `/v1/conversations/${conversation.id}/messages`;
    const body = { attachmentIds: [attachment.id], requestId: 'send-1', stream: false, wait: false };
    const accepted = await send(sunnie, path, body);
    assert.equal(accepted.status, 202);
    const reply = await accepted.json() as { run: { id: string; status: string }; messages: unknown[] };
    assert.equal(reply.run.status, 'running');
    assert.deepEqual(reply.messages, []);
    const retried = await (await send(sunnie, path, body)).json() as { run: { id: string } };
    assert.equal(retried.run.id, reply.run.id);
    release();
    await sunnie.runs.get(reply.run.id)!.done;
    const messages = sunnie.deps.conversations.listMessages(conversation.id);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[0]!.text, '');
    assert.deepEqual(messages[0]!.attachments, [attachment]);
    assert.equal(sunnie.deps.conversations.get(conversation.id)!.title, attachment.filename);
    assert.match(promptText(model.doStreamCalls[0]), /Notes résumé\.txt/);
    const history = await (await sunnie.app.request(path, { headers })).json() as { messages: Array<Record<string, unknown>> };
    assert.deepEqual(history.messages[0]!.attachments, [attachment]);
    assert.equal(history.messages[0]!.content, undefined);
    assert.doesNotMatch(JSON.stringify(history), /<attachments>|<attachment_text/);
  } finally {
    release();
    await sunnie.close();
  }
});

test('a file sent during a run is persisted with its steer and used exactly once', async () => {
  let sunnie!: Sunnie;
  let runId = '';
  let attachment!: Attachment;
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    calls += 1;
    if (calls === 1) {
      const path = `/v1/runs/${runId}/messages`;
      const body = { text: 'Use this too.', attachmentIds: [attachment.id], requestId: 'steer-file' };
      assert.equal((await send(sunnie, path, body)).status, 202);
      assert.equal((await send(sunnie, path, body)).status, 202);
      return textStep('First answer.');
    }
    return textStep('I included the attachment.');
  } });
  sunnie = testSunnie({}, { models: registryOf(model) });
  try {
    attachment = await (await upload(sunnie)).json() as Attachment;
    const conversation = sunnie.deps.conversations.create();
    const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Help me.' });
    runId = run.id;
    await run.done;
    assert.equal(run.status, 'completed');
    const users = sunnie.deps.conversations.listMessages(conversation.id).filter((message) => message.role === 'user');
    assert.equal(users.length, 2);
    assert.equal(users[1]!.text, 'Use this too.');
    assert.deepEqual(users[1]!.attachments, [attachment]);
    assert.deepEqual(sunnie.deps.runLog.pendingSteers(runId), []);
    assert.match(promptText(model.doStreamCalls[1]), /Notes résumé\.txt/);
    const retryBody = { text: 'Use this too.', attachmentIds: [attachment.id], requestId: 'steer-file' };
    const retriedSteer = await send(sunnie, `/v1/runs/${run.id}/messages`, retryBody);
    assert.equal(retriedSteer.status, 202, 'an accepted steer remains accepted after the run ends');
    assert.equal(((await retriedSteer.json()) as { id: string }).id, run.id);
    const switchedRoute = await send(sunnie, `/v1/conversations/${conversation.id}/messages`, { ...retryBody, stream: false, wait: false });
    assert.equal(((await switchedRoute.json()) as { run: { id: string } }).run.id, run.id);
    assert.equal(calls, 2, 'retrying through the other route does not repeat the task');

    const ordinary = sunnie.runs.start({ conversationId: conversation.id, text: 'Next.', requestId: 'ordinary-send' });
    await ordinary.done;
    const switchedToSteer = await send(sunnie, `/v1/runs/${ordinary.id}/messages`, { text: 'Next.', requestId: 'ordinary-send' });
    assert.equal(switchedToSteer.status, 202);
    assert.equal(((await switchedToSteer.json()) as { id: string }).id, ordinary.id);
    assert.equal(calls, 3, 'an ordinary send is not appended again as a steer');
  } finally {
    await sunnie.close();
  }
});

test('restart recovers uploaded IDs before the opening message was stored', async () => {
  const config = testConfig();
  const first = createSunnie(config, { models: registryOf(new MockLanguageModelV4({ doStream: [] })) });
  const attachment = first.deps.attachments.create({ filename: 'Restart.txt', mediaType: 'text/plain', data: Buffer.from('Still here.') }).attachment;
  const conversation = first.deps.conversations.create();
  first.deps.runLog.create({
    id: 'run_upload_restart', conversationId: conversation.id, startedAt: new Date().toISOString(),
    input: { conversationId: conversation.id, text: '', attachmentIds: [attachment.id] },
  });
  first.db.close();
  const model = new MockLanguageModelV4({ doStream: [textStep('Recovered your file.')] });
  const second = createSunnie(config, { models: registryOf(model) });
  try {
    await second.runs.get('run_upload_restart')!.done;
    const user = second.deps.conversations.listMessages(conversation.id)[0]!;
    assert.deepEqual(user.attachments, [attachment]);
    assert.deepEqual(Buffer.from(second.deps.attachments.getBytes(attachment.id)!), Buffer.from('Still here.'));
    assert.match(promptText(model.doStreamCalls[0]), /Restart\.txt/);
  } finally {
    await second.close();
  }
});

test('restart passes a completed run’s queued file batches onward without losing later files', async () => {
  const config = testConfig();
  const first = createSunnie(config, { models: registryOf(new MockLanguageModelV4({ doStream: [] })) });
  const conversation = first.deps.conversations.create();
  const files = Array.from({ length: 9 }, (_, index) => first.deps.attachments.create({
    filename: `File-${index}.txt`, mediaType: 'text/plain', data: Buffer.from(`Number ${index}`),
  }).attachment);
  first.deps.runLog.create({ id: 'run_before_handoff', conversationId: conversation.id, input: { conversationId: conversation.id, text: 'Earlier work.' }, startedAt: new Date().toISOString() });
  first.deps.runLog.addSteer('run_before_handoff', { text: 'First batch.', attachmentIds: files.slice(0, 8).map((file) => file.id), requestId: 'handoff-file' });
  first.deps.runLog.addSteer('run_before_handoff', { text: 'Last file.', attachmentIds: [files[8]!.id] });
  first.deps.runLog.finish('run_before_handoff', { status: 'completed', finishReason: 'stop' });
  first.db.close();

  const model = new MockLanguageModelV4({ doStream: [textStep('First batch read.'), textStep('Last file read.')] });
  const second = createSunnie(config, { models: registryOf(model) });
  try {
    const next = second.runs.activeFor(conversation.id)!;
    assert.ok(next);
    await next.done;
    const users = second.deps.conversations.listMessages(conversation.id).filter((message) => message.role === 'user');
    assert.deepEqual(users.map((message) => message.attachments?.length), [8, 1]);
    assert.deepEqual(users.flatMap((message) => message.attachments?.map((file) => file.id) ?? []), files.map((file) => file.id));
    assert.deepEqual(second.deps.runLog.unsettled(), []);
    assert.deepEqual(second.deps.runLog.pendingSteers(next.id), []);
    const retry = await send(second, '/v1/runs/run_before_handoff/messages', { text: 'First batch.', attachmentIds: files.slice(0, 8).map((file) => file.id), requestId: 'handoff-file' });
    assert.equal(retry.status, 202);
    assert.equal(((await retry.json()) as { id: string }).id, next.id, 'handoff retains the original request identity');
  } finally {
    await second.close();
  }
});
