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
  await t.sql('ALTER TABLE clinics DROP COLUMN working_hours');
  // rodada final (Julia, MFA, LGPD): o banco antigo não tem estas colunas/tabela
  await t.sql('ALTER TABLE sara_messages DROP COLUMN client_msg_id');
  await t.sql('ALTER TABLE users DROP COLUMN totp_secret_enc, DROP COLUMN totp_enabled_at, DROP COLUMN totp_last_step, DROP COLUMN mfa_fails, DROP COLUMN mfa_fail_at');
  await t.sql('DROP TABLE mfa_recovery_codes');
  await t.sql('ALTER TABLE patients DROP COLUMN legal_hold_reason, DROP COLUMN legal_hold_at, DROP COLUMN anonymized_at');
  await t.sql('ALTER TABLE clinics DROP COLUMN retention_years');
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
  // a primeira chamada já aplicou também os passos da rodada final, sem perder dados
  const [{ k }] = await t.sql(`SELECT (SELECT count(*) FROM information_schema.columns WHERE (table_name, column_name) IN
    (('sara_messages','client_msg_id'),('users','totp_secret_enc'),('users','totp_enabled_at'),('users','totp_last_step'),('users','mfa_fails'),('users','mfa_fail_at'),
     ('patients','legal_hold_reason'),('patients','legal_hold_at'),('patients','anonymized_at'),('clinics','retention_years')))::int
    + (SELECT count(*) FROM information_schema.tables WHERE table_name='mfa_recovery_codes')::int AS k`);
  assert.equal(k, 11);
  assert.equal((await t.sql('SELECT count(*)::int n FROM patients'))[0].n > 0, true);
  assert.equal((await t.call('GET', '/lgpd/retention', { token: owner })).status, 200);
  const h = await t.call('GET', '/clinic/hours', { token: owner });
  assert.deepEqual([h.status, h.json.isDefault, h.json.hours[1]], [200, true, [['08:00', '11:00'], ['13:00', '18:00']]]);
});
