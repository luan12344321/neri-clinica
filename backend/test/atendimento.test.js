import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, A, B } from './helpers.js';
import { decrypt } from '../src/crypto.js';

let t, owner, pro, manager, reception;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  const hash = bcrypt.hashSync('demo1234', 4);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES
    ($1,'Doutora','dra@demo.test',$2,'professional'), ($1,'Gerente','gerente@demo.test',$2,'manager')`, [A, hash]);
  owner = await t.tokenFor('gestor@demo.test');
  pro = await t.tokenFor('dra@demo.test');
  manager = await t.tokenFor('gerente@demo.test');
  reception = await t.tokenFor('recepcao@demo.test');
});

const TOXINA = '40000000-0000-0000-0000-000000000001';
const BOTOX = '10000000-0000-0000-0000-000000000001';
const futuro = "(now() + interval '200 days')::date";
const passado = "(now() - interval '5 days')::date";

// Toxina de 100 U por frasco, custo R$ 500/frasco (R$ 5/U); lote de 1 frasco = 100 U.
async function prep({ expires = futuro, units = 100, cost = 500 } = {}) {
  await t.sql(`UPDATE products SET units_per_package=100, unit_cost=$2, quantity=1, device_type='toxin' WHERE id=$1`, [TOXINA, cost]);
  const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'L1',${expires},$3,$3) RETURNING id`, [A, TOXINA, units]);
  return lot.id;
}
const appt = async () => (await t.sql(`SELECT id FROM appointments WHERE clinic_id=$1 AND status='scheduled'`, [A]))[0].id;
const newAppt = async (patient = '20000000-0000-0000-0000-000000000003') =>
  (await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
    VALUES ($1,$2,$3, now(), now() + interval '1 hour', 1200) RETURNING id`, [A, patient, BOTOX]))[0].id;
const conclude = (id, token, applications, confirmed = true) =>
  t.call('POST', `/appointments/${id}/conclude`, { token, body: { confirmed, applications } });
const lotUnits = async (id) => (await t.sql('SELECT quantity_units::float u FROM product_lots WHERE id=$1', [id]))[0].u;
const prodQty = async () => (await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [TOXINA]))[0].q;
const n = async (table) => (await t.sql(`SELECT count(*)::int n FROM ${table}`))[0].n;

test('conclusão feliz: baixa lote e produto, grava aplicação, movimento, receita e auditoria', async () => {
  const lot = await prep();
  const id = await appt();
  const r = await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 40 }]);
  assert.equal(r.status, 200);
  assert.equal(r.json.appointment.status, 'done');
  assert.equal(r.json.applications.length, 1);
  assert.equal(r.json.applications[0].lot.code, 'L1');
  assert.equal(r.json.applications[0].cost, 200);
  assert.equal(r.json.totalCost, 200);
  assert.deepEqual(r.json.margin, { value: 1000, pct: 83.33 });
  assert.equal(r.json.returnSuggested, null);
  assert.equal(r.json.traceability, null);
  assert.equal(await lotUnits(lot), 60);
  assert.equal(await prodQty(), 0.6);
  const [ap] = await t.sql('SELECT units_used::float u, unit_cost::float uc, cost::float c, lot_id FROM applications');
  assert.deepEqual([ap.u, ap.uc, ap.c, ap.lot_id], [40, 5, 200, lot]);
  const [m] = await t.sql(`SELECT delta::float d, reason, lot_id, application_id, appointment_id FROM stock_movements WHERE reason='usage'`);
  assert.deepEqual([m.d, m.reason, m.lot_id, m.appointment_id], [-0.4, 'usage', lot, id]);
  assert.equal(m.application_id, r.json.applications[0].id);
  assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 1);
  const acts = (await t.sql(`SELECT action FROM audit_log WHERE action IN ('application.create','appointment.complete_confirmed')`)).map((x) => x.action).sort();
  assert.deepEqual(acts, ['application.create', 'appointment.complete_confirmed']);
});

test('sem confirmed:true nada muda (400)', async () => {
  const lot = await prep();
  const id = await appt();
  assert.equal((await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 10 }], false)).status, 400);
  assert.equal((await t.call('POST', `/appointments/${id}/conclude`, { token: owner, body: { applications: [] } })).status, 400);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  assert.equal(await lotUnits(lot), 100);
  assert.equal(await n('applications'), 0);
  assert.equal(await n('stock_movements'), 0);
});

test('lote vencido: 409 lot_expired, bloqueado no contexto e nada gravado', async () => {
  const lot = await prep({ expires: passado });
  const id = await appt();
  const ctx = await t.call('GET', `/appointments/${id}/conclusion-context`, { token: owner });
  assert.equal(ctx.json.products.find((p) => p.id === TOXINA).lots[0].blocked, true);
  const r = await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 10 }]);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'lot_expired');
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  assert.equal(await lotUnits(lot), 100);
});

test('saldo insuficiente: ROLLBACK total (status, receita, outras linhas)', async () => {
  const lot = await prep({ units: 30 });
  const id = await appt();
  const r = await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 20 }, { productId: TOXINA, lotId: lot, units: 20 }]);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'insufficient_stock');
  assert.equal((await t.sql('SELECT status, completed_at FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  assert.equal(await lotUnits(lot), 30);
  assert.equal(await prodQty(), 1);
  assert.equal(await n('applications'), 0);
  assert.equal(await n('stock_movements'), 0);
  assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 0);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action LIKE 'application.%' OR action='appointment.complete_confirmed'`))[0].n, 0);
});

