import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, owner, reception, ownerB, crypto;
before(async () => { t = await setup(); crypto = await import('../src/crypto.js'); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  [owner, reception, ownerB] = await Promise.all(['gestor@demo.test', 'recepcao@demo.test', 'b@demo.test'].map((e) => t.tokenFor(e)));
});

const CPF = '529.982.247-25'; // CPF válido de exemplo (dígitos verificadores corretos)
const newPatient = (token, extra = {}) => t.call('POST', '/patients', { token, body: { fullName: 'Maria Souza', ...extra } });
const audits = (action) => t.sql('SELECT * FROM audit_log WHERE action=$1 ORDER BY id', [action]);

test('paciente: telefone que não vira número de WhatsApp é recusado', async () => {
  assert.equal((await newPatient(owner, { phone: '1234' })).status, 400);
  assert.equal((await newPatient(owner, { phone: '(11) 98765-4321' })).status, 201);
  assert.equal((await newPatient(owner, { phone: '' })).status, 201);
});

// ---------- criptografia ----------
test('crypto: ida e volta, IV aleatório, prefixo de versão', () => {
  const enc = crypto.encrypt('segredo', 'ctx:1');
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes('segredo'));
  assert.equal(crypto.decrypt(enc, 'ctx:1'), 'segredo');
  assert.notEqual(crypto.encrypt('segredo', 'ctx:1'), enc);
});

test('crypto: AAD diferente, adulteração, versão desconhecida e chave ausente falham', () => {
  const enc = crypto.encrypt('segredo', 'ctx:1');
  assert.throws(() => crypto.decrypt(enc, 'ctx:2'));
  const buf = Buffer.from(enc.slice(3), 'base64'); buf[buf.length - 1] ^= 1;
  assert.throws(() => crypto.decrypt(`v1:${buf.toString('base64')}`, 'ctx:1'));
  assert.throws(() => crypto.decrypt(enc.replace('v1:', 'v9:'), 'ctx:1'), /desconhecido/);
  const k = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = 'curta';
  try { assert.throws(() => crypto.encrypt('x', 'a'), /ENCRYPTION_KEY/); } finally { process.env.ENCRYPTION_KEY = k; }
});

test('CPF: valida dígitos verificadores', () => {
  assert.equal(crypto.normalizeCpf(CPF), '52998224725');
  assert.equal(crypto.normalizeCpf('52998224725'), '52998224725');
  for (const bad of ['529.982.247-26', '111.111.111-11', '123', '', 'abcdefghijk']) assert.equal(crypto.normalizeCpf(bad), null, bad);
});

// ---------- CPF ----------
test('CPF: nunca fica em claro no banco; índice cego deduplica por clínica', async () => {
  const r = await newPatient(owner, { cpf: CPF });
  assert.equal(r.status, 201);
  const [row] = await t.sql('SELECT cpf_enc, cpf_hash FROM patients WHERE id=$1', [r.json.id]);
  assert.ok(row.cpf_enc.startsWith('v1:'));
  assert.ok(!JSON.stringify(row).includes('52998224725') && !JSON.stringify(row).includes('529.982'));
  assert.equal((await newPatient(owner, { cpf: '52998224725' })).status, 409);       // mesmo CPF, formato diferente
  assert.equal((await newPatient(ownerB, { cpf: CPF })).status, 201);                // outra clínica pode ter
});

test('CPF inválido é rejeitado (400) e a lista de pacientes não expõe CPF', async () => {
  assert.equal((await newPatient(owner, { cpf: '111.111.111-11' })).status, 400);
  await newPatient(owner, { cpf: CPF });
  const list = (await t.call('GET', '/patients', { token: owner })).json;
  assert.ok(!JSON.stringify(list).includes('cpf'));
});

