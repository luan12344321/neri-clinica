import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const P = '20000000-0000-0000-0000-000000000001';

// A recepção (secretária) trabalha com agenda, pacientes e estoque. Nada de dinheiro, custos, mensagens, CPF, prontuário ou equipe.
test('recepção: tudo que é de dono/gerente responde 403', async () => {
  const rec = await t.tokenFor('recepcao@demo.test');
  const proibidos = [
    ['GET', '/finance/summary?month=2026-10'], ['GET', '/finance/top-procedures'], ['GET', '/finance/cashflow'], ['GET', '/finance/dre?month=2026-10'],
    ['GET', '/finance/payables'], ['GET', '/finance/receivables'], ['GET', '/finance/transactions'],
    ['GET', '/banks'], ['GET', '/integrations'], ['GET', '/integrations/whatsapp'], ['GET', '/audit'], ['GET', '/team'], ['GET', '/presence'],
    ['GET', '/categories'], ['GET', '/automation'],
    ['GET', `/patients/${P}`], ['GET', `/patients/${P}/records`],
    ['POST', '/finance/transactions'], ['POST', '/procedures'], ['POST', '/categories'], ['POST', '/protocols'],
    ['POST', '/automation/templates'], ['PUT', '/clinic/hours'], ['POST', '/team'], ['PUT', '/integrations/whatsapp'], ['POST', '/sara/test'],
  ];
  for (const [m, u] of proibidos) assert.equal((await t.call(m, u, { token: rec, body: {} })).status, 403, `${m} ${u}`);
});

test('recepção: continua fazendo o trabalho do dia (agenda, pacientes, estoque, horário, Julia)', async () => {
  const rec = await t.tokenFor('recepcao@demo.test');
  for (const u of ['/me', '/appointments?from=2020-01-01&to=2030-01-01', '/patients', '/procedures', '/protocols', '/products', '/stock/restock', '/clinic/hours', '/alerts', '/integrations/whatsapp/waiting']) {
    assert.equal((await t.call('GET', u, { token: rec })).status, 200, `GET ${u}`);
  }
  assert.equal((await t.call('POST', '/patients', { token: rec, body: { fullName: 'Paciente Recepção' } })).status, 201);
  const dash = (await t.call('GET', '/dashboard', { token: rec })).json;
  assert.deepEqual([dash.revenueByMonth, dash.todayRevenue], [[], null], 'o painel não traz dinheiro');
});

test('recepção cuida do estoque e da reposição, mas nunca vê nem grava o custo dos produtos', async () => {
  const rec = await t.tokenFor('recepcao@demo.test'), owner = await t.tokenFor('gestor@demo.test');
  const lista = (await t.call('GET', '/products', { token: rec })).json;
  assert.ok(lista.length >= 2 && lista.every((p) => !('unit_cost' in p)), 'lista sem custo');
  assert.ok((await t.call('GET', '/products', { token: owner })).json.every((p) => 'unit_cost' in p), 'o dono continua vendo o custo');

  const novo = await t.call('POST', '/products', { token: rec, body: { name: 'Seringa 3ml', unit: 'cx', minQuantity: 2, targetQuantity: 10, unitCost: 99 } });
  assert.equal(novo.status, 201);
  assert.ok(!('unit_cost' in novo.json));
  assert.equal((await t.sql('SELECT unit_cost FROM products WHERE id=$1', [novo.json.id]))[0].unit_cost, null, 'custo enviado pela recepção é ignorado');
  const comCusto = await t.call('POST', '/products', { token: owner, body: { name: 'Agulha 30G', minQuantity: 1, targetQuantity: 5, unitCost: 12.5 } });
  assert.equal(Number((await t.sql('SELECT unit_cost FROM products WHERE id=$1', [comCusto.json.id]))[0].unit_cost), 12.5, 'dono grava o custo');

  const mov = (id, delta, reason = 'purchase') => t.call('POST', `/products/${id}/movements`, { token: rec, body: { delta, reason } });
  const entrada = await mov(novo.json.id, 5);
  assert.equal(entrada.status, 200);
  assert.deepEqual([Number(entrada.json.quantity), 'unit_cost' in entrada.json], [5, false]);
  assert.equal((await mov(novo.json.id, -2, 'loss')).status, 200);
  assert.equal((await mov(novo.json.id, -99, 'loss')).status, 409, 'não deixa o estoque ficar negativo');
  assert.equal(Number((await t.sql('SELECT quantity FROM products WHERE id=$1', [novo.json.id]))[0].quantity), 3);
  assert.equal((await t.sql('SELECT count(*)::int n FROM stock_movements WHERE product_id=$1', [novo.json.id]))[0].n, 2);
  const acoes = (await t.sql('SELECT action FROM audit_log')).map((a) => a.action);
  assert.ok(acoes.includes('stock.product_create') && acoes.filter((a) => a === 'stock.movement').length === 2, 'tudo fica na auditoria');

  // isolamento: produto de outra clínica não é alcançado
  const [pb] = await t.sql(`INSERT INTO products (clinic_id, name, quantity) VALUES ($1, 'Produto B', 4) RETURNING id`, [B]);
  assert.equal((await mov(pb.id, 5)).status, 409);
  assert.equal(Number((await t.sql('SELECT quantity FROM products WHERE id=$1', [pb.id]))[0].quantity), 4);
  assert.ok(!(await t.call('GET', '/products', { token: rec })).json.some((p) => p.name === 'Produto B'));
  assert.equal((await t.call('POST', `/products/${novo.json.id}/movements`, { body: { delta: 1, reason: 'purchase' } })).status, 401, 'sem login não mexe');
  assert.ok(A, 'clínica A usada pelo token');
});

test('gerente e dono continuam com acesso completo às áreas de gestão', async () => {
  await t.sql(`UPDATE users SET role='manager' WHERE email='recepcao@demo.test'`);
  const mgr = await t.tokenFor('recepcao@demo.test'), owner = await t.tokenFor('gestor@demo.test');
  for (const token of [mgr, owner]) {
    for (const u of ['/products', '/categories', '/automation', '/finance/transactions', '/banks', `/patients/${P}`, `/patients/${P}/records`]) {
      assert.equal((await t.call('GET', u, { token })).status, 200, `GET ${u}`);
    }
  }
  assert.equal((await t.call('GET', '/team', { token: mgr })).status, 403, 'gerente não gerencia a equipe');
  assert.equal((await t.call('GET', '/team', { token: owner })).status, 200);
});

test('trocar o perfil para recepção tira o acesso na hora, com o mesmo token', async () => {
  await t.sql(`UPDATE users SET role='manager' WHERE email='recepcao@demo.test'`);
  const token = await t.tokenFor('recepcao@demo.test');
  assert.equal((await t.call('GET', '/finance/summary?month=2026-10', { token })).status, 200);
  assert.ok('unit_cost' in (await t.call('GET', '/products', { token })).json[0], 'gerente vê o custo');
  await t.sql(`UPDATE users SET role='reception' WHERE email='recepcao@demo.test'`);
  assert.equal((await t.call('GET', '/finance/summary?month=2026-10', { token })).status, 403);
  assert.equal((await t.call('GET', '/categories', { token })).status, 403);
  assert.ok(!('unit_cost' in (await t.call('GET', '/products', { token })).json[0]), 'e passa a não ver o custo');
});
