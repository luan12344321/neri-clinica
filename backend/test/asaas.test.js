import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, owner, reception, calls;
const realFetch = globalThis.fetch;
const WEBHOOK = 'segredo-do-webhook-com-mais-de-trinta-e-dois-caracteres';
before(async () => { t = await setup(); });
after(() => { globalThis.fetch = realFetch; return t.close(); });
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  [owner, reception] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test'].map((e) => t.tokenFor(e)));
  Object.assign(process.env, { ASAAS_API_KEY: '$aact_hmlg_teste', ASAAS_WEBHOOK_TOKEN: WEBHOOK, ASAAS_ENV: 'sandbox' });
});

// Simula a API do Asaas e guarda cada chamada para conferir método, caminho, cabeçalhos e corpo.
const asaasStub = (over = {}) => {
  calls = [];
  const defaults = {
    'GET /customers': () => ({ data: [] }),
    'POST /customers': () => ({ id: 'cus_1' }),
    'POST /payments': () => ({ id: 'pay_1', status: 'PENDING' }),
    'GET /payments/pay_1/pixQrCode': () => ({ payload: '00020126ASAASPIX6304ABCD', expirationDate: '2026-12-31 23:59:59', encodedImage: 'x' }),
    'GET /finance/balance': () => ({ balance: 10 }),
    'DELETE /payments/pay_1': () => ({ deleted: true }),
    // consulta que o webhook faz para confirmar: devolve a cobrança criada (mesmo valor e referência), já recebida
    'GET /payments/pay_1': () => {
      const created = calls.findLast((c) => c.key === 'POST /payments')?.body;
      return { id: 'pay_1', status: 'RECEIVED', value: created?.value, netValue: created ? created.value - 1.99 : undefined, externalReference: created?.externalReference };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace('/v3', '')}`;
    calls.push({ key, host: u.host, search: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = (() => { const r = (over[key] ?? defaults[key])?.(); return Array.isArray(r) ? r : [200, r ?? {}]; })();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
};

const CPF = '529.982.247-25';
// Atendimento concluído = conta a receber ligada ao paciente (é o caso real).
async function receivable(patientExtra = { cpf: CPF }) {
  const p = (await t.call('POST', '/patients', { token: owner, body: { fullName: 'Maria Souza', ...patientExtra } })).json;
  const start = new Date(Date.now() + 3600e3);
  const ap = (await t.call('POST', '/appointments', { token: owner, body: { patientId: p.id, procedureId: '10000000-0000-0000-0000-000000000001',
    startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600e3).toISOString() } })).json;
  await t.call('POST', `/appointments/${ap.id}/complete`, { token: owner });
  const [tx] = await t.sql('SELECT id, amount::float a FROM transactions WHERE appointment_id=$1', [ap.id]);
  return { patientId: p.id, tx };
}
const charge = (id, token = owner) => t.call('POST', `/finance/transactions/${id}/charge`, { token });
const webhook = async (body, token) => {
  const res = await t.app.inject({ method: 'POST', url: '/webhooks/asaas', headers: token === undefined ? {} : { 'asaas-access-token': token }, payload: body });
  return { status: res.statusCode, json: res.json() };
};
const received = { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', status: 'RECEIVED', value: 1200, netValue: 1198.01, billingType: 'PIX' } };

test('integração: sem variáveis não está configurada; com elas aparece como sandbox', async () => {
  delete process.env.ASAAS_API_KEY;
  assert.deepEqual((await t.call('GET', '/integrations', { token: owner })).json, { asaas: { configured: false, sandbox: true } });
  process.env.ASAAS_API_KEY = '$aact_hmlg_teste';
  assert.equal((await t.call('GET', '/integrations', { token: owner })).json.asaas.configured, true);
  assert.equal((await t.call('GET', '/integrations', { token: reception })).status, 403);
});

test('cobrança: cria cliente e cobrança Pix no Asaas, grava o vínculo e devolve o copia e cola; a segunda chamada reaproveita', async () => {
  asaasStub();
  const { tx } = await receivable();
  const r = await charge(tx.id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.provider, r.json.payload, r.json.amount], ['asaas', '00020126ASAASPIX6304ABCD', tx.a]);

  assert.deepEqual(calls.map((c) => c.key), ['GET /customers', 'POST /customers', 'POST /payments', 'GET /payments/pay_1/pixQrCode']);
  assert.ok(calls.every((c) => c.host === 'api-sandbox.asaas.com' && c.headers.access_token === '$aact_hmlg_teste' && c.headers['User-Agent']));
  assert.deepEqual([calls[1].body.cpfCnpj, calls[1].body.notificationDisabled, calls[1].body.name], ['52998224725', true, 'Maria Souza']);
  assert.deepEqual([calls[2].body.customer, calls[2].body.billingType, calls[2].body.value, calls[2].body.externalReference], ['cus_1', 'PIX', tx.a, tx.id]);
  assert.equal((await t.sql('SELECT external_id FROM transactions WHERE id=$1', [tx.id]))[0].external_id, 'asaas:pay_1');
  assert.equal((await t.sql(`SELECT count(*)::int n FROM bank_accounts WHERE provider='asaas'`))[0].n, 1);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='asaas.customer_created'`))[0].n, 1);

  const again = await charge(tx.id);
  assert.equal(again.status, 200);
  assert.deepEqual(calls.slice(4).map((c) => c.key), ['GET /payments/pay_1/pixQrCode'], 'não cria cobrança nem cliente de novo');
});

