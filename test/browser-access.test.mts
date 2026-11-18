import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAccess, REMEMBER_SECONDS, PAIRING_MS, publicOrigin } from '../src/access/browsers.mjs';

function fixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ade-access-'));
  let now = 1_800_000_000_000;
  const path = join(dir, 'browser-access.sqlite');
  const access = new BrowserAccess(path, () => now);
  t.after(() => { access.close(); rmSync(dir, { recursive: true, force: true }); });
  return { access, path, advance: (ms: number) => { now += ms; } };
}
test('pairing is single-use across connections, expiring and hash-only', t => {
  const { access, path, advance } = fixture(t);
  assert.throws(() => access.createCode('mobile'), /--url/);
  const code = access.createCode('Mi móvil', 'https://example.test');
  assert.equal(new URL(code.link).search, ''); assert.match(new URL(code.link).hash, /^#pair=/);
  const other = new BrowserAccess(path); t.after(() => other.close());
  const session = access.redeem(code.code.toLowerCase().replaceAll('-', ' '))!;
  assert.ok(session); assert.equal(other.redeem(code.code), null);
  assert.equal(access.authenticate(session.token)!.name, 'Mi móvil');
  const rows = JSON.stringify(access.db.prepare('SELECT * FROM browsers').all());
  assert.ok(!rows.includes(session.token));
  const expiring = access.createCode('Tablet');
  assert.ok(!JSON.stringify(access.db.prepare('SELECT * FROM pairing_codes').all()).includes(expiring.code.replaceAll('-', '')));
  advance(PAIRING_MS); assert.equal(access.redeem(expiring.code), null);
  assert.equal(access.redeem('not-a-code'), null);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
test('browser leases survive reopen, renew with use, expire and revoke independently', t => {
  const { access, path, advance } = fixture(t);
  access.configure('https://example.test');
  const a = access.redeem(access.createCode('A').code)!;
  const b = access.redeem(access.createCode('B').code)!;
  const reopened = new BrowserAccess(path, () => a.device.createdAt); t.after(() => reopened.close());
  assert.ok(reopened.authenticate(a.token));
  advance(REMEMBER_SECONDS * 1000 - 1000);
  access.remember(a.device.id);
  advance(2000);
  assert.ok(access.authenticate(a.token)); assert.equal(access.authenticate(b.token), null);
  assert.equal(access.revoke(a.device.id), true);
  access.remember(a.device.id); assert.equal(access.authenticate(a.token), null);
  assert.equal(access.active(a.device.id), false);
});
test('origin changes require explicit local configuration and revoke old devices/codes', t => {
  const { access } = fixture(t);
  const pending = access.createCode('A', 'https://example.test');
  const device = access.redeem(access.createCode('B').code)!;
  assert.throws(() => access.createCode('C', 'https://another.test'), /configure/);
  assert.ok(access.authenticate(device.token));
  access.configure('https://another.test');
  assert.equal(access.authenticate(device.token), null); assert.equal(access.redeem(pending.code), null);
  for (const url of ['http://example.test', 'https://a.test/path', 'https://u:p@a.test', 'https://a.test/?x=1', 'https://a.test/#x']) assert.throws(() => publicOrigin(url));
  assert.equal(publicOrigin('http://[::1]:8787'), 'http://[::1]:8787');
});
test('attempt throttling persists across processes and code cancellation is explicit', t => {
  const { access, path, advance } = fixture(t);
  for (let i = 0; i < 20; i++) assert.equal(access.allowAttempt('peer'), true);
  const other = new BrowserAccess(path, () => 1_800_000_000_000); t.after(() => other.close());
  assert.equal(other.allowAttempt('peer'), false);
  advance(60_001); assert.equal(access.allowAttempt('peer'), true);
  const code = access.createCode('A', 'https://example.test'); access.cancelCodes();
  assert.equal(access.redeem(code.code), null);
});
