import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, mod, jobs;
before(async () => {
  t = await setup();
  mod = await import('../src/retornos.js');
  jobs = await import('../src/jobs.js');
  mock.method(console, 'log', () => {});
  mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 })); // nada sai de verdade
});
after(() => t.close());

const BOTOX = '10000000-0000-0000-0000-000000000001';
const PAT = '20000000-0000-0000-0000-000000000001';
const GOOD = 'Oi {{nome}}, já faz um tempo do seu {{procedimento}}. Que tal agendar uma avaliação de retorno até {{data}}?';
const rule = (o = {}) => ({ targetDays: 105, windowMinDays: 90, windowMaxDays: 120, messageText: GOOD, active: true, ...o });

let owner, prof, recep;
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  owner = await t.tokenFor('gestor@demo.test');
  recep = await t.tokenFor('recepcao@demo.test');
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role)
               SELECT clinic_id, 'Profissional', 'prof@demo.test', password_hash, 'professional' FROM users WHERE email='gestor@demo.test'`);
  prof = await t.tokenFor('prof@demo.test');
});

const putRule = (body, token = owner, id = BOTOX) => t.call('PUT', `/procedures/${id}/return-rule`, { token, body });
// atendimento concluído em 2030-03-15 02:00Z = 14/03 23:00 em São Paulo (testa o fuso)
const doneAppt = async (completed = '2030-03-15T02:00:00Z', procedure = BOTOX) => (await t.sql(
  `INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, status, completed_at)
   VALUES ($1,$2,$3,$4::timestamptz - interval '1 hour',$4,'done',$4) RETURNING id`, [A, PAT, procedure, completed]))[0].id;
const suggest = async (apptId, procedure = BOTOX) => {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await mod.suggestReturn(c, { clinicId: A, appointmentId: apptId, patientId: PAT, procedureId: procedure });
    await c.query('COMMIT');
    return r;
  } finally { c.release(); }
};
const day = (d) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);
const plus = (base, n) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (iso, dow, from = 0) => { // próximo dia da semana `dow` a partir de uma data distante
  let d = new Date(`${iso}T12:00:00Z`); d = new Date(d.getTime() + from * 864e5);
  while (d.getUTCDay() !== dow) d = new Date(d.getTime() + 864e5);
  return d.toISOString().slice(0, 10);
};
const mkReturn = async (state = 'suggested', extra = {}) => {
  const appt = await doneAppt();
  const [r] = await t.sql(
    `INSERT INTO returns (clinic_id, patient_id, procedure_id, source_appointment_id, suggested_date, window_start, window_end, state, remind_on)
     VALUES ($1,$2,$3,$4,'2030-06-27','2030-06-12','2030-07-12',$5,$6) RETURNING id`, [A, PAT, BOTOX, appt, state, extra.remindOn ?? null]);
  return { id: r.id, appt };
};

test('regra: owner grava, professional lê, recepção não grava', async () => {
  assert.equal((await putRule(rule())).status, 200);
  const g = await t.call('GET', `/procedures/${BOTOX}/return-rule`, { token: prof });
  assert.equal(g.status, 200);
  assert.equal(g.json.targetDays, 105);
  assert.equal(g.json.windowMinDays, 90);
  assert.equal((await putRule(rule(), prof)).status, 403);
  assert.equal((await putRule(rule(), recep)).status, 403);
  assert.equal((await t.call('GET', `/procedures/${BOTOX}/return-rule`, { token: recep })).status, 403);
  // upsert: atualizar não duplica
  assert.equal((await putRule(rule({ targetDays: 100, active: false }))).status, 200);
  assert.equal((await t.sql('SELECT count(*)::int n FROM procedure_return_rules'))[0].n, 1);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='return_rule.update'`))[0].n, 2);
});

test('regra: sem regra o GET informa configured=false; procedimento de outra clínica dá 404', async () => {
  const g = await t.call('GET', `/procedures/${BOTOX}/return-rule`, { token: owner });
  assert.equal(g.json.configured, false);
  const [other] = await t.sql(`INSERT INTO procedures (clinic_id, name, default_price) VALUES ('00000000-0000-0000-0000-0000000000b1','Alheio',10) RETURNING id`);
  assert.equal((await putRule(rule(), owner, other.id)).status, 404);
  assert.equal((await t.call('GET', `/procedures/${other.id}/return-rule`, { token: owner })).status, 404);
});

