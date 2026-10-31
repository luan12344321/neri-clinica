import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

// Regressões da auditoria de segurança (.security-audit/2026-10-30-0943): cada teste falha se a correção for desfeita.
let t, tokenB, owner, reception;
const procA = '10000000-0000-0000-0000-000000000001';
const patientB = '2b000000-0000-0000-0000-000000000001';
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  [tokenB, owner, reception] = await Promise.all(['b@demo.test', 'gestor@demo.test', 'recepcao@demo.test'].map((e) => t.tokenFor(e)));
});

test('agendamento não aceita procedimento ou profissional de outra clínica (A-01)', async () => {
  const [userA] = await t.sql('SELECT id FROM users WHERE clinic_id=$1 LIMIT 1', [A]);
  const slot = { patientId: patientB, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' };
  const proc = await t.call('POST', '/appointments', { token: tokenB, body: { ...slot, procedureId: procA } });
  assert.deepEqual([proc.status, proc.json.error], [404, 'procedure not found']);
  const prof = await t.call('POST', '/appointments', { token: tokenB, body: { ...slot, professionalId: userA.id } });
  assert.deepEqual([prof.status, prof.json.error], [404, 'professional not found']);
  assert.equal((await t.sql('SELECT count(*)::int n FROM appointments WHERE clinic_id=$1', [B]))[0].n, 0);
  assert.equal((await t.call('POST', '/appointments', { token: tokenB, body: slot })).status, 201, 'sem ids estrangeiros continua funcionando');
});

test('protocolo e regra de retorno não apontam para procedimento de outra clínica (A-03)', async () => {
  const proto = await t.call('POST', '/protocols', { token: tokenB, body: { name: 'Protocolo', instructions: 'xx', procedureId: procA } });
  assert.equal(proto.status, 404);
  const [tpl] = await t.sql(`INSERT INTO message_templates (clinic_id, kind, body) VALUES ($1,'followup','Olá, tudo bem?') RETURNING id`, [B]);
  const rule = await t.call('POST', '/automation/followup-rules', { token: tokenB, body: { daysAfter: 1, templateId: tpl.id, procedureId: procA } });
  assert.equal(rule.status, 404);
});

test('agendamento com fim antes do início é recusado ao criar e ao remarcar (A-10)', async () => {
  const bad = await t.call('POST', '/appointments', { token: tokenB,
    body: { patientId: patientB, startsAt: '2030-01-01T11:00:00Z', endsAt: '2030-01-01T10:00:00Z' } });
  assert.equal(bad.status, 400);
  const ok = await t.call('POST', '/appointments', { token: tokenB,
    body: { patientId: patientB, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' } });
  const moved = await t.call('PATCH', `/appointments/${ok.json.id}`, { token: tokenB,
    body: { startsAt: '2030-01-02T11:00:00Z', endsAt: '2030-01-02T10:00:00Z' } });
  assert.equal(moved.status, 400);
});

test('remover alguém da equipe desliga a Agenda Google dele (A-02/C-02)', async () => {
  const [u] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  await t.sql(`UPDATE users SET google_refresh_token_enc='v1:x', google_sync_token='s' WHERE id=$1`, [u.id]);
  assert.equal((await t.call('DELETE', `/team/${u.id}`, { token: owner })).status, 204);
  const [after] = await t.sql('SELECT google_refresh_token_enc, google_sync_token FROM users WHERE id=$1', [u.id]);
  assert.deepEqual([after.google_refresh_token_enc, after.google_sync_token], [null, null]);
});

test('painel: quem não é gestor não vê faturamento por procedimento (A-07)', async () => {
  const d = (await t.call('GET', '/dashboard', { token: reception })).json;
  assert.ok(d.topProcedures.every((p) => !('revenue' in p)));
});

test('busca de pacientes recusa termo gigante (B-08)', async () => {
  assert.equal((await t.call('GET', `/patients?search=${'a'.repeat(81)}`, { token: owner })).status, 400);
  assert.equal((await t.call('GET', '/patients?search=Mar', { token: owner })).status, 200);
});

test('webhook do WhatsApp com muitos números distintos é recusado antes de consultar o banco (B-03)', async () => {
  const changes = Array.from({ length: 50 }, (_, i) => ({ value: { metadata: { phone_number_id: `fake${i}` }, messages: [{ id: `m${i}`, from: '1' }] } }));
  const res = await t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes }] }) });
  assert.equal(res.statusCode, 400);
});

test('reativar alguém removido não religa a Agenda Google antiga (V-05)', async () => {
  const [u] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  await t.sql(`UPDATE users SET password_hash='!', google_refresh_token_enc='v1:x' WHERE id=$1`, [u.id]);
  assert.equal((await t.call('PATCH', `/team/${u.id}`, { token: owner, body: { password: 'nova-senha-123' } })).status, 200);
  assert.equal((await t.sql('SELECT google_refresh_token_enc FROM users WHERE id=$1', [u.id]))[0].google_refresh_token_enc, null);
});

test('webhook do WhatsApp com corpo malformado não quebra (V-08)', async () => {
  const res = await t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [null] }] }) });
  assert.equal(res.statusCode, 200);
});

test('agenda: duração do atendimento tem teto (V-07)', async () => {
  const long = await t.call('POST', '/appointments', { token: tokenB,
    body: { patientId: patientB, startsAt: '2030-01-01T10:00:00Z', endsAt: '2031-01-01T10:00:00Z' } });
  assert.equal(long.status, 400);
});

