import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, token;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); token = await t.tokenFor('gestor@demo.test'); });

const todayAppt = async () => (await t.sql(`SELECT id FROM appointments WHERE clinic_id=$1 AND status='scheduled'`, [A]))[0].id;
const prevMonth = async () => (await t.sql(`SELECT to_char(date_trunc('month', now()) - interval '1 month','YYYY-MM') m`))[0].m;

test('concluir atendimento: gera recebível categorizado e baixa o estoque do protocolo', async () => {
  const id = await todayAppt();
  const r = await t.call('POST', `/appointments/${id}/complete`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'done');
  const [tx] = await t.sql(`SELECT amount::float a, status, category_id FROM transactions WHERE appointment_id=$1`, [id]);
  assert.deepEqual([tx.a, tx.status], [1200, 'pending']);
  assert.ok(tx.category_id, 'recebível precisa de categoria para entrar no DRE');
  const [p] = await t.sql(`SELECT quantity::float q FROM products WHERE id='40000000-0000-0000-0000-000000000001'`);
  assert.equal(p.q, 0.5); // 1 − 0,5 do protocolo
  const [m] = await t.sql(`SELECT delta::float d, reason FROM stock_movements WHERE appointment_id=$1`, [id]);
  assert.deepEqual([m.d, m.reason], [-0.5, 'usage']);
});

