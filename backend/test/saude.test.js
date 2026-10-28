import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); await t.reset(); });
after(() => t.close());

test('/health simples e profundo (testa o banco)', async () => {
  assert.deepEqual((await t.call('GET', '/health')).json, { ok: true });
  const deep = await t.call('GET', '/health?deep=1');
  assert.equal(deep.status, 200); assert.deepEqual(deep.json, { ok: true, db: true });
});

test('erro de tela: aceita sem login, responde 204 e não quebra com lixo', async () => {
  const ok = await t.call('POST', '/client-error', { body: { message: 'x is not a function', stack: 'at a (b.js:1)', path: '/pacientes?cpf=123' } });
  assert.equal(ok.status, 204);
  assert.equal((await t.call('POST', '/client-error', { body: { message: 'a'.repeat(5000) } })).status, 204);
  assert.ok((await t.call('POST', '/client-error', { body: 'lixo' })).status < 500, 'lixo não gera erro 500');
});
