import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostMatches } from '../browser/protocol.ts';
import { openDatabase } from '../src/db/database.ts';
import { LoginStore, normalizeSite, normalizeTotpSecret, toLoginDto, totp } from '../src/logins/login-store.ts';

test('a site is stored as a bare host, and a login only matches that host or its subdomains', () => {
  assert.equal(normalizeSite('GitHub.com'), 'github.com');
  assert.equal(normalizeSite('https://www.github.com/login?next=/'), 'github.com');
  assert.equal(normalizeSite('localhost:3000'), 'localhost');
  assert.throws(() => normalizeSite('not a site'), /not a site/);

  assert.equal(hostMatches('github.com', 'github.com'), true);
  assert.equal(hostMatches('www.github.com', 'github.com'), true);
  assert.equal(hostMatches('gist.github.com', 'github.com'), true);
  assert.equal(hostMatches('github.com.evil.example', 'github.com'), false);
  assert.equal(hostMatches('notgithub.com', 'github.com'), false);
  assert.equal(hostMatches('', 'github.com'), false);
});

test('one-time codes follow RFC 6238', () => {
  // The RFC's SHA-1 test secret ("12345678901234567890") and the last six digits of its vectors.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(secret, 1111111109_000), '081804');
  assert.equal(totp(secret, 20000000000_000), '353130');

  assert.equal(normalizeTotpSecret('gezd gnbv-gy3t qojq'), 'GEZDGNBVGY3TQOJQ');
  assert.equal(normalizeTotpSecret('otpauth://totp/GitHub:adit?secret=gezdgnbvgy3tqojq&issuer=GitHub'), 'GEZDGNBVGY3TQOJQ');
  assert.equal(normalizeTotpSecret('  '), '');
  assert.throws(() => normalizeTotpSecret('123456'), /base32 setup key/);
});

test('logins: create, look up by name, update, and never expose secrets in the DTO', () => {
  const logins = new LoginStore(openDatabase(':memory:'));

  const created = logins.create({ site: 'https://www.github.com/login', username: ' adit ', password: 'hunter2!' });
  assert.equal(created.name, 'github.com', 'the name defaults to the site');
  assert.equal(created.username, 'adit');
  assert.equal(logins.byName('GITHUB.com')?.id, created.id);

  const dto = toLoginDto(created);
  assert.deepEqual(
    { ...dto, createdAt: '', updatedAt: '' },
    { id: created.id, name: 'github.com', site: 'github.com', username: 'adit', hasPassword: true, hasTotp: false, createdAt: '', updatedAt: '' },
  );
  assert.doesNotMatch(JSON.stringify(dto), /hunter2/);

  assert.throws(() => logins.create({ site: 'github.com' }), /already exists/);
  logins.create({ name: 'work github', site: 'github.com', username: 'adit-work' });

  const updated = logins.update(created.id, { totpSecret: 'GEZDGNBVGY3TQOJQ', username: 'aditya' })!;
  assert.equal(updated.password, 'hunter2!', 'fields left out keep their value');
  assert.equal(updated.username, 'aditya');
  assert.equal(toLoginDto(updated).hasTotp, true);
  assert.equal(logins.update(created.id, { password: '' })!.password, '', 'an empty string clears a secret');
  assert.throws(() => logins.update(created.id, { name: 'Work GitHub' }), /already exists/);
  assert.throws(() => logins.update(created.id, { totpSecret: 'nope!' }), /base32/);

  assert.deepEqual(logins.list().map((l) => l.name), ['github.com', 'work github']);
  assert.equal(logins.delete(created.id), true);
  assert.equal(logins.delete(created.id), false);
  assert.equal(logins.update('login_missing', { username: 'x' }), undefined);
});
