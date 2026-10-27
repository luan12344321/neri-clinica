import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';
import { crc16, normalizePixKey, pixPayload } from '../src/pix.js';

let t, owner, reception;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); [owner, reception] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test'].map((e) => t.tokenFor(e))); });

const CPF = '52998224725'; // CPF válido de teste
const bank = (extra = {}) => t.call('POST', '/banks', { token: owner, body: { name: 'Nubank PJ', institution: 'Nubank', kind: 'checking', openingBalance: 1000, ...extra } });
// o seed não traz contas a receber pendentes: cria uma
const pending = async () => {
  const [cat] = await t.sql(`SELECT id FROM categories WHERE clinic_id=$1 AND kind='income' LIMIT 1`, [A]);
  const r = await t.call('POST', '/finance/transactions', { token: owner, body: { type: 'income', categoryId: cat.id, description: 'Consulta',
    amount: 450, competenceDate: '2026-10-01', dueDate: '2026-10-30' } });
  return { id: r.json.id, a: 450 };
};

test('Pix: CRC-16/CCITT-FALSE confere com o vetor padrão e o payload fecha com o próprio CRC', () => {
  assert.equal(crc16('123456789'), '29B1');
  const p = pixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Clínica Ação Ltda', city: 'São Paulo', amount: 1234.5, txid: 'T-abc 123' });
  assert.match(p, /^00020101021226/);
  assert.ok(p.includes('54071234.50') && p.includes('5802BR'));
  assert.ok(p.includes('CLINICA ACAO LTDA') && p.includes('SAO PAULO') && p.includes('0507Tabc123'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  assert.ok(pixPayload({ key: 'a@b.co', name: 'X' }).startsWith('00020101021126'), 'sem valor é código estático reutilizável (11)');
});

test('chave Pix é validada e padronizada por tipo', () => {
  assert.equal(normalizePixKey('cpf', '529.982.247-25'), CPF);
  assert.equal(normalizePixKey('cpf', '11111111111'), null);
  assert.equal(normalizePixKey('phone', '(11) 98765-4321'), '+5511987654321');
  assert.equal(normalizePixKey('email', 'Ana@Clinica.com'), 'ana@clinica.com');
  assert.equal(normalizePixKey('cnpj', '12.345.678/0001-95'), '12345678000195');
  assert.equal(normalizePixKey('random', '123E4567-e12b-12d1-a456-426655440000'), '123e4567-e12b-12d1-a456-426655440000');
  assert.equal(normalizePixKey('email', 'sem-arroba'), null);
});

test('conta bancária: a primeira vira padrão, o saldo parte do saldo inicial e a chave Pix só volta mascarada e cifrada no banco', async () => {
  const r = await bank({ pixKeyType: 'cpf', pixKey: '529.982.247-25', last4: '4321' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.isDefault, r.json.balance, r.json.pixKeyType, r.json.last4], [true, 1000, 'cpf', '4321']);
  assert.ok(r.json.pixKeyMasked && !r.json.pixKeyMasked.includes(CPF), 'mascarada');
  assert.ok(!JSON.stringify((await t.call('GET', '/banks', { token: owner })).json).includes(CPF), 'a listagem não vaza a chave');
  const [row] = await t.sql('SELECT pix_key_enc FROM bank_accounts');
  assert.ok(row.pix_key_enc.startsWith('v1:') && !row.pix_key_enc.includes(CPF), 'cifrada em repouso');
  const second = await bank({ name: 'Caixa físico', institution: 'Dinheiro', kind: 'cash', openingBalance: 0 });
  assert.equal(second.json.isDefault, false);
  const made = await t.call('PATCH', `/banks/${second.json.id}`, { token: owner, body: { isDefault: true } });
  assert.equal(made.json.isDefault, true);
  assert.deepEqual((await t.call('GET', '/banks', { token: owner })).json.map((b) => b.isDefault), [true, false]);
});

test('validações: chave inválida, tipo sem chave, últimos dígitos e perfil sem permissão', async () => {
  assert.equal((await bank({ pixKeyType: 'cpf', pixKey: '123' })).status, 400);
  assert.equal((await bank({ pixKey: '529.982.247-25' })).status, 400);
  assert.equal((await bank({ last4: '12' })).status, 400);
  assert.equal((await t.call('GET', '/banks', { token: reception })).status, 403);
  assert.equal((await t.call('POST', '/banks', { token: reception, body: { name: 'X1', institution: 'Y1', kind: 'cash' } })).status, 403);
  assert.equal((await t.call('GET', '/banks')).status, 401);
});

test('receber: sem conta escolhida usa a padrão; o saldo da conta sobe; escolher conta de outra clínica dá 404', async () => {
  const b = (await bank()).json;
  const tx = await pending();
  const other = await t.sql(`INSERT INTO bank_accounts (clinic_id, name) VALUES ('00000000-0000-0000-0000-0000000000b1', 'Banco B') RETURNING id`);
  assert.equal((await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token: owner, body: { bankAccountId: other[0].id } })).status, 404);
  const paid = await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token: owner });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.bank_account_id, b.id);
  const after = (await t.call('GET', '/banks', { token: owner })).json[0];
  assert.equal(after.balance, 1000 + tx.a);
});

