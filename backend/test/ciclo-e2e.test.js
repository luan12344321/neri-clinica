import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, A } from './helpers.js';
import { decrypt } from '../src/crypto.js';

// Ciclo do procedimento de ponta a ponta (dados fictícios). Não depende da hora do dia:
// os atendimentos são criados aqui com início = agora, nunca o "hoje às 14h" do seed.
let t, owner, pro, reception;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  const hash = bcrypt.hashSync('demo1234', 4);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES ($1,'Doutora','dra@demo.test',$2,'professional')`, [A, hash]);
  owner = await t.tokenFor('gestor@demo.test');
  pro = await t.tokenFor('dra@demo.test');
  reception = await t.tokenFor('recepcao@demo.test');
});

const PREENCH = '10000000-0000-0000-0000-000000000003'; // Preenchimento, R$ 1800
const BOTOX = '10000000-0000-0000-0000-000000000001';
const TOXINA = '40000000-0000-0000-0000-000000000001';
const P3 = '20000000-0000-0000-0000-000000000003'; // telefone +551199990003
const TZ = 'America/Sao_Paulo';
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const spToday = async () => (await t.sql(`SELECT (now() AT TIME ZONE '${TZ}')::date::text d`))[0].d;
const plus = (day, n) => iso(Date.parse(`${day}T00:00:00Z`) + n * 864e5);
const newAppt = async (patient, procedure, price) =>
  (await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
    VALUES ($1,$2,$3, now(), now() + interval '1 hour', $4) RETURNING id`, [A, patient, procedure, price]))[0].id;
const conclude = (id, token, applications) => t.call('POST', `/appointments/${id}/conclude`, { token, body: { confirmed: true, applications } });
const count = async (table, where = 'true') => (await t.sql(`SELECT count(*)::int n FROM ${table} WHERE ${where}`))[0].n;
const acts = async () => (await t.sql('SELECT action FROM audit_log')).map((x) => x.action);

async function acidoHialuronico() {
  const [p] = await t.sql(`INSERT INTO products (clinic_id, name, unit, quantity, min_quantity, target_quantity, unit_cost, device_type, units_per_package, manufacturer)
    VALUES ($1,'Ácido hialurônico 1 mL','seringa',0,1,5,300,'hyaluronic_acid',1,'Fabricante Fictício') RETURNING id`, [A]);
  return p.id;
}

