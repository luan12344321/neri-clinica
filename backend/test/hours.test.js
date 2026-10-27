import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t, owner, reception, ownerB;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  [owner, reception, ownerB] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test', 'b@demo.test'].map((e) => t.tokenFor(e)));
});

const WORK = [['08:00', '11:00'], ['13:00', '18:00']];
const put = (hours, token = owner) => t.call('PUT', '/clinic/hours', { token, body: { hours } });
const week = (over = {}) => ({ 0: [], 1: WORK, 2: WORK, 3: WORK, 4: WORK, 5: WORK, 6: [], ...over });

test('padrão: 08:00–11:00 e 13:00–18:00 de segunda a sexta, fechado no fim de semana', async () => {
  const r = await t.call('GET', '/clinic/hours', { token: reception }); // qualquer usuário logado lê
  assert.equal(r.status, 200);
  assert.equal(r.json.isDefault, true);
  assert.deepEqual([1, 2, 3, 4, 5].map((d) => r.json.hours[d]), Array(5).fill(WORK));
  assert.deepEqual([r.json.hours[0], r.json.hours[6]], [[], []]);
  assert.equal((await t.call('GET', '/clinic/hours')).status, 401);
});

test('dono e gerente configuram; a mudança vale para todos e fica registrada na auditoria', async () => {
  const sab = week({ 6: [['08:00', '12:00']], 3: [['09:00', '17:30']] });
  const r = await put(sab);
  assert.deepEqual([r.status, r.json.isDefault], [200, false]);
  const got = (await t.call('GET', '/clinic/hours', { token: reception })).json;
  assert.deepEqual([got.hours[6], got.hours[3], got.isDefault], [[['08:00', '12:00']], [['09:00', '17:30']], false]);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='clinic.hours_update'`))[0].n, 1);
});

test('recepção não altera o horário', async () => {
  assert.equal((await put(week(), reception)).status, 403);
  assert.equal((await t.call('GET', '/clinic/hours', { token: reception })).json.isDefault, true);
});

test('validação: formato, fora da grade de 30 min, fim antes do início, sobreposição, faixas demais e dias faltando', async () => {
  assert.equal((await put(week({ 1: [['8:00', '11:00']] }))).status, 400);
  assert.equal((await put(week({ 1: [['08:15', '11:00']] }))).status, 400);
  assert.equal((await put(week({ 1: [['11:00', '08:00']] }))).status, 400);
  assert.equal((await put(week({ 1: [['08:00', '08:00']] }))).status, 400);
  assert.equal((await put(week({ 1: [['08:00', '12:00'], ['11:30', '18:00']] }))).status, 400);
  assert.equal((await put(week({ 1: [['13:00', '18:00'], ['08:00', '11:00']] }))).status, 400, 'fora de ordem');
  assert.equal((await put(week({ 1: [['06:00', '07:00'], ['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00']] }))).status, 400);
  const { 6: _omit, ...semSabado } = week();
  assert.equal((await put(semSabado)).status, 400);
  assert.equal((await t.call('GET', '/clinic/hours', { token: owner })).json.isDefault, true, 'nada foi gravado');
});

test('cada clínica tem o seu horário', async () => {
  await put(week({ 1: [['10:00', '15:00']] }));
  const b = (await t.call('GET', '/clinic/hours', { token: ownerB })).json;
  assert.deepEqual([b.isDefault, b.hours[1]], [true, WORK]);
});
