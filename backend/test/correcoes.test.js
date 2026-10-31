import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, waitFor } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const PROC = '10000000-0000-0000-0000-000000000002'; // Limpeza de pele, R$ 250
const CAT_IN = '30000000-0000-0000-0000-000000000001';
const owner = () => t.tokenFor('gestor@demo.test');
const rec = () => t.tokenFor('recepcao@demo.test');
const slot = (h) => { const s = new Date(Date.UTC(2031, 0, 6, h + 3)); return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 3600e3).toISOString() }; };
const newPatient = async (token, extra = {}) =>
  (await t.call('POST', '/patients', { token, body: { fullName: 'Marta Teste', phone: '(11) 98765-4321', marketingConsent: true, ...extra } })).json;
const book = async (token, patientId, h = 9, extra = {}) =>
  (await t.call('POST', '/appointments', { token, body: { patientId, procedureId: PROC, ...slot(h), ...extra } })).json;
const queue = () => t.sql('SELECT kind, body FROM message_queue ORDER BY kind');
// O aviso é enfileirado em segundo plano (não atrasa a resposta da agenda): espera chegar ao número esperado.
const queueWith = async (n) => { await waitFor(async () => (await queue()).length >= n); await new Promise((r) => setTimeout(r, 60)); return queue(); };

// ---------- Estoque ----------
test('estoque: concluir sem lote com saldo insuficiente é recusado e o atendimento não fecha; com saldo baixa certo', async () => {
  const o = await owner();
  const semSaldo = (await t.call('POST', '/products', { token: o, body: { name: 'Ácido teste', minQuantity: 1, targetQuantity: 5 } })).json;
  const p = await newPatient(o); const a = await book(o, p.id);
  const r = await t.call('POST', `/appointments/${a.id}/conclude`, { token: o, body: { confirmed: true, applications: [{ productId: semSaldo.id, units: 1 }] } });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'insufficient_stock');
  assert.equal((await t.sql('SELECT status FROM appointments WHERE id=$1', [a.id]))[0].status, 'scheduled', 'nada fechou');
  assert.equal((await t.sql('SELECT count(*)::int AS n FROM applications'))[0].n, 0);

  const comSaldo = (await t.call('POST', '/products', { token: o, body: { name: 'Gel teste', minQuantity: 1, targetQuantity: 5, quantity: 2 } })).json;
  const ok = await t.call('POST', `/appointments/${a.id}/conclude`, { token: o, body: { confirmed: true, applications: [{ productId: comSaldo.id, units: 1 }] } });
  assert.equal(ok.status, 200);
  assert.equal(Number((await t.sql('SELECT quantity FROM products WHERE id=$1', [comSaldo.id]))[0].quantity), 1);
  const soma = (await t.sql('SELECT sum(delta)::float AS s FROM stock_movements WHERE product_id=$1', [comSaldo.id]))[0].s;
  assert.equal(soma, 1, 'o histórico fecha com o saldo (2 de entrada - 1 de uso)');
});

test('produtos: quantidade inicial entra no histórico; nome repetido 409; edição; custo só dono/gerente', async () => {
  const o = await owner(), r = await rec();
  const p = (await t.call('POST', '/products', { token: o, body: { name: 'Sérum X', minQuantity: 2, targetQuantity: 8, quantity: 5, unitCost: 30 } })).json;
  assert.equal(Number(p.quantity), 5);
  assert.equal((await t.sql('SELECT delta::float AS d, reason FROM stock_movements WHERE product_id=$1', [p.id]))[0].d, 5);
  assert.equal((await t.call('POST', '/products', { token: o, body: { name: '  sérum x ', minQuantity: 1, targetQuantity: 2 } })).status, 409);
  const ed = await t.call('PATCH', `/products/${p.id}`, { token: o, body: { name: 'Sérum X2', unitCost: 35, minQuantity: 3 } });
  assert.equal(ed.status, 200); assert.equal(ed.json.name, 'Sérum X2'); assert.equal(Number(ed.json.unit_cost), 35);
  assert.equal(Number((await t.sql('SELECT quantity FROM products WHERE id=$1', [p.id]))[0].quantity), 5, 'o saldo não muda pela edição');
  assert.equal((await t.call('PATCH', `/products/${p.id}`, { token: r, body: { unitCost: 1 } })).status, 403, 'custo é dado financeiro');
  assert.equal((await t.call('PATCH', `/products/${p.id}`, { token: r, body: { minQuantity: 4 } })).status, 200, 'recepção ajusta o mínimo');
});

