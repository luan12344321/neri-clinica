import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t, fetchMock;
before(async () => {
  t = await setup();
  mock.method(console, 'log', () => {});
  fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
});
after(() => t.close());

const BOTOX = '10000000-0000-0000-0000-000000000001';
const LIMPEZA = '10000000-0000-0000-0000-000000000002';
const P1 = '20000000-0000-0000-0000-000000000001'; // Paciente 1, +551199990001 (11 dígitos com 55? ver abaixo)
const P2 = '20000000-0000-0000-0000-000000000002';
const PB = '2b000000-0000-0000-0000-000000000001';
const GOOD = 'Oi {{nome}}, já faz um tempo do seu {{procedimento}}. Que tal agendar uma avaliação de retorno até {{data}}?';

let owner, prof, recep, ownerB;
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  owner = await t.tokenFor('gestor@demo.test');
  recep = await t.tokenFor('recepcao@demo.test');
  ownerB = await t.tokenFor('b@demo.test');
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role)
               SELECT clinic_id, 'Profissional', 'prof@demo.test', password_hash, 'professional' FROM users WHERE email='gestor@demo.test'`);
  prof = await t.tokenFor('prof@demo.test');
});

const TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
const today = async () => (await t.sql(`SELECT ${TODAY}::text AS d`))[0].d;
const plus = (base, n) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const doneAppt = async (patient = P1, procedure = BOTOX) => (await t.sql(
  `INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, status, completed_at)
   VALUES ($1,$2,$3, now() - interval '200 days', now() - interval '200 days' + interval '1 hour','done', now() - interval '200 days') RETURNING id`,
  [A, patient, procedure]))[0].id;
// ws/we = deslocamentos em dias a partir de hoje
const mkReturn = async ({ ws, we, state = 'suggested', patient = P1, procedure = BOTOX, sd = 0, clinic = A, remindOn = null }) => {
  const appt = await doneAppt(patient, procedure);
  const [r] = await t.sql(
    `INSERT INTO returns (clinic_id, patient_id, procedure_id, source_appointment_id, suggested_date, window_start, window_end, state, remind_on)
     VALUES ($1,$2,$3,$4, ${TODAY} + $5::int, ${TODAY} + $6::int, ${TODAY} + $7::int, $8, $9) RETURNING id`,
    [clinic, patient, procedure, appt, sd, ws, we, state, remindOn]);
  return r.id;
};
const consent = (patient, purpose, granted, at = null) => t.sql(
  `INSERT INTO contact_consents (clinic_id, patient_id, purpose, granted, recorded_at) VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()))`,
  [A, patient, purpose, granted, at]);
const queue = (scope = 'today', token = owner) => t.call('GET', `/returns/queue${scope ? `?scope=${scope}` : ''}`, { token });
const rule = (procedure = BOTOX, msg = GOOD) => t.sql(
  `INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text) VALUES ($1,$2,105,90,120,$3)`,
  [A, procedure, msg]);

test('fila: ordem por urgência e janelas (today não traz futuros nem lembrar-depois)', async () => {
  const dueSoon = await mkReturn({ ws: -10, we: 2, sd: -4 });        // na janela, fecha em 2 dias
  const late5 = await mkReturn({ ws: -20, we: -5, patient: P2 });     // vencido 5 dias
  const late1 = await mkReturn({ ws: -20, we: -1, patient: P2, procedure: LIMPEZA });
  const roomy = await mkReturn({ ws: -2, we: 30, procedure: LIMPEZA }); // folgado
  await mkReturn({ ws: 3, we: 40, patient: P2, procedure: BOTOX });   // futuro
  await mkReturn({ ws: -5, we: 10, state: 'remind_later', procedure: LIMPEZA, patient: P2 });
  const r = await queue();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((i) => i.id), [late5, late1, dueSoon, roomy]);
  assert.deepEqual(r.json.items.map((i) => i.urgency), ['high', 'high', 'medium', 'low']);
  assert.deepEqual(r.json.items.map((i) => i.daysLate), [5, 1, 0, 0]);
  assert.equal(r.json.items[0].patient.name, 'Paciente 2');
  assert.equal(r.json.items[0].procedure.name, 'Botox');
  const all = await queue('all');
  assert.equal(all.json.items.length, 6);
  assert.equal((await queue(null)).json.items.length, 4); // padrão = today
  assert.equal((await queue('xx')).status, 400);
});

test('fila: telefone só com consentimento e some se o último registro for revogação', async () => {
  const id = await mkReturn({ ws: -3, we: 5 });
  let it = (await queue()).json.items[0];
  assert.equal(it.consent, false); assert.equal(it.phone, null);
  await consent(P1, 'birthday', true); await consent(P1, 'marketing', true); // não valem para retorno
  it = (await queue()).json.items[0];
  assert.equal(it.phone, null);
  await consent(P1, 'return', true, new Date(Date.now() - 60000).toISOString());
  it = (await queue()).json.items[0];
  assert.equal(it.consent, true);
  assert.match(it.phone, /^55\d{10,11}$/);
  assert.equal(it.id, id);
  await consent(P1, 'return', false);
  it = (await queue()).json.items[0];
  assert.equal(it.consent, false); assert.equal(it.phone, null);
  assert.equal(JSON.stringify(it).includes('9999000'), false); // telefone nem aparece em outro campo
});

test('fila: mensagem renderizada, primeiro nome e sem promessa; neutra sem regra', async () => {
  await mkReturn({ ws: -3, we: 5 });
  let it = (await queue()).json.items[0];
  assert.match(it.message, /Paciente/);                // texto neutro, sem regra
  assert.doesNotMatch(it.message, /\{\{/);
  assert.doesNotMatch(it.message, /garant|100%|resultado|milagre/i);
  await t.sql('UPDATE patients SET full_name=$2 WHERE id=$1', [P1, 'Maria Souza Lima']);
  await rule();
  it = (await queue()).json.items[0];
  const we = await t.sql(`SELECT to_char(window_end,'DD/MM') d FROM returns`);
  assert.equal(it.message, `Oi Maria, já faz um tempo do seu Botox. Que tal agendar uma avaliação de retorno até ${we[0].d}?`);
  // regra com promessa gravada direto no banco nunca chega à tela
  await t.sql(`UPDATE procedure_return_rules SET message_text='Seu resultado garantido, {{nome}}'`);
  it = (await queue()).json.items[0];
  assert.doesNotMatch(it.message, /garantid/);
});

test('fila: perfis (recepção e profissional leem) e isolamento entre clínicas', async () => {
  const idA = await mkReturn({ ws: -3, we: 5 });
  assert.equal((await queue('today', recep)).status, 200);
  assert.equal((await queue('today', prof)).status, 200);
  assert.equal((await t.call('GET', '/returns/queue')).status, 401);
  assert.equal((await queue('today', ownerB)).json.items.length, 0);
  assert.equal((await t.call('POST', `/returns/${idA}/result`, { token: ownerB, body: { result: 'declined' } })).status, 404);
  assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [idA]))[0].state, 'suggested');
  assert.equal((await t.call('POST', `/returns/${idA}/result`, { body: { result: 'declined' } })).status, 401);
});

test('resultado: estados, contacted_at, remind_later com datas e 409', async () => {
  const d = await today();
  for (const [res, state] of [['scheduled', 'scheduled'], ['declined', 'declined'], ['no_response', 'no_response']]) {
    const id = await mkReturn({ ws: -3, we: 5, procedure: res === 'declined' ? LIMPEZA : BOTOX, patient: res === 'no_response' ? P2 : P1 });
    const r = await t.call('POST', `/returns/${id}/result`, { token: recep, body: { result: res } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [row] = await t.sql('SELECT state, contacted_at FROM returns WHERE id=$1', [id]);
    assert.equal(row.state, state); assert.ok(row.contacted_at);
  }
  const id = await mkReturn({ ws: -3, we: 5, patient: P2, procedure: LIMPEZA });
  const bad = async (body) => (await t.call('POST', `/returns/${id}/result`, { token: owner, body })).status;
  assert.equal(await bad({ result: 'remind_later' }), 400);
  assert.equal(await bad({ result: 'remind_later', remindOn: d }), 400);                 // hoje
  assert.equal(await bad({ result: 'remind_later', remindOn: plus(d, 181) }), 400);
  assert.equal(await bad({ result: 'remind_later', remindOn: '2030-02-31' }), 400);
  assert.equal(await bad({ result: 'remind_later', remindOn: 'amanha' }), 400);
  assert.equal(await bad({ result: 'foo' }), 400);
  assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [id]))[0].state, 'suggested');
  const ok = await t.call('POST', `/returns/${id}/result`, { token: owner, body: { result: 'remind_later', remindOn: plus(d, 7) } });
  assert.equal(ok.status, 200);
  const [row] = await t.sql('SELECT state, remind_on::text AS r FROM returns WHERE id=$1', [id]);
  assert.equal(row.state, 'remind_later'); assert.equal(row.r, plus(d, 7));
  // remind_later pode virar outro resultado; retorno resolvido dá 409
  assert.equal((await t.call('POST', `/returns/${id}/result`, { token: owner, body: { result: 'declined' } })).status, 200);
  assert.equal((await t.call('POST', `/returns/${id}/result`, { token: owner, body: { result: 'scheduled' } })).status, 409);
  const done = await mkReturn({ ws: -3, we: 5, state: 'done', patient: P2 });
  assert.equal((await t.call('POST', `/returns/${done}/result`, { token: owner, body: { result: 'declined' } })).status, 409);
  const au = await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='return.result' AND clinic_id=$1`, [A]);
  assert.equal(au[0].n, 5);
});

