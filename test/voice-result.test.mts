import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedResult } from '../src/voice/result-parts.mjs';

const bytes = (text: string) => Buffer.byteLength(text);

test('an oversized answer keeps its opening and its closing caveat and question, and states the omission', () => {
  const opening = 'El hilo principal terminó su turno.';
  const closing = 'Salvedad: no he leído los subagentes. ¿Quieres que los revise?';
  const output = `${opening} ${'Detalle intermedio número siete. '.repeat(400)}${closing}`;
  const { text, truncated } = boundedResult(output, 2100);
  assert.equal(truncated, true); assert.ok(bytes(text) <= 2100);
  assert.ok(text.startsWith(opening)); assert.ok(text.endsWith(closing));
  assert.match(text, /middle part omitted for length/);
  assert.deepEqual(boundedResult(' Breve. ', 2100), { text: 'Breve.', truncated: false });
});
