import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t, askSara;
before(async () => { t = await setup(); ({ askSara } = await import('../src/sara.js')); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const usage = { input: 1, output: 1 };
const OWNER = 'gestor@demo.test', RECEPTION = 'recepcao@demo.test';
const P1 = '20000000-0000-0000-0000-000000000001', PB = '2b000000-0000-0000-0000-000000000001';
const MONDAY = '2030-03-18';

// Executa UMA ferramenta pelo caminho real (askSara -> permissão -> SQL) e devolve a resposta que o modelo veria.
async function run(email, name, args = {}, clinicId = A) {
  const calls = [];
  const client = { generate: async (req) => {
    calls.push(structuredClone(req));
    return calls.length === 1 ? { parts: [{ functionCall: { name, args } }], usage } : { parts: [{ text: 'ok' }], usage };
  } };
  const [u] = await t.sql('SELECT id, role FROM users WHERE email=$1', [email]);
  await askSara({ clinicId, userId: u.id, role: u.role, ip: '1.2.3.4', message: 'pergunta', client });
  return { res: calls[1].contents.at(-1).parts[0].functionResponse.response, declared: calls[0].tools.map((x) => x.name) };
}
const setRole = (email, role) => t.sql('UPDATE users SET role=$2 WHERE email=$1', [email, role]);
const audited = async (action) => (await t.sql('SELECT 1 FROM audit_log WHERE action=$1', [action])).length;

test('count_patients: conta só a clínica do usuário', async () => {
  const [{ n }] = await t.sql('SELECT count(*)::int n FROM patients WHERE clinic_id=$1', [A]);
  const { res } = await run(OWNER, 'count_patients');
  assert.equal(res.result.total, n);
  assert.equal((await run('b@demo.test', 'count_patients', {}, B)).res.result.total, 1);
});

test('patient_profile: dono vê CPF mascarado e total gasto; recepção vê só o operacional; outra clínica não existe', async () => {
  const owner = await t.tokenFor(OWNER);
  assert.equal((await t.call('PUT', `/patients/${P1}/cpf`, { token: owner, body: { cpf: '529.982.247-25' } })).status, 200);
  const o = (await run(OWNER, 'patient_profile', { patientId: P1 })).res.result;
  assert.equal(o.cpf, '***.***.***-25');
  assert.ok(!JSON.stringify(o).includes('52998224725') && typeof o.total_gasto === 'number');
  assert.ok(o.concluidos >= 1 && Array.isArray(o.procedimentos) && Array.isArray(o.ultimos_atendimentos));
  const r = (await run(RECEPTION, 'patient_profile', { patientId: P1 })).res.result;
  assert.ok(!('cpf' in r) && !('total_gasto' in r), 'recepção: sem CPF e sem valores');
  assert.match((await run(OWNER, 'patient_profile', { patientId: PB })).res.error, /não encontrado/);
  assert.ok(await audited('sara.patient_profile'));
});

test('patient_records: só dono e profissional; texto vem do prontuário real; recepção nem enxerga a ferramenta', async () => {
  const owner = await t.tokenFor(OWNER);
  assert.equal((await t.call('POST', `/patients/${P1}/records`, { token: owner, body: { allergies: 'Dipirona', evolution: 'Retorno em 30 dias', anamnesis: { queixa: 'rugas' } } })).status, 201);
  const o = await run(OWNER, 'patient_records', { patientId: P1 });
  assert.equal(o.res.result.registros[0].alergias, 'Dipirona');
  assert.equal(o.res.result.registros[0].anamnese.queixa, 'rugas');
  assert.ok(await audited('sara.patient_records'));
  const r = await run(RECEPTION, 'patient_records', { patientId: P1 });
  assert.ok(!r.declared.includes('patient_records'));
  assert.match(r.res.error, /indisponível/);
  await setRole(RECEPTION, 'manager');
  assert.ok(!(await run(RECEPTION, 'patient_records', { patientId: P1 })).declared.includes('patient_records'), 'gerente não recebe o prontuário pela Julia');
  await setRole(RECEPTION, 'professional');
  assert.equal((await run(RECEPTION, 'patient_records', { patientId: P1 })).res.result.registros[0].alergias, 'Dipirona');
  assert.match((await run(OWNER, 'patient_records', { patientId: PB })).res.error, /não encontrado/, 'paciente de outra clínica');
  const vazio = await run(OWNER, 'patient_records', { patientId: '20000000-0000-0000-0000-000000000002' });
  assert.match(vazio.res.result.aviso, /sem prontuário/, 'sem registro: avisa em vez de inventar');
});

test('search_appointments: detalhes com id, contagem por status e filtros; limite de intervalo', async () => {
  const { res } = await run(OWNER, 'search_appointments', { from: '2000-01-01', to: '2000-03-31' });
  assert.deepEqual(res.result.itens, []);
  const todos = (await run(OWNER, 'search_appointments', { from: '2020-01-01', to: '2020-06-30' })).res;
  assert.match(todos.error, /intervalo/, 'mais de 92 dias é recusado');
  const [a] = await t.sql(`SELECT a.id, p.full_name, a.starts_at FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.clinic_id=$1 ORDER BY a.starts_at DESC LIMIT 1`, [A]);
  const dia = new Date(a.starts_at).toISOString().slice(0, 10);
  const r = (await run(RECEPTION, 'search_appointments', { from: dia, to: dia, patient: a.full_name.slice(0, 6) })).res.result;
  assert.ok(r.itens.some((x) => x.id === a.id && x.paciente === a.full_name), 'inclui o agendamento real, com id');
  assert.ok(Object.keys(r.resumo_por_status).length >= 1);
  assert.equal((await run('b@demo.test', 'search_appointments', { from: dia, to: dia }, B)).res.result.itens.length, 0, 'clínica B não vê a agenda da A');
});

test('estoque: lista completa, sem estoque e movimentações (todos os perfis)', async () => {
  await t.sql(`INSERT INTO products (clinic_id, name, unit, quantity, min_quantity, target_quantity) VALUES ($1,'Gaze estéril','pct',0,2,5)`, [A]);
  await t.sql(`INSERT INTO stock_movements (clinic_id, product_id, delta, reason) SELECT $1, id, -1, 'usage' FROM products WHERE name='Luvas M'`, [A]);
  const todos = (await run(RECEPTION, 'list_products')).res.result.itens;
  assert.ok(todos.length >= 3 && todos.some((p) => p.produto === 'Luvas M'));
  const zerados = (await run(RECEPTION, 'list_products', { onlyOut: true })).res.result.itens;
  assert.deepEqual(zerados.map((p) => p.produto), ['Gaze estéril']);
  const mov = (await run(RECEPTION, 'stock_movements', { product: 'Luvas' })).res.result.itens;
  assert.equal(mov.length, 1);
  assert.equal(mov[0].variacao, -1);
  assert.equal((await run('b@demo.test', 'list_products', {}, B)).res.result.itens.length, 0);
});

test('financeiro detalhado: lançamentos, inadimplência, fluxo de caixa e comparativo só para dono/gerente', async () => {
  await t.sql(`INSERT INTO transactions (clinic_id, type, description, amount, competence_date, due_date, status)
               VALUES ($1,'income','Parcela atrasada',777.5, current_date - 40, current_date - 30, 'pending')`, [A]);
  const od = (await run(OWNER, 'list_transactions', { status: 'overdue', type: 'income' })).res.result;
  assert.equal(od.total_registros, 1);
  assert.equal(od.itens[0].descricao, 'Parcela atrasada');
  assert.equal(od.soma_total, 777.5);
  const pag = (await run(OWNER, 'list_transactions', { limit: 1 })).res.result;
  assert.equal(pag.itens.length, 1);
  assert.equal(pag.truncado, true);
  assert.ok(pag.total_registros > 1);
  assert.equal((await run(OWNER, 'cash_flow', { months: 3 })).res.result.length, 3);
  const cmp = (await run(OWNER, 'compare_months', { months: 3 })).res.result;
  assert.equal(cmp.length, 3);
  assert.ok(cmp.every((m) => /^\d{4}-\d{2}$/.test(m.mes) && 'income' in m));
  assert.ok(await audited('sara.list_transactions'));
  for (const nome of ['list_transactions', 'cash_flow', 'compare_months']) {
    const r = await run(RECEPTION, nome, { months: 3 });
    assert.ok(!r.declared.includes(nome), `${nome}: recepção não recebe a ferramenta`);
    assert.match(r.res.error, /indisponível/);
  }
  await setRole(RECEPTION, 'professional');
  assert.ok(!(await run(RECEPTION, 'cash_flow', { months: 3 })).declared.includes('cash_flow'), 'profissional também não vê financeiro');
  await setRole(RECEPTION, 'manager');
  assert.equal((await run(RECEPTION, 'cash_flow', { months: 2 })).res.result.length, 2, 'gerente vê');
  assert.equal((await run('b@demo.test', 'list_transactions', {}, B)).res.result.total_registros, 0, 'clínica B não vê os lançamentos da A');
});

test('report_summary: dinheiro só aparece para dono/gerente', async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  const o = (await run(OWNER, 'report_summary', { period: 'month', date: hoje })).res.result;
  assert.ok(o.financeiro && typeof o.financeiro.saldo === 'number');
  assert.ok(o.periodo.de.endsWith('-01') && 'atendimentos_por_status' in o);
  const w = (await run(RECEPTION, 'report_summary', { period: 'week', date: MONDAY })).res.result;
  assert.ok(!('financeiro' in w));
  assert.equal(new Date(`${w.periodo.de}T12:00:00Z`).getUTCDay(), 1, 'semana começa na segunda');
  assert.equal(new Date(`${w.periodo.ate}T12:00:00Z`).getUTCDay(), 0, 'e termina no domingo');
});

test('remarcar e cancelar: confirmação obrigatória, disponibilidade revalidada, perfis e isolamento', async () => {
  const [{ id: pro }] = await t.sql('SELECT id FROM users WHERE email=$1', [OWNER]);
  const mk = async (hhmm, mins = 30, clinic = A, patient = P1) => (await t.sql(
    `INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'scheduled') RETURNING id`,
    [clinic, patient, `${MONDAY}T${hhmm}:00-03:00`, new Date(new Date(`${MONDAY}T${hhmm}:00-03:00`).getTime() + mins * 60000).toISOString()]))[0].id;
  const hora = async (id) => (await t.sql(`SELECT to_char(starts_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') h, to_char(ends_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') f, status FROM appointments WHERE id=$1`, [id]))[0];
  const a1 = await mk('14:00', 60), a2 = await mk('16:00');
  const re = (id, hh, extra = {}) => run(RECEPTION, 'reschedule_appointment', { appointmentId: id, startsAt: `${MONDAY}T${hh}:00-03:00`, confirmed: true, ...extra });

  assert.equal((await re(a1, '15:00', { confirmed: false })).res.error, 'argumentos inválidos');
  assert.deepEqual(await hora(a1), { h: '14:00', f: '15:00', status: 'scheduled' }, 'sem confirmação nada muda');
  assert.match((await re(a1, '16:00')).res.error, /indisponível/, 'horário ocupado por outro agendamento');
  assert.match((await re(a1, '12:00')).res.error, /indisponível/, 'fora do expediente');
  assert.equal((await re(a1, '14:30')).res.result.ok, true, 'pode sobrepor o próprio horário antigo');
  assert.deepEqual(await hora(a1), { h: '14:30', f: '15:30', status: 'scheduled' }, 'mantém a duração de 60 min');
  assert.ok(await audited('sara.reschedule_appointment'));

  const outra = await mk('10:00', 30, B, PB);
  assert.match((await re(outra, '10:30')).res.error, /não encontrado/, 'agendamento de outra clínica');

  assert.match((await run(RECEPTION, 'cancel_appointment', { appointmentId: a2, confirmed: false })).res.error, /inválidos/);
  assert.equal((await hora(a2)).status, 'scheduled');
  assert.equal((await run(RECEPTION, 'cancel_appointment', { appointmentId: a2, confirmed: true })).res.result.status, 'canceled');
  assert.equal((await hora(a2)).status, 'canceled');
  assert.match((await run(RECEPTION, 'cancel_appointment', { appointmentId: a2, confirmed: true })).res.error, /encerrado/, 'não cancela duas vezes');
  assert.match((await run(RECEPTION, 'cancel_appointment', { appointmentId: outra, confirmed: true })).res.error, /não encontrado/);
  assert.equal((await hora(outra)).status, 'scheduled', 'a clínica B não foi tocada');
  assert.ok(await audited('sara.cancel_appointment'));

  await setRole(RECEPTION, 'professional');
  for (const nome of ['reschedule_appointment', 'cancel_appointment']) {
    const r = await run(RECEPTION, nome, { appointmentId: a1, startsAt: `${MONDAY}T15:00:00-03:00`, confirmed: true });
    assert.ok(!r.declared.includes(nome), `profissional não recebe ${nome}`);
  }
  assert.ok(pro, 'usuário dono existe');
});
