import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, owner, pro, reception, ownerB, mod, appt, patient, proUser;
before(async () => { t = await setup(); mod = await import('../src/rastreabilidade.js'); });
after(() => t.close());

const LOT = 'LOTE-ZX9001';
// pdfkit grava o texto em arrays TJ com pedaços hexadecimais (kerning); reconstrói o texto de cada linha.
const textOf = (buf) => buf.toString('latin1').split(String.fromCharCode(10)).filter((l) => l.endsWith('TJ'))
  .map((l) => [...l.matchAll(/<([0-9a-f]*)>/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('')).join(' | ');
const hasText = (buf, s) => textOf(buf).includes(s);

async function seedApp(deviceType, { withApplication = true } = {}) {
  const [p] = await t.sql(`INSERT INTO products (clinic_id, name, device_type, manufacturer, unit_cost) VALUES ($1,'Preenchedor Teste',$2,'Fabricante Teste',777.77) RETURNING id`, [A, deviceType]);
  const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units) VALUES ($1,$2,$3,'2027-08-15',10,10) RETURNING id`, [A, p.id, LOT]);
  const [pt] = await t.sql(`INSERT INTO patients (clinic_id, full_name, cpf_enc) VALUES ($1,'Maria Teste','v1:xx') RETURNING id`, [A]);
  const [u] = await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`);
  const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, professional_id, starts_at, ends_at, status, completed_at) VALUES ($1,$2,$3,now(),now()+interval '1 hour','done',now()) RETURNING id`, [A, pt.id, u.id]);
  if (withApplication) await t.sql(`INSERT INTO applications (clinic_id, appointment_id, patient_id, product_id, lot_id, units_used, unit_cost, cost, created_by) VALUES ($1,$2,$3,$4,$5,2.5,300,750,$6)`, [A, ap.id, pt.id, p.id, lot.id, u.id]);
  return { appt: ap.id, patient: pt.id, user: u.id };
}

beforeEach(async () => {
  await t.reset(); await t.addExtras();
  [owner, reception, ownerB] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test', 'b@demo.test'].map((e) => t.tokenFor(e)));
  pro = owner;
});

const gen = (a) => mod.createTraceabilityDocument({ clinicId: A, appointmentId: a.appt, userId: a.user });
const pdfOf = async (id, token = owner) => t.app.inject({ method: 'GET', url: `/traceability/${id}/pdf`, headers: { authorization: `Bearer ${token}` } });

test('gera para ácido hialurônico, PDF válido com lote e validade, sem custo e sem CPF', async () => {
  const a = await seedApp('hyaluronic_acid');
  const r = await gen(a);
  assert.ok(r?.id);
  const res = await pdfOf(r.id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-disposition'], /attachment; filename="comprovante-rastreabilidade.pdf"/);
  const buf = res.rawPayload;
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  assert.ok(buf.length > 800);
  assert.ok(hasText(buf, LOT), 'lote no PDF');
  assert.ok(hasText(buf, '15/08/2027'), 'validade no PDF');
  assert.ok(hasText(buf, 'Maria Teste'));
  for (const bad of ['777', '750', 'custo', 'Custo', 'margem', 'CPF', 'v1:xx']) assert.ok(!hasText(buf, bad), `sem ${bad}`);
  const [aud] = await t.sql(`SELECT * FROM audit_log WHERE action='traceability.generate'`);
  assert.equal(aud.entity_id, r.id);
});

test('não gera para toxina nem other (devolve null)', async () => {
  for (const type of ['toxin', 'other']) {
    const a = await seedApp(type);
    assert.equal(await gen(a), null, type);
  }
  assert.equal((await t.sql('SELECT 1 FROM traceability_documents')).length, 0);
  const a = await seedApp('plla', { withApplication: false });
  assert.equal(await gen(a), null);
});

test('é idempotente: reemitir devolve o mesmo documento', async () => {
  const a = await seedApp('plla');
  const r1 = await gen(a); const r2 = await gen(a);
  assert.equal(r1.id, r2.id);
  const post = await t.call('POST', `/appointments/${a.appt}/traceability`, { token: owner });
  assert.equal(post.json.id, r1.id);
  assert.equal((await t.sql('SELECT 1 FROM traceability_documents')).length, 1);
  const l = await t.call('GET', `/appointments/${a.appt}/traceability`, { token: owner });
  assert.equal(l.json.length, 1);
  const lp = await t.call('GET', `/patients/${a.patient}/traceability`, { token: owner });
  assert.equal(lp.json[0].id, r1.id);
});

test('POST sem produto rastreável responde 404', async () => {
  const a = await seedApp('toxin');
  assert.equal((await t.call('POST', `/appointments/${a.appt}/traceability`, { token: owner })).status, 404);
});

test('cifrado em repouso: sem %PDF nem lote em claro no banco', async () => {
  const a = await seedApp('pmma');
  const r = await gen(a);
  const [row] = await t.sql('SELECT pdf_enc FROM traceability_documents WHERE id=$1', [r.id]);
  assert.ok(row.pdf_enc.startsWith('v1:'));
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes('%PDF') && !raw.includes(LOT));
  assert.ok(!Buffer.from(row.pdf_enc.slice(3), 'base64').toString('latin1').includes('%PDF'));
  // cópia para outra linha não decifra (AAD amarrado ao id)
  await t.sql(`UPDATE traceability_documents SET id=$2 WHERE id=$1`, [r.id, '11111111-1111-4111-8111-111111111111']);
  assert.equal((await t.app.inject({ method: 'GET', url: '/traceability/11111111-1111-4111-8111-111111111111/pdf', headers: { authorization: `Bearer ${owner}` } })).statusCode, 500);
});

test('leitura do PDF é auditada', async () => {
  const a = await seedApp('calcium_hydroxylapatite');
  const r = await gen(a);
  await pdfOf(r.id);
  const aud = await t.sql(`SELECT * FROM audit_log WHERE action='traceability.read'`);
  assert.equal(aud.length, 1);
  assert.equal(aud[0].entity_id, r.id);
});

test('recepção 403, outra clínica 404, sem login 401', async () => {
  const a = await seedApp('hyaluronic_acid');
  const r = await gen(a);
  for (const [m, u] of [['GET', `/appointments/${a.appt}/traceability`], ['POST', `/appointments/${a.appt}/traceability`],
    ['GET', `/patients/${a.patient}/traceability`], ['GET', `/traceability/${r.id}/pdf`]]) {
    assert.equal((await t.call(m, u, { token: reception })).status, 403, `${m} ${u}`);
    assert.equal((await t.call(m, u)).status, 401, `${m} ${u}`);
    assert.equal((await t.call(m, u, { token: ownerB })).status, 404, `${m} ${u}`);
  }
});
