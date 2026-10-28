import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t, owner;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); owner = await t.tokenFor('gestor@demo.test'); });

test('novo usuário ainda não aceitou; aceitar grava data, versão e auditoria', async () => {
  const me = await t.call('GET', '/me', { token: owner });
  assert.equal(me.status, 200);
  assert.equal(me.json.termsAccepted, false);
  assert.equal('terms_version' in me.json, false, 'não vaza a coluna crua');

  const ok = await t.call('POST', '/me/terms', { token: owner, body: { version: '2026-10' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call('GET', '/me', { token: owner })).json.termsAccepted, true);

  const [u] = await t.sql(`SELECT terms_version, terms_accepted_at FROM users WHERE email='gestor@demo.test'`);
  assert.equal(u.terms_version, '2026-10'); assert.ok(u.terms_accepted_at);
  const [a] = await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='terms.accepted'`);
  assert.equal(a.n, 1);
});

test('versão antiga ou sem login é recusada; aceite de um usuário não vale para outro', async () => {
  assert.equal((await t.call('POST', '/me/terms', { token: owner, body: { version: '1999-01' } })).status, 400);
  assert.equal((await t.call('POST', '/me/terms', { body: { version: '2026-10' } })).status, 401);
  await t.call('POST', '/me/terms', { token: owner, body: { version: '2026-10' } });
  const rec = await t.tokenFor('recepcao@demo.test');
  assert.equal((await t.call('GET', '/me', { token: rec })).json.termsAccepted, false);
});
