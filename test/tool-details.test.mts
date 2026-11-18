import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDetails } from '../src/conversation/tool-details.mjs';

test('diagnostic copies redact nested, embedded and configured secrets without changing results', () => {
  const raw = { token: 'private', nested: { apiKey: 'private' }, content: [{ type: 'text', text: '{"password":"private with spaces","text":"Bearer abc.def sk-test123 AIza123 configured-value"}' }], output: 'a'.repeat(40000) };
  const safe = toolDetails(raw, ['configured-value']) as typeof raw;
  assert.doesNotMatch(JSON.stringify(safe), /private|abc.def|sk-test123|AIza123|configured-value/);
  assert.match(safe.output, /abreviado/);
  assert.equal(raw.token, 'private'); assert.equal(raw.output.length, 40000);
  assert.ok(JSON.stringify(toolDetails(Array.from({ length: 100 }, () => 'x'.repeat(40000)))).length < 30000);
});
