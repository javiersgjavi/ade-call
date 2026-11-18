import test from 'node:test';
import assert from 'node:assert/strict';
import { cliFailure } from '../src/adapters/cli-failure.mjs';
import { DirectSession } from '../src/direct/session.mjs';
import { NotDispatchedError, type DirectAde } from '../src/direct/contract.mjs';
import { T3_PROMPT } from '../src/direct/t3.mjs';

test('CLI failures distinguish causes without leaking stderr, paths or claiming delivery', () => {
  for (const ade of ['T3', 'Orca'] as const) {
    for (const [code, expected] of [['ENOENT', /could not be started/], ['EACCES', /permission/], ['ETIMEDOUT', /in time/], ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', /output limit/], ['ADE_REJECTED', /rejected/], [1, /cause is not verified/]] as const) {
      const result = cliFailure(ade, { code, message: '/private/secret', stderr: 'sk-private', stdout: 'private transcript' });
      assert.match(result, expected);
      assert.doesNotMatch(result, /private|secret|transcript|repeat a send/);
    }
    assert.match(cliFailure(ade, new SyntaxError('private')), /JSON/);
  }
});

test('read failure, refused dispatch and uncertain dispatch keep distinct recovery and execution semantics', async () => {
  for (const kind of ['read', 'preflight', 'uncertain'] as const) {
    let calls = 0;
    const ade: DirectAde = { id: 'test', name: 'Test', prompt: T3_PROMPT, catalog: () => '', tools: [{
      name: 'operation', description: '', parameters: {}, sends: kind !== 'read',
      async execute() {
        calls++;
        if (kind === 'preflight') throw new NotDispatchedError('Invalid destination');
        throw new Error('No answer');
      }
    }] };
    const session = new DirectSession(ade);
    session.remember('user', 'Sí, envíalo');
    const item = { name: 'operation', call_id: 'one', arguments: '{}' };
    const context = { requestId: 'request-one', signal: new AbortController().signal };
    const result = await session.run(item, context);
    assert.equal(result?.status, kind === 'uncertain' ? 'unknown' : 'error');
    assert.equal(await session.run(item, context), null);
    assert.equal(calls, 1, 'the error message must not cause an automatic retry');
    if (kind === 'read') {
      assert.match(result!.output, /repeat only the read/);
      assert.doesNotMatch(result!.output, /Delivery not confirmed|Nothing was sent/);
    } else if (kind === 'preflight') {
      assert.match(result!.output, /Nothing was sent in this attempt/);
      assert.equal(session.sendRefusal(), null, 'a rejected preflight retains authorization');
    } else {
      assert.match(result!.output, /Do not repeat it, not with another ID/);
      assert.match(result!.output, /empty or failed read does not prove/);
      assert.notEqual(session.sendRefusal(), null, 'an uncertain send consumes this turn');
    }
  }
});