// ---------- Cadastros ----------
test('procedimentos: nome repetido 409, edição de preço, desativar tira da lista; recepção não edita', async () => {
  const o = await owner(), r = await rec();
  assert.equal((await t.call('POST', '/procedures', { token: o, body: { name: ' limpeza DE pele ', defaultPrice: 99 } })).status, 409);
  const novo = (await t.call('POST', '/procedures', { token: o, body: { name: 'Peeling X', defaultPrice: 200, durationMin: 45 } })).json;
  const ed = await t.call('PATCH', `/procedures/${novo.id}`, { token: o, body: { defaultPrice: 220 } });
  assert.equal(ed.status, 200); assert.equal(Number(ed.json.default_price), 220);
  assert.equal((await t.call('PATCH', `/procedures/${novo.id}`, { token: o, body: { name: 'Limpeza de pele' } })).status, 409);
  assert.equal((await t.call('PATCH', `/procedures/${novo.id}`, { token: r, body: { defaultPrice: 1 } })).status, 403);
  assert.equal((await t.call('PATCH', `/procedures/${novo.id}`, { token: o, body: {} })).status, 400);
  await t.call('PATCH', `/procedures/${novo.id}`, { token: o, body: { active: false } });
  assert.ok(!(await t.call('GET', '/procedures', { token: o })).json.some((x) => x.id === novo.id));
});

test('pacientes: duplicidade por nome+telefone pede confirmação; endereço e observações; campo desconhecido é erro', async () => {
  const r = await rec(), o = await owner();
  const a = await t.call('POST', '/patients', { token: r, body: { fullName: 'Bruno Costa', phone: '(11) 98765-4321', address: 'Rua A, 10', notes: 'prefere manhã', email: 'b@x.com' } });
  assert.equal(a.status, 201);
  const dup = await t.call('POST', '/patients', { token: r, body: { fullName: ' bruno costa', phone: '11987654321' } });
  assert.equal(dup.status, 409); assert.equal(dup.json.code, 'possible_duplicate'); assert.equal(dup.json.existingId, a.json.id);
  assert.equal((await t.call('POST', '/patients', { token: r, body: { fullName: 'Bruno Costa', phone: '(11) 98765-4321', confirmDuplicate: true } })).status, 201);
  assert.equal((await t.call('POST', '/patients', { token: r, body: { fullName: 'Bruno Costa', phone: '(11) 91111-2222' } })).status, 201, 'outro telefone = outra pessoa');
  const ficha = (await t.call('GET', `/patients/${a.json.id}`, { token: o })).json;
  assert.equal(ficha.address, 'Rua A, 10'); assert.equal(ficha.notes, 'prefere manhã'); assert.equal(ficha.email, 'b@x.com');
  assert.equal((await t.call('POST', '/patients', { token: r, body: { fullName: 'Com Campo Extra', foo: 'bar' } })).status, 400);
  assert.equal((await t.call('PATCH', `/patients/${a.json.id}`, { token: r, body: { address: 'Rua B, 20' } })).status, 200);
  assert.equal((await t.sql('SELECT address FROM patients WHERE id=$1', [a.json.id]))[0].address, 'Rua B, 20');
});

test('LGPD: o endereço entra na exportação e some na anonimização', async () => {
  const o = await owner();
  const p = await newPatient(o, { address: 'Rua Secreta, 1' });
  const exp = (await t.call('GET', `/lgpd/patients/${p.id}/export`, { token: o })).json;
  assert.equal(JSON.stringify(exp).includes('Rua Secreta'), true);
  const an = await t.call('POST', `/lgpd/patients/${p.id}/anonymize`, { token: o, body: { confirmName: 'Marta Teste', acknowledge: true } });
  assert.equal(an.status, 200);
  assert.equal((await t.sql('SELECT address FROM patients WHERE id=$1', [p.id]))[0].address, null);
});