// QA Security 2026-10-30 (.qa/agents/security.md S-01): token preso à senha atual.
test('trocar ou redefinir a senha derruba as sessões antigas; token sem a marca da senha não autentica (S-01)', async () => {
  const login = async (email, password) => (await t.call('POST', '/auth/login', { body: { email, password } })).json.token;
  const old1 = await login('gestor@demo.test', 'demo1234');
  const old2 = await login('gestor@demo.test', 'demo1234');
  const ch = await t.call('POST', '/me/password', { token: old1, body: { current: 'demo1234', next: 'nova-senha-123' } });
  assert.equal(ch.status, 200);
  assert.equal((await t.call('GET', '/me', { token: old2 })).status, 401, 'outra sessão aberta com a senha antiga cai');
  assert.equal((await t.call('GET', '/me', { token: old1 })).status, 401, 'o token antigo desta sessão também cai');
  assert.equal((await t.call('GET', '/me', { token: ch.json.token })).status, 200, 'o token novo devolvido continua a sessão');

  const recTok = await login('recepcao@demo.test', 'demo1234');
  const [rec] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  const reset = await t.call('PATCH', `/team/${rec.id}`, { token: ch.json.token, body: { password: 'redefinida-123' } });
  assert.equal(reset.status, 200);
  assert.equal((await t.call('GET', '/me', { token: recTok })).status, 401, 'senha redefinida pelo dono derruba a sessão do funcionário');

  const [u] = await t.sql(`SELECT id, clinic_id, role FROM users WHERE email='b@demo.test'`);
  const legacy = t.app.jwt.sign({ userId: u.id, clinicId: u.clinic_id, role: u.role }, { expiresIn: '1h' });
  assert.equal((await t.call('GET', '/me', { token: legacy })).status, 401, 'token sem marca (formato antigo/forjado sem senha) é recusado');
  assert.equal((await t.call('GET', '/me', { token: tokenB })).status, 200);
});

test('recepção não define preço do atendimento: vale o preço do procedimento; dono pode ajustar (S-04)', async () => {
  const [{ default_price: dp }] = await t.sql('SELECT default_price FROM procedures WHERE id=$1', [procA]);
  const patientA = (await t.sql('SELECT id FROM patients WHERE clinic_id=$1 LIMIT 1', [A]))[0].id;
  const body = (h) => ({ patientId: patientA, procedureId: procA, startsAt: `2031-01-0${h}T10:00:00Z`, endsAt: `2031-01-0${h}T11:00:00Z`, price: 1 });
  const rec = await t.call('POST', '/appointments', { token: reception, body: body(1) });
  assert.equal(rec.status, 201);
  assert.equal(Number(rec.json.price), Number(dp), 'preço enviado pela recepção é ignorado');
  const own = await t.call('POST', '/appointments', { token: owner, body: body(2) });
  assert.equal(Number(own.json.price), 1, 'dono continua podendo dar desconto');
});

test('busca de paciente ignora acento e maiúsculas e trata % e _ como texto (F-04)', async () => {
  await t.sql(`INSERT INTO patients (clinic_id, full_name) VALUES ($1, 'Mariana Fictícia'), ($1, 'João_100%')`, [A]);
  const find = async (s) => (await t.call('GET', `/patients?search=${encodeURIComponent(s)}`, { token: reception })).json.map((p) => p.full_name);
  assert.ok((await find('mariana ficticia')).includes('Mariana Fictícia'));
  assert.ok((await find('FICTÍCIA')).includes('Mariana Fictícia'));
  assert.deepEqual(await find('_100%'), ['João_100%'], 'curinga digitado não vira "qualquer coisa"');
  assert.deepEqual(await find('%'), ['João_100%'], '% só acha quem tem % no nome');
  assert.ok(!(await t.call('GET', '/patients?search=Paciente%20B', { token: reception })).json.length, 'paciente da clínica B não aparece');
});

test('saldo do resumo financeiro sai em centavos exatos (F-05)', async () => {
  const { getFinanceSummary } = await import('../src/queries.js');
  await t.sql(`INSERT INTO transactions (clinic_id, type, description, amount, competence_date, due_date, status) VALUES
    ($1,'income','a',2383.33,'2031-05-10','2031-05-10','paid'), ($1,'expense','b',2500,'2031-05-11','2031-05-11','paid')`, [A]);
  assert.equal((await getFinanceSummary(A, '2031-05-01')).balance, -116.67);
});

test('cota do rate limit é por usuário logado; token forjado ou ausente cai no IP (L-06)', async () => {
  const { rateKey } = await import('../src/app.js');
  const [u] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  const req = (authorization) => ({ ip: '9.9.9.9', headers: authorization ? { authorization } : {} });
  assert.equal(rateKey(req(`Bearer ${reception}`)), `u:${u.id}`);
  const forged = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ userId: 'x', clinicId: A })).toString('base64url') + '.assinatura';
  assert.equal(rateKey(req(`Bearer ${forged}`)), '9.9.9.9', 'sem assinatura válida não escolhe a própria cota');
  assert.equal(rateKey(req(`Bearer ${t.app.jwt.sign({ userId: 'x', purpose: 'google-oauth' })}`)), '9.9.9.9', 'token de OAuth state não vale');
  assert.equal(rateKey(req()), '9.9.9.9');
});
