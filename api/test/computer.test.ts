import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalComputer, shq } from '../src/computer/computer.ts';

test('local tools remain available in fresh login shells, even when a profile resets PATH', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "sunnie's computer-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bin = join(workspace, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(workspace, '.bash_profile'), 'export PATH=/usr/bin:/bin\n');
  const program = join(bin, 'sunnie-local-tool');
  writeFileSync(program, '#!/bin/sh\nprintf "local tool works\\n"\n');
  chmodSync(program, 0o755);
  const computer = new LocalComputer({ workspace });

  for (let call = 0; call < 2; call++) {
    const result = await computer.exec('sunnie-local-tool');
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.stdout, 'local tool works\n');
  }
});

test('package storage is confined to each computer home without inheriting server variables', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'sunnie-packages-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const name = 'SUNNIE_COMPUTER_TEST_SECRET';
  const before = process.env[name];
  process.env[name] = 'server-only';
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
  const computer = new LocalComputer({ workspace });
  const code = `console.log(JSON.stringify({ home: process.env.HOME, mamba: process.env.MAMBA_ROOT_PREFIX, npm: process.env.NPM_CONFIG_PREFIX, secret: process.env.${name} ?? null }))`;
  const result = await computer.exec(`${shq(process.execPath)} -e ${shq(code)}`);
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout), {
    home: workspace,
    mamba: join(workspace, '.local', 'share', 'mamba'),
    npm: join(workspace, '.local'),
    secret: null,
  });
});