test('frasco fracionado: 3 pacientes de 100 U com custo proporcional', async () => {
  const lot = await prep({ units: 300, cost: 900 }); // R$ 9/U
  await t.sql(`UPDATE products SET quantity=3 WHERE id=$1`, [TOXINA]);
  const ids = [await appt(), await newAppt(), await newAppt('20000000-0000-0000-0000-000000000004')];
  for (const id of ids) {
    const r = await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 33.33 }]);
    assert.equal(r.status, 200);
    assert.equal(r.json.applications[0].cost, 299.97);
  }
  assert.equal(Math.round((await lotUnits(lot)) * 100) / 100, 200.01); // 300 − 3 × 33,33
  assert.equal(Math.round((await prodQty()) * 100) / 100, 2.01);
});

test('margem e custo só para owner/manager; professional não recebe custo nem margem', async () => {
  const lot = await prep();
  const ids = [await appt(), await newAppt(), await newAppt('20000000-0000-0000-0000-000000000004')];
  const m = await conclude(ids[0], manager, [{ productId: TOXINA, lotId: lot, units: 10 }]);
  assert.equal(m.json.totalCost, 50);
  assert.equal(m.json.margin.value, 1150);
  const p = await conclude(ids[1], pro, [{ productId: TOXINA, lotId: lot, units: 10 }]);
  assert.equal(p.status, 200);
  assert.equal('totalCost' in p.json, false);
  assert.equal('margin' in p.json, false);
  assert.equal('cost' in p.json.applications[0], false);
  assert.equal(JSON.stringify(p.json).includes('unit_cost'), false);
  const ctx = await t.call('GET', `/appointments/${ids[2]}/conclusion-context`, { token: pro });
  assert.equal(ctx.status, 200);
  assert.equal(JSON.stringify(ctx.json).includes('cost'), false);
});

test('recepção recebe 403 no contexto e na conclusão', async () => {
  const lot = await prep();
  const id = await appt();
  assert.equal((await t.call('GET', `/appointments/${id}/conclusion-context`, { token: reception })).status, 403);
  assert.equal((await conclude(id, reception, [{ productId: TOXINA, lotId: lot, units: 10 }])).status, 403);
  assert.equal((await t.call('POST', `/appointments/${id}/conclude`, { body: { confirmed: true, applications: [] } })).status, 401);
  assert.equal(await lotUnits(lot), 100);
});

