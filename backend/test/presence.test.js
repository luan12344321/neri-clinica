import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t, owner, reception;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); [owner, reception] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test'].map((e) => t.tokenFor(e))); });

const who = async () => (await t.call('GET', '/presence', { token: owner })).json;

// Primeiro teste do arquivo de propósito: sem a coluna, o primeiro ping a cria sozinho (banco em produção sem migração).
test('o primeiro ping cria a coluna de presença se ela não existir', async () => {
  await t.sql('ALTER TABLE users DROP COLUMN last_seen_at');
  assert.equal((await t.call('POST', '/presence/ping', { token: reception })).status, 204);
  const [{ n }] = await t.sql(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='users' AND column_name='last_seen_at'`);
  assert.equal(n, 1);
  assert.equal((await who()).find((u) => u.name === 'Recepção').online, true);
});

test('ping marca online; sem ping há mais de 2 min fica offline; quem nunca entrou aparece como offline', async () => {
  await t.call('POST', '/presence/ping', { token: reception });
  let list = await who();
  assert.deepEqual(list.map((u) => [u.name, u.online]), [['Recepção', true], ['Gestor Demo', false]]);
  await t.sql(`UPDATE users SET last_seen_at = now() - interval '5 minutes' WHERE email='recepcao@demo.test'`);
  list = await who();
  assert.equal(list.find((u) => u.name === 'Recepção').online, false);
  assert.ok(list.find((u) => u.name === 'Recepção').lastSeenAt, 'guarda quando foi visto');
  assert.equal(list.find((u) => u.name === 'Gestor Demo').lastSeenAt, null);
});

test('só o proprietário vê a lista; ping exige login', async () => {
  assert.equal((await t.call('GET', '/presence', { token: reception })).status, 403);
  assert.equal((await t.call('GET', '/presence')).status, 401);
  assert.equal((await t.call('POST', '/presence/ping')).status, 401);
});

test('a lista é só da própria clínica e não inclui quem teve o acesso removido', async () => {
  const [{ id }] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  await t.call('DELETE', `/team/${id}`, { token: owner });
  const names = (await who()).map((u) => u.name);
  assert.deepEqual(names, ['Gestor Demo']);
});

test('pings em sequência não regravam dentro de 30 s', async () => {
  await t.call('POST', '/presence/ping', { token: reception });
  const [a] = await t.sql(`SELECT last_seen_at FROM users WHERE email='recepcao@demo.test'`);
  await t.call('POST', '/presence/ping', { token: reception });
  const [b] = await t.sql(`SELECT last_seen_at FROM users WHERE email='recepcao@demo.test'`);
  assert.equal(String(a.last_seen_at), String(b.last_seen_at));
});