test('cobrança: sem CPF do paciente, sem paciente, não configurado e perfil sem permissão são recusados sem chamar o Asaas', async () => {
  asaasStub();
  const noCpf = await receivable({});
  assert.deepEqual([(await charge(noCpf.tx.id)).status, (await charge(noCpf.tx.id)).json.error], [409, 'patient cpf required']);
  const [cat] = await t.sql(`SELECT id FROM categories WHERE clinic_id=$1 AND kind='income' LIMIT 1`, [A]);
  const manual = (await t.call('POST', '/finance/transactions', { token: owner, body: { type: 'income', categoryId: cat.id, description: 'Avulso', amount: 100, competenceDate: '2026-10-01', dueDate: '2026-10-30' } })).json;
  assert.equal((await charge(manual.id)).json.error, 'no patient');
  assert.equal((await charge(manual.id, reception)).status, 403);
  delete process.env.ASAAS_API_KEY;
  assert.equal((await charge(manual.id)).status, 503);
  assert.deepEqual(calls, [], 'nenhuma chamada saiu');
});

test('erro do Asaas vira 502 com o motivo, sem derrubar nem gravar vínculo', async () => {
  asaasStub({ 'POST /payments': () => [400, { errors: [{ code: 'invalid_value', description: 'O valor mínimo da cobrança é R$ 5,00' }] }] });
  const { tx } = await receivable();
  const r = await charge(tx.id);
  assert.deepEqual([r.status, r.json.error, r.json.detail], [502, 'provider_error', 'O valor mínimo da cobrança é R$ 5,00']);
  assert.equal((await t.sql('SELECT external_id FROM transactions WHERE id=$1', [tx.id]))[0].external_id, null);
});

test('webhook: exige o segredo; ignora eventos que não são recebimento', async () => {
  assert.equal((await webhook(received)).status, 401);
  assert.equal((await webhook(received, 'errado')).status, 401);
  delete process.env.ASAAS_WEBHOOK_TOKEN;
  assert.equal((await webhook(received, 'qualquer')).status, 401, 'sem segredo configurado nada passa');
  process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK;
  const r = await webhook({ event: 'PAYMENT_OVERDUE', payment: { id: 'pay_1' } }, WEBHOOK);
  assert.deepEqual([r.status, r.json.ignored], [200, true]);
});

test('webhook: pagamento recebido dá baixa na conta do Asaas, registra a tarifa e repetir o aviso não duplica nada', async () => {
  asaasStub();
  const { tx } = await receivable();
  await charge(tx.id);
  const first = await webhook(received, WEBHOOK);
  assert.deepEqual([first.status, first.json.ok], [200, true]);
  const [paid] = await t.sql(`SELECT t.status, t.paid_at, b.name AS bank FROM transactions t JOIN bank_accounts b ON b.id=t.bank_account_id WHERE t.id=$1`, [tx.id]);
  assert.deepEqual([paid.status, !!paid.paid_at, paid.bank], ['paid', true, 'Asaas (conta digital)']);
  const fees = await t.sql(`SELECT amount::float a, status, description FROM transactions WHERE external_id='asaas-fee:pay_1'`);
  assert.deepEqual(fees, [{ a: 1.99, status: 'paid', description: 'Tarifa Asaas' }]);
  const bank = () => t.call('GET', '/banks', { token: owner }).then((r) => r.json.find((b) => b.institution === 'Asaas'));
  assert.equal((await bank()).balance, 1198.01);

  await webhook(received, WEBHOOK); await webhook(received, WEBHOOK);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM transactions WHERE external_id='asaas-fee:pay_1'`))[0].n, 1);
  assert.equal((await bank()).balance, 1198.01);
  assert.equal((await t.call('GET', `/finance/transactions/${tx.id}/status`, { token: owner })).json.status, 'paid');
});

test('webhook forjado não dá baixa: o Asaas é consultado e precisa confirmar recebimento, referência e valor (B-07)', async () => {
  asaasStub();
  const { tx } = await receivable();
  await charge(tx.id);
  const pending = async () => (await t.sql('SELECT status FROM transactions WHERE id=$1', [tx.id]))[0].status;
  for (const fake of [
    { status: 'PENDING', value: tx.a, externalReference: tx.id },
    { status: 'RECEIVED', value: tx.a, externalReference: '00000000-0000-0000-0000-000000000000' },
    { status: 'RECEIVED', value: 0.01, externalReference: tx.id },
  ]) {
    asaasStub({ 'GET /payments/pay_1': () => ({ id: 'pay_1', ...fake }) });
    const r = await webhook(received, WEBHOOK);
    assert.equal(r.status, 200);
    assert.equal(await pending(), 'pending', JSON.stringify(fake));
  }
  asaasStub({ 'GET /payments/pay_1': () => [500, {}] });
  assert.equal((await webhook(received, WEBHOOK)).status, 502, 'Asaas fora do ar: pede reenvio em vez de dar baixa');
  assert.equal(await pending(), 'pending');
});

test('webhook de cobrança desconhecida responde 200 e não altera nada (não pode travar a fila do Asaas)', async () => {
  const before = (await t.sql(`SELECT count(*)::int n FROM transactions WHERE status='paid'`))[0].n;
  const r = await webhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_inexistente', value: 10, netValue: 9 } }, WEBHOOK);
  assert.equal(r.status, 200);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM transactions WHERE status='paid'`))[0].n, before);
});

test('testar conexão: devolve o saldo do Asaas; falha vira 502; só dono e gerente', async () => {
  asaasStub();
  const ok = await t.call('POST', '/integrations/asaas/test', { token: owner });
  assert.deepEqual([ok.status, ok.json.ok, ok.json.balance, ok.json.sandbox], [200, true, 10, true]);
  asaasStub({ 'GET /finance/balance': () => [401, { errors: [{ description: 'A chave de API informada é inválida' }] }] });
  assert.equal((await t.call('POST', '/integrations/asaas/test', { token: owner })).status, 502);
  assert.equal((await t.call('POST', '/integrations/asaas/test', { token: reception })).status, 403);
});