test('regra: janela inválida e números inválidos dão 400', async () => {
  assert.equal((await putRule(rule({ windowMinDays: 110 }))).status, 400);
  assert.equal((await putRule(rule({ windowMaxDays: 100 }))).status, 400);
  assert.equal((await putRule(rule({ targetDays: 0, windowMinDays: 0 }))).status, 400);
  assert.equal((await putRule(rule({ targetDays: 10.5 }))).status, 400);
  assert.equal((await putRule(rule({ messageText: 'curta' + '' }))).status, 200);
  assert.equal((await putRule(rule({ messageText: 'abc' }))).status, 400);
  assert.equal((await putRule(rule({ messageText: 'x'.repeat(601) }))).status, 400);
});

test('regra: mensagem com promessa de resultado é recusada com mensagem clara', async () => {
  for (const txt of ['Resultado garantido para você, {{nome}}!', 'Efeito 100% natural, venha!', 'Sem risco nenhum, volte logo',
    'Rejuvenesça com a gente, {{nome}}', 'Veja o antes e depois no retorno', 'Um resultado definitivo te espera', 'Garantimos sua satisfação']) {
    const r = await putRule(rule({ messageText: txt }));
    assert.equal(r.status, 400, txt);
    assert.match(r.json.error, /não pode prometer resultado/);
  }
  const v = await putRule(rule({ messageText: 'Oi {{apelido}}, vamos agendar o retorno?' }));
  assert.equal(v.status, 400);
  assert.match(v.json.error, /Variável/);
  assert.ok(mod.FORBIDDEN_PROMISES.includes('garantido'));
});

test('renderReturnMessage troca as variáveis', () => {
  assert.equal(mod.renderReturnMessage('Oi {{nome}}, {{procedimento}} em {{data}}', { nome: 'Ana', procedimento: 'Botox', data: '27/06' }),
    'Oi Ana, Botox em 27/06');
});

test('suggestReturn: datas pelo alvo e pela janela, no fuso de São Paulo', async () => {
  await putRule(rule());
  const appt = await doneAppt();
  const r = await suggest(appt);
  assert.equal(day(r.suggested_date), plus('2030-03-14', 105));
  assert.equal(day(r.window_start), plus('2030-03-14', 90));
  assert.equal(day(r.window_end), plus('2030-03-14', 120));
  assert.equal(r.procedure_id, BOTOX);
  const rows = await t.sql(`SELECT state FROM returns`);
  assert.deepEqual(rows, [{ state: 'suggested' }]);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='return.suggested'`))[0].n, 1);
});

test('suggestReturn: sem regra ativa devolve null e é idempotente', async () => {
  const appt = await doneAppt();
  assert.equal(await suggest(appt), null);
  await putRule(rule({ active: false }));
  assert.equal(await suggest(appt), null);
  await putRule(rule());
  const a = await suggest(appt), b = await suggest(appt);
  assert.equal(a.id, b.id);
  assert.equal((await t.sql('SELECT count(*)::int n FROM returns'))[0].n, 1);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='return.suggested'`))[0].n, 1);
});

test('agendar agora: cria o agendamento, marca scheduled e audita', async () => {
  const { id } = await mkReturn();
  const date = weekday('2035-03-01', 1);
  const slots = await t.call('GET', `/returns/${id}/slots?date=${date}`, { token: recep });
  assert.equal(slots.status, 200);
  assert.ok(slots.json.slots.includes('09:00'));
  const res = await t.call('POST', `/returns/${id}/schedule`, { token: recep, body: { startsAt: `${date}T09:00:00-03:00` } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.state, 'scheduled');
  const [r] = await t.sql('SELECT state, generated_appointment_id g FROM returns WHERE id=$1', [id]);
  assert.equal(r.state, 'scheduled');
  const [ap] = await t.sql('SELECT patient_id, procedure_id FROM appointments WHERE id=$1', [r.g]);
  assert.deepEqual(ap, { patient_id: PAT, procedure_id: BOTOX });
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='return.schedule'`))[0].n, 1);
  // já agendado: 409
  assert.equal((await t.call('POST', `/returns/${id}/schedule`, { token: owner, body: { startsAt: `${date}T10:00:00-03:00` } })).status, 409);
});

test('agendar agora: horário ocupado ou fora do expediente dá 409 e não muda o estado', async () => {
  const { id } = await mkReturn();
  const date = weekday('2035-03-01', 1);
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at) VALUES ($1,$2,$3,$4)`,
    [A, PAT, `${date}T10:00:00-03:00`, `${date}T10:30:00-03:00`]);
  const busy = await t.call('POST', `/returns/${id}/schedule`, { token: owner, body: { startsAt: `${date}T10:00:00-03:00` } });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /indispon/);
  const sunday = weekday('2035-03-01', 0);
  assert.equal((await t.call('POST', `/returns/${id}/schedule`, { token: owner, body: { startsAt: `${sunday}T10:00:00-03:00` } })).status, 409);
  assert.equal((await t.call('POST', `/returns/${id}/schedule`, { token: owner, body: { startsAt: 'ontem' } })).status, 400);
  assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [id]))[0].state, 'suggested');
});

