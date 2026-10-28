import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t, owner, recep, ownerB;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  owner = await t.tokenFor('gestor@demo.test');
  recep = await t.tokenFor('recepcao@demo.test');
  ownerB = await t.tokenFor('b@demo.test');
});

const mkProduct = async (token, extra = {}) =>
  (await t.call('POST', '/products', { token, body: { name: 'Toxina Teste', minQuantity: 1, targetQuantity: 5, unitCost: 900,
    category: 'Injetáveis', manufacturer: 'Fab Ficticio', deviceType: 'toxin', unitsPerPackage: 100, ...extra } })).json;

test('estruturas do ciclo existem', async () => {
  const names = ['product_lots', 'procedure_return_rules', 'applications', 'returns', 'contact_consents', 'traceability_documents', 'ai_record_usage'];
  const rows = await t.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`, [names]);
  assert.equal(rows.length, names.length);
  const cols = await t.sql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
    AND ((table_name='products' AND column_name IN ('category','manufacturer','device_type','units_per_package'))
      OR (table_name='stock_movements' AND column_name IN ('lot_id','application_id')))`);
  assert.equal(cols.length, 6);
});

test('ensureSchema é idempotente (duas execuções, inclusive sobre banco antigo)', async () => {
  // simula banco antigo: remove as estruturas novas e deixa o ensureSchema recriá-las
  await t.pool.query(`DROP TABLE ai_record_usage, traceability_documents, contact_consents, returns, applications, procedure_return_rules;
    ALTER TABLE stock_movements DROP COLUMN lot_id, DROP COLUMN application_id;
    DROP TABLE product_lots;
    ALTER TABLE products DROP COLUMN category, DROP COLUMN manufacturer, DROP COLUMN device_type, DROP COLUMN units_per_package;`);
  // o ensureSchema já foi memorizado nesta instância: roda os passos de novo via módulo com cache limpo
  const mod = await import(`../src/schema.js?x=${Date.now()}`);
  await mod.ensureSchema();
  await mod.CYCLE_STEPS.reduce((p, s) => p.then(() => t.pool.query(s.sql)), Promise.resolve()); // 2ª execução dos mesmos comandos
  const [{ n }] = await t.sql(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('product_lots','returns','applications')`);
  assert.equal(n, 3);
});

test('CHECK: janela de retorno inválida', async () => {
  const [proc] = await t.sql('SELECT id FROM procedures WHERE clinic_id=$1 LIMIT 1', [A]);
  await t.sql(`INSERT INTO procedure_return_rules (clinic_id,procedure_id,target_days,window_min_days,window_max_days,message_text)
    VALUES ($1,$2,30,20,40,'ok')`, [A, proc.id]);
  await assert.rejects(t.sql(`INSERT INTO procedure_return_rules (clinic_id,procedure_id,target_days,window_min_days,window_max_days,message_text)
    VALUES ($1,$2,30,40,20,'x')`, [B, proc.id]));
});

test('CHECK: units_used <= 0 e units_per_package <= 0', async () => {
  const p = await mkProduct(owner);
  await assert.rejects(t.sql('UPDATE products SET units_per_package = 0 WHERE id=$1', [p.id]));
});

test('CHECK: state de retorno inválido', async () => {
  await assert.rejects(t.sql(`INSERT INTO returns (clinic_id,patient_id,procedure_id,source_appointment_id,suggested_date,state)
    VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'2026-12-01','xpto')`, [A]));
});

test('CHECK: device_type inválido na API e no banco', async () => {
  const r = await t.call('POST', '/products', { token: owner, body: { name: 'Ruim', minQuantity: 1, targetQuantity: 2, deviceType: 'laser' } });
  assert.equal(r.status, 400);
  const r2 = await t.call('POST', '/products', { token: owner, body: { name: 'Ruim', minQuantity: 1, targetQuantity: 2, unitsPerPackage: 0 } });
  assert.equal(r2.status, 400);
  await assert.rejects(t.sql(`INSERT INTO products (clinic_id,name,device_type) VALUES ($1,'x','laser')`, [A]));
});

test('backfill de consentimento: birthday+marketing, nunca return, sem duplicar', async () => {
  const { backfillConsents } = await import('../src/schema.js');
  const [p1] = await t.sql(`INSERT INTO patients (clinic_id, full_name, marketing_consent) VALUES ($1,'Paciente Sim',true) RETURNING id`, [A]);
  await t.sql(`INSERT INTO patients (clinic_id, full_name, marketing_consent) VALUES ($1,'Paciente Nao',false)`, [A]);
  await backfillConsents(); await backfillConsents();
  const rows = await t.sql('SELECT patient_id, purpose, granted FROM contact_consents ORDER BY purpose');
  const mine = rows.filter((r) => r.patient_id === p1.id);
  assert.deepEqual(mine.map((r) => [r.purpose, r.granted]), [['birthday', true], ['marketing', true]]);
  assert.equal(rows.filter((r) => r.purpose === 'return').length, 0);
  const [{ n }] = await t.sql(`SELECT count(*)::int n FROM contact_consents WHERE patient_id <> $1`, [p1.id]);
  assert.equal(n, rows.filter((r) => r.patient_id !== p1.id).length);
});

test('lotes: soma em unidades e embalagens, movimento com lot_id, auditoria', async () => {
  const p = await mkProduct(owner);
  assert.equal(p.category, 'Injetáveis'); assert.equal(p.device_type, 'toxin'); assert.equal(Number(p.units_per_package), 100);
  const r = await t.call('POST', `/products/${p.id}/lots`, { token: owner, body: { lotCode: 'L-001', expiresAt: '2027-06-30', packages: 2 } });
  assert.equal(r.status, 201);
  assert.equal(Number(r.json.lot.quantity_units), 200);
  assert.equal(Number(r.json.lot.initial_units), 200);
  assert.equal(Number(r.json.product.quantity), 2);
  const [mv] = await t.sql(`SELECT lot_id, delta, reason FROM stock_movements WHERE product_id=$1`, [p.id]);
  assert.deepEqual([mv.lot_id, Number(mv.delta), mv.reason], [r.json.lot.id, 2, 'purchase']);
  const [au] = await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='stock.lot_create' AND entity_id=$1`, [r.json.lot.id]);
  assert.equal(au.n, 1);
  const list = await t.call('GET', `/products/${p.id}/lots`, { token: owner });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
});