test('ficha do paciente devolve o CPF em claro só para perfis clínicos, com auditoria', async () => {
  const { json: p } = await newPatient(reception, { cpf: CPF });        // recepção cadastra...
  assert.equal((await t.call('GET', `/patients/${p.id}`, { token: reception })).status, 403); // ...mas não lê
  const r = await t.call('GET', `/patients/${p.id}`, { token: owner });
  assert.equal(r.status, 200);
  assert.equal(r.json.cpf, '52998224725');
  assert.ok(!('cpf_enc' in r.json));
  const log = await audits('patient.read');
  assert.equal(log.length, 1);
  assert.equal(log[0].entity_id, p.id);
});

test('CPF cifrado copiado para outro paciente não decifra (preso ao id)', async () => {
  const a = (await newPatient(owner, { cpf: CPF })).json;
  const b = (await newPatient(owner, { fullName: 'Outra Pessoa' })).json;
  const [{ cpf_enc }] = await t.sql('SELECT cpf_enc FROM patients WHERE id=$1', [a.id]);
  await t.sql('UPDATE patients SET cpf_enc=$2 WHERE id=$1', [b.id, cpf_enc]);
  const r = await t.call('GET', `/patients/${b.id}`, { token: owner });
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(r.json).includes('52998224725'));
});

test('PUT /patients/:id/cpf define o CPF, bloqueia duplicado e respeita a clínica', async () => {
  const a = (await newPatient(owner)).json;
  assert.equal((await t.call('PUT', `/patients/${a.id}/cpf`, { token: owner, body: { cpf: CPF } })).status, 200);
  assert.equal((await t.call('GET', `/patients/${a.id}`, { token: owner })).json.cpf, '52998224725');
  const b = (await newPatient(owner, { fullName: 'Segundo Paciente' })).json;
  assert.equal((await t.call('PUT', `/patients/${b.id}/cpf`, { token: owner, body: { cpf: CPF } })).status, 409);
  assert.equal((await t.call('PUT', `/patients/${a.id}/cpf`, { token: ownerB, body: { cpf: CPF } })).status, 404);
  assert.equal((await t.call('PUT', `/patients/${a.id}/cpf`, { token: owner, body: { cpf: '123' } })).status, 400);
});

// ---------- prontuário ----------
const record = { allergies: 'Alergia a dipirona', evolution: 'Paciente relata melhora', anamnesis: { gestante: 'não' } };

test('prontuário: conteúdo clínico fica cifrado no banco e volta decifrado', async () => {
  const p = (await newPatient(owner)).json;
  const c = await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: record });
  assert.equal(c.status, 201);
  const [row] = await t.sql('SELECT data_enc FROM medical_records WHERE id=$1', [c.json.id]);
  assert.ok(row.data_enc.startsWith('v1:'));
  for (const word of ['dipirona', 'melhora', 'gestante']) assert.ok(!row.data_enc.includes(word), word);
  const list = (await t.call('GET', `/patients/${p.id}/records`, { token: owner })).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].allergies, 'Alergia a dipirona');
  assert.equal(list[0].author, 'Gestor Demo');
  assert.deepEqual(list[0].anamnesis, { gestante: 'não' });
});

test('prontuário: recepção não lê nem escreve; outra clínica não enxerga', async () => {
  const p = (await newPatient(owner)).json;
  await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: record });
  assert.equal((await t.call('GET', `/patients/${p.id}/records`, { token: reception })).status, 403);
  assert.equal((await t.call('POST', `/patients/${p.id}/records`, { token: reception, body: record })).status, 403);
  assert.equal((await t.call('GET', `/patients/${p.id}/records`, { token: ownerB })).status, 404);
  assert.equal((await t.call('POST', `/patients/${p.id}/records`, { token: ownerB, body: record })).status, 404);
  assert.equal((await t.sql('SELECT count(*)::int n FROM medical_records'))[0].n, 1);
});

