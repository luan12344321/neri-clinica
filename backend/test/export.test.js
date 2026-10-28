import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t, exportClinic;
before(async () => { t = await setup(); ({ exportClinic } = await import('../src/export.js')); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

test('exporta só a clínica pedida, sem senhas nem tokens', async () => {
  const a = await exportClinic(A);
  assert.equal(a.clinic.id, A);
  assert.ok(a.tables.patients.length >= 5);
  assert.ok(a.tables.users.length >= 2);
  assert.ok(a.tables.users.every((u) => !('password_hash' in u)), 'senha não sai');
  assert.ok(Object.values(a.tables).flat().every((r) => !r.clinic_id || r.clinic_id === A), 'nenhum dado de outra clínica');
  assert.ok(!JSON.stringify(a).includes('Paciente B'));

  const b = await exportClinic(B);
  assert.equal(b.tables.patients.length, 1);
  assert.equal(b.tables.patients[0].full_name, 'Paciente B');
});

test('clínica inexistente dá erro', async () => {
  await assert.rejects(exportClinic('99999999-9999-9999-9999-999999999999'), /não encontrada/);
});