test('consentimento: histórico preservado, sync do marketing_consent e return não herdado', async () => {
  const g0 = await t.call('GET', `/patients/${P2}/consents`, { token: recep });
  assert.equal(g0.status, 200);
  assert.deepEqual(g0.json, { return: null, birthday: null, marketing: null });
  const put = (purpose, granted, token = recep, id = P2) => t.call('PUT', `/patients/${id}/consents`, { token, body: { purpose, granted } });
  assert.equal((await put('return', true)).status, 200);
  assert.equal((await put('return', false)).status, 200);
  assert.equal((await put('return', true, prof)).status, 200);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM contact_consents WHERE patient_id=$1 AND purpose='return'`, [P2]))[0].n, 3);
  const g = (await t.call('GET', `/patients/${P2}/consents`, { token: owner })).json;
  assert.equal(g.return.granted, true); assert.ok(g.return.recordedAt);
  assert.equal(g.birthday, null);
  // return não mexe no marketing_consent (seed: true)
  assert.equal((await t.sql('SELECT marketing_consent m FROM patients WHERE id=$1', [P2]))[0].m, true);
  // birthday revogado desliga o campo; marketing concedido depois não religa (birthday manda)
  await put('birthday', false);
  assert.equal((await t.sql('SELECT marketing_consent m FROM patients WHERE id=$1', [P2]))[0].m, false);
  await put('marketing', true);
  assert.equal((await t.sql('SELECT marketing_consent m FROM patients WHERE id=$1', [P2]))[0].m, false);
  await put('birthday', true);
  assert.equal((await t.sql('SELECT marketing_consent m FROM patients WHERE id=$1', [P2]))[0].m, true);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM contact_consents WHERE patient_id=$1`, [P2]))[0].n, 6);
  const rb = (await t.sql(`SELECT recorded_by FROM contact_consents WHERE patient_id=$1 ORDER BY id LIMIT 1`, [P2]))[0].recorded_by;
  assert.ok(rb);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='consent.update'`))[0].n, 6);
  assert.equal((await put('x', true)).status, 400);
  assert.equal((await t.call('PUT', `/patients/${P2}/consents`, { token: owner, body: { purpose: 'return' } })).status, 400);
  // outra clínica
  assert.equal((await put('return', true, ownerB, P2)).status, 404);
  assert.equal((await t.call('GET', `/patients/${P2}/consents`, { token: ownerB })).status, 404);
  assert.equal((await put('return', true, owner, PB)).status, 404);
  assert.equal((await t.call('GET', `/patients/${PB}/consents`, { token: ownerB })).status, 200);
});

test('attention: doutora vê tarefa clínica; recepção nunca vê finanças', async () => {
  const d = await today();
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, status)
               VALUES ($1,$2,$3, now() - interval '3 hours', now() - interval '2 hours', 'confirmed')`, [A, P2, BOTOX]);
  await t.sql(`INSERT INTO transactions (clinic_id, type, description, amount, competence_date, due_date, status) VALUES
    ($1,'expense','Aluguel',500,$2,$3,'pending'), ($1,'income','Fiado',300,$2,$3,'pending')`, [A, plus(d, -20), plus(d, -10)]);
  const prod = '40000000-0000-0000-0000-000000000002';
  await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units) VALUES
    ($1,$2,'L1',$3,5,5), ($1,$2,'L2',$4,5,5)`, [A, prod, plus(d, -2), plus(d, 30)]);
  await mkReturn({ ws: -20, we: -3 });
  await mkReturn({ ws: -3, we: 4, patient: P2, procedure: LIMPEZA });

  const att = async (token) => (await t.call('GET', '/attention', { token })).json.items;
  const own = await att(owner);
  const kinds = own.map((i) => i.kind);
  for (const k of ['late_appointments', 'payables_overdue', 'receivables_overdue', 'lots_expired', 'lots_expiring', 'returns_overdue',
    'returns_closing', 'restock', 'birthdays']) assert.ok(kinds.includes(k), `falta ${k}`);
  // ordenado por urgência
  const rank = { high: 0, medium: 1, low: 2 };
  assert.deepEqual(own.map((i) => rank[i.urgency]), own.map((i) => rank[i.urgency]).sort());
  const lateItem = own.find((i) => i.kind === 'late_appointments');
  assert.equal(lateItem.owner, 'doctor'); assert.equal(lateItem.urgency, 'high');
  assert.deepEqual(lateItem.nextActions.map((a) => a.kind), ['check_status', 'register', 'reschedule', 'forward']);
  assert.equal(own.find((i) => i.kind === 'returns_overdue').owner, 'secretary');
  assert.equal(own.find((i) => i.kind === 'birthdays').urgency, 'low');
  assert.equal(own.find((i) => i.kind === 'payables_overdue').owner, 'manager');

  const doc = await att(prof);
  assert.ok(doc.some((i) => i.kind === 'late_appointments'));
  assert.equal(doc.some((i) => ['payables_overdue', 'receivables_overdue', 'lots_expired', 'lots_expiring'].includes(i.kind)), false);

  const rec = await att(recep);
  const recStr = JSON.stringify(rec);
  assert.ok(rec.some((i) => i.kind === 'returns_overdue'));
  assert.equal(rec.some((i) => ['payables_overdue', 'receivables_overdue', 'lots_expired', 'lots_expiring'].includes(i.kind)), false);
  assert.doesNotMatch(recStr, /amount|unit_cost|custo|margem|Aluguel|Fiado/i);
  assert.equal((await t.call('GET', '/attention')).status, 401);
});

test('attention: isolamento entre clínicas', async () => {
  await mkReturn({ ws: -20, we: -3 });
  const b = (await t.call('GET', '/attention', { token: ownerB })).json.items;
  assert.equal(b.some((i) => i.kind.startsWith('returns')), false);
  assert.equal(b.some((i) => i.kind === 'late_appointments'), false);
});

test('nenhum envio automático: sem message_queue novo e sem chamada de rede', async () => {
  const before = (await t.sql('SELECT count(*)::int n FROM message_queue'))[0].n;
  fetchMock.mock.resetCalls();
  const id = await mkReturn({ ws: -3, we: 5 });
  await consent(P1, 'return', true);
  await queue(); await queue('all');
  await t.call('GET', '/attention', { token: owner });
  await t.call('POST', `/returns/${id}/result`, { token: owner, body: { result: 'no_response' } });
  await t.call('PUT', `/patients/${P1}/consents`, { token: owner, body: { purpose: 'birthday', granted: true } });
  assert.equal((await t.sql('SELECT count(*)::int n FROM message_queue'))[0].n, before);
  assert.equal(fetchMock.mock.callCount(), 0);
});
