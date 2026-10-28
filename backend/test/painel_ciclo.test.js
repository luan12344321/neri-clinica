import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { setup, A, B } from './helpers.js';

// Dados fictícios inseridos direto no banco, com datas relativas a hoje (meio-dia no fuso de São Paulo,
// para não depender da hora em que o teste roda).
let t, owner, manager, pro, reception, ownerB;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  const hash = bcrypt.hashSync('demo1234', 4);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES
    ($1,'Doutora','dra@demo.test',$2,'professional'), ($1,'Gerente','gerente@demo.test',$2,'manager')`, [A, hash]);
  owner = await t.tokenFor('gestor@demo.test');
  manager = await t.tokenFor('gerente@demo.test');
  pro = await t.tokenFor('dra@demo.test');
  reception = await t.tokenFor('recepcao@demo.test');
  ownerB = await t.tokenFor('b@demo.test');
});

const PX = '10000000-0000-0000-0000-0000000000a1'; // procedimento fictício, preço padrão 500
const PY = '10000000-0000-0000-0000-0000000000a2'; // preço padrão 400
const TOXINA = '40000000-0000-0000-0000-000000000001';
const D = (n) => `((now() AT TIME ZONE 'America/Sao_Paulo')::date + (${n}))`;
const TS = (n) => `((${D(n)} + time '12:00') AT TIME ZONE 'America/Sao_Paulo')`;
let seq = 0;

async function procs() {
  await t.sql(`INSERT INTO procedures (id, clinic_id, name, default_price) VALUES ($1,$3,'Proc X',500), ($2,$3,'Proc Y',400)`, [PX, PY, A]);
}
async function patient() {
  const id = `2a000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`;
  await t.sql(`INSERT INTO patients (id, clinic_id, full_name) VALUES ($1,$2,$3)`, [id, A, `Fictícia ${seq}`]);
  return id;
}
async function done(pid, proc, day, price = 600) {
  return (await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, status, price, completed_at)
    VALUES ($1,$2,$3,${TS(day)},${TS(day)} + interval '1 hour','done',$4,${TS(day)}) RETURNING id`, [A, pid, proc, price]))[0].id;
}
// retorno com atendimento de origem concluído há `srcDay` dias (negativo)
async function ret({ sug, state = 'suggested', end, proc = PX, patientId, srcDay = -100, price = 600 }) {
  const p = patientId ?? await patient();
  const src = await done(p, proc, srcDay, price);
  await t.sql(`INSERT INTO returns (clinic_id, patient_id, procedure_id, source_appointment_id, suggested_date, window_start, window_end, state)
    VALUES ($1,$2,$3,$4,${D(sug)},${D(sug)},${D(end ?? sug + 5)},$5)`, [A, p, proc, src, state]);
  return p;
}
const get = (token = owner) => t.call('GET', '/dashboard/cycle', { token });

test('permissões: owner e gerente 200; profissional e recepção 403; sem login 401', async () => {
  assert.equal((await get(owner)).status, 200);
  assert.equal((await get(manager)).status, 200);
  assert.equal((await get(pro)).status, 403);
  assert.equal((await get(reception)).status, 403);
  assert.equal((await t.call('GET', '/dashboard/cycle')).status, 401);
});

test('estado vazio: tudo zerado ou null, nunca número inventado', async () => {
  const { json: j } = await get();
  assert.deepEqual(Object.keys(j).sort(), ['avgMarginByProcedure', 'forecast30d', 'idleMoney', 'lotCoverage', 'lotsExpiring60d', 'onTimeRate']);
  assert.deepEqual(j.forecast30d, { count: 0, amount: 0 });
  assert.deepEqual(j.onTimeRate.current, { rate: null, onTime: 0, total: 0 });
  assert.equal(j.onTimeRate.baseline6m.rate, null);
  assert.equal(j.onTimeRate.baseline6m.estimated, true);
  assert.ok(j.onTimeRate.note.length > 10);
  assert.deepEqual(j.lotsExpiring60d, []);
  assert.ok(j.avgMarginByProcedure.every((m) => m.n === 0 && m.avgMargin === null && m.pct === null));
  assert.deepEqual(j.lotCoverage, { pct: null, withLot: 0, total: 0, target: 95 });
  assert.deepEqual(j.idleMoney, { patients: 0, amount: 0, action: 'open_queue' });
});

