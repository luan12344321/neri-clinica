import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, owner, manager, reception, prof, ownerB, pid;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  for (const [name, email, role] of [['Gerente', 'gerente@demo.test', 'manager'], ['Prof', 'prof@demo.test', 'professional']]) {
    await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) SELECT $1,$2,$3,password_hash,$4 FROM users WHERE email='gestor@demo.test'`, [A, name, email, role]);
  }
  [owner, manager, reception, prof, ownerB] = await Promise.all(['gestor@demo.test', 'gerente@demo.test', 'recepcao@demo.test', 'prof@demo.test', 'b@demo.test'].map((e) => t.tokenFor(e)));
  // titular fictício completo: CPF, telefone, prontuário, consentimento, mensagem na fila, conversa de WhatsApp
  const p = await t.call('POST', '/patients', { token: owner, body: { fullName: 'Fulana de Tal Teste', birthDate: '1990-05-17', phone: '11988887777', email: 'fulana@teste.invalid', cpf: '529.982.247-25' } });
  assert.equal(p.status, 201);
  pid = p.json.id;
  await t.call('POST', `/patients/${pid}/records`, { token: owner, body: { allergies: 'dipirona', evolution: 'sem intercorrências' } });
  await t.sql(`INSERT INTO message_queue (clinic_id, patient_id, kind, body, dedupe_key) VALUES ($1,$2,'return','Olá, Fulana! volte logo','k1'), ($1,$2,'birthday','Parabéns, Fulana','k2')`, [A, pid]);
  await t.sql(`UPDATE message_queue SET status='sent', sent_at=now() WHERE dedupe_key='k2'`);
  await t.sql(`INSERT INTO wa_messages (clinic_id, contact, direction, body) VALUES ($1,'5511988887777','in','oi, sou a Fulana')`, [A]);
  await t.sql(`INSERT INTO wa_contacts (clinic_id, contact, display_name) VALUES ($1,'5511988887777','Fulana WhatsApp')`, [A]);
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at, status, price) VALUES ($1,$2, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'done', 300)`, [A, pid]);
});

const patientRow = async () => (await t.sql('SELECT * FROM patients WHERE id=$1', [pid]))[0];
const anon = (token, body = { confirmName: 'Fulana de Tal Teste', acknowledge: true }) => t.call('POST', `/lgpd/patients/${pid}/anonymize`, { token, body });

test('exportação: dados completos do titular (CPF e prontuário decifrados), só dono/gerente, da própria clínica, auditada', async () => {
  const r = await t.call('GET', `/lgpd/patients/${pid}/export`, { token: manager });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /attachment; filename="titular-/);
  assert.equal(r.json.patient.cpf, '52998224725');
  assert.deepEqual([r.json.patient.fullName, r.json.patient.phone, r.json.patient.email], ['Fulana de Tal Teste', '11988887777', 'fulana@teste.invalid']);
  assert.equal(r.json.medicalRecords[0].allergies, 'dipirona');
  assert.equal(r.json.appointments.length, 1);
  assert.equal(r.json.messages.length, 2);
  assert.equal(r.json.whatsappMessages[0].body, 'oi, sou a Fulana');
  assert.ok(r.json.accessLog.some((l) => l.action === 'patient.create'));
  assert.ok(!JSON.stringify(r.json).match(/password|totp|token/i), 'nada de credencial');
  for (const [who, tk] of [['recepção', reception], ['profissional', prof]]) assert.equal((await t.call('GET', `/lgpd/patients/${pid}/export`, { token: tk })).status, 403, who);
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}/export`)).status, 401);
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}/export`, { token: ownerB })).status, 404, 'outra clínica');
  assert.equal((await t.call('GET', '/lgpd/patients/xyz/export', { token: owner })).status, 400);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='lgpd.export' AND entity_id=$1`, [pid]))[0].n, 1, 'só o acesso permitido foi registrado');
});

test('situação do titular: bloqueio e anonimização visíveis para dono/gerente', async () => {
  assert.deepEqual((await t.call('GET', `/lgpd/patients/${pid}`, { token: manager })).json, { legalHold: null, anonymizedAt: null });
  await t.call('PUT', `/lgpd/patients/${pid}/hold`, { token: owner, body: { reason: 'litígio em andamento' } });
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}`, { token: manager })).json.legalHold.reason, 'litígio em andamento');
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}`, { token: reception })).status, 403);
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}`, { token: ownerB })).status, 404);
});

