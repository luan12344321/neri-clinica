import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

test('login: credenciais corretas devolvem token que acessa o dashboard', async () => {
  const r = await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' } });
  assert.equal(r.status, 200);
  const d = await t.call('GET', '/dashboard', { token: r.json.token });
  assert.equal(d.status, 200);
});

test('/me devolve nome, papel e clínica do usuário logado e exige token', async () => {
  const r = await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' } });
  const me = await t.call('GET', '/me', { token: r.json.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { name: 'Gestor Demo', email: 'gestor@demo.test', role: 'owner', clinic: 'Clínica Demo', termsAccepted: false });
  assert.equal((await t.call('GET', '/me')).status, 401);
});

test('login: senha errada e e-mail inexistente dão a mesma resposta 401', async () => {
  const wrong = await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'errada' } });
  const none = await t.call('POST', '/auth/login', { body: { email: 'ninguem@demo.test', password: 'demo1234' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, none.json);
});

test('login: e-mail não diferencia maiúsculas de minúsculas', async () => {
  const r = await t.call('POST', '/auth/login', { body: { email: 'GESTOR@Demo.Test', password: 'demo1234' } });
  assert.equal(r.status, 200);
});

test('login: 5 falhas bloqueiam aquele IP (429) mesmo com a senha certa, sem trancar a conta para outros IPs', async () => {
  const bad = { email: 'gestor@demo.test', password: 'errada' };
  for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/auth/login', { body: bad, ip: '203.0.113.9' })).status, 401);
  const good = { email: 'gestor@demo.test', password: 'demo1234' };
  assert.equal((await t.call('POST', '/auth/login', { body: good, ip: '203.0.113.9' })).status, 429);
  assert.equal((await t.call('POST', '/auth/login', { body: good, ip: '198.51.100.4' })).status, 200);
});

test('login: sem Origin permitido, a API não devolve cabeçalhos CORS', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://site-malicioso.example' } });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('login: corpo inválido vira 400 (não 500)', async () => {
  const r = await t.call('POST', '/auth/login', { body: { email: 'nao-e-email' } });
  assert.equal(r.status, 400);
});

test('rotas protegidas exigem token válido', async () => {
  for (const url of ['/dashboard', '/patients', '/finance/payables', '/stock/restock', '/alerts', '/google/status']) {
    assert.equal((await t.call('GET', url)).status, 401, url);
  }
  assert.equal((await t.call('GET', '/dashboard', { token: 'lixo' })).status, 401);
});

test('token do `state` do OAuth (sem clinicId) não autentica', async () => {
  const state = t.app.jwt.sign({ userId: 'x', purpose: 'google-oauth' });
  assert.equal((await t.call('GET', '/dashboard', { token: state })).status, 401);
});

test('recepção lê cadastros, cuida do estoque, mas não altera cadastros de gestão (403)', async () => {
  const token = await t.tokenFor('recepcao@demo.test');
  assert.equal((await t.call('GET', '/procedures', { token })).status, 200);
  const w = await t.call('POST', '/procedures', { token, body: { name: 'Novo', defaultPrice: 10 } });
  assert.equal(w.status, 403);
  const p = await t.call('POST', '/products', { token, body: { name: 'Item X', minQuantity: 1, targetQuantity: 2, unitCost: 5 } });
  assert.equal(p.status, 201, 'recepção cuida do estoque');
  assert.ok(!('unit_cost' in p.json), 'mas sem o custo');
});

test('GET /health é público', async () => {
  assert.equal((await t.call('GET', '/health')).status, 200);
});
