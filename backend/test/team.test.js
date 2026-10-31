import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t, owner, aiFailure;
let GeminiError, BudgetError;
before(async () => { t = await setup(); ({ aiFailure } = await import('../src/sara.js')); ({ GeminiError, BudgetError } = await import('../src/gemini.js')); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); owner = await t.tokenFor('gestor@demo.test'); });

const PW = 'senha-forte-123';
const login = (email, password = PW) => t.call('POST', '/auth/login', { body: { email, password } });
const hire = (role = 'reception', email = 'ana@demo.test') =>
  t.call('POST', '/team', { token: owner, body: { name: 'Ana Souza', email, password: PW, role } });

test('dono cadastra funcionário, que entra com e-mail e senha e acessa a agenda e os pacientes', async () => {
  const r = await hire();
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.role, r.json.email, r.json.revoked], ['reception', 'ana@demo.test', false]);
  assert.equal(r.json.password_hash, undefined);
  const l = await login('ANA@demo.test');
  assert.equal(l.status, 200);
  assert.equal((await t.call('GET', '/patients', { token: l.json.token })).status, 200);
  assert.equal((await t.call('GET', '/me', { token: l.json.token })).json.role, 'reception');
});

test('funcionário não vê dinheiro nem a equipe: financeiro, Julia e /team dão 403; painel sem receita', async () => {
  await hire();
  const { json: { token } } = await login('ana@demo.test');
  for (const [m, u] of [['GET', '/finance/summary?month=2026-01'], ['GET', '/finance/cashflow'], ['GET', '/finance/receivables'],
    ['POST', '/sara/test'], ['GET', '/team'], ['POST', '/team']]) {
    assert.equal((await t.call(m, u, { token, body: { message: 'oi' } })).status, 403, `${m} ${u}`);
  }
  const dash = (await t.call('GET', '/dashboard', { token })).json;
  assert.deepEqual([dash.revenueByMonth, dash.todayRevenue], [[], null]);
  assert.ok((await t.call('GET', '/dashboard', { token: owner })).json.revenueByMonth.length > 0, 'o dono continua vendo a receita');
});

test('cadastro valida e-mail duplicado, senha curta e papel desconhecido', async () => {
  assert.equal((await hire()).status, 201);
  const bad = (body) => t.call('POST', '/team', { token: owner, body: { name: 'Zé', email: 'ze@demo.test', password: PW, role: 'reception', ...body } });
  assert.equal((await bad({ password: 'curta' })).status, 400);
  assert.equal((await bad({ role: 'superuser' })).status, 400);
  assert.equal((await bad({ email: 'sem-arroba' })).status, 400);
  assert.equal((await hire()).status, 409); // por último: o PGlite de teste derruba a conexão após um erro de SQL
});

test('troca de perfil vale na hora, com o mesmo token', async () => {
  const id = (await hire()).json.id;
  const { json: { token } } = await login('ana@demo.test');
  assert.equal((await t.call('GET', '/finance/cashflow', { token })).status, 403);
  const p = await t.call('PATCH', `/team/${id}`, { token: owner, body: { role: 'manager' } });
  assert.equal(p.json.role, 'manager');
  assert.equal((await t.call('GET', '/finance/cashflow', { token })).status, 200);
});

test('remover acesso: o token antigo cai na hora, o login falha, o registro fica e reativa com nova senha', async () => {
  const id = (await hire()).json.id;
  const { json: { token } } = await login('ana@demo.test');
  assert.equal((await t.call('DELETE', `/team/${id}`, { token: owner })).status, 204);
  assert.equal((await t.call('GET', '/patients', { token })).status, 401);
  assert.equal((await login('ana@demo.test')).status, 401);
  const list = (await t.call('GET', '/team', { token: owner })).json;
  assert.equal(list.find((u) => u.id === id).revoked, true);
  await t.call('PATCH', `/team/${id}`, { token: owner, body: { password: 'outra-senha-456' } });
  assert.equal((await login('ana@demo.test', 'outra-senha-456')).status, 200);
});