test('concluir duas vezes dá 409 e não duplica receita nem baixa estoque de novo', async () => {
  const id = await todayAppt();
  await t.call('POST', `/appointments/${id}/complete`, { token });
  assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token })).status, 409);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM transactions WHERE appointment_id=$1`, [id]))[0].n, 1);
  assert.equal((await t.sql(`SELECT quantity::float q FROM products WHERE id='40000000-0000-0000-0000-000000000001'`))[0].q, 0.5);
});

test('cancelado não pode ser concluído', async () => {
  const id = await todayAppt();
  assert.equal((await t.call('PATCH', `/appointments/${id}`, { token, body: { status: 'canceled' } })).status, 200);
  assert.equal((await t.call('POST', `/appointments/${id}/complete`, { token })).status, 409);
});

test('estoque: saída maior que o saldo é recusada e nada muda', async () => {
  const luvas = '40000000-0000-0000-0000-000000000002';
  const r = await t.call('POST', `/products/${luvas}/movements`, { token, body: { delta: -999, reason: 'loss' } });
  assert.equal(r.status, 409);
  assert.equal((await t.sql('SELECT quantity::float q FROM products WHERE id=$1', [luvas]))[0].q, 10);
  assert.equal((await t.sql('SELECT count(*)::int n FROM stock_movements WHERE product_id=$1', [luvas]))[0].n, 0);
});

test('estoque: entrada soma ao saldo, registra histórico e tira o item da lista de reposição', async () => {
  const toxina = '40000000-0000-0000-0000-000000000001';
  assert.equal((await t.call('GET', '/stock/restock', { token })).json[0].qty_to_buy, 5); // alvo 6 − 1
  const r = await t.call('POST', `/products/${toxina}/movements`, { token, body: { delta: 5, reason: 'purchase' } });
  assert.equal(Number(r.json.quantity), 6);
  assert.equal((await t.call('GET', '/stock/restock', { token })).json.length, 0);
});

test('estoque: delta zero e motivo inválido são rejeitados', async () => {
  const toxina = '40000000-0000-0000-0000-000000000001';
  assert.equal((await t.call('POST', `/products/${toxina}/movements`, { token, body: { delta: 0, reason: 'purchase' } })).status, 400);
  assert.equal((await t.call('POST', `/products/${toxina}/movements`, { token, body: { delta: 1, reason: 'usage' } })).status, 400);
});

test('DRE do mês anterior bate com os dados do seed', async () => {
  const r = await t.call('GET', `/finance/dre?month=${await prevMonth()}`, { token });
  assert.equal(r.json.receitaBruta, 3000);
  assert.equal(r.json.despesasOperacionais, 2500);
  assert.equal(r.json.resultadoOperacional, 500);
  assert.equal(r.json.lucroLiquido, 500);
});

test('resumo financeiro: saldo = receitas − despesas e ticket médio = receita / atendimentos', async () => {
  const s = (await t.call('GET', `/finance/summary?month=${await prevMonth()}`, { token })).json;
  assert.deepEqual([s.income, s.expense, s.balance, s.proceduresDone, s.averageTicket], [3000, 2500, 500, 2, 1500]);
});

test('faturamento por mês e procedimentos mais realizados', async () => {
  const d = (await t.call('GET', '/dashboard', { token })).json;
  assert.equal(d.revenueByMonth.length, 6);
  assert.ok(d.revenueByMonth.every((m) => /^\d{4}-\d{2}$/.test(m.month) && m.revenue > 0 && m.patients > 0));
  assert.ok(d.topProcedures.length > 0 && d.topProcedures[0].total >= d.topProcedures.at(-1).total);
  assert.equal(d.today.length, 1);
});

test('baixar conta: pendente vira paga uma única vez', async () => {
  const [tx] = await t.sql(`SELECT id FROM transactions WHERE clinic_id=$1 AND status='pending'`, [A]);
  const ok = await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token });
  assert.equal(ok.json.status, 'paid');
  assert.equal((await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token })).status, 404);
});

test('validação: dados inválidos viram 400 com detalhes', async () => {
  assert.equal((await t.call('POST', '/procedures', { token, body: { name: 'x' } })).status, 400);
  assert.equal((await t.call('POST', '/procedures', { token, body: { name: 'Ok', defaultPrice: -5 } })).status, 400);
  assert.equal((await t.call('POST', '/appointments/nao-e-uuid/complete', { token })).status, 400);
  assert.equal((await t.call('GET', '/finance/summary?month=2026-13x', { token })).status, 400);
  assert.equal((await t.call('PATCH', `/appointments/${await todayAppt()}`, { token, body: { startsAt: '2030-01-01T10:00:00Z' } })).status, 400);
});

test('criar e reagendar agendamento; preço padrão vem do procedimento', async () => {
  const body = { patientId: '20000000-0000-0000-0000-000000000003', procedureId: '10000000-0000-0000-0000-000000000002',
    startsAt: '2030-05-01T13:00:00Z', endsAt: '2030-05-01T14:00:00Z' };
  const c = await t.call('POST', '/appointments', { token, body });
  assert.equal(c.status, 201);
  assert.equal(Number(c.json.price), 250);
  const p = await t.call('PATCH', `/appointments/${c.json.id}`, { token, body: { startsAt: '2030-05-02T13:00:00Z', endsAt: '2030-05-02T14:00:00Z' } });
  assert.equal(new Date(p.json.starts_at).toISOString(), '2030-05-02T13:00:00.000Z');
});

test('cadastros: categoria, lançamento, protocolo e regras de automação', async () => {
  const cat = await t.call('POST', '/categories', { token, body: { name: 'Marketing', kind: 'expense', dreGroup: 'despesas_operacionais' } });
  assert.equal(cat.status, 201);
  const tx = await t.call('POST', '/finance/transactions', { token, body: { type: 'expense', categoryId: cat.json.id,
    description: 'Anúncios', amount: 300, competenceDate: '2030-01-10', dueDate: '2030-01-15' } });
  assert.equal(tx.status, 201);
  const proto = await t.call('POST', '/protocols', { token, body: { name: 'Limpeza', instructions: 'Higienizar e esfoliar',
    procedureId: '10000000-0000-0000-0000-000000000002', items: [{ productId: '40000000-0000-0000-0000-000000000002', quantity: 2 }] } });
  assert.equal(proto.status, 201);
  const tpl = await t.call('POST', '/automation/templates', { token, body: { kind: 'followup', body: 'Olá {{nome}}, tudo bem?' } });
  const rule = await t.call('POST', '/automation/followup-rules', { token, body: { daysAfter: 2, templateId: tpl.json.id } });
  assert.equal(rule.status, 201);
});

test('fluxo de caixa: 6 meses com o que foi efetivamente pago, só da própria clínica', async () => {
  const r = await t.call('GET', '/finance/cashflow', { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 6);
  const [{ m }] = await t.sql(`SELECT to_char(now(), 'YYYY-MM') m`);
  assert.equal(r.json.at(-1).month, m);
  const [paid] = await t.sql(`SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0)::float i,
    COALESCE(SUM(amount) FILTER (WHERE type='expense'),0)::float e FROM transactions
    WHERE clinic_id=$1 AND status='paid' AND paid_at >= date_trunc('month', now()) - interval '5 months'`, [A]);
  assert.equal(r.json.reduce((a, x) => a + x.income, 0), paid.i);
  assert.equal(r.json.reduce((a, x) => a + x.expense, 0), paid.e);
  assert.ok(paid.i > 0 && paid.e > 0, 'o seed precisa ter entradas e saídas pagas');
  const other = await t.call('GET', '/finance/cashflow', { token: await t.tokenFor('b@demo.test') });
  assert.deepEqual(other.json.map((x) => x.income + x.expense), [0, 0, 0, 0, 0, 0]);
});
