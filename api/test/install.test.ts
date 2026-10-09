import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const library = fileURLToPath(new URL('../../scripts/install-common.sh', import.meta.url));

// Only file helpers run here: no installer entrypoint, sudo, apt, Docker or network.
function shell(code: string, ...args: string[]) {
  return spawnSync('bash', ['-euc', 'source "$1"; shift; ' + code, 'install-test', library, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('installer credentials are private, random and never overwrite an existing file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sunnie-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, 'first.env');
  const second = join(dir, 'second.env');
  const create = (path: string) => shell('create_credentials_file "$1" "$2" "$3"', path, 'fake-provider-key', '');
  assert.equal(create(first).status, 0);
  assert.equal(create(second).status, 0);
  const before = readFileSync(first, 'utf8');
  assert.match(before, /^SUNNIE_API_KEY=[a-f0-9]{64}\nOPENROUTER_API_KEY=fake-provider-key\n$/);
  assert.equal(statSync(first).mode & 0o777, 0o600);
  assert.notEqual(before, readFileSync(second, 'utf8'));
  assert.notEqual(create(first).status, 0);
  assert.equal(readFileSync(first, 'utf8'), before);
});

test('installer rejects credentials or model text that could change the env file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sunnie-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials');
  for (const [key, model] of [
    ['', ''],
    ['fake\nSUNNIE_HOST=0.0.0.0', ''],
    ['fake"key', ''],
    ['fake', 'provider/model\nSUNNIE_PORT=80'],
    ['fake', '$(touch marker)'],
  ] as const) {
    assert.notEqual(shell('create_credentials_file "$1" "$2" "$3"', path, key, model).status, 0);
    assert.equal(existsSync(path), false);
  }
  assert.equal(shell('create_credentials_file "$1" "$2" "$3"', path, 'fake', 'openrouter/vendor/model:free').status, 0);
  assert.match(readFileSync(path, 'utf8'), /\nSUNNIE_MODEL=openrouter\/vendor\/model:free\n$/);
});

test('installer reads the app key as data and rejects missing or duplicate keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sunnie-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials');
  const marker = join(dir, 'must-not-exist');
  writeFileSync(path, `SUNNIE_API_KEY=fake-app-key\nUNRELATED=$(touch "${marker}")\n`);
  const read = shell('read_api_key "$1"', path);
  assert.equal(read.status, 0);
  assert.equal(read.stdout, 'fake-app-key');
  assert.equal(existsSync(marker), false);
  for (const text of ['', 'SUNNIE_API_KEY=\n', 'SUNNIE_API_KEY=one\nSUNNIE_API_KEY=two\n']) {
    writeFileSync(path, text);
    assert.notEqual(shell('read_api_key "$1"', path).status, 0);
  }
});

test('deployment copies only runtime source and refuses links into mutable files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sunnie-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  for (const child of ['src', 'browser', 'skills', 'data', 'node_modules']) {
    mkdirSync(join(repo, 'api', child), { recursive: true });
  }
  for (const file of ['src/index.ts', 'browser/client.ts', 'skills/client.ts', 'package.json', 'pnpm-lock.yaml', '.env', 'data/sunnie.db', 'node_modules/local-file']) {
    writeFileSync(join(repo, 'api', file), file);
  }
  const destination = join(dir, 'deployment');
  mkdirSync(destination);
  const copy = () => shell('SUNNIE_REPO=$1; chown() { :; }; copy_api "$2"', repo, destination);
  assert.equal(copy().status, 0);
  assert.equal(readFileSync(join(destination, 'src/index.ts'), 'utf8'), 'src/index.ts');
  for (const excluded of ['.env', 'data', 'node_modules']) assert.equal(existsSync(join(destination, excluded)), false);
  symlinkSync(join(repo, 'api/.env'), join(repo, 'api/src/linked-secret'));
  assert.notEqual(copy().status, 0);
});