test('prontuário: registro vazio é rejeitado; registro adulterado ou trocado não decifra', async () => {
  const p = (await newPatient(owner)).json;
  assert.equal((await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: {} })).status, 400);
  const r1 = (await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: record })).json;
  const r2 = (await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: { evolution: 'outro' } })).json;
  const [{ data_enc }] = await t.sql('SELECT data_enc FROM medical_records WHERE id=$1', [r1.id]);
  await t.sql('UPDATE medical_records SET data_enc=$2 WHERE id=$1', [r2.id, data_enc]);   // troca de linha
  const res = await t.call('GET', `/patients/${p.id}/records`, { token: owner });
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.json).includes('dipirona'));
});

// ---------- auditoria ----------
test('auditoria: login, falha de login, criação e leituras são registrados; e-mail inexistente não', async () => {
  await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'demo1234' } });
  await t.call('POST', '/auth/login', { body: { email: 'gestor@demo.test', password: 'errada' } });
  await t.call('POST', '/auth/login', { body: { email: 'fantasma@demo.test', password: 'x' } });
  const p = (await newPatient(owner)).json;
  await t.call('POST', `/patients/${p.id}/records`, { token: owner, body: record });
  await t.call('GET', `/patients/${p.id}/records`, { token: owner });
  const actions = (await t.sql('SELECT action FROM audit_log ORDER BY id')).map((r) => r.action);
  assert.deepEqual(actions, ['auth.login', 'auth.login_failed', 'patient.create', 'record.create', 'record.read']);
  const [last] = await t.sql('SELECT clinic_id, user_id, entity, entity_id, ip FROM audit_log ORDER BY id DESC LIMIT 1');
  assert.equal(last.clinic_id, A);
  assert.ok(last.user_id && last.ip);
  assert.equal(last.entity_id, p.id);
});

test('auditoria é imutável: UPDATE, DELETE e TRUNCATE são recusados', async () => {
  await newPatient(owner);
  await assert.rejects(() => t.sql(`UPDATE audit_log SET action='x'`), /imutável/);
  await assert.rejects(() => t.sql('DELETE FROM audit_log'), /imutável/);
  await assert.rejects(() => t.sql('TRUNCATE audit_log'), /imutável/);
});

test('GET /audit: só o dono da clínica, só da própria clínica', async () => {
  await newPatient(owner); await newPatient(ownerB);
  assert.equal((await t.call('GET', '/audit', { token: reception })).status, 403);
  const rows = (await t.call('GET', '/audit', { token: owner })).json;
  assert.ok(rows.length >= 1 && rows.every((r) => r.action));
  assert.ok(rows[0].user_name);
  const idsB = new Set((await t.sql('SELECT id FROM audit_log WHERE clinic_id<>$1', [A])).map((r) => r.id));
  assert.ok(rows.every((r) => !idsB.has(r.id)));
});

test('fail-closed: se o log de auditoria falhar, o dado sensível não é devolvido', async () => {
  const p = (await newPatient(owner, { cpf: CPF })).json;
  await t.sql('ALTER TABLE audit_log RENAME TO audit_log_off');
  try {
    const r = await t.call('GET', `/patients/${p.id}`, { token: owner });
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.json).includes('52998224725'));
  } finally { await t.sql('ALTER TABLE audit_log_off RENAME TO audit_log'); }
});

test('login: o tempo de resposta não depende de o e-mail existir', async () => {
  const time = async (email) => { const s = process.hrtime.bigint(); await t.call('POST', '/auth/login', { body: { email, password: 'errada' } }); return Number(process.hrtime.bigint() - s) / 1e6; };
  await time('gestor@demo.test'); // aquece
  const known = Math.min(await time('gestor@demo.test'), await time('gestor@demo.test'));
  const unknown = Math.min(await time('fantasma@demo.test'), await time('fantasma2@demo.test'));
  assert.ok(unknown > known * 0.5, `sem usuário respondeu rápido demais (${unknown.toFixed(1)}ms vs ${known.toFixed(1)}ms)`);
});
