import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

// Testa o adaptador real do Netlify (netlify/functions/api.mjs): Request -> Fastify -> Response.
let t, handler, config;
before(async () => {
  t = await setup();
  ({ default: handler, config } = await import('../../netlify/functions/api.mjs'));
});
after(() => t.close());
beforeEach(() => t.reset());

const call = (method, path, { body, token, ip = '203.0.113.7', headers = {} } = {}) => handler(
  new Request(`https://clinica.netlify.app${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }),
  { ip });
const json = async (res) => res.json();

test('rota pública responde pelo prefixo /api', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('login pelo adaptador devolve token e o token abre rotas protegidas (com query string)', async () => {
  const login = await call('POST', '/api/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' } });
  assert.equal(login.status, 200);
  const { token } = await json(login);
  assert.equal((await call('GET', '/api/dashboard', { token })).status, 200);
  const appts = await json(await call('GET', '/api/appointments?from=2000-01-01&to=2100-01-01', { token }));
  assert.ok(appts.length > 0, 'query string preservada');
  assert.equal((await call('GET', '/api/dashboard')).status, 401);
});

test('o IP real do cliente (context.ip) vai para a auditoria', async () => {
  await call('POST', '/api/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' }, ip: '203.0.113.77' });
  const [row] = await t.sql(`SELECT ip FROM audit_log WHERE action='auth.login'`);
  assert.equal(row.ip, '203.0.113.77');
});

test('erros: 400 de validação, 404 de rota inexistente e corpo POST chegam íntegros', async () => {
  const bad = await call('POST', '/api/auth/login', { body: { email: 'nao-e-email' } });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).error, 'validation');
  assert.equal((await call('GET', '/api/nao-existe')).status, 404);
  const token = await t.tokenFor('gestor@demo.test');
  const created = await call('POST', '/api/procedures', { token, body: { name: 'Via Netlify', defaultPrice: 99.5 } });
  assert.equal(created.status, 201);
  assert.equal((await json(created)).name, 'Via Netlify');
});

test('sem CORS liberado e com a configuração de rota/limite esperada pelo Netlify', async () => {
  const res = await call('GET', '/api/health', { headers: { origin: 'https://site-malicioso.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(config.path, '/api/*');
  assert.equal(config.rateLimit.aggregateBy.includes('ip'), true);
});

test('a função agendada exporta cron e roda o job único', async () => {
  const jobs = await import('../../netlify/functions/jobs.mjs');
  assert.match(jobs.config.schedule, /^(\*\/\d+ \* \* \* \*|@hourly)$/);
  const res = await jobs.default();
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(Object.values(out).every((v) => v === 'ok'), JSON.stringify(out));
});
