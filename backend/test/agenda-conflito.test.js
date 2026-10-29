import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, owner;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); owner = await t.tokenFor('gestor@demo.test'); });

const P1 = '20000000-0000-0000-0000-000000000001';
const P2 = '20000000-0000-0000-0000-000000000002';
const BOTOX = '10000000-0000-0000-0000-000000000001';
const at = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d; };
const book = (patientId, start, minutes = 60, extra = {}) =>
  t.call('POST', '/appointments', { token: owner, body: { patientId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(), ...extra } });

test('agendar no mesmo horário é recusado (409 slot_taken); horário vizinho passa', async () => {
  const s = at(30, 15);
  assert.equal((await book(P1, s)).status, 201);
  const dup = await book(P2, s);
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'slot_taken');
  assert.equal((await book(P2, new Date(s.getTime() + 30 * 60_000))).status, 409, 'sobreposição parcial também conta');
  assert.equal((await book(P2, new Date(s.getTime() + 60 * 60_000))).status, 201, 'encostar no fim não conflita');
});

test('lista da agenda usa o dia no fuso da clínica (22:30 de São Paulo é do mesmo dia, não do seguinte)', async () => {
  // 2030-03-05 22:30 em São Paulo (UTC-3) = 2030-03-06 01:30 UTC
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at)
               SELECT clinic_id, id, '2030-03-06T01:30:00Z', '2030-03-06T02:00:00Z' FROM patients WHERE id=$1`, [P1]);
  const list = async (from, to) => (await t.call('GET', `/appointments?from=${from}&to=${to}`, { token: owner })).json.length;
  assert.equal(await list('2030-03-05', '2030-03-05'), 1);
  assert.equal(await list('2030-03-06', '2030-03-06'), 0);
});

test('cancelado não ocupa o horário', async () => {
  const s = at(31, 15);
  const a = await book(P1, s);
  assert.equal((await t.call('PATCH', `/appointments/${a.json.id}`, { token: owner, body: { status: 'canceled' } })).status, 200);
  assert.equal((await book(P2, s)).status, 201);
});

test('reagendar para cima de outro atendimento é recusado; para horário livre funciona', async () => {
  const s = at(32, 15);
  await book(P1, s);
  const b = await book(P2, at(32, 18));
  const body = (d) => ({ startsAt: d.toISOString(), endsAt: new Date(d.getTime() + 3600_000).toISOString() });
  const bad = await t.call('PATCH', `/appointments/${b.json.id}`, { token: owner, body: body(s) });
  assert.equal(bad.status, 409); assert.equal(bad.json.error, 'slot_taken');
  assert.equal((await t.call('PATCH', `/appointments/${b.json.id}`, { token: owner, body: body(at(32, 20)) })).status, 200);
  assert.equal((await t.call('PATCH', `/appointments/${b.json.id}`, { token: owner, body: { status: 'confirmed' } })).status, 200, 'confirmar sem mudar horário não conflita consigo mesmo');
});

test('profissionais diferentes podem atender no mesmo horário', async () => {
  const [u] = await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`);
  const [r] = await t.sql(`SELECT id FROM users WHERE email='recepcao@demo.test'`);
  const s = at(33, 15);
  assert.equal((await book(P1, s, 60, { professionalId: u.id })).status, 201);
  assert.equal((await book(P2, s, 60, { professionalId: r.id })).status, 201);
  assert.equal((await book(P2, s, 60, { professionalId: u.id })).status, 409);
});

test('outra clínica não bloqueia o horário', async () => {
  const s = at(34, 15);
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at) VALUES ('00000000-0000-0000-0000-0000000000b1','2b000000-0000-0000-0000-000000000001',$1,$2)`,
    [s.toISOString(), new Date(s.getTime() + 3600_000).toISOString()]);
  assert.equal((await book(P1, s)).status, 201);
});

test('novo retorno do mesmo procedimento encerra o retorno antigo em aberto (sem fila duplicada)', async () => {
  await t.sql(`INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text, active)
               VALUES ($1,$2,120,100,140,'Olá, {{nome}}! Avaliação de retorno do {{procedimento}}.',true)`, [A, BOTOX]);
  const conclude = async (days) => {
    const s = at(-days, 12);
    const a = await book(P1, s, 60, { procedureId: BOTOX });
    assert.equal(a.status, 201);
    const r = await t.call('POST', `/appointments/${a.json.id}/conclude`, { token: owner, body: { confirmed: true, applications: [] } });
    assert.equal(r.status, 200);
  };
  await conclude(20); await conclude(10);
  const open = await t.sql(`SELECT state FROM returns WHERE clinic_id=$1 AND patient_id=$2 AND procedure_id=$3 ORDER BY created_at`, [A, P1, BOTOX]);
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((x) => x.state), ['done', 'suggested']);
});