test('pagar uma despesa na conta escolhida reduz o saldo dela', async () => {
  const b = (await bank()).json;
  const [cat] = await t.sql(`SELECT id FROM categories WHERE clinic_id=$1 AND kind='expense' LIMIT 1`, [A]);
  const exp = (await t.call('POST', '/finance/transactions', { token: owner, body: { type: 'expense', categoryId: cat.id, description: 'Luvas',
    amount: 300, competenceDate: '2026-10-01', dueDate: '2026-10-05' } })).json;
  await t.call('POST', `/finance/transactions/${exp.id}/pay`, { token: owner, body: { bankAccountId: b.id } });
  assert.equal((await t.call('GET', '/banks', { token: owner })).json[0].balance, 700);
});

test('Pix de uma conta a receber: payload com o valor, na chave da conta; 409 sem chave; 404 se já paga', async () => {
  const tx = await pending();
  await bank(); // sem chave Pix
  assert.equal((await t.call('GET', `/finance/transactions/${tx.id}/pix`, { token: owner })).status, 409);
  await bank({ name: 'Inter', institution: 'Inter', pixKeyType: 'email', pixKey: 'pix@clinica.com', isDefault: true });
  const r = await t.call('GET', `/finance/transactions/${tx.id}/pix`, { token: owner });
  assert.equal(r.status, 200);
  assert.ok(r.json.payload.includes('pix@clinica.com') && r.json.payload.includes('5406450.00'));
  assert.equal(r.json.payload.slice(-4), crc16(r.json.payload.slice(0, -4)));
  assert.equal(r.json.bank, 'Inter');
  assert.ok(!r.json.keyMasked.includes('pix@clinica.com'));
  await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token: owner });
  assert.equal((await t.call('GET', `/finance/transactions/${tx.id}/pix`, { token: owner })).status, 404);
});

test('movimentações recentes trazem categoria, status e a conta usada', async () => {
  const b = (await bank()).json;
  const tx = await pending();
  await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token: owner });
  const list = (await t.call('GET', '/finance/transactions?limit=3', { token: owner })).json;
  assert.equal(list.length, 3);
  assert.deepEqual([list[0].id, list[0].status, list[0].bank], [tx.id, 'paid', b.name]);
  assert.equal((await t.call('GET', '/finance/transactions', { token: reception })).status, 403);
});

test('arquivar conta a tira do uso padrão; o dono de outra clínica não a enxerga', async () => {
  const b = (await bank()).json;
  await t.call('PATCH', `/banks/${b.id}`, { token: owner, body: { active: false } });
  const tx = await pending();
  assert.equal((await t.call('POST', `/finance/transactions/${tx.id}/pay`, { token: owner })).json.bank_account_id, null);
  const ownerB = await t.tokenFor('b@demo.test');
  assert.deepEqual((await t.call('GET', '/banks', { token: ownerB })).json, []);
  assert.equal((await t.call('PATCH', `/banks/${b.id}`, { token: ownerB, body: { name: 'Invasor' } })).status, 404);
});
