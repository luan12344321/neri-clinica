import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

test('clínica sem categorias recebe as padrão ao abrir a lista; quem já tem não ganha extras', async () => {
  const o = await t.tokenFor('gestor@demo.test');
  const antes = (await t.call('GET', '/categories', { token: o })).json;
  assert.ok(antes.length >= 4);
  assert.equal((await t.call('GET', '/categories', { token: o })).json.length, antes.length, 'não duplica');
  await t.sql('DELETE FROM transactions'); await t.sql('DELETE FROM categories');
  const depois = (await t.call('GET', '/categories', { token: o })).json;
  assert.ok(depois.some((c) => c.name === 'Procedimentos' && c.kind === 'income'));
  assert.ok(depois.some((c) => c.kind === 'expense'));
  assert.equal((await t.call('GET', '/categories', { token: o })).json.length, depois.length);
});
