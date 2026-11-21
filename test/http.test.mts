import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/conversation/store.mjs';

// The server with simulated T3 and Orca CLIs and no OpenAI key: nothing here
// reaches a provider. Stored call events are seeded before it starts.
test('HTTP authentication, CSRF protection, single voice design and ADE availability', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-http-test-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as net.AddressInfo).port; await new Promise(resolve => socket.close(resolve));
  const fakeT3 = join(tmp, 'fake-t3.mjs');
  writeFileSync(fakeT3, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(join(tmp, 'cli.log'))}, process.argv.slice(2).join(' ') + '\\n'); console.log(JSON.stringify([{threadId:'test-thread',projectId:'test-project',title:'Principal',status:'idle'}]));`, { mode: 0o700 });
  const t3Base = join(tmp, 't3'); mkdirSync(join(t3Base, 'userdata'), { recursive: true });
  const t3db = new DatabaseSync(join(t3Base, 'userdata/statev2.sqlite'));
  t3db.exec("CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at); INSERT INTO projection_projects VALUES('test-project','Proyecto T3','/demo',NULL,NULL)"); t3db.close();
  const fakeOrca = join(tmp, 'fake-orca.mjs');
  writeFileSync(fakeOrca, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,result:{repos:[{id:'orca-project',displayName:'Orca project',path:'/demo-orca'}],worktrees:[],terminals:[]}}));`, { mode: 0o700 });
  // Calls of T3's current conversation, with events that must not reach it:
  // another ADE, another conversation and an unrelated event type.
  const seed = new Store(join(tmp, 'state/caller.sqlite'));
  const current = seed.conversation('t3').id;
  seed.event('transcript', { call: 'c1', role: 'user', text: 'Read the thread', backend: 't3', conversationId: current, at: '2026-11-17T10:00:00.000Z' });
  seed.event('voice-diagnostic', { id: 'c1', backend: 't3', conversationId: current });
  seed.event('voice-tool', { id: 'c1', callId: 'f1', name: 't3_read_thread', ok: true, status: 'completed', args: { threadId: 'abc' }, result: 'Mensajes', backend: 't3', conversationId: current });
  seed.event('transcript', { call: 'o1', role: 'user', text: 'Otro ADE', backend: 'orca', conversationId: current });
  seed.event('transcript', { call: 'c0', role: 'user', text: 'Another conversation', backend: 't3', conversationId: 'other' });
  const lastSeeded = seed.event('transcript', { call: 'c1', role: 'assistant', text: 'I have read it', backend: 't3', conversationId: current, at: '2026-11-17T10:00:05.000Z' }).id;
  seed.close();
  const child = spawn(process.execPath, ['dist/src/server.mjs'], { env: { ...process.env, PORT: String(port), ADE_CALL_STATE: join(tmp, 'state'), ADE_CALL_CONFIG: join(tmp, 'config'), ORCA_BIN: fakeOrca, T3_BIN: fakeT3, T3CODE_HOME: t3Base, OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 5000).unref())]);
    const base = `http://127.0.0.1:${port}`;
    // The login screen also needs the complete module graph without credentials.
    const modules = new Set(['/app.js']);
    for (const path of modules) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `public module ${path}`);
      assert.match(response.headers.get('content-type')!, /javascript/);
      const source = await response.text();
      for (const match of source.matchAll(/from\s+['"]([.][^'"]+)['"]/g)) {
        modules.add(new URL(match[1], base + path).pathname);
      }
    }
    assert.ok(modules.has('/live-events.js')); assert.ok(modules.has('/i18n.js')); assert.ok(modules.has('/sounds.js'));
    for (const unlisted of ['/unknown.js', '/i18n.ts', '/server.mjs']) assert.equal((await fetch(base + unlisted)).status, 401, unlisted);
    assert.equal((await fetch(base + '/api/status')).status, 401);
    const token = readFileSync(join(tmp, 'config/access-token'), 'utf8');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const post = async (path: string, data: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
    assert.equal((await fetch(base + '/api/live', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/calls')).status, 401, 'the calls are private');
    assert.equal((await fetch(base + '/api/recordings')).status, 401);
    assert.equal((await fetch(base + '/api/recordings/part', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/recordings/part', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
    assert.deepEqual(await (await fetch(base + '/api/recordings', { headers })).json(), { recordings: [] });
    const status = await (await fetch(base + '/api/status', { headers })).json();
    assert.equal(status.serviceBusy, false, 'no call and no tool running: the installer may restart it');
    const recordingId = '11111111-2222-3333-4444-555555555555';
    const recordingPart = { info: { id: recordingId, backend: 't3', conversationId: status.conversation.id, provider: 'realtime', mime: 'audio/webm', startedAt: new Date().toISOString(), durationMs: 0, status: 'complete' }, sequence: 0, audio: 'dGVzdA==', events: [] };
    assert.equal((await post('/api/recordings/part', { ...recordingPart, info: { ...recordingPart.info, id: '11111111-2222-3333-4444-666666666666', provider: 'other' } })).status, 400, 'only GPT Realtime calls are recorded');
    assert.equal((await post('/api/recordings/part', recordingPart)).status, 200);
    assert.equal(readFileSync(join(tmp, 'state/recordings', recordingId, 'audio.webm'), 'utf8'), 'test');
    assert.equal((await fetch(base + '/recordings/' + recordingId + '/audio.webm', { headers })).status, 404, 'audio is not exposed as a static download');
    // No WebSocket endpoint is left: the voice audio is WebRTC to the provider.
    const upgraded = await new Promise(resolve => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { ...headers, Origin: base } });
      ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(false); });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    assert.equal(upgraded, false);

    // Status: honest readiness, no secrets.
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(status.voiceReady, false, 'no openaiKey');
    assert.equal(status.voiceModel.model, 'gpt-realtime-2.1');
    assert.deepEqual(status.voiceModel, { provider: 'realtime', model: 'gpt-realtime-2.1', reasoning: 'low', eagerness: 'low', noiseReduction: 'near_field', voice: 'marin' }, 'the server-wide voice settings; their options are in /api/settings/voice');
    assert.deepEqual(status.ades.map((ade: { id: string; direct: boolean }) => [ade.id, ade.direct]), [['t3', true], ['orca', true]]);
    assert.equal(status.backend, 't3'); assert.equal(status.conversation.id, current);

    // The "Conversation" panel: transcript turns and voice tools of this ADE
    // and conversation only, in order, as stored, up to the given cursor.
    const calls = await (await fetch(base + '/api/calls', { headers })).json();
    assert.equal(calls.backend, 't3'); assert.equal(calls.conversationId, current); assert.equal(calls.truncated, false);
    assert.deepEqual(calls.events.map((e: { type: string; data: { text?: string; name?: string } }) => [e.type, e.data.text || e.data.name]), [
      ['transcript', 'Read the thread'], ['voice-tool', 't3_read_thread'], ['transcript', 'I have read it']]);
    assert.deepEqual(calls.events[1].data.args, { threadId: 'abc' }); assert.equal(calls.events[1].data.result, 'Mensajes');
    assert.ok(status.eventCursor >= lastSeeded);
    const early = await (await fetch(base + `/api/calls?through=${lastSeeded - 1}`, { headers })).json();
    assert.equal(early.events.at(-1).type, 'voice-tool', 'nothing after the cursor');
    assert.equal((await fetch(base + '/api/calls?through=-1', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/calls?through=abc', { headers })).status, 400);
    assert.deepEqual((await (await fetch(base + '/api/calls?backend=orca', { headers })).json()).events.map((e: { data: { text: string } }) => e.data.text), [], 'another conversation of Orca');

    assert.equal((await post('/api/live/interrupt', { id: 'no-active-call' })).status, 200);
    // A missing key is the server's configuration, not a bad request.
    const live = await post('/api/live', { sdp: 'v=test' });
    assert.equal(live.status, 503); assert.match((await live.json()).error, /OpenAI key/);
    const malformed = await fetch(base + '/api/live', { method: 'POST', headers, body: '{"sdp":' });
    assert.equal(malformed.status, 400, 'a malformed body is a bad request');
    for (const raw of ['null', '[]', '"text"', '7', 'true']) {
      for (const path of ['/api/live', '/api/live/close', '/api/browsers/revoke']) {
        const response = await fetch(base + path, { method: 'POST', headers, body: raw });
        assert.equal(response.status, 400, `${path} with ${raw}`);
        assert.deepEqual(await response.json(), { error: 'The request body must be a JSON object.' }, `${path} with ${raw}`);
      }
    }
    assert.equal((await post('/api/live', { sdp: 'no offer' })).status, 400);

    // Orca has voice through its direct tools; only the key is missing here.
    const orca = await (await fetch(base + '/api/status?backend=orca', { headers })).json();
    assert.equal(orca.backend, 'orca'); assert.equal(orca.voiceReady, false, 'no openaiKey');
    assert.equal(orca.ades.find((ade: { id: string }) => ade.id === 'orca').direct, true);
    assert.match(orca.limitation, /reads terminal output.*does not read or continue its structured chats/);
    const refused = await post('/api/live?backend=orca', { sdp: 'v=test', backend: 'orca', conversationId: orca.conversation.id });
    assert.equal(refused.status, 503); assert.match((await refused.json()).error, /OpenAI key/);
    assert.equal((await fetch(base + '/api/status?backend=hedr', { headers })).status, 400);

    const projects = await (await fetch(base + '/api/projects', { headers })).json();
    assert.equal(projects.projects[0].name, 'Proyecto T3');
    const context = await (await fetch(base + '/api/context', { headers })).json();
    assert.equal(context.backend, 't3'); assert.equal(context.projects[0].id, 'test-project');
    assert.doesNotMatch(readFileSync(join(tmp, 'cli.log'), 'utf8'), /send|start/, 'only read-only T3 commands');

    const resetBody = { backend: 't3', conversationId: status.conversation.id };
    const reset = await post('/api/conversation/new', resetBody);
    assert.equal(reset.status, 200);
    assert.notEqual((await reset.json()).conversation.id, status.conversation.id);
    assert.equal((await post('/api/conversation/new', resetBody)).status, 409, 'stale reset must not reset twice');
    assert.equal((await post('/api/live', { sdp: 'v=test', backend: 't3', conversationId: status.conversation.id })).status, 409, 'a call for the old session');
    assert.deepEqual((await (await fetch(base + '/api/calls', { headers })).json()).events, [], 'a new session starts with an empty panel');
    const kept = new Store(join(tmp, 'state/caller.sqlite'));
    try { assert.equal(kept.callEvents('t3', current).events.length, 3, 'earlier calls stay stored'); } finally { kept.close(); }
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); rmSync(tmp, { recursive: true, force: true }); }
});
