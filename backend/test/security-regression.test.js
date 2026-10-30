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