test('o dono não é editável nem removível; outra clínica não é alcançada', async () => {
  const [{ id: ownerId }] = await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`);
  assert.equal((await t.call('DELETE', `/team/${ownerId}`, { token: owner })).status, 404);
  assert.equal((await t.call('PATCH', `/team/${ownerId}`, { token: owner, body: { role: 'reception' } })).status, 404);
  const [{ id: otherId }] = await t.sql(`SELECT id FROM users WHERE email='b@demo.test'`);
  assert.equal((await t.call('DELETE', `/team/${otherId}`, { token: owner })).status, 404);
  assert.equal((await login('b@demo.test', 'demo1234')).status, 200);
  assert.equal((await t.call('GET', '/team', { token: owner })).json.some((u) => u.email === 'b@demo.test'), false);
});

test('trocar a própria senha exige a atual e mínimo de 10 caracteres', async () => {
  const r = (body) => t.call('POST', '/me/password', { token: owner, body });
  assert.equal((await r({ current: 'errada', next: 'nova-senha-123' })).status, 403);
  assert.equal((await r({ current: 'demo1234', next: 'curta' })).status, 400);
  assert.equal((await r({ current: 'demo1234', next: 'nova-senha-123' })).status, 200);
  assert.equal((await login('gestor@demo.test', 'nova-senha-123')).status, 200);
  assert.equal((await login('gestor@demo.test', 'demo1234')).status, 401);
});

test('falhas da IA viram códigos específicos; erros comuns não são mascarados', () => {
  assert.deepEqual(aiFailure(new GeminiError(400, 'billing')), { code: 503, error: 'ai_unavailable' });
  assert.deepEqual(aiFailure(new GeminiError(403, 'API key invalid')), { code: 503, error: 'ai_unavailable' });
  assert.deepEqual(aiFailure(new GeminiError(0, 'sem chave')), { code: 503, error: 'ai_unavailable' });
  assert.deepEqual(aiFailure(new GeminiError(429, 'rate limited')), { code: 429, error: 'ai_busy' });
  assert.deepEqual(aiFailure(new BudgetError('clínica')), { code: 429, error: 'ai_budget' });
  assert.deepEqual(aiFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })), { code: 504, error: 'ai_timeout' });
  assert.equal(aiFailure(new Error('falha de banco')), null);
});

test('rota /sara/chat: sem crédito responde 503 ai_unavailable (não 500) e não vaza a causa', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 400, message: 'billing not enabled', status: 'FAILED_PRECONDITION' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const r = await t.call('POST', '/sara/chat', { token: owner, body: { message: 'oi' } });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: 'ai_unavailable' });
    assert.equal((await t.call('POST', '/sara/test', { token: owner })).status, 503);
  } finally { globalThis.fetch = real; }
});

test('o proprietário pode cadastrar outro proprietário; gerente não cadastra ninguém', async () => {
  const novo = await t.call('POST', '/team', { token: owner, body: { name: 'Sócio Teste', email: 'socio@demo.test', password: PW, role: 'owner' } });
  assert.equal(novo.status, 201); assert.equal(novo.json.role, 'owner');
  const socio = await login('socio@demo.test');
  assert.equal(socio.status, 200);
  assert.equal((await t.call('GET', '/team', { token: socio.json.token })).status, 200, 'o novo dono gerencia a equipe');
  await t.call('POST', '/team', { token: owner, body: { name: 'Gerente Teste', email: 'ger@demo.test', password: PW, role: 'manager' } });
  const ger = await login('ger@demo.test');
  assert.equal((await t.call('POST', '/team', { token: ger.json.token, body: { name: 'Xis Ypsilon', email: 'xy@demo.test', password: PW, role: 'owner' } })).status, 403);
});
