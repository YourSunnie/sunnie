import assert from 'node:assert/strict';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { MAX_DRIVE_FILE_BYTES, MAX_DRIVE_TEXT_BYTES, type DriveEntry } from '../src/drive/protocol.ts';
import { HttpError } from '../src/util/errors.ts';
import { runTurn } from '../src/agent/agent.ts';
import { TEST_API_KEY, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };
const bytes = (text: string) => Buffer.from(text).toString('base64');
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;

test('Drive shares ordinary computer files, handles Unicode, preserves edits, and refuses overwrites', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const drive = sunnie.deps.drive;
  assert.deepEqual((await drive.list('')).entries, []);
  await drive.request({ action: 'mkdir', path: 'Plans' });
  const file = await drive.request<DriveEntry>({ action: 'upload', path: "Plans/Résumé & it's.txt", data: bytes('first') });
  assert.equal(file.kind, 'file');
  assert.equal((await drive.read(file.path)).data, bytes('first'));
  const before = await drive.text(file.path);
  writeFileSync(join(sunnie.deps.computer.workspace, 'Drive', file.path), 'changed by Sunnie');
  await assert.rejects(drive.request({ action: 'write', path: file.path, text: 'stale', revision: before.entry.revision }), status(409));
  assert.equal((await drive.text(file.path)).text, 'changed by Sunnie');
  const current = await drive.text(file.path);
  const saved = await drive.request<DriveEntry>({ action: 'write', path: file.path, text: 'edited on phone', revision: current.entry.revision });
  assert.equal(readFileSync(join(sunnie.deps.computer.workspace, 'Drive', file.path), 'utf8'), 'edited on phone');
  await drive.request({ action: 'upload', path: 'occupied.txt', data: bytes('keep') });
  await assert.rejects(drive.request({ action: 'upload', path: 'occupied.txt', data: bytes('replace') }), status(409));
  await assert.rejects(drive.request({ action: 'move', path: file.path, destination: 'occupied.txt', revision: saved.revision }), status(409));
  await drive.request({ action: 'move', path: file.path, destination: 'renamed.txt', revision: saved.revision });
  assert.equal((await drive.text('renamed.txt')).text, 'edited on phone');
  await assert.rejects(drive.stat(file.path), status(404));
  const renamed = await drive.stat('renamed.txt');
  await drive.request({ action: 'delete', path: renamed.path, revision: renamed.revision });
  await assert.rejects(drive.stat(renamed.path), status(404));
  const folder = await drive.stat('Plans');
  await assert.rejects(drive.request({ action: 'move', path: folder.path, destination: 'Plans/nested', revision: folder.revision }), status(400));
});

test('Drive refuses traversal, symlinks, hard links and special files without reading outside its root', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const drive = sunnie.deps.drive;
  const home = sunnie.deps.computer.workspace;
  await drive.list('');
  writeFileSync(join(home, 'private.txt'), 'private');
  symlinkSync(join(home, 'private.txt'), join(home, 'Drive', 'linked.txt'));
  symlinkSync(home, join(home, 'Drive', 'outside'));
  linkSync(join(home, 'private.txt'), join(home, 'Drive', 'hard.txt'));
  for (const path of ['../private.txt', '/private.txt', 'outside/private.txt', 'linked.txt', 'hard.txt', 'a/../../private.txt', 'a\\b', 'a\u0000b']) {
    await assert.rejects(drive.read(path), status(400));
  }
  await assert.rejects(drive.request({ action: 'upload', path: 'outside/created.txt', data: bytes('x') }), status(400));
  await assert.rejects(drive.request({ action: 'delete', path: '', revision: (await drive.stat('')).revision }), status(400));
  assert.ok((await drive.list('')).entries.every((item) => item.kind === 'unsupported'));
  assert.equal(readFileSync(join(home, 'private.txt'), 'utf8'), 'private');
  mkdirSync(join(home, 'Drive', 'deletable'));
  symlinkSync(home, join(home, 'Drive', 'deletable', 'escape'));
  const folder = await drive.stat('deletable');
  await drive.request({ action: 'delete', path: folder.path, revision: folder.revision });
  assert.equal(readFileSync(join(home, 'private.txt'), 'utf8'), 'private');
});

test('Drive rejects a replaced root and bounds text and binary transfers', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const home = sunnie.deps.computer.workspace;
  symlinkSync(home, join(home, 'Drive'));
  await assert.rejects(sunnie.deps.drive.list(''), status(400));
  const other = testSunnie();
  t.after(() => other.close());
  const drive = other.deps.drive;
  await drive.list('');
  await drive.request({ action: 'upload', path: 'binary.bin', data: 'AAECAw==' });
  await assert.rejects(drive.text('binary.bin'), status(400));
  writeFileSync(join(other.deps.computer.workspace, 'Drive', 'large.txt'), 'x'.repeat(MAX_DRIVE_TEXT_BYTES + 1));
  await assert.rejects(drive.text('large.txt'), status(413));
  const response = await other.app.request('/v1/drive/content?path=too-large', {
    method: 'POST', headers: { ...headers, 'content-length': String(MAX_DRIVE_FILE_BYTES + 1) }, body: 'x',
  });
  assert.equal(response.status, 413);
});