test('profissionais: qualquer perfil lista quem atende, sem e-mail; atendimentos trazem o nome do profissional', async () => {
  const o = await owner(), r = await rec();
  await t.call('POST', '/team', { token: o, body: { name: 'Dra. Helena', email: 'h@x.com', password: 'Senha@12345', role: 'professional' } });
  const l = await t.call('GET', '/professionals', { token: r });
  assert.equal(l.status, 200);
  assert.ok(l.json.some((x) => x.name === 'Dra. Helena'));
  assert.ok(l.json.every((x) => !('email' in x)));
  assert.ok(!l.json.some((x) => x.role === 'reception'), 'recepção não atende');
  const helena = l.json.find((x) => x.name === 'Dra. Helena');
  const p = await newPatient(o); const a = await book(r, p.id, 9, { professionalId: helena.id });
  const dia = (await t.call('GET', '/appointments?from=2031-01-06&to=2031-01-06', { token: r })).json;
  assert.equal(dia.find((x) => x.id === a.id).professional, 'Dra. Helena');
});

// ---------- Financeiro ----------
test('financeiro: lançamento já pago entra na conta escolhida; pendente edita e cancela; pago não', async () => {
  const o = await owner(), r = await rec();
  const conta = (await t.call('POST', '/banks', { token: o, body: { name: 'Caixa', institution: 'Dinheiro', kind: 'cash' } })).json;
  const pago = await t.call('POST', '/finance/transactions', { token: o, body: { type: 'income', categoryId: CAT_IN, description: 'Adiantamento pacote', amount: 600,
    competenceDate: '2031-01-06', dueDate: '2031-01-06', paid: true, bankAccountId: conta.id } });
  assert.equal(pago.status, 201); assert.equal(pago.json.bank_account_id, conta.id);
  assert.equal((await t.call('GET', '/banks', { token: o })).json.find((b) => b.id === conta.id).balance, 600);
  assert.equal((await t.call('POST', '/finance/transactions', { token: o, body: { type: 'income', categoryId: CAT_IN, description: 'Conta inexistente', amount: 5,
    competenceDate: '2031-01-06', dueDate: '2031-01-06', paid: true, bankAccountId: '99999999-9999-4999-8999-999999999999' } })).status, 404);

  const pend = (await t.call('POST', '/finance/transactions', { token: o, body: { type: 'expense', categoryId: '30000000-0000-0000-0000-000000000003', description: 'Aluguel',
    amount: 2500, competenceDate: '2031-01-06', dueDate: '2031-01-10' } })).json;
  const ed = await t.call('PATCH', `/finance/transactions/${pend.id}`, { token: o, body: { amount: 2400, dueDate: '2031-01-12' } });
  assert.equal(ed.status, 200); assert.equal(Number(ed.json.amount), 2400);
  assert.equal((await t.call('PATCH', `/finance/transactions/${pago.json.id}`, { token: o, body: { amount: 1 } })).status, 404, 'pago não edita');
  assert.equal((await t.call('DELETE', `/finance/transactions/${pago.json.id}`, { token: o })).status, 404, 'pago não cancela');
  assert.equal((await t.call('DELETE', `/finance/transactions/${pend.id}`, { token: r })).status, 403);
  assert.equal((await t.call('DELETE', `/finance/transactions/${pend.id}`, { token: o })).status, 204);
  assert.ok(!(await t.call('GET', '/finance/payables', { token: o })).json.some((x) => x.id === pend.id));
});