test('correção: qualquer perfil da clínica corrige identificação/contato; valida; audita só os nomes dos campos; outra clínica 404', async () => {
  const r = await t.call('PATCH', `/patients/${pid}`, { token: reception, body: { fullName: 'Fulana de Tal Silva', phone: '(11) 97777-6666', notes: null } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: pid, full_name: 'Fulana de Tal Silva', birth_date: '1990-05-17', phone: '(11) 97777-6666' }, 'devolve só o que a recepção já vê (sem e-mail/observações)');
  assert.equal((await patientRow()).notes, null);
  assert.equal((await t.call('PATCH', `/patients/${pid}`, { token: reception, body: {} })).status, 400);
  assert.equal((await t.call('PATCH', `/patients/${pid}`, { token: reception, body: { phone: '123' } })).status, 400);
  assert.equal((await t.call('PATCH', `/patients/${pid}`, { token: reception, body: { email: 'nao-e-email' } })).status, 400);
  assert.equal((await t.call('PATCH', `/patients/${pid}`, { token: ownerB, body: { fullName: 'Invasor' } })).status, 404);
  assert.equal((await t.call('PATCH', `/patients/${pid}`)).status, 401);
  const acts = (await t.sql(`SELECT action FROM audit_log WHERE entity_id=$1 AND action LIKE 'patient.update%'`, [pid])).map((x) => x.action);
  assert.deepEqual(acts, ['patient.update:fullName,notes,phone']);
  assert.ok(!JSON.stringify(acts).includes('Silva'), 'valor novo nunca vai para a trilha');
});

test('anonimização: só o dono, com nome digitado e confirmação; some a identificação, mantém prontuário/financeiro/auditoria', async () => {
  for (const [who, tk] of [['gerente', manager], ['recepção', reception], ['profissional', prof]]) assert.equal((await anon(tk)).status, 403, who);
  assert.equal((await anon(ownerB)).status, 404);
  assert.equal((await anon(owner, { confirmName: 'Outra Pessoa', acknowledge: true })).status, 400);
  assert.equal((await anon(owner, { confirmName: 'Fulana de Tal Teste' })).status, 400, 'exige acknowledge');
  assert.equal((await patientRow()).anonymized_at, null, 'recusas não alteram nada');
  const r = await anon(owner);
  assert.equal(r.status, 200);
  assert.ok(r.json.kept.length && r.json.notCovered.length, 'a resposta diz o que ficou e o que não foi coberto');
  const p = await patientRow();
  assert.deepEqual([p.full_name, p.birth_date, p.phone, p.email, p.cpf_enc, p.cpf_hash, p.notes, p.marketing_consent], ['Paciente anonimizado', null, null, null, null, null, null, false]);
  assert.ok(p.anonymized_at);
  // sem novos contatos
  const q1 = await t.sql(`SELECT dedupe_key, body, status FROM message_queue WHERE patient_id=$1 ORDER BY dedupe_key`, [pid]);
  assert.deepEqual(q1.map((x) => [x.body, x.status]), [['[removido]', 'failed'], ['[removido]', 'sent']]);
  assert.equal((await t.sql(`SELECT body FROM wa_messages WHERE contact='5511988887777'`))[0].body, '[removido]');
  assert.equal((await t.sql(`SELECT display_name FROM wa_contacts WHERE contact='5511988887777'`))[0].display_name, null);
  const consents = await t.sql(`SELECT DISTINCT ON (purpose) purpose, granted FROM contact_consents WHERE patient_id=$1 ORDER BY purpose, id DESC`, [pid]);
  assert.ok(consents.length === 3 && consents.every((c) => c.granted === false));
  // o que se mantém por obrigação
  assert.equal((await t.call('GET', `/patients/${pid}/records`, { token: owner })).json[0].allergies, 'dipirona', 'prontuário não é tocado');
  assert.equal((await t.sql('SELECT count(*)::int n FROM appointments WHERE patient_id=$1', [pid]))[0].n, 1);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='lgpd.anonymize' AND entity_id=$1`, [pid]))[0].n, 1);
  // some das buscas e não aceita agendamento novo nem correção; segunda vez 409
  for (const s of ['Paciente anon', 'Fulana']) assert.ok(!(await t.call('GET', `/patients?search=${encodeURIComponent(s)}`, { token: owner })).json.some((x) => x.id === pid), s);
  const ap = await t.call('POST', '/appointments', { token: owner, body: { patientId: pid, startsAt: '2031-01-05T13:00:00.000Z', endsAt: '2031-01-05T14:00:00.000Z' } });
  assert.equal(ap.status, 404);
  assert.equal((await t.call('PATCH', `/patients/${pid}`, { token: owner, body: { fullName: 'Voltou' } })).status, 409);
  assert.equal((await anon(owner, { confirmName: 'Paciente anonimizado', acknowledge: true })).status, 409);
  // exportar depois mostra o estado anonimizado
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}/export`, { token: owner })).json.patient.fullName, 'Paciente anonimizado');
});