test('Drive HTTP routes require authentication, encode paths, and report stale revisions', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  for (const [method, path] of [['GET', 'entries'], ['GET', 'entry'], ['GET', 'text'], ['GET', 'content'], ['POST', 'content'], ['POST', 'folders'], ['PUT', 'text'], ['PATCH', 'entry'], ['DELETE', 'entry']]) {
    assert.equal((await sunnie.app.request(`/v1/drive/${path}`, { method })).status, 401);
  }
  const path = 'a & #? résumé.txt';
  const url = `/v1/drive/content?path=${encodeURIComponent(path)}`;
  const upload = await sunnie.app.request(url, { method: 'POST', headers, body: 'hello' });
  assert.equal(upload.status, 201);
  const entry = await upload.json() as DriveEntry;
  const content = await sunnie.app.request(url, { headers });
  assert.equal(await content.text(), 'hello');
  assert.equal(content.headers.get('cache-control'), 'no-store');
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  const save = (revision: string) => sunnie.app.request('/v1/drive/text', { method: 'PUT', headers, body: JSON.stringify({ path, text: 'saved', revision }) });
  assert.equal((await save(entry.revision)).status, 200);
  assert.equal((await save(entry.revision)).status, 409);
  assert.equal((await sunnie.app.request('/v1/drive/text?path=..%2Fprivate', { headers })).status, 400);
});

test('uploaded attachments have one editable Drive copy; retries never restore a deleted copy', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const upload = () => sunnie.app.request('/v1/attachments', {
    method: 'POST', headers: { ...headers, 'x-filename': 'notes.txt', 'x-request-id': 'drive-copy' }, body: 'original',
  });
  const response = await upload();
  const attachment = await response.json() as { id: string; drivePath: string };
  const original = await sunnie.deps.drive.text(attachment.drivePath);
  await sunnie.deps.drive.request({ action: 'write', path: attachment.drivePath, text: 'edited', revision: original.entry.revision });
  await upload();
  assert.equal((await sunnie.deps.drive.text(attachment.drivePath)).text, 'edited');
  const current = await sunnie.deps.drive.stat(attachment.drivePath);
  await sunnie.deps.drive.request({ action: 'delete', path: attachment.drivePath, revision: current.revision });
  assert.equal((await upload()).status, 200);
  await assert.rejects(sunnie.deps.drive.stat(attachment.drivePath), status(404));
  const download = await sunnie.app.request(`/v1/attachments/${attachment.id}/content`, { headers });
  assert.equal(await download.text(), 'original');
});

test('shell and file tools default to Drive while explicit home paths remain available', async (t) => {
  const model = new MockLanguageModelV4({ doStream: [
    toolStep('bash', { command: 'printf shell > shell.txt' }),
    toolStep('write_file', { path: 'notes.txt', content: 'notes' }, 'write'),
    toolStep('write_file', { path: '~/internal.txt', content: 'internal' }, 'home'),
    textStep('Done.'),
  ] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  const conversation = sunnie.deps.conversations.create();
  await runTurn(sunnie.deps, { conversationId: conversation.id, runId: 'drive-run', text: 'Make files.', signal: new AbortController().signal, emit: () => {} });
  const home = sunnie.deps.computer.workspace;
  assert.equal(readFileSync(join(home, 'Drive', 'shell.txt'), 'utf8'), 'shell');
  assert.equal(readFileSync(join(home, 'Drive', 'notes.txt'), 'utf8'), 'notes');
  assert.equal(readFileSync(join(home, 'internal.txt'), 'utf8'), 'internal');
});

test('Drive downloads bind cached bytes to the requested revision', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const entry = await sunnie.deps.drive.request<DriveEntry>({ action: 'upload', path: 'cached.txt', data: bytes('original') });
  const url = `/v1/drive/content?path=cached.txt&revision=${encodeURIComponent(entry.revision)}`;
  const first = await sunnie.app.request(url, { headers });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Drive-Revision'), entry.revision);
  assert.equal(await first.text(), 'original');
  writeFileSync(join(sunnie.deps.computer.workspace, 'Drive', entry.path), 'changed on computer');
  const stale = await sunnie.app.request(url, { headers });
  assert.equal(stale.status, 409);
  const current = await sunnie.app.request('/v1/drive/content?path=cached.txt', { headers });
  assert.equal(current.status, 200);
  assert.notEqual(current.headers.get('X-Drive-Revision'), entry.revision);
  assert.equal(await current.text(), 'changed on computer');
});