test('ciclo completo: lote -> conclusão -> custo/margem -> baixa -> retorno -> comprovante -> fila -> resultado -> painel', async () => {
  const prod = await acidoHialuronico();
  // lote de 5 seringas, entrada feita pela recepção (todos os perfis podem)
  const lotR = await t.call('POST', `/products/${prod}/lots`, { token: reception, body: { lotCode: 'HA-001', expiresAt: plus(await spToday(), 200), packages: 5 } });
  assert.equal(lotR.status, 201);
  assert.ok(!JSON.stringify(lotR.json).includes('unit_cost'), 'recepção não recebe custo do lote/produto');
  const lotId = lotR.json.lot.id;
  assert.equal((await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [prod]))[0].q, 5);

  // regra de retorno da doutora (mensagem sem promessa de resultado)
  const rule = await t.call('PUT', `/procedures/${PREENCH}/return-rule`, { token: owner,
    body: { targetDays: 180, windowMinDays: 150, windowMaxDays: 210, messageText: 'Olá, {{nome}}! Já está no período para a avaliação de retorno do seu {{procedimento}}. Podemos combinar um horário?' } });
  assert.equal(rule.status, 200);
  const bad = await t.call('PUT', `/procedures/${PREENCH}/return-rule`, { token: owner,
    body: { targetDays: 180, windowMinDays: 150, windowMaxDays: 210, messageText: 'Resultado garantido para você!' } });
  assert.equal(bad.status, 400, 'mensagem que promete resultado é recusada');

  const id = await newAppt(P3, PREENCH, 1800);
  const ctx = await t.call('GET', `/appointments/${id}/conclusion-context`, { token: pro });
  assert.equal(ctx.status, 200);
  const hp = ctx.json.products.find((p) => p.id === prod);
  assert.equal(hp.lots[0].code, 'HA-001');
  assert.equal(ctx.json.returnRule.targetDays, 180);
  assert.ok(!JSON.stringify(ctx.json).match(/unit_cost|totalCost|margin/), 'contexto sem custo para a doutora profissional');

  const hoje = await spToday();
  const r = await conclude(id, owner, [{ productId: prod, lotId, units: 2 }]);
  assert.equal(r.status, 200);
  assert.equal(r.json.appointment.status, 'done');
  assert.equal(r.json.applications[0].cost, 600);
  assert.equal(r.json.totalCost, 600);
  assert.deepEqual(r.json.margin, { value: 1200, pct: 66.67 });
  // baixa no lote e em products.quantity (embalagens)
  assert.equal((await t.sql('SELECT quantity_units::float u FROM product_lots WHERE id=$1', [lotId]))[0].u, 3);
  assert.equal((await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [prod]))[0].q, 3);
  const [mv] = await t.sql(`SELECT delta::float d, lot_id, application_id FROM stock_movements WHERE reason='usage'`);
  assert.deepEqual([mv.d, mv.lot_id, mv.application_id], [-2, lotId, r.json.applications[0].id]);

  // retorno sugerido pelas datas da regra
  const rs = r.json.returnSuggested;
  assert.equal(iso(rs.suggested_date), plus(hoje, 180));
  assert.equal(iso(rs.window_start), plus(hoje, 150));
  assert.equal(iso(rs.window_end), plus(hoje, 210));

  // comprovante PDF arquivado cifrado, lido só por rota autenticada
  const tr = r.json.traceability;
  assert.ok(tr?.id);
  const [doc] = await t.sql('SELECT pdf_enc FROM traceability_documents WHERE id=$1', [tr.id]);
  assert.ok(!doc.pdf_enc.includes('JVBER') && !doc.pdf_enc.includes('%PDF'), 'PDF não fica em claro no banco');
  assert.ok(Buffer.from(decrypt(doc.pdf_enc, `traceability.pdf:${tr.id}`), 'base64').subarray(0, 5).toString() === '%PDF-');
  const pdf = await t.app.inject({ method: 'GET', url: `/traceability/${tr.id}/pdf`, headers: { authorization: `Bearer ${pro}` } });
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['cache-control'], 'no-store');
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await t.call('GET', `/traceability/${tr.id}/pdf`, { token: reception })).status, 403);
  assert.equal((await t.call('GET', `/traceability/${tr.id}/pdf`)).status, 401);

  const a = await acts();
  for (const x of ['stock.lot_create', 'return_rule.update', 'application.create', 'appointment.complete_confirmed', 'return.suggested', 'traceability.generate', 'traceability.read'])
    assert.ok(a.includes(x), `auditoria ${x}`);
  assert.equal(await count('message_queue'), 0, 'nenhuma mensagem enfileirada');

  // fila: coloca o retorno na janela de hoje (a data vem da regra; aqui só simulamos a passagem do tempo)
  await t.sql(`UPDATE returns SET window_start=$1::date, suggested_date=$2::date, window_end=$3::date`, [hoje, plus(hoje, 10), plus(hoje, 30)]);
  let qr = await t.call('GET', '/returns/queue', { token: reception });
  assert.equal(qr.status, 200);
  assert.equal(qr.json.items.length, 1);
  const item = qr.json.items[0];
  assert.equal(item.phone, null, 'sem consentimento return: sem telefone');
  assert.equal(item.consent, false);
  assert.match(item.message, /^Olá, Paciente!/);
  assert.ok(!/garant|100%/i.test(item.message));
  // consentimento de aniversário/marketing NÃO libera o retorno
  await t.call('PUT', `/patients/${P3}/consents`, { token: reception, body: { purpose: 'marketing', granted: true } });
  assert.equal((await t.call('GET', '/returns/queue', { token: reception })).json.items[0].phone, null);
  await t.call('PUT', `/patients/${P3}/consents`, { token: reception, body: { purpose: 'return', granted: true } });
  qr = await t.call('GET', '/returns/queue', { token: reception });
  assert.equal(qr.json.items[0].phone, '551199990003');
  assert.equal(qr.json.items[0].consent, true);
  assert.equal(await count('message_queue'), 0);

  // painel antes do resultado
  let pn = (await t.call('GET', '/dashboard/cycle', { token: owner })).json;
  assert.deepEqual(pn.forecast30d, { count: 1, amount: 1800 });
  assert.equal(pn.lotCoverage.pct, 100);
  assert.equal(pn.lotCoverage.withLot, 1);
  const m = pn.avgMarginByProcedure.find((x) => x.procedureId === PREENCH);
  assert.equal(m.n, 1);
  assert.equal(m.avgMargin, 1200);
  assert.equal(m.pct, 66.7);
  assert.equal(pn.lotsExpiring60d.length, 0);

  // resultado: recusou -> sai da fila e da previsão
  const res = await t.call('POST', `/returns/${item.id}/result`, { token: reception, body: { result: 'declined' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, 'declined');
  assert.equal((await t.call('POST', `/returns/${item.id}/result`, { token: reception, body: { result: 'declined' } })).status, 409);
  assert.equal((await t.call('GET', '/returns/queue', { token: reception })).json.items.length, 0);
  pn = (await t.call('GET', '/dashboard/cycle', { token: owner })).json;
  assert.deepEqual(pn.forecast30d, { count: 0, amount: 0 });
  assert.ok((await acts()).includes('return.result'));
  assert.equal(await count('message_queue'), 0);
});