test('previsão 30 dias: conta suggested/remind_later na janela e soma o preço padrão', async () => {
  await procs();
  await ret({ sug: 10 });                                  // conta
  await ret({ sug: 30, state: 'remind_later' });           // conta (limite)
  await ret({ sug: 31 });                                  // fora (31 dias)
  await ret({ sug: 5, state: 'scheduled' });               // outro estado
  await ret({ sug: -2, end: 3 });                          // já na janela: conta
  await ret({ sug: -10, end: -5 });                        // janela encerrada: não conta
  await ret({ sug: 8, proc: PY });                         // conta, R$ 400
  const { json } = await get();
  assert.deepEqual(json.forecast30d, { count: 4, amount: 1900 });
});

test('retorno no prazo (atual): taxa sobre retornos com prazo+30 vencido nos últimos 90 dias', async () => {
  await procs();
  // sugerido há 60 dias: prazo (sug+30) foi há 30 dias
  for (const next of [-45, -45, -31]) {                    // no prazo (até sug+30 = -30)
    const p = await ret({ sug: -60, srcDay: -90 });
    await done(p, PX, next);
  }
  const late = await ret({ sug: -60, srcDay: -90 }); await done(late, PX, -20); // atrasado
  await ret({ sug: -60, srcDay: -90 });                    // não voltou
  await ret({ sug: -20, srcDay: -50 });                    // prazo ainda não venceu: fora
  await ret({ sug: -60, srcDay: -90, state: 'declined' }); // recusado: fora
  const { json } = await get();
  assert.deepEqual(json.onTimeRate.current, { rate: 60, onTime: 3, total: 5 });
});

test('retorno no prazo (atual): rate null com menos de 5 casos', async () => {
  await procs();
  for (let i = 0; i < 4; i++) { const p = await ret({ sug: -60, srcDay: -90 }); await done(p, PX, -45); }
  const { json } = await get();
  assert.deepEqual(json.onTimeRate.current, { rate: null, onTime: 4, total: 4 });
});

test('linha de base 6 meses: estimada pela história de atendimentos concluídos', async () => {
  await procs();
  await t.sql(`INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text)
    VALUES ($1,$2,30,20,40,'Convite para avaliação de retorno')`, [A, PX]);
  const rep = [];
  for (let i = 0; i < 5; i++) {
    const p = await patient(); await done(p, PX, -200);
    if (i < 2) rep.push(p);
  }
  for (const p of rep) await done(p, PX, -175);            // voltaram em 25 dias (dentro de [20, 70])
  const late = await patient(); await done(late, PX, -200); await done(late, PX, -100); // voltou só em 100 dias: fora
  const { json } = await get();
  // fontes elegíveis: 5 (em -200) + 1 (tardio em -200) + 1 (tardio em -100) + 2 (retornos em -175, que não repetiram) = 9
  const b = json.onTimeRate.baseline6m;
  assert.equal(b.estimated, true);
  assert.equal(b.total, 9);
  assert.equal(b.rate, 22.2);                              // 2 de 9
});

test('linha de base: rate null com poucos casos', async () => {
  await procs();
  await t.sql(`INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text)
    VALUES ($1,$2,30,20,40,'Convite para avaliação de retorno')`, [A, PX]);
  for (let i = 0; i < 3; i++) await done(await patient(), PX, -200);
  const { json } = await get();
  assert.deepEqual(json.onTimeRate.baseline6m, { rate: null, total: 3, estimated: true });
});