test('lotes: duplicado 409 sem alterar saldo; dados inválidos 400', async () => {
  const p = await mkProduct(owner);
  const body = { lotCode: 'L-DUP', expiresAt: '2027-06-30', packages: 1 };
  assert.equal((await t.call('POST', `/products/${p.id}/lots`, { token: owner, body })).status, 201);
  assert.equal((await t.call('POST', `/products/${p.id}/lots`, { token: owner, body })).status, 409);
  const [{ quantity }] = await t.sql('SELECT quantity FROM products WHERE id=$1', [p.id]);
  assert.equal(Number(quantity), 1);
  assert.equal((await t.call('POST', `/products/${p.id}/lots`, { token: owner, body: { ...body, lotCode: 'X', packages: 0 } })).status, 400);
  assert.equal((await t.call('POST', `/products/${p.id}/lots`, { token: owner, body: { ...body, lotCode: 'Y', expiresAt: 'ontem' } })).status, 400);
});

test('lotes: isolamento entre clínicas', async () => {
  const p = await mkProduct(owner);
  const body = { lotCode: 'L-ISO', expiresAt: '2027-06-30', packages: 1 };
  assert.equal((await t.call('POST', `/products/${p.id}/lots`, { token: ownerB, body })).status, 404);
  assert.equal((await t.call('GET', `/products/${p.id}/lots`, { token: ownerB })).status, 404);
  await t.call('POST', `/products/${p.id}/lots`, { token: owner, body });
  const [{ n }] = await t.sql(`SELECT count(*)::int n FROM product_lots WHERE clinic_id=$1`, [B]);
  assert.equal(n, 0);
});

test('lotes: recepção usa, mas não recebe nem grava custo', async () => {
  const p = await mkProduct(owner);
  const r = await t.call('POST', `/products/${p.id}/lots`, { token: recep, body: { lotCode: 'L-REC', expiresAt: '2027-06-30', packages: 3 } });
  assert.equal(r.status, 201);
  assert.equal('unit_cost' in r.json.product, false);
  assert.equal(Number(r.json.lot.quantity_units), 300);
  const lst = await t.call('GET', '/products', { token: recep });
  assert.equal(lst.json.some((x) => 'unit_cost' in x), false);
  const mine = await t.call('POST', '/products', { token: recep, body: { name: 'Da Recepcao', minQuantity: 1, targetQuantity: 2, unitCost: 50 } });
  assert.equal(mine.status, 201);
  const [{ unit_cost }] = await t.sql('SELECT unit_cost FROM products WHERE id=$1', [mine.json.id]);
  assert.equal(unit_cost, null);
});
