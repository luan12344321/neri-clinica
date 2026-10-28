import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { setup, A, B } from './helpers.js';
import { encrypt } from '../src/crypto.js';

// Matriz de permissões dos endpoints novos do ciclo: sem login 401, cada perfil com o status do contrato,
// recurso de outra clínica 404 (nunca vaza) e nenhuma resposta com custo/margem para recepção e profissional.
let t, tok, F, FB; // tokens, fixtures da clínica A e da B
const ROLES = ['owner', 'manager', 'professional', 'reception'];
const day = (n) => `(now() + interval '${n} days')::date`;

before(async () => {
  t = await setup();
  await t.reset(); await t.addExtras();
  const hash = bcrypt.hashSync('demo1234', 4);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES
    ($1,'Doutora','dra@demo.test',$2,'professional'), ($1,'Gerente','gerente@demo.test',$2,'manager')`, [A, hash]);
  tok = { owner: await t.tokenFor('gestor@demo.test'), manager: await t.tokenFor('gerente@demo.test'),
    professional: await t.tokenFor('dra@demo.test'), reception: await t.tokenFor('recepcao@demo.test'), ownerB: await t.tokenFor('b@demo.test') };

  const mk = async (clinic, patient, procName) => {
    const [proc] = await t.sql(`INSERT INTO procedures (clinic_id, name, default_price) VALUES ($1,$2,900) RETURNING id`, [clinic, procName]);
    const [prod] = await t.sql(`INSERT INTO products (clinic_id, name, unit, quantity, unit_cost, device_type, units_per_package)
      VALUES ($1,'Produto fictício','seringa',3,300,'hyaluronic_acid',1) RETURNING id`, [clinic]);
    const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
      VALUES ($1,$2,'L-X',${day(-4)},2,3) RETURNING id`, [clinic, prod.id]); // vencido com saldo (item financeiro do /attention)
    const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
      VALUES ($1,$2,$3, now(), now() + interval '1 hour', 900) RETURNING id`, [clinic, patient, proc.id]);
    const [done] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price, status, completed_at)
      VALUES ($1,$2,$3, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 900, 'done', now() - interval '2 days') RETURNING id`, [clinic, patient, proc.id]);
    const [ret] = await t.sql(`INSERT INTO returns (clinic_id, patient_id, procedure_id, source_appointment_id, suggested_date, window_start, window_end)
      VALUES ($1,$2,$3,$4,${day(2)},${day(-1)},${day(8)}) RETURNING id`, [clinic, patient, proc.id, done.id]);
    await t.sql(`INSERT INTO applications (clinic_id, appointment_id, patient_id, product_id, lot_id, units_used, unit_cost, cost)
      VALUES ($1,$2,$3,$4,$5,1,300,300)`, [clinic, done.id, patient, prod.id, lot.id]);
    const tdoc = randomUUID();
    await t.sql(`INSERT INTO traceability_documents (id, clinic_id, appointment_id, patient_id, pdf_enc) VALUES ($1,$2,$3,$4,$5)`,
      [tdoc, clinic, done.id, patient, encrypt(Buffer.from('%PDF-1.4 fake').toString('base64'), `traceability.pdf:${tdoc}`)]);
    return { proc: proc.id, prod: prod.id, lot: lot.id, ap: ap.id, done: done.id, ret: ret.id, tdoc, patient };
  };
  F = await mk(A, '20000000-0000-0000-0000-000000000002', 'Proc A');
  FB = await mk(B, '2b000000-0000-0000-0000-000000000001', 'Proc B');
  await t.sql(`INSERT INTO transactions (clinic_id, type, description, amount, competence_date, due_date, status)
    VALUES ($1,'expense','Conta fictícia',100,${day(-10)},${day(-5)},'pending')`, [A]);
});
after(() => t.close());

const ruleBody = { targetDays: 30, windowMinDays: 20, windowMaxDays: 40, messageText: 'Convite para a avaliação de retorno do {{procedimento}}.' };
const ALL = { owner: 200, manager: 200, professional: 200, reception: 200 };
const CLIN = { owner: 200, manager: 200, professional: 200, reception: 403 };
let seq = 0;