test('lotes vencendo em 60 dias: com saldo, ordenados, vencidos marcados', async () => {
  const lot = (code, off, units) => t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,$3,${D(off)},$4,10)`, [A, TOXINA, code, units]);
  await lot('L59', 59, 4); await lot('L10', 10, 5); await lot('L61', 61, 9); await lot('VENC', -3, 2); await lot('ZERO', 5, 0);
  const { json } = await get();
  assert.deepEqual(json.lotsExpiring60d.map((l) => l.lotCode), ['VENC', 'L10', 'L59']);
  const [v, l10] = json.lotsExpiring60d;
  assert.equal(v.expired, true); assert.equal(v.daysLeft, -3); assert.equal(v.units, 2);
  assert.equal(l10.daysLeft, 10); assert.equal(l10.expired, undefined);
  assert.equal(l10.productName, 'Toxina botulínica 100U');
  assert.match(l10.expiresAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('margem média: ignora atendimentos sem custo e informa missingCost', async () => {
  await procs();
  const p = await patient();
  const app = (appt, cost) => t.sql(`INSERT INTO applications (clinic_id, appointment_id, patient_id, product_id, units_used, unit_cost, cost)
    VALUES ($1,$2,$3,$4,1,$5,$5)`, [A, appt, p, TOXINA, cost]);
  const a1 = await done(p, PX, -20, 500); await app(a1, 100); await app(a1, 50);   // margem 350
  const a2 = await done(p, PX, -21, 300); await app(a2, 100);                      // margem 200
  await done(p, PX, -22, 500);                                                      // sem aplicações: missing
  const a4 = await done(p, PX, -23, 500); await app(a4, null);                      // custo desconhecido: missing
  const a5 = await done(p, PX, -250, 500); await app(a5, 10);                       // fora dos 6 meses
  const { json } = await get();
  const m = json.avgMarginByProcedure.find((x) => x.procedureId === PX);
  assert.deepEqual(m, { procedureId: PX, procedure: 'Proc X', n: 2, missingCost: 2, avgMargin: 275, pct: 68.8 });
});

test('cobertura de lote: % das aplicações dos últimos 90 dias com lote', async () => {
  await procs();
  const p = await patient();
  const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'LC',${D(200)},50,50) RETURNING id`, [A, TOXINA]);
  const a = await done(p, PX, -5);
  const ins = (lotId, when = 'now()') => t.sql(`INSERT INTO applications (clinic_id, appointment_id, patient_id, product_id, lot_id, units_used, created_at)
    VALUES ($1,$2,$3,$4,$5,1,${when})`, [A, a, p, TOXINA, lotId]);
  await ins(lot.id); await ins(lot.id); await ins(lot.id); await ins(null);
  await ins(null, "now() - interval '100 days'");          // fora da janela de 90 dias
  const { json } = await get();
  assert.deepEqual(json.lotCoverage, { pct: 75, withLot: 3, total: 4, target: 95 });
});

test('dinheiro parado: retornos vencidos × ticket médio (ou preço padrão)', async () => {
  await procs();
  await ret({ sug: -20, end: -5 });                                        // vencido, ticket R$ 600
  await ret({ sug: -15, end: -1, state: 'no_response' });                  // vencido, R$ 600
  await ret({ sug: -15, end: -2, state: 'remind_later', proc: PY, price: null }); // sem ticket: preço padrão R$ 400
  await ret({ sug: -15, end: -2, state: 'done' });                         // já resolvido
  await ret({ sug: -3, end: 2 });                                          // ainda na janela
  const { json } = await get();
  assert.deepEqual(json.idleMoney, { patients: 3, amount: 1600, action: 'open_queue' });
});

test('isolamento: a clínica B não vê dados da clínica A', async () => {
  await procs();
  await ret({ sug: 10 }); await ret({ sug: -20, end: -5 });
  await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'LA',${D(5)},3,3)`, [A, TOXINA]);
  const a = await get(owner);
  assert.equal(a.json.forecast30d.count, 1);
  assert.equal(a.json.lotsExpiring60d.length, 1);
  const b = await get(ownerB);
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.forecast30d, { count: 0, amount: 0 });
  assert.deepEqual(b.json.lotsExpiring60d, []);
  assert.deepEqual(b.json.avgMarginByProcedure, []);
  assert.deepEqual(b.json.idleMoney, { patients: 0, amount: 0, action: 'open_queue' });
  assert.equal(b.json.lotCoverage.total, 0);
});