test('ROLLBACK: lote vencido ou saldo insuficiente não grava nada e o atendimento continua agendado', async () => {
  const prod = await acidoHialuronico();
  await t.call('PUT', `/procedures/${PREENCH}/return-rule`, { token: owner,
    body: { targetDays: 180, windowMinDays: 150, windowMaxDays: 210, messageText: 'Convite para a avaliação de retorno do {{procedimento}}.' } });
  const [vencido] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'VENC',(now() - interval '3 days')::date,5,5) RETURNING id`, [A, prod]);
  const [bom] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'BOM',(now() + interval '90 days')::date,1,1) RETURNING id`, [A, prod]);
  await t.sql('UPDATE products SET quantity=6 WHERE id=$1', [prod]);
  const id = await newAppt(P3, PREENCH, 1800);
  const snap = async () => JSON.stringify([
    await t.sql(`SELECT status, completed_at FROM appointments WHERE id=$1`, [id]),
    await t.sql('SELECT lot_code, quantity_units::float FROM product_lots ORDER BY lot_code'),
    await t.sql('SELECT quantity::float FROM products WHERE id=$1', [prod]),
    await count('applications'), await count('stock_movements'), await count('returns'),
    await count('traceability_documents'), await count('transactions', `appointment_id='${id}'`)]);
  const before = await snap();

  const venc = await conclude(id, owner, [{ productId: prod, lotId: vencido.id, units: 1 }]);
  assert.equal(venc.status, 409);
  assert.equal(venc.json.error, 'lot_expired');
  assert.equal(await snap(), before);

  // 1ª linha válida, 2ª estoura o saldo: a 1ª também é desfeita
  const ins = await conclude(id, owner, [{ productId: prod, lotId: bom.id, units: 1 }, { productId: prod, lotId: bom.id, units: 1 }]);
  assert.equal(ins.status, 409);
  assert.equal(ins.json.error, 'insufficient_stock');
  assert.equal(await snap(), before);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'scheduled');

  // depois do erro o mesmo atendimento ainda conclui normalmente
  const ok = await conclude(id, owner, [{ productId: prod, lotId: bom.id, units: 1 }]);
  assert.equal(ok.status, 200);
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [id]))[0].status, 'done');
  assert.equal((await t.sql(`SELECT quantity_units::float u FROM product_lots WHERE id=$1`, [bom.id]))[0].u, 0);
});

test('frasco fracionado: 3 pacientes dividem um frasco de 100 U e o quarto é barrado', async () => {
  await t.sql(`UPDATE products SET units_per_package=100, unit_cost=500, device_type='toxin', quantity=0 WHERE id=$1`, [TOXINA]);
  const lotR = await t.call('POST', `/products/${TOXINA}/lots`, { token: reception, body: { lotCode: 'TX-1', expiresAt: plus(await spToday(), 120), packages: 1 } });
  assert.equal(lotR.status, 201);
  const lot = lotR.json.lot.id;
  assert.equal(lotR.json.lot.quantity_units, '100.00');
  const fatias = [['20000000-0000-0000-0000-000000000003', 40], ['20000000-0000-0000-0000-000000000004', 30], ['20000000-0000-0000-0000-000000000005', 30]];
  const custos = [];
  for (const [pat, u] of fatias) {
    const id = await newAppt(pat, BOTOX, 1200);
    const r = await conclude(id, pro, [{ productId: TOXINA, lotId: lot, units: u }]);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.json).match(/"(cost|unit_cost|totalCost|margin)"/), 'profissional não recebe custo nem margem');
    custos.push(Number((await t.sql('SELECT cost::float c FROM applications WHERE id=$1', [r.json.applications[0].id]))[0].c));
  }
  assert.deepEqual(custos, [200, 150, 150]);
  assert.equal((await t.sql('SELECT quantity_units::float u FROM product_lots WHERE id=$1', [lot]))[0].u, 0);
  assert.equal((await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [TOXINA]))[0].q, 0);
  assert.equal(await count('applications'), 3);
  const quarto = await newAppt('20000000-0000-0000-0000-000000000002', BOTOX, 1200);
  assert.equal((await conclude(quarto, owner, [{ productId: TOXINA, lotId: lot, units: 1 }])).status, 409);
  assert.equal(await count('applications'), 3);
});

test('regressão: o complete antigo não baixa estoque e a recepção segue sem financeiro', async () => {
  const [p] = await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [TOXINA]);
  const id = (await t.sql(`SELECT id FROM appointments WHERE clinic_id=$1 AND status='scheduled'`, [A]))[0].id;
  const r = await t.call('POST', `/appointments/${id}/complete`, { token: owner });
  assert.equal(r.status, 200);
  assert.equal((await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [TOXINA]))[0].q, p.q);
  assert.equal(await count('stock_movements', `reason='usage'`), 0);
  assert.equal(await count('applications'), 0);
  assert.equal((await t.call('GET', '/finance/summary', { token: reception })).status, 403);
  assert.equal((await t.call('GET', '/dashboard/cycle', { token: pro })).status, 403);
  assert.equal((await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' } })).status, 200);
});
