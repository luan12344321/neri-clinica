import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

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
    ['GET', '/products'], ['GET', '/categories'], ['GET', '/automation'],
    ['GET', `/patients/${P}`], ['GET', `/patients/${P}/records`],
    ['POST', '/finance/transactions'], ['POST', '/products'], ['POST', '/procedures'], ['POST', '/categories'], ['POST', '/protocols'],
    ['POST', '/automation/templates'], ['PUT', '/clinic/hours'], ['POST', '/team'], ['PUT', '/integrations/whatsapp'], ['POST', '/sara/test'],
  ];
  for (const [m, u] of proibidos) assert.equal((await t.call(m, u, { token: rec, body: {} })).status, 403, `${m} ${u}`);
});

test('recepção: continua fazendo o trabalho do dia (agenda, pacientes, estoque, horário, Julia)', async () => {
  const rec = await t.tokenFor('recepcao@demo.test');
  for (const u of ['/me', '/appointments?from=2020-01-01&to=2030-01-01', '/patients', '/procedures', '/protocols', '/stock/restock', '/clinic/hours', '/alerts', '/integrations/whatsapp/waiting']) {
    assert.equal((await t.call('GET', u, { token: rec })).status, 200, `GET ${u}`);
  }
  assert.equal((await t.call('POST', '/patients', { token: rec, body: { fullName: 'Paciente Recepção' } })).status, 201);
  const dash = (await t.call('GET', '/dashboard', { token: rec })).json;
  assert.deepEqual([dash.revenueByMonth, dash.todayRevenue], [[], null], 'o painel não traz dinheiro');
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
  await t.sql(`UPDATE users SET role='reception' WHERE email='recepcao@demo.test'`);
  assert.equal((await t.call('GET', '/finance/summary?month=2026-10', { token })).status, 403);
  assert.equal((await t.call('GET', '/products', { token })).status, 403);
});
