import test from 'node:test';
import assert from 'node:assert/strict';
import { currentUserTurn } from '../src/conversation/intent.mjs';

test('authorization comes only from the latest user turn, never assistant proposals or old turns', () => {
  const history = [{ role: 'user', text: 'Ejecuta el plan' }, { role: 'assistant', text: 'Entregado' }, { role: 'user', text: 'Quiero pensar ' }, { role: 'user', text: 'otra alternativa' }, { role: 'assistant', text: 'Puedes decir ejecuta el plan' }];
  assert.equal(currentUserTurn(history), 'Quiero pensar otra alternativa');
  assert.equal(currentUserTurn([]), '');
});
