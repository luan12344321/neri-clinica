import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, A } from './helpers.js';

// Regressão da rota rápida POST /appointments/:id/complete em todos os perfis (rodada final, item C).
// Regra estabelecida (QA anterior + PLANO): qualquer perfil da clínica fecha o atendimento para cobrança; só os perfis clínicos
// baixam estoque (POST /conclude). A rota rápida nunca mexe em estoque e deixa trilha própria.
let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role)
    SELECT $1, 'Profissional', 'prof@demo.test', password_hash, 'professional' FROM users WHERE email='gestor@demo.test'`, [A]);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role)
    SELECT $1, 'Gerente', 'gerente@demo.test', password_hash, 'manager' FROM users WHERE email='gestor@demo.test'`, [A]);
});

const fresh = async () => {
  const id = randomUUID();
  await t.sql(`INSERT INTO appointments (id, clinic_id, patient_id, procedure_id, starts_at, ends_at, status, price)
    SELECT $2, clinic_id, patient_id, procedure_id, now(), now() + interval '1 hour', 'scheduled', 500 FROM appointments WHERE clinic_id=$1 LIMIT 1`, [A, id]);
  return id;
};
const emails = { owner: 'gestor@demo.test', manager: 'gerente@demo.test', professional: 'prof@demo.test', reception: 'recepcao@demo.test' };

for (const [role, email] of Object.entries(emails)) {
  test(`/complete (${role}): fecha, gera 1 receita, audita, não mexe em estoque`, async () => {
    const id = await fresh();
    const [{ q: before }] = await t.sql(`SELECT sum(quantity)::float q FROM products WHERE clinic_id=$1`, [A]);
    const r = await t.call('POST', `/appointments/${id}/complete`, { token: await t.tokenFor(email) });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'done');
    assert.deepEqual((await t.sql('SELECT amount::float a, type, status FROM transactions WHERE appointment_id=$1', [id])), [{ a: 500, type: 'income', status: 'pending' }]);
    assert.equal((await t.sql('SELECT count(*)::int n FROM stock_movements WHERE appointment_id=$1', [id]))[0].n, 0);
    assert.equal((await t.sql('SELECT count(*)::int n FROM applications WHERE appointment_id=$1', [id]))[0].n, 0);
    assert.equal((await t.sql(`SELECT sum(quantity)::float q FROM products WHERE clinic_id=$1`, [A]))[0].q, before);
    const [log] = await t.sql(`SELECT user_id, action FROM audit_log WHERE entity_id=$1 AND action='appointment.complete_quick'`, [id]);
    assert.equal(log.user_id, (await t.sql('SELECT id FROM users WHERE email=$1', [email]))[0].id, 'trilha identifica quem fechou');
    // segunda chamada: 409, sem receita nem auditoria duplicadas
    assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token: await t.tokenFor(email) })).status, 409);
    assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 1);
    assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='appointment.complete_quick'`, [id]))[0].n, 1);
  });
}

test('/conclude continua só para perfis clínicos; recepção não baixa estoque por nenhum caminho', async () => {
  const id = await fresh();
  const rec = await t.tokenFor(emails.reception);
  assert.equal((await t.call('POST', `/appointments/${id}/conclude`, { token: rec, body: { confirmed: true, applications: [] } })).status, 403);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled', '403 não fecha nada');
  assert.equal((await t.call('POST', `/appointments/${id}/conclude`, { token: await t.tokenFor(emails.professional), body: { confirmed: true, applications: [] } })).status, 200);
});

test('/complete: sem login 401, id inválido 400, outra clínica 409 sem tocar no atendimento, cancelado 409', async () => {
  const id = await fresh();
  assert.equal((await t.call('POST', `/appointments/${id}/complete`)).status, 401);
  assert.equal((await t.call('POST', '/appointments/xyz/complete', { token: await t.tokenFor(emails.owner) })).status, 400);
  assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token: await t.tokenFor('b@demo.test') })).status, 409);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  await t.sql(`UPDATE appointments SET status='canceled' WHERE id=$1`, [id]);
  assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token: await t.tokenFor(emails.owner) })).status, 409);
  assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 0);
});

test('/complete e /conclude concorrentes no mesmo atendimento: só um vence, uma receita só', async () => {
  const id = await fresh();
  const [a, b] = await Promise.all([
    t.call('POST', `/appointments/${id}/complete`, { token: await t.tokenFor(emails.owner) }),
    t.call('POST', `/appointments/${id}/conclude`, { token: await t.tokenFor(emails.owner), body: { confirmed: true, applications: [] } })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 1);
});