test('financeiro: contas a receber trazem o paciente; resumo separa recebido de previsto e o ticket só conta atendimentos', async () => {
  const o = await owner();
  const p = await newPatient(o, { fullName: 'Rita Devedora' });
  const a = await book(o, p.id, 10);
  await t.call('POST', `/appointments/${a.id}/complete`, { token: o });
  const rc = (await t.call('GET', '/finance/receivables', { token: o })).json.find((x) => x.appointment_id === a.id);
  assert.equal(rc.patient, 'Rita Devedora'); assert.equal(rc.procedure, 'Limpeza de pele');
  await t.call('POST', '/finance/transactions', { token: o, body: { type: 'income', categoryId: CAT_IN, description: 'Venda avulsa', amount: 1000,
    competenceDate: '2031-01-06', dueDate: '2031-01-06', paid: true } });
  await t.sql(`UPDATE appointments SET completed_at='2031-01-06T15:00:00Z' WHERE id=$1`, [a.id]);
  await t.sql(`UPDATE transactions SET competence_date='2031-01-06' WHERE appointment_id=$1`, [a.id]);
  const s = (await t.call('GET', '/finance/summary?month=2031-01', { token: o })).json;
  assert.equal(s.incomePending, 250); assert.equal(s.incomeReceived, 1000); assert.equal(s.income, 1250);
  assert.equal(s.averageTicket, 250, 'a venda avulsa de 1000 não infla o ticket');
});

// ---------- Mensagens ----------
test('avisos: agendar, remarcar e cancelar enfileiram só para quem autorizou e tem telefone; concluir não enfileira', async () => {
  const o = await owner();
  const sim = await newPatient(o, { fullName: 'Ana Autorizou' });
  const nao = await newPatient(o, { fullName: 'Nina Naoautorizou', phone: '(11) 97777-6666', marketingConsent: false });
  const a = await book(o, sim.id, 9); await book(o, nao.id, 11);
  assert.deepEqual((await queueWith(1)).map((m) => m.kind), ['booked'], 'sem autorização não se envia');
  assert.match((await queue())[0].body, /Olá, Ana! Seu horário de Limpeza de pele está agendado para 06\/01 às 09:00/);
  await t.call('PATCH', `/appointments/${a.id}`, { token: o, body: slot(14) });
  assert.deepEqual((await queueWith(2)).map((m) => m.kind), ['booked', 'rescheduled']);
  await t.call('PATCH', `/appointments/${a.id}`, { token: o, body: { status: 'canceled' } });
  assert.deepEqual((await queueWith(3)).map((m) => m.kind), ['booked', 'canceled', 'rescheduled']);
  const b = await book(o, sim.id, 16);
  const antes = (await queueWith(4)).length;
  await t.call('POST', `/appointments/${b.id}/complete`, { token: o });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await queue()).length, antes, 'concluir atendimento não enfileira mensagem');
});

test('lembrete: atendimentos de amanhã entram uma vez só, com o modelo da clínica (variáveis com ou sem espaço)', async () => {
  const o = await owner();
  const { reminderTask } = await import('../src/avisos.js');
  const p = await newPatient(o, { fullName: 'Lia Lembrada' });
  const [{ ts }] = await t.sql(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date + 1 + time '12:00') AT TIME ZONE 'America/Sao_Paulo' AS ts`);
  const s = new Date(ts);
  await t.call('POST', '/appointments', { token: o, body: { patientId: p.id, procedureId: PROC, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 3600e3).toISOString() } });
  await queueWith(1); // o aviso de "agendado" chega em segundo plano; só depois limpamos a fila
  await t.sql(`DELETE FROM message_queue`);
  await reminderTask(); await reminderTask();
  assert.equal((await queue()).length, 1, 'idempotente');
  assert.match((await queue())[0].body, /Lia.*Limpeza de pele.*12:00/);
  await t.sql(`DELETE FROM message_queue`);
  assert.equal((await t.call('POST', '/automation/templates', { token: o, body: { kind: 'reminder', body: 'Oi {{ nome }}, amanhã às {{hora}}: {{procedimento}}.' } })).status, 201);
  await reminderTask();
  assert.equal((await queue())[0].body, 'Oi Lia, amanhã às 12:00: Limpeza de pele.');
});

test('modelos de mensagem: variável inexistente é recusada ao salvar', async () => {
  const o = await owner();
  const r = await t.call('POST', '/automation/templates', { token: o, body: { kind: 'birthday', body: 'Parabéns {{apelido}}!' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /apelido/);
  assert.equal((await t.call('POST', '/automation/templates', { token: o, body: { kind: 'birthday', body: 'Parabéns {{ nome }}!' } })).status, 201);
});
