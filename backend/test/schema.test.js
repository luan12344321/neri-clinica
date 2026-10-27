import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());

// Simula o banco de produção, criado antes destas colunas: o primeiro uso as acrescenta, sem perder o que já existia.
test('banco antigo: as colunas novas são acrescentadas na primeira chamada e os dados existentes ficam', async () => {
  await t.reset();
  await t.sql(`ALTER TABLE bank_accounts DROP COLUMN institution, DROP COLUMN kind, DROP COLUMN last4, DROP COLUMN pix_key_enc,
    DROP COLUMN pix_key_type, DROP COLUMN opening_balance, DROP COLUMN is_default, DROP COLUMN active, DROP COLUMN created_at`);
  await t.sql('ALTER TABLE users DROP COLUMN last_seen_at');
  await t.sql(`INSERT INTO bank_accounts (clinic_id, name) VALUES ($1, 'Conta antiga')`, [A]);
  const owner = await t.tokenFor('gestor@demo.test');

  const r = await t.call('GET', '/banks', { token: owner });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((b) => [b.name, b.institution, b.kind, b.active, b.balance]), [['Conta antiga', 'Outro', 'checking', true, 0]]);

  const made = await t.call('POST', '/banks', { token: owner, body: { name: 'Nova', institution: 'Inter', kind: 'savings', openingBalance: 50 } });
  assert.equal(made.status, 201);
  assert.equal((await t.call('POST', '/presence/ping', { token: owner })).status, 204);
  const [{ n }] = await t.sql(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='users' AND column_name='last_seen_at'`);
  assert.equal(n, 1);
});
