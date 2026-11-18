import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { BrowserAccess } from '../src/access/browsers.mjs';

test('CLI pairing persists across HTTP restart, validates origin/host, and revokes SSE access', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-browser-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: join(tmp, 'config'), ADE_CALL_STATE: join(tmp, 'state'), T3CODE_HOME: join(tmp, 't3'), OPENAI_API_KEY: '' };
  let child: ChildProcess | undefined;
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  const start = async () => {
    child = spawn(process.execPath, ['dist/src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([once(child.stdout!, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Startup failed')), 5000).unref())]);
  };
  t.after(async () => { await stop(); rmSync(tmp, { recursive: true, force: true }); });
  const cli = (...args: string[]) => execFileSync(process.execPath, ['dist/scripts/access.mjs', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const invite = JSON.parse(cli('pair', '--url', base, '--name', 'Test phone'));
  await start();
  const raw = (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => new Promise<Response>((resolve, reject) => {
    const req = http.request(base + path, init, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(new Response(body, { status: response.statusCode, headers: response.headers as Record<string, string> })));
    }); req.on('error', reject); req.end(init.body);
  });
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => raw(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await post('/api/pair', { code: invite.code }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('/api/pair', { code: invite.code }, { Origin: base.replace('http:', 'https:') })).status, 403);
  const paired = await post('/api/pair', { code: invite.code }); assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Max-Age=15552000/);
  const cookie = setCookie.split(';')[0]; const device = (await paired.json()).device;
  assert.equal((await post('/api/pair', { code: invite.code })).status, 401);
  const headers = { Cookie: cookie };
  assert.equal((await fetch(base + '/api/status', { headers })).status, 200);
  assert.equal((await (await fetch(base + '/api/status', { headers })).json()).voiceReady, false, 'no openaiKey');
  assert.equal((await raw('/api/status', { headers: { ...headers, Host: 'evil.test' } })).status, 401);
  assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 403);
  await stop(); await start();
  assert.equal((await fetch(base + '/api/status', { headers })).status, 200, 'session survives restart');
  const devices = await (await fetch(base + '/api/browsers', { headers })).json();
  assert.equal(devices.currentId, device.id); assert.equal(devices.devices[0].name, 'Test phone');
  assert.doesNotMatch(JSON.stringify(devices), /tokenHash|pairing_codes/);
  const streamAbort = new AbortController(); t.after(() => streamAbort.abort());
  // SSE writes headers on its heartbeat if there are no existing events. Abort timeout
  // remains bounded, and revoke from the CLI while the initial response is pending.
  const stream = fetch(base + '/api/events', { headers, signal: streamAbort.signal });
  await new Promise(resolve => setTimeout(resolve, 100));
  cli('revoke', '--id', device.id);
  const response = await Promise.race([stream, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE revocation did not close')), 4000).unref())]);
  assert.equal(await response.text(), '');
  assert.equal((await fetch(base + '/api/status', { headers })).status, 401);
  const race = JSON.parse(cli('pair', '--name', 'Concurrent'));
  const raced = await Promise.all([post('/api/pair', { code: race.code }), post('/api/pair', { code: race.code })]);
  assert.deepEqual(raced.map(response => response.status).sort(), [200, 401], 'one code creates only one session under concurrent HTTP redemption');
  const second = JSON.parse(cli('pair', '--name', 'Second'));
  const secondResponse = await post('/api/pair', { code: second.code });
  const secondCookie = secondResponse.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post('/api/logout', {}, { Cookie: secondCookie })).status, 200);
  assert.equal((await fetch(base + '/api/status', { headers: { Cookie: secondCookie } })).status, 401);
  // Proxy transport decisions come from configured origin, never client X-Forwarded-*.
  cli('configure', '--url', 'https://app.example.test');
  const secureCode = JSON.parse(cli('pair', '--name', 'Secure'));
  assert.equal((await post('/api/pair', { code: secureCode.code }, { 'X-Forwarded-Host': 'app.example.test', 'X-Forwarded-Proto': 'https' })).status, 403);
  const secure = await post('/api/pair', { code: secureCode.code }, { Host: 'app.example.test', Origin: 'https://app.example.test', 'X-Forwarded-Proto': 'http' });
  assert.equal(secure.status, 200); assert.match(secure.headers.get('set-cookie')!, /^__Host-ade_browser=.*; Secure$/);
  const adminToken = readFileSync(join(tmp, 'config/access-token'), 'utf8').trim();
  assert.equal((await fetch(base + '/api/status', { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
  const login = await post('/api/login', { token: adminToken }, { Host: 'app.example.test', Origin: 'https://app.example.test' });
  assert.equal(login.status, 401, 'the admin token never becomes a browser cookie'); assert.equal(login.headers.get('set-cookie'), null);
});

test('a paired browser or the administrator creates codes for another device, only with the configured origin', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-browser-pair-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: join(tmp, 'config'), ADE_CALL_STATE: join(tmp, 'state'), T3CODE_HOME: join(tmp, 't3'), OPENAI_API_KEY: '' };
  const child = spawn(process.execPath, ['dist/src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } rmSync(tmp, { recursive: true, force: true }); });
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Startup failed')), 5000).unref())]);
  const cli = (...args: string[]) => execFileSync(process.execPath, ['dist/scripts/access.mjs', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => new Promise<Response>((resolve, reject) => {
    const req = http.request(base + path, init, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(new Response(body, { status: response.statusCode, headers: response.headers as Record<string, string> })));
    }); req.on('error', reject); req.end(init.body);
  });
  const create = (data: unknown, headers: Record<string, string>) => raw('/api/browsers/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const admin = { Authorization: `Bearer ${readFileSync(join(tmp, 'config/access-token'), 'utf8').trim()}` };
  const configured = () => {
    const access = new BrowserAccess(join(tmp, 'config/browser-access.sqlite'));
    try { return access.origin(); } finally { access.close(); }
  };

  assert.equal((await create({ name: 'Phone' }, {})).status, 401, 'only an authorized browser or the administrator');
  // Without a configured address it refuses, even with a Host it could have trusted.
  for (const host of [`127.0.0.1:${port}`, 'evil.test']) {
    const missing = await create({ name: 'Phone' }, { ...admin, Host: host });
    assert.equal(missing.status, 409);
    const result = await missing.json();
    assert.equal(result.reason, 'origin_missing'); assert.match(result.error, /npm run access -- pair --url URL --name NAME/);
  }
  assert.equal(configured(), undefined, 'the request never configures an origin');

  cli('configure', '--url', base);
  assert.equal((await create({ name: 'Phone' }, { ...admin, Origin: 'https://evil.test' })).status, 403, 'a foreign Origin is refused');
  for (const name of ['', '   ', 'x'.repeat(81), 'a\u0001b', 42, null]) {
    const bad = await create({ name }, admin);
    assert.equal(bad.status, 400, `name ${JSON.stringify(name)}`); assert.equal((await bad.json()).reason, 'invalid_name');
  }
  // The link uses the configured origin, whatever Host the request names.
  const spoofed = await create({ name: '  Test phone  ' }, { ...admin, Host: 'evil.test' });
  assert.equal(spoofed.status, 201);
  const invite = await spoofed.json();
  assert.match(invite.code, /^[0-9A-F]{6}(?:-[0-9A-F]{6}){3}$/);
  assert.equal(invite.link, `${base}/#pair=${invite.code}`); assert.equal(invite.name, 'Test phone');
  assert.ok(Math.abs(Date.parse(invite.expiresAt) - Date.now() - 600_000) < 5000);
  assert.ok(invite.expiresIn > 590_000 && invite.expiresIn <= 600_000);
  assert.equal(configured(), base);
  assert.match(spoofed.headers.get('cache-control')!, /no-store/);

  const pair = (code: string) => raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code }) });
  const paired = await pair(invite.code);
  assert.equal(paired.status, 200); assert.equal((await paired.json()).device.name, 'Test phone');
  assert.equal((await pair(invite.code)).status, 401, 'a code is redeemed once');
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];

  // A paired browser needs its exact Origin, like every other browser mutation.
  assert.equal((await create({ name: 'Laptop' }, { Cookie: cookie })).status, 403);
  assert.equal((await create({ name: 'Laptop' }, { Cookie: cookie, Origin: 'https://evil.test' })).status, 403);
  const fromBrowser = await create({ name: 'Laptop' }, { Cookie: cookie, Origin: base });
  assert.equal(fromBrowser.status, 201);
  const second = await fromBrowser.json();
  assert.equal((await pair(second.code)).status, 200);
  const list = await (await raw('/api/browsers', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(list.devices.map((device: { name: string }) => device.name).sort(), ['Laptop', 'Test phone']);

  // At most twenty pending codes; cancel-codes clears them.
  let status = 201, made = 0;
  while (status === 201 && made < 25) { status = (await create({ name: 'Spare' }, admin)).status; made++; }
  assert.equal(status, 429); assert.equal(made, 21);
  cli('cancel-codes');
  assert.equal((await create({ name: 'Spare' }, admin)).status, 201);
  assert.doesNotMatch(output, new RegExp(invite.code + '|' + second.code), 'codes never reach the logs');
});