// [descrição, método, url(f), corpo(f, papel), status esperados por papel, status do recurso da outra clínica (null = sem id)]
const MATRIX = [
  ['GET lots', 'GET', (f) => `/products/${f.prod}/lots`, null, ALL, 404],
  ['POST lots', 'POST', (f) => `/products/${f.prod}/lots`, () => ({ lotCode: `N-${++seq}`, expiresAt: '2031-01-01', packages: 1 }),
    { owner: 201, manager: 201, professional: 201, reception: 201 }, 404],
  ['GET conclusion-context', 'GET', (f) => `/appointments/${f.ap}/conclusion-context`, null, CLIN, 404],
  ['POST conclude (corpo inválido: só testa a porta)', 'POST', (f) => `/appointments/${f.ap}/conclude`, () => ({}), { owner: 400, manager: 400, professional: 400, reception: 403 }, null],
  ['POST conclude (corpo válido, outra clínica)', 'POST', null, null, null, 404],
  ['GET traceability do atendimento', 'GET', (f) => `/appointments/${f.done}/traceability`, null, CLIN, 404],
  ['GET traceability do paciente', 'GET', (f) => `/patients/${f.patient}/traceability`, null, CLIN, 404],
  ['POST traceability do atendimento', 'POST', (f) => `/appointments/${f.ap}/traceability`, null, { owner: 404, manager: 404, professional: 404, reception: 403 }, 404], // 404 = sem produto rastreável aplicado
  ['GET traceability pdf', 'GET', (f) => `/traceability/${f.tdoc}/pdf`, null, CLIN, 404],
  ['GET return-rule', 'GET', (f) => `/procedures/${f.proc}/return-rule`, null, CLIN, 404],
  ['PUT return-rule', 'PUT', (f) => `/procedures/${f.proc}/return-rule`, () => ruleBody, { owner: 200, manager: 200, professional: 403, reception: 403 }, 404],
  ['GET returns/:id/slots', 'GET', (f) => `/returns/${f.ret}/slots?date=2031-03-17`, null, ALL, 404],
  ['POST returns/:id/schedule (corpo inválido)', 'POST', (f) => `/returns/${f.ret}/schedule`, () => ({}), { owner: 400, manager: 400, professional: 400, reception: 400 }, null],
  ['POST returns/:id/schedule (corpo válido, outra clínica)', 'POST', null, null, null, 404],
  ['GET returns/queue', 'GET', () => '/returns/queue', null, ALL, null],
  ['POST returns/:id/result (corpo inválido)', 'POST', (f) => `/returns/${f.ret}/result`, () => ({ result: 'xx' }), { owner: 400, manager: 400, professional: 400, reception: 400 }, null],
  ['POST returns/:id/result (corpo válido, outra clínica)', 'POST', null, null, null, 404],
  ['GET consents', 'GET', (f) => `/patients/${f.patient}/consents`, null, ALL, 404],
  ['PUT consents', 'PUT', (f) => `/patients/${f.patient}/consents`, () => ({ purpose: 'return', granted: true }), ALL, 404],
  ['GET attention', 'GET', () => '/attention', null, ALL, null],
  ['GET dashboard/cycle', 'GET', () => '/dashboard/cycle', null, { owner: 200, manager: 200, professional: 403, reception: 403 }, null],
  ['GET patients/:id/ai-usage', 'GET', (f) => `/patients/${f.patient}/ai-usage`, null, CLIN, 404],
];
// Chamadas "outra clínica" com corpo válido, para endpoints cujo corpo é checado antes do recurso
const FOREIGN_BODY = {
  'POST conclude (corpo válido, outra clínica)': ['POST', (f) => `/appointments/${f.ap}/conclude`, { confirmed: true, applications: [] }],
  'POST returns/:id/schedule (corpo válido, outra clínica)': ['POST', (f) => `/returns/${f.ret}/schedule`, { startsAt: '2031-03-17T14:00:00-03:00' }],
  'POST returns/:id/result (corpo válido, outra clínica)': ['POST', (f) => `/returns/${f.ret}/result`, { result: 'declined' }],
};

