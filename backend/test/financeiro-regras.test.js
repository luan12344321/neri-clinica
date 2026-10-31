import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const CAT_IN = '30000000-0000-0000-0000-000000000001';
const owner = () => t.tokenFor('gestor@demo.test');
const rec = () => t.tokenFor('recepcao@demo.test');
const novo = (token, body) => t.call('POST', '/finance/transactions', { token, body: { type: 'income', categoryId: CAT_IN, description: 'Pacote', competenceDate: '2031-01-31', dueDate: '2031-01-31', ...body } });

test('parcelamento: divide em centavos (a sobra vai na 1ª), vence mês a mês e a soma fecha', async () => {
  const r = await novo(await owner(), { amount: 100, installments: 3 });
  assert.equal(r.status, 201);
  const p = r.json.installments;
  assert.deepEqual(p.map((x) => +x.amount), [33.34, 33.33, 33.33]);
  assert.deepEqual(p.map((x) => x.due_date.slice(0, 10)), ['2031-01-31', '2031-02-28', '2031-03-31']);
  assert.deepEqual(p.map((x) => x.description), ['Pacote (1/3)', 'Pacote (2/3)', 'Pacote (3/3)']);
  assert.equal(new Set(p.map((x) => x.installment_group)).size, 1);
  assert.ok(p.every((x) => x.status === 'pending' && x.installments_total === 3));
});

test('desconto: o valor guardado é o líquido, parcelado reparte o desconto e desconto >= valor é recusado', async () => {
  const o = await owner();
  const r = await novo(o, { amount: 300, discount: 30, installments: 2 });
  const p = r.json.installments;
  assert.deepEqual(p.map((x) => +x.amount), [135, 135]);
  assert.deepEqual(p.map((x) => +x.discount), [15, 15]);
  assert.equal((await novo(o, { amount: 50, discount: 50 })).status, 400);
  assert.equal((await novo(o, { amount: 50, discount: 10, paid: true, installments: 2 })).status, 400, 'pago não parcela');
});

test('desconto adicional num pendente abate do valor; maior que o valor é recusado; pago não recebe', async () => {
  const o = await owner();
  const l = (await novo(o, { amount: 200 })).json;
  const d = await t.call('PATCH', `/finance/transactions/${l.id}`, { token: o, body: { discount: 50 } });
  assert.equal(+d.json.amount, 150); assert.equal(+d.json.discount, 50);
  assert.equal((await t.call('PATCH', `/finance/transactions/${l.id}`, { token: o, body: { discount: 150 } })).status, 404);
  assert.equal((await t.call('PATCH', `/finance/transactions/${l.id}`, { token: o, body: { discount: 5, amount: 90 } })).status, 400);
});

test('estorno: tira do recebido e do saldo da conta, guarda motivo, só vale para pago e só dono/gerente', async () => {
  const o = await owner();
  const antes = (await t.call('GET', '/finance/summary?month=2031-01', { token: o })).json;
  const l = (await novo(o, { amount: 400, paid: true })).json;
  const meio = (await t.call('GET', '/finance/summary?month=2031-01', { token: o })).json;
  assert.equal(meio.incomeReceived - antes.incomeReceived, 400);
  assert.equal((await t.call('POST', `/finance/transactions/${l.id}/refund`, { token: o, body: {} })).status, 400, 'motivo obrigatório');
  assert.equal((await t.call('POST', `/finance/transactions/${l.id}/refund`, { token: await rec(), body: { reason: 'Paciente desistiu' } })).status, 403);
  const e = await t.call('POST', `/finance/transactions/${l.id}/refund`, { token: o, body: { reason: 'Paciente desistiu' } });
  assert.equal(e.status, 200); assert.equal(e.json.status, 'refunded'); assert.equal(e.json.refund_reason, 'Paciente desistiu');
  const depois = (await t.call('GET', '/finance/summary?month=2031-01', { token: o })).json;
  assert.equal(depois.incomeReceived, antes.incomeReceived);
  assert.equal((await t.call('POST', `/finance/transactions/${l.id}/refund`, { token: o, body: { reason: 'de novo' } })).status, 404, 'não estorna duas vezes');
  const pend = (await novo(o, { amount: 10 })).json;
  assert.equal((await t.call('POST', `/finance/transactions/${pend.id}/refund`, { token: o, body: { reason: 'pendente' } })).status, 404);
  const lista = (await t.call('GET', '/finance/transactions', { token: o })).json;
  assert.ok(lista.some((x) => x.id === l.id && x.status === 'refunded'), 'continua no histórico');
});
