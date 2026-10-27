import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

// Isolamento entre clínicas: o gestor da clínica B nunca vê nem altera dados da clínica A.
let t, tokenB, apptA, txPendingA, productA, templateA, patientA;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  tokenB = await t.tokenFor('b@demo.test');
  apptA = (await t.sql(`SELECT id FROM appointments WHERE clinic_id=$1 AND status='scheduled'`, [A]))[0].id;
  txPendingA = (await t.sql(`SELECT id FROM transactions WHERE clinic_id=$1 AND status='pending'`, [A]))[0].id;
  productA = '40000000-0000-0000-0000-000000000001';
  templateA = '60000000-0000-0000-0000-000000000002';
  patientA = '20000000-0000-0000-0000-000000000001';
});

const untouchedA = async () => {
  const [a] = await t.sql('SELECT status FROM appointments WHERE id=$1', [apptA]);
  const [tx] = await t.sql('SELECT status FROM transactions WHERE id=$1', [txPendingA]);
  const [p] = await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [productA]);
  assert.equal(a.status, 'scheduled'); assert.equal(tx.status, 'pending'); assert.equal(p.q, 1);
};

test('leituras só devolvem dados da própria clínica', async () => {
  const patients = (await t.call('GET', '/patients', { token: tokenB })).json;
  assert.deepEqual(patients.map((p) => p.full_name), ['Paciente B']);
  const appts = (await t.call('GET', '/appointments?from=2000-01-01&to=2100-01-01', { token: tokenB })).json;
  assert.equal(appts.length, 0);
  assert.equal((await t.call('GET', '/products', { token: tokenB })).json.length, 0);
  assert.equal((await t.call('GET', '/procedures', { token: tokenB })).json.length, 0);
  assert.equal((await t.call('GET', '/finance/payables', { token: tokenB })).json.length, 0);
  assert.equal((await t.call('GET', '/stock/restock', { token: tokenB })).json.length, 0);
  const dash = (await t.call('GET', '/dashboard', { token: tokenB })).json;
  assert.deepEqual([dash.today, dash.revenueByMonth, dash.topProcedures], [[], [], []]);
});

test('não conclui, reagenda ou cancela agendamento de outra clínica', async () => {
  assert.equal((await t.call('POST', `/appointments/${apptA}/complete`, { token: tokenB })).status, 409);
  assert.equal((await t.call('PATCH', `/appointments/${apptA}`, { token: tokenB, body: { status: 'canceled' } })).status, 404);
  await untouchedA();
});

test('não baixa conta nem mexe em estoque de outra clínica', async () => {
  assert.equal((await t.call('POST', `/finance/transactions/${txPendingA}/pay`, { token: tokenB })).status, 404);
  const mv = await t.call('POST', `/products/${productA}/movements`, { token: tokenB, body: { delta: 100, reason: 'purchase' } });
  assert.equal(mv.status, 409);
  await untouchedA();
});

test('não referencia paciente, produto, categoria ou modelo de outra clínica', async () => {
  const appt = await t.call('POST', '/appointments', { token: tokenB,
    body: { patientId: patientA, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' } });
  assert.equal(appt.status, 404);
  const proto = await t.call('POST', '/protocols', { token: tokenB,
    body: { name: 'Protocolo', instructions: 'xx', items: [{ productId: productA, quantity: 1 }] } });
  assert.equal(proto.status, 404);
  const tx = await t.call('POST', '/finance/transactions', { token: tokenB, body: { type: 'expense',
    categoryId: '30000000-0000-0000-0000-000000000003', description: 'Despesa', amount: 10, competenceDate: '2030-01-01', dueDate: '2030-01-01' } });
  assert.equal(tx.status, 404);
  const rule = await t.call('POST', '/automation/followup-rules', { token: tokenB, body: { daysAfter: 1, templateId: templateA } });
  assert.equal(rule.status, 404);
  // nada vazou para a clínica B
  assert.equal((await t.sql('SELECT count(*)::int n FROM appointments WHERE clinic_id=$1', [(await t.sql(`SELECT id FROM clinics WHERE name='Clínica B'`))[0].id]))[0].n, 0);
});

test('cada clínica vê o próprio financeiro, sem somar com a outra', async () => {
  const month = (await t.sql(`SELECT to_char(now(),'YYYY-MM') m`))[0].m;
  const b = (await t.call('GET', `/finance/summary?month=${month}`, { token: tokenB })).json;
  assert.deepEqual([b.income, b.expense, b.proceduresDone], [0, 0, 0]);
  const a = (await t.call('GET', `/finance/summary?month=${month}`, { token: await t.tokenFor('gestor@demo.test') })).json;
  assert.ok(a.income > 0);
});