for (const [name, method, url, body, expected, foreign] of MATRIX) {
  test(`permissões: ${name}`, async () => {
    if (expected) {
      assert.equal((await t.call(method, url(F), { body: body?.() })).status, 401, 'sem login = 401');
      for (const role of ROLES) {
        const r = await t.call(method, url(F), { token: tok[role], body: body?.(role) });
        assert.equal(r.status, expected[role], `${name} como ${role}`);
      }
    }
    if (foreign) {
      const [m, u, b] = FOREIGN_BODY[name] ?? [method, url, body?.()];
      // o dono de A pedindo o recurso da B e o dono de B pedindo o da A: ambos 404
      assert.equal((await t.call(m, u(FB), { token: tok.owner, body: b })).status, foreign, `${name}: A -> B`);
      assert.equal((await t.call(m, u(F), { token: tok.ownerB, body: b })).status, foreign, `${name}: B -> A`);
    }
  });
}

test('ids malformados viram 404/400, nunca 500 com detalhe', async () => {
  for (const u of ['/products/xx/lots', '/returns/xx/slots?date=2031-01-01', '/patients/xx/consents', '/traceability/xx/pdf', '/procedures/xx/return-rule']) {
    const r = await t.call('GET', u, { token: tok.owner });
    assert.ok([400, 404].includes(r.status), `${u} -> ${r.status}`);
  }
});

test('nenhuma resposta para recepção e profissional contém custo ou margem', async () => {
  const COST = /"(unit_cost|cost|totalCost|total_cost|margin|avgMargin|missingCost)"/;
  const gets = [`/products/${F.prod}/lots`, '/products', '/returns/queue', '/returns/queue?scope=all', '/attention', `/appointments/${F.ap}/conclusion-context`,
    `/patients/${F.patient}/consents`, `/procedures/${F.proc}/return-rule`, `/appointments/${F.done}/traceability`, '/stock/restock', '/appointments', '/dashboard'];
  for (const role of ['reception', 'professional']) {
    for (const u of gets) {
      const r = await t.call('GET', u, { token: tok[role] });
      if (r.status === 403) continue;
      assert.ok(!COST.test(JSON.stringify(r.json)), `${role} ${u} vazou custo/margem: ${JSON.stringify(r.json).match(COST)?.[0]}`);
    }
    const post = await t.call('POST', `/products/${F.prod}/lots`, { token: tok[role], body: { lotCode: `V-${role}`, expiresAt: '2031-01-01', packages: 1 } });
    assert.equal(post.status, 201);
    assert.ok(!COST.test(JSON.stringify(post.json)), `${role} POST lots vazou custo`);
  }
  // sanidade: o dono enxerga custo onde ele existe (o teste acima não é vazio)
  assert.match(JSON.stringify((await t.call('GET', `/appointments/${F.ap}/conclusion-context`, { token: tok.owner })).json), /lots/);
  assert.match(JSON.stringify((await t.call('POST', `/products/${F.prod}/lots`, { token: tok.owner, body: { lotCode: 'V-owner', expiresAt: '2031-01-01', packages: 1 } })).json), /unit_cost/);
});

test('/attention: recepção não recebe item financeiro; dono recebe', async () => {
  const FIN = ['payables_overdue', 'receivables_overdue', 'lots_expired', 'lots_expiring'];
  const kinds = async (role) => (await t.call('GET', '/attention', { token: tok[role] })).json.items.map((i) => i.kind);
  const own = await kinds('owner');
  assert.ok(FIN.some((k) => own.includes(k)), `dono deveria ver itens financeiros: ${own}`);
  for (const role of ['reception', 'professional']) {
    const r = await t.call('GET', '/attention', { token: tok[role] });
    assert.ok(!r.json.items.some((i) => FIN.includes(i.kind)), `${role} recebeu item financeiro`);
    assert.ok(!/R\$|amount|"valor"/i.test(JSON.stringify(r.json)), `${role}: sem valores em dinheiro`);
  }
});

test('fila e atenção não misturam clínicas', async () => {
  const q = (await t.call('GET', '/returns/queue?scope=all', { token: tok.owner })).json.items;
  assert.ok(q.length >= 1 && q.every((i) => i.id !== FB.ret && i.patient.name !== 'Paciente B'));
  const qb = (await t.call('GET', '/returns/queue?scope=all', { token: tok.ownerB })).json.items;
  assert.ok(qb.every((i) => i.id !== F.ret));
});