test('agendar agora: retorno de outra clínica dá 404; estado declined dá 409', async () => {
  const { id } = await mkReturn();
  const date = weekday('2035-03-01', 2);
  const other = await t.tokenFor('b@demo.test');
  assert.equal((await t.call('POST', `/returns/${id}/schedule`, { token: other, body: { startsAt: `${date}T09:00:00-03:00` } })).status, 404);
  assert.equal((await t.call('GET', `/returns/${id}/slots?date=${date}`, { token: other })).status, 404);
  await t.sql(`UPDATE returns SET state='declined' WHERE id=$1`, [id]);
  assert.equal((await t.call('POST', `/returns/${id}/schedule`, { token: owner, body: { startsAt: `${date}T09:00:00-03:00` } })).status, 409);
});

test('returnsTick: remind_later vencido volta a suggested; futuro permanece; idempotente', async () => {
  const past = await mkReturn('remind_later', { remindOn: '2020-01-01' });
  const future = await mkReturn('remind_later', { remindOn: '2099-01-01' });
  await mod.returnsTick(); await mod.returnsTick();
  const st = async (id) => (await t.sql('SELECT state FROM returns WHERE id=$1', [id]))[0].state;
  assert.equal(await st(past.id), 'suggested');
  assert.equal(await st(future.id), 'remind_later');
});

test('returnsTick: agendamento gerado concluído vira done', async () => {
  const { id } = await mkReturn('scheduled');
  const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, status)
    VALUES ($1,$2,$3,'2035-03-05T12:00Z','2035-03-05T12:30Z','scheduled') RETURNING id`, [A, PAT, BOTOX]);
  await t.sql('UPDATE returns SET generated_appointment_id=$2 WHERE id=$1', [id, ap.id]);
  await mod.returnsTick();
  assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [id]))[0].state, 'scheduled');
  await t.sql(`UPDATE appointments SET status='done', completed_at=now() WHERE id=$1`, [ap.id]);
  await mod.returnsTick(); await mod.returnsTick();
  assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [id]))[0].state, 'done');
});

test('returnsTick: novo atendimento do mesmo procedimento encerra o retorno em aberto', async () => {
  const a = await mkReturn('no_response');
  const b = await mkReturn('suggested'); // origem em 2030-03-15, outro atendimento (mesma data)
  await doneAppt('2030-09-01T15:00:00Z', '10000000-0000-0000-0000-000000000002'); // outro procedimento: não conta
  await mod.returnsTick();
  assert.deepEqual((await t.sql(`SELECT state FROM returns`)).map((x) => x.state), ['no_response', 'suggested']);
  await doneAppt('2030-09-01T15:00:00Z'); // mesmo procedimento, depois da origem
  await mod.returnsTick(); await mod.returnsTick();
  for (const r of [a, b]) assert.equal((await t.sql('SELECT state FROM returns WHERE id=$1', [r.id]))[0].state, 'done');
});

test('tick: não roda followup nem enfileira mensagem por causa de retornos', async () => {
  await t.sql(`UPDATE appointments SET completed_at = now() - interval '36 hours' WHERE status='done'`); // followup dispararia
  await mkReturn('remind_later', { remindOn: '2020-01-01' });
  const before = (await t.sql(`SELECT count(*)::int n FROM message_queue`))[0].n;
  const r = await jobs.tick(new Date('2030-03-15T08:00:00Z')); // 05:00 SP: sem aniversário
  assert.ok(!('followup' in r));
  assert.equal(r.returnsTick, 'ok');
  assert.equal((await t.sql(`SELECT count(*)::int n FROM message_queue WHERE kind='followup'`))[0].n, 0);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM message_queue`))[0].n, before);
  assert.equal(typeof jobs.tasks.followup, 'function'); // continua exportada
  assert.equal(fetch.mock.calls.length, 0, 'nenhuma chamada externa');
});