test('anonimização: WhatsApp com e sem o 9º dígito e Julia não acha nem agenda o anonimizado', async () => {
  await t.sql(`INSERT INTO wa_messages (clinic_id, contact, direction, body) VALUES ($1,'551188887777','in','sem nono digito, sou a Fulana')`, [A]);
  assert.equal((await anon(owner)).status, 200);
  assert.deepEqual((await t.sql(`SELECT body FROM wa_messages WHERE clinic_id=$1`, [A])).map((x) => x.body), ['[removido]', '[removido]']);
  const { toolsFor } = await import('../src/sara.js');
  const tool = (n) => toolsFor('owner').find((x) => x.name === n);
  const ctx = { clinicId: A, userId: (await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`))[0].id, role: 'owner' };
  assert.deepEqual(await tool('find_patient').run(ctx, { name: 'anonimizado' }), [], 'Julia não encontra');
  await assert.rejects(tool('create_appointment').run(ctx, { patientId: pid, startsAt: '2031-02-03T14:00:00-03:00', confirmed: true }));
  assert.equal((await t.sql('SELECT count(*)::int n FROM appointments WHERE patient_id=$1 AND starts_at > now()', [pid]))[0].n, 0);
});

test('anonimização bloqueada por consulta futura e por retenção legal; liberar o bloqueio permite', async () => {
  await t.sql(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at, status) VALUES ($1,$2, now() + interval '3 days', now() + interval '3 days 1 hour', 'scheduled')`, [A, pid]);
  const open = await anon(owner);
  assert.deepEqual([open.status, open.json.error], [409, 'open appointments']);
  await t.sql(`UPDATE appointments SET status='canceled' WHERE patient_id=$1 AND starts_at > now()`, [pid]);
  assert.equal((await t.call('PUT', `/lgpd/patients/${pid}/hold`, { token: manager, body: { reason: 'processo judicial 123' } })).status, 403, 'só o dono');
  assert.equal((await t.call('PUT', `/lgpd/patients/${pid}/hold`, { token: owner, body: { reason: 'x' } })).status, 400, 'motivo obrigatório');
  assert.equal((await t.call('PUT', `/lgpd/patients/${pid}/hold`, { token: owner, body: { reason: 'processo judicial 123' } })).status, 200);
  const held = await anon(owner);
  assert.deepEqual([held.status, held.json.error], [409, 'legal_hold']);
  assert.equal((await patientRow()).anonymized_at, null);
  assert.equal((await t.call('DELETE', `/lgpd/patients/${pid}/hold`, { token: owner })).status, 204);
  assert.equal((await anon(owner)).status, 200);
  const acts = (await t.sql(`SELECT action FROM audit_log WHERE entity_id=$1 AND action LIKE 'lgpd.%' ORDER BY id`, [pid])).map((x) => x.action);
  assert.deepEqual(acts, ['lgpd.hold_set', 'lgpd.hold_cleared', 'lgpd.anonymize']);
});

test('anonimizações simultâneas: uma só vence', async () => {
  const [a, b] = await Promise.all([anon(owner), anon(owner)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='lgpd.anonymize'`))[0].n, 1);
});

test('retenção: sem prazo definido nada é sugerido; com prazo lista só quem passou, sem bloqueio, e nunca apaga', async () => {
  assert.deepEqual((await t.call('GET', '/lgpd/retention', { token: manager })).json, { retentionYears: null, decisionPending: true, candidates: [] });
  assert.equal((await t.call('GET', '/lgpd/retention', { token: reception })).status, 403);
  assert.equal((await t.call('PUT', '/lgpd/retention', { token: manager, body: { retentionYears: 5 } })).status, 403);
  assert.equal((await t.call('PUT', '/lgpd/retention', { token: owner, body: { retentionYears: 0 } })).status, 400);
  assert.equal((await t.call('PUT', '/lgpd/retention', { token: owner, body: { retentionYears: 5 } })).status, 200);
  assert.equal((await t.call('GET', '/lgpd/retention', { token: owner })).json.candidates.length, 0, 'paciente recente não passou do prazo');
  await t.sql('ALTER TABLE medical_records DISABLE TRIGGER ALL');
  await t.sql(`UPDATE patients SET created_at = now() - interval '9 years' WHERE id=$1`, [pid]);
  await t.sql(`UPDATE appointments SET starts_at = now() - interval '8 years', ends_at = now() - interval '8 years' + interval '1 hour' WHERE patient_id=$1`, [pid]);
  await t.sql(`UPDATE medical_records SET created_at = now() - interval '8 years' WHERE patient_id=$1`, [pid]);
  await t.sql('ALTER TABLE medical_records ENABLE TRIGGER ALL');
  const r = await t.call('GET', '/lgpd/retention', { token: manager });
  assert.deepEqual(r.json.candidates.map((c) => c.id), [pid]);
  await t.call('PUT', `/lgpd/patients/${pid}/hold`, { token: owner, body: { reason: 'litígio em andamento' } });
  assert.equal((await t.call('GET', '/lgpd/retention', { token: manager })).json.candidates.length, 0, 'bloqueio legal tira da lista');
  assert.equal((await patientRow()).anonymized_at, null, 'listar nunca anonimiza nem apaga');
  assert.equal((await t.sql('SELECT count(*)::int n FROM medical_records WHERE patient_id=$1', [pid]))[0].n, 1);
  assert.equal((await t.call('PUT', '/lgpd/retention', { token: owner, body: { retentionYears: null } })).status, 200);
});

test('trilha de acesso do titular: só o dono vê; mostra quem fez o quê e é registrada', async () => {
  await t.call('GET', `/patients/${pid}`, { token: prof });
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}/access-log`, { token: manager })).status, 403);
  assert.equal((await t.call('GET', `/lgpd/patients/${pid}/access-log`, { token: ownerB })).status, 404);
  const r = await t.call('GET', `/lgpd/patients/${pid}/access-log`, { token: owner });
  assert.equal(r.status, 200);
  assert.ok(r.json.some((l) => l.action === 'patient.read' && l.userName === 'Prof'));
  assert.ok(r.json.some((l) => l.action === 'record.read' || l.action === 'patient.create'));
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='lgpd.access_log_read'`))[0].n, 1);
});
