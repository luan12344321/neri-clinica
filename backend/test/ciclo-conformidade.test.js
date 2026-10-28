import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, A, B } from './helpers.js';
import { decrypt } from '../src/crypto.js';

// Conformidade do ciclo: nenhuma mensagem automática, LGPD (logs, cifra em repouso), uso de IA sobre prontuário e reversão.
let t, askSara, tick, owner, pro, reception, ownerB;
before(async () => { t = await setup(); ({ askSara } = await import('../src/sara.js')); ({ tick } = await import('../src/jobs.js')); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  const hash = bcrypt.hashSync('demo1234', 4);
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES ($1,'Doutora','dra@demo.test',$2,'professional')`, [A, hash]);
  owner = await t.tokenFor('gestor@demo.test'); pro = await t.tokenFor('dra@demo.test');
  reception = await t.tokenFor('recepcao@demo.test'); ownerB = await t.tokenFor('b@demo.test');
});

const SRC = new URL('../src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, SRC), 'utf8');
const CICLO = ['atendimento.js', 'retornos.js', 'fila.js', 'painel_ciclo.js', 'lotes.js', 'rastreabilidade.js'];
const P1 = '20000000-0000-0000-0000-000000000001', PB = '2b000000-0000-0000-0000-000000000001';
const BOTOX = '10000000-0000-0000-0000-000000000001', TOXINA = '40000000-0000-0000-0000-000000000001';
const usage = { input: 1, output: 1 };

async function julia(email, name, args, clinicId = A) {
  const calls = [];
  const client = { generate: async (req) => {
    calls.push(structuredClone(req));
    return calls.length === 1 ? { parts: [{ functionCall: { name, args } }], usage } : { parts: [{ text: 'ok' }], usage };
  } };
  const [u] = await t.sql('SELECT id, role FROM users WHERE email=$1', [email]);
  await askSara({ clinicId, userId: u.id, role: u.role, ip: '1.2.3.4', message: 'pergunta', client });
  return { system: calls[0].system, response: calls[1].contents.at(-1).parts[0].functionResponse.response };
}

// ---------------- Julia e uso de IA sobre prontuário ----------------
test('Julia: ler prontuário grava ai_record_usage; recepção não vê; outra clínica 404; outro paciente não grava', async () => {
  await t.call('POST', `/patients/${P1}/records`, { token: owner, body: { allergies: 'Dipirona', evolution: 'Retorno em 30 dias' } });
  assert.equal((await t.sql('SELECT count(*)::int n FROM ai_record_usage'))[0].n, 0);
  const r = await julia('gestor@demo.test', 'patient_records', { patientId: P1 });
  assert.equal(r.response.result.registros[0].alergias, 'Dipirona');
  const [u] = await t.sql('SELECT clinic_id, patient_id, user_id, tool FROM ai_record_usage');
  assert.equal(u.clinic_id, A); assert.equal(u.patient_id, P1); assert.equal(u.tool, 'patient_records');
  assert.equal(u.user_id, (await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`))[0].id);
  assert.ok((await t.sql(`SELECT 1 FROM audit_log WHERE action='sara.patient_records'`)).length >= 1, 'auditoria antiga continua');
  // paciente de outra clínica: erro e nenhum registro novo
  const x = await julia('gestor@demo.test', 'patient_records', { patientId: PB });
  assert.match(x.response.error, /não encontrado/);
  assert.equal((await t.sql('SELECT count(*)::int n FROM ai_record_usage'))[0].n, 1);

  const ok = await t.call('GET', `/patients/${P1}/ai-usage`, { token: owner });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.length, 1);
  assert.deepEqual(Object.keys(ok.json[0]).sort(), ['createdAt', 'tool', 'userName']);
  assert.equal(ok.json[0].userName, 'Gestor Demo');
  assert.equal((await t.call('GET', `/patients/${P1}/ai-usage`, { token: pro })).status, 200);
  assert.equal((await t.call('GET', `/patients/${P1}/ai-usage`, { token: reception })).status, 403);
  assert.equal((await t.call('GET', `/patients/${P1}/ai-usage`)).status, 401);
  assert.equal((await t.call('GET', `/patients/${P1}/ai-usage`, { token: ownerB })).status, 404);
  assert.equal((await t.call('GET', `/patients/${PB}/ai-usage`, { token: owner })).status, 404);
});