test('outra clínica fica isolada: produto, lote e atendimento', async () => {
  const lot = await prep();
  const id = await appt();
  const tokenB = await t.tokenFor('b@demo.test');
  assert.equal((await t.call('GET', `/appointments/${id}/conclusion-context`, { token: tokenB })).status, 404);
  assert.equal((await conclude(id, tokenB, [])).status, 404); // atendimento de A, visto de B (404: nunca vaza; antes era 409)
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  // produto/lote de outra clínica usados por A
  const [pB] = await t.sql(`INSERT INTO products (clinic_id, name, quantity) VALUES ($1,'Produto B',5) RETURNING id`, [B]);
  const [lB] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'LB',${futuro},10,10) RETURNING id`, [B, pB.id]);
  assert.equal((await conclude(id, owner, [{ productId: pB.id, units: 1 }])).status, 404);
  assert.equal((await conclude(id, owner, [{ productId: TOXINA, lotId: lB.id, units: 1 }])).status, 404);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');
  assert.equal(await lotUnits(lot), 100);
  assert.equal(await lotUnits(lB.id), 10);
});

test('reconclusão dá 409 e não baixa de novo', async () => {
  const lot = await prep();
  const id = await appt();
  assert.equal((await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 10 }])).status, 200);
  assert.equal((await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 10 }])).status, 409);
  assert.equal(await lotUnits(lot), 90);
  assert.equal(await n('applications'), 1);
  assert.equal((await t.sql('SELECT count(*)::int n FROM transactions WHERE appointment_id=$1', [id]))[0].n, 1);
});

test('aplicação sem lote: baixa só o produto e fica com lot_id nulo', async () => {
  const lot = await prep();
  const id = await appt();
  const r = await conclude(id, owner, [{ productId: TOXINA, units: 25 }]);
  assert.equal(r.status, 200);
  assert.equal(r.json.applications[0].lot, null);
  assert.equal(await lotUnits(lot), 100);
  assert.equal(await prodQty(), 0.75);
  const [ap] = await t.sql('SELECT lot_id FROM applications');
  assert.equal(ap.lot_id, null);
});

test('foto da etiqueta: cifrada no banco; acima de 400 KB dá 413', async () => {
  const lot = await prep();
  const id = await appt();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('ETIQUETA-SECRETA-123')]).toString('base64');
  const r = await conclude(id, owner, [{ productId: TOXINA, lotId: lot, units: 10, labelPhoto: `data:image/jpeg;base64,${jpeg}` }]);
  assert.equal(r.status, 200);
  const [row] = await t.sql('SELECT id, label_photo_enc FROM applications');
  assert.ok(row.label_photo_enc.startsWith('v1:'));
  assert.equal(row.label_photo_enc.includes(jpeg), false);
  assert.equal(Buffer.from(decrypt(row.label_photo_enc, `applications.label:${row.id}`), 'base64').includes('ETIQUETA-SECRETA-123'), true);

  const id2 = await newAppt();
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(420 * 1024, 1)]).toString('base64');
  const r2 = await conclude(id2, owner, [{ productId: TOXINA, lotId: lot, units: 10, labelPhoto: big }]);
  assert.equal(r2.status, 413);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id2]))[0].status, 'scheduled');
  assert.equal(await lotUnits(lot), 90);
});

test('contexto: sugestão do protocolo em unidades, FEFO e regra de retorno', async () => {
  await prep();
  await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'L0',(now() + interval '30 days')::date,50,50)`, [A, TOXINA]);
  await t.sql(`INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text)
    VALUES ($1,$2,120,90,150,'Hora de avaliar')`, [A, BOTOX]);
  const id = await appt();
  const r = await t.call('GET', `/appointments/${id}/conclusion-context`, { token: owner });
  assert.equal(r.status, 200);
  assert.equal(r.json.suggestions[0].units, 50); // 0,5 frasco × 100 U
  assert.deepEqual(r.json.products.find((p) => p.id === TOXINA).lots.map((l) => l.code), ['L0', 'L1']); // FEFO
  assert.equal(r.json.returnRule.targetDays, 120);
  assert.equal(r.json.patient.name.length > 0, true);
});

test('o complete antigo não baixa mais estoque', async () => {
  await prep();
  const id = await appt();
  assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token: owner })).status, 200);
  assert.equal(await prodQty(), 1);
  assert.equal(await n('stock_movements'), 0);
});