test('ai-usage: mais recentes primeiro e limite de 50', async () => {
  const [u] = await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`);
  await t.sql(`INSERT INTO ai_record_usage (clinic_id, patient_id, user_id, tool, created_at)
    SELECT $1,$2,$3,'patient_records', now() - i * interval '1 minute' FROM generate_series(1,60) i`, [A, P1, u.id]);
  const r = (await t.call('GET', `/patients/${P1}/ai-usage`, { token: owner })).json;
  assert.equal(r.length, 50);
  assert.ok(Date.parse(r[0].createdAt) > Date.parse(r[49].createdAt));
});

test('prompt da Julia proíbe diagnóstico, conduta, prescrição e interpretação clínica', async () => {
  const { system } = await julia('gestor@demo.test', 'count_patients', {});
  assert.match(system, /NUNCA faz diagnóstico/);
  assert.match(system, /conduta, prescrição/);
  assert.match(system, /interpreta/);
  assert.match(system, /decisão é da doutora/);
});

// ---------------- Nenhuma mensagem automática ----------------
test('ciclo e jobs não enviam nada: nenhuma linha em message_queue por retorno, nenhum fetch para a Meta', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { sent.push(String(u)); return new Response('{}', { status: 200 }); };
  try {
    await t.sql(`UPDATE products SET units_per_package=100, unit_cost=500, device_type='toxin' WHERE id=$1`, [TOXINA]);
    const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
      VALUES ($1,$2,'L1',(now()+interval '90 days')::date,100,100) RETURNING id`, [A, TOXINA]);
    await t.call('PUT', `/procedures/${BOTOX}/return-rule`, { token: owner,
      body: { targetDays: 120, windowMinDays: 100, windowMaxDays: 140, messageText: 'Convite para a avaliação de retorno do {{procedimento}}.' } });
    const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
      VALUES ($1,$2,$3, now(), now() + interval '1 hour', 1200) RETURNING id`, [A, P1, BOTOX]);
    const r = await t.call('POST', `/appointments/${ap.id}/conclude`, { token: owner, body: { confirmed: true, applications: [{ productId: TOXINA, lotId: lot.id, units: 30 }] } });
    assert.equal(r.status, 200);
    // follow-up automático antigo teria disparado: o atendimento foi concluído há mais de 1 dia
    await t.sql(`UPDATE appointments SET completed_at = now() - interval '25 hours' WHERE id=$1`, [ap.id]);
    // um retorno "lembrar depois" que chegou o dia
    await t.sql(`UPDATE returns SET state='remind_later', remind_on=(now() - interval '1 day')::date`);
    const res = await tick(new Date());
    assert.ok(!('followup' in res), 'followup fora do tick');
    assert.equal(res.returnsTick, 'ok');
    assert.equal((await t.sql(`SELECT state FROM returns`))[0].state, 'suggested', 'returnsTick só muda estado');
    const kinds = (await t.sql('SELECT DISTINCT kind FROM message_queue')).map((x) => x.kind);
    assert.ok(kinds.every((k) => k === 'birthday'), `message_queue só pode ter aniversário (existia antes do ciclo): ${kinds}`);
    // GET da fila de retornos não enfileira nem envia
    await t.call('GET', '/returns/queue?scope=all', { token: reception });
    assert.deepEqual(sent.filter((u) => /graph\.facebook|wa\.me|api\.whatsapp/.test(u)), []);
  } finally { globalThis.fetch = realFetch; }
});

test('por leitura de código: só jobs.js (outbox), whatsapp.js e Julia chamam envio/fetch de saída; o ciclo não', () => {
  for (const f of CICLO) {
    const s = read(f);
    assert.ok(!/sendWhatsApp|fetch\(|wa\.me|nodemailer|sendMail|twilio|sms/i.test(s), `${f} não deve enviar nada`);
    assert.ok(!/message_queue/.test(s), `${f} não deve escrever em message_queue`);
  }
  const callers = readdirSync(SRC).filter((f) => f.endsWith('.js') && /sendWhatsApp\(|fetch\(/.test(read(f))).sort();
  assert.deepEqual(callers, ['asaas.js', 'gemini.js', 'google.js', 'jobs.js', 'whatsapp.js']);
});

// ---------------- LGPD ----------------
test('LGPD: nenhum log/console do ciclo carrega telefone, nome, lote ou conteúdo clínico; URLs só com ids', () => {
  for (const f of [...CICLO, 'prontuario.js']) {
    const s = read(f);
    assert.ok(!/console\./.test(s), `${f} usa console`);
    for (const line of s.split(/\r?\n/).filter((l) => /\blog\.(info|warn|error|debug|trace)\(/.test(l))) {
      assert.ok(!/(phone|full_name|patient|nome|lot|body|photo|record|allerg|cpf)/i.test(line), `${f} loga dado sensível: ${line.trim()}`);
    }
    for (const m of s.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g))
      assert.ok(/^[\w/:-]+$/.test(m[2]) && !/:(phone|name|cpf|lot|code)/i.test(m[2]), `${f}: rota ${m[2]} com dado na URL`);
  }
  const app = read('app.js');
  assert.ok(!/req\.log\.error\(err\);/.test(app), 'handler global não registra o objeto de erro inteiro (campos detail/parameters do pg)');
});

test('LGPD: erro 500 registra só tipo/código/mensagem, sem conteúdo do paciente', async () => {
  const [p] = await t.sql(`SELECT id FROM patients WHERE clinic_id=$1 LIMIT 1`, [A]);
  const [doc] = await t.sql(`INSERT INTO traceability_documents (clinic_id, appointment_id, patient_id, pdf_enc)
    SELECT $1, id, $2, 'lixo' FROM appointments WHERE clinic_id=$1 LIMIT 1 RETURNING id`, [A, p.id]);
  const logged = [];
  const orig = t.app.log.error;
  t.app.log.error = (...a) => { logged.push(a); };
  const consoleSeen = [];
  const co = console.error; console.error = (...a) => { consoleSeen.push(a); };
  try {
    const r = await t.call('GET', `/traceability/${doc.id}/pdf`, { token: owner });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal' });
  } finally { t.app.log.error = orig; console.error = co; }
  const text = JSON.stringify([...logged, ...consoleSeen]);
  assert.ok(!/Paciente|\+55|551199/.test(text));
  for (const a of logged) if (a[0]?.err) assert.deepEqual(Object.keys(a[0].err).sort(), ['code', 'message', 'stack', 'type']);
});

test('LGPD: erros de validação e 404 não devolvem nome, telefone nem foto', async () => {
  const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'L1',(now()+interval '90 days')::date,10,10) RETURNING id`, [A, TOXINA]);
  const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
    VALUES ($1,$2,$3, now(), now() + interval '1 hour', 1200) RETURNING id`, [A, P1, BOTOX]);
  const foto = 'NAOEJPEGNAOEJPEG==';
  const r = await t.call('POST', `/appointments/${ap.id}/conclude`, { token: owner, body: { confirmed: true, applications: [{ productId: TOXINA, lotId: lot.id, units: 1, labelPhoto: foto }] } });
  assert.equal(r.status, 400);
  const all = JSON.stringify([r.json, (await t.call('GET', `/returns/${ap.id}/slots?date=2031-01-01`, { token: owner })).json]);
  assert.ok(!all.includes(foto) && !/Paciente 1|99990001/.test(all));
});

test('LGPD: foto da etiqueta e comprovante só existem cifrados em repouso e sem rota pública', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('FOTO-ETIQUETA-FICTICIA')]).toString('base64');
  await t.sql(`UPDATE products SET units_per_package=1, device_type='hyaluronic_acid', unit_cost=100 WHERE id=$1`, [TOXINA]);
  const [lot] = await t.sql(`INSERT INTO product_lots (clinic_id, product_id, lot_code, expires_at, quantity_units, initial_units)
    VALUES ($1,$2,'AH1',(now()+interval '90 days')::date,5,5) RETURNING id`, [A, TOXINA]);
  const [ap] = await t.sql(`INSERT INTO appointments (clinic_id, patient_id, procedure_id, starts_at, ends_at, price)
    VALUES ($1,$2,$3, now(), now() + interval '1 hour', 1200) RETURNING id`, [A, P1, BOTOX]);
  const r = await t.call('POST', `/appointments/${ap.id}/conclude`, { token: pro, body: { confirmed: true, applications: [{ productId: TOXINA, lotId: lot.id, units: 1, labelPhoto: `data:image/jpeg;base64,${jpeg}` }] } });
  assert.equal(r.status, 200);
  const [row] = await t.sql('SELECT label_photo_enc FROM applications');
  assert.ok(row.label_photo_enc && !row.label_photo_enc.includes(jpeg.slice(0, 20)));
  assert.equal(decrypt(row.label_photo_enc, `applications.label:${r.json.applications[0].id}`), jpeg);
  assert.ok(!JSON.stringify(r.json).includes(jpeg), 'a resposta não devolve a foto');
  const [d] = await t.sql('SELECT pdf_enc FROM traceability_documents');
  assert.ok(!d.pdf_enc.includes('JVBER'));
  // nenhuma rota serve estes dados sem login
  assert.equal((await t.call('GET', `/traceability/${r.json.traceability.id}/pdf`)).status, 401);
  assert.equal((await t.app.inject({ method: 'GET', url: `/traceability/${r.json.traceability.id}/pdf?token=abc` })).statusCode, 401);
});

// ---------------- Reversão ----------------
test('rollback_ciclo_procedimento.sql: remove o ciclo, preserva dados antigos e o ensureSchema recria tudo', async () => {
  const cnt = async () => JSON.stringify(await Promise.all(['patients', 'products', 'appointments', 'stock_movements', 'transactions', 'procedures', 'users']
    .map(async (n) => [n, (await t.sql(`SELECT count(*)::int n FROM ${n}`))[0].n])));
  // um movimento antigo com um produto (sem lote) para conferir que continua após o rollback
  await t.sql(`INSERT INTO stock_movements (clinic_id, product_id, delta, reason) VALUES ($1,$2,2,'purchase')`, [A, TOXINA]);
  const before = await cnt();
  const prodBefore = JSON.stringify(await t.sql('SELECT id, name, quantity::float q, unit_cost::float c FROM products ORDER BY id'));

  await t.pool.query(readFileSync(new URL('../../db/rollback_ciclo_procedimento.sql', import.meta.url), 'utf8'));

  const gone = await t.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
    AND table_name IN ('product_lots','procedure_return_rules','applications','returns','contact_consents','traceability_documents','ai_record_usage')`);
  assert.deepEqual(gone, []);
  const cols = await t.sql(`SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND ((table_name='products' AND column_name IN ('category','manufacturer','device_type','units_per_package'))
      OR (table_name='stock_movements' AND column_name IN ('lot_id','application_id')))`);
  assert.deepEqual(cols, []);
  assert.equal(await cnt(), before, 'dados antigos íntegros');
  assert.equal(JSON.stringify(await t.sql('SELECT id, name, quantity::float q, unit_cost::float c FROM products ORDER BY id')), prodBefore);

  // reaplica: o ensureSchema (módulo novo, sem o cache da instância) recria tudo e o segundo ciclo é idempotente
  const mod = await import(`../src/schema.js?rollback=${Date.now()}`);
  await mod.ensureSchema();
  const back = await t.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
    AND table_name IN ('product_lots','procedure_return_rules','applications','returns','contact_consents','traceability_documents','ai_record_usage')`);
  assert.equal(back.length, 7);
  const bcols = await t.sql(`SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND ((table_name='products' AND column_name IN ('category','manufacturer','device_type','units_per_package'))
      OR (table_name='stock_movements' AND column_name IN ('lot_id','application_id')))`);
  assert.equal(bcols.length, 6);
  assert.equal(await cnt(), before);
});
