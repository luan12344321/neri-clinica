import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, A, B } from './helpers.js';

let t, askSara, toolsFor, BudgetError;
before(async () => { t = await setup(); ({ askSara, toolsFor } = await import('../src/sara.js')); ({ BudgetError } = await import('../src/gemini.js')); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const usage = { input: 10, output: 5 };
const toolUse = (name, args = {}) => ({ parts: [{ functionCall: { name, args } }], usage });
const text = (s) => ({ parts: [{ text: s }], usage });
function fakeClient(script) {
  const calls = [];
  return { calls, generate: async (req, opts) => { calls.push({ ...structuredClone(req), opts }); return typeof script === 'function' ? script(calls.length) : script.shift(); } };
}
const userOf = async (clinicId, email) => (await t.sql(email ? 'SELECT id, role FROM users WHERE email=$1' : 'SELECT id, role FROM users WHERE clinic_id=$1 LIMIT 1', [email ?? clinicId]))[0];
const ask = async (clinicId, client, extra = {}) => {
  const u = await userOf(clinicId, extra.email);
  return askSara({ clinicId, userId: u.id, role: u.role, message: 'faturamento?', client, ...extra, email: undefined });
};
const asReception = (client, extra = {}) => ask(A, client, { email: 'recepcao@demo.test', ...extra });
const lastResponse = (client) => client.calls.at(-1).contents.at(-1).parts[0].functionResponse.response;
const month = async () => (await t.sql(`SELECT to_char(date_trunc('month', now()) - interval '1 month','YYYY-MM') m`))[0].m;
const MONDAY = '2030-03-18', SUNDAY = '2030-03-17';

test('executa a ferramenta pedida e devolve o texto final', async () => {
  const c = fakeClient([toolUse('finance_summary', { month: await month() }), text('Faturou R$ 3.000')]);
  const r = await ask(A, c);
  assert.equal(r.reply, 'Faturou R$ 3.000');
  assert.equal(lastResponse(c).result.income, 3000);
  const decl = c.calls[0].tools;
  assert.ok(decl.length >= 6 && decl.every((x) => Object.keys(x).every((k) => ['name', 'description', 'parameters'].includes(k))), 'só nome, descrição e parâmetros vão ao modelo');
  assert.match(c.calls[0].system, /Julia/);
});

test('isolamento: clinic_id vindo do modelo é ignorado; vale o da sessão', async () => {
  const m = await month();
  const evil = () => [toolUse('finance_summary', { month: m, clinic_id: A, clinicId: A }), text('ok')];
  const cB = fakeClient(evil());
  await ask(B, cB);
  assert.equal(lastResponse(cB).result.income, 0, 'clínica B não pode ver a receita da A');
  const cA = fakeClient(evil());
  await ask(A, cA);
  assert.equal(lastResponse(cA).result.income, 3000);
});

test('ferramenta desconhecida vira erro para o modelo, sem derrubar a Julia', async () => {
  const c = fakeClient([toolUse('drop_database'), text('desculpe')]);
  const r = await ask(A, c);
  assert.equal(r.reply, 'desculpe');
  assert.ok(lastResponse(c).error);
});

test('erro próprio da ferramenta chega ao modelo com mensagem segura', async () => {
  const c = fakeClient([toolUse('list_appointments', { from: '2030-03-10', to: '2030-01-01' }), text('ok')]);
  await ask(A, c);
  assert.match(lastResponse(c).error, /intervalo inválido/);
});

test('limite de iterações: não entra em loop infinito de ferramentas', async () => {
  const c = fakeClient(() => toolUse('restock'));
  const r = await ask(A, c);
  assert.equal(c.calls.length, 8);
  assert.match(r.reply, /Não consegui concluir/);
});

test('orçamento de tempo: para de consultar antes de estourar o limite da função e avisa', async () => {
  const seen = [];
  const slow = { calls: [], generate: async (req, opts) => { seen.push(opts); await new Promise((r) => setTimeout(r, 30)); return toolUse('restock'); } };
  process.env.SARA_BUDGET_MS = '10';
  try {
    const r = await ask(A, slow);
    assert.equal(seen.length, 1, 'não faz uma segunda chamada depois de estourar o orçamento');
    assert.match(r.reply, /a tempo/);
    assert.ok(seen[0].timeout >= 1000, 'cada chamada leva um timeout para não travar a função');
  } finally { delete process.env.SARA_BUDGET_MS; }
});

test('persiste a conversa e reaproveita o histórico na mensagem seguinte', async () => {
  const c1 = fakeClient([text('Olá!')]);
  const r1 = await ask(A, c1);
  assert.equal((await t.sql('SELECT count(*)::int n FROM sara_messages WHERE conversation_id=$1', [r1.conversationId]))[0].n, 2);
  const c2 = fakeClient([text('de novo')]);
  await ask(A, c2, { conversationId: r1.conversationId });
  assert.equal(c2.calls[0].contents.length, 3); // user, model, nova pergunta
});

test('histórico antigo (formato do provedor anterior) é lido sem quebrar e sem reenviar ferramentas', async () => {
  const u = await userOf(A);
  const conv = '22222222-2222-4222-8222-222222222222';
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content) VALUES
    ($1,$2,$3,'user','"pergunta antiga"'),
    ($1,$2,$3,'assistant','[{"type":"tool_use","id":"x","name":"restock","input":{}}]'),
    ($1,$2,$3,'user','[{"type":"tool_result","tool_use_id":"x","content":"{}"}]'),
    ($1,$2,$3,'assistant','[{"type":"text","text":"resposta antiga"}]')`, [A, u.id, conv]);
  const c = fakeClient([text('ok')]);
  await ask(A, c, { conversationId: conv });
  assert.deepEqual(c.calls[0].contents.map((x) => x.role), ['user', 'model', 'user']);
});

test('histórico de uma conversa não vaza para outra clínica', async () => {
  const r = await ask(A, fakeClient([text('segredo da clínica A')]));
  const c = fakeClient([text('oi')]);
  await assert.rejects(ask(B, c, { conversationId: r.conversationId }), { error: 'conversation_not_found', code: 404 });
  assert.equal(c.calls.length, 0, 'a IA nem foi chamada');
  assert.equal((await t.sql('SELECT count(*)::int n FROM sara_messages WHERE clinic_id=$1', [B]))[0].n, 0, 'nada gravado na conversa alheia');
});

test('histórico: outro usuário não lê a conversa mesmo sabendo o conversationId', async () => {
  const a = await userOf(A);
  const other = (await t.sql('SELECT id, role FROM users WHERE id<>$1 LIMIT 1', [a.id]))[0];
  const conversationId = '11111111-1111-4111-8111-111111111111';
  await askSara({ clinicId: A, userId: a.id, role: a.role, message: 'segredo da conversa', conversationId, client: fakeClient([text('ok')]) });
  const c = fakeClient([text('ok')]);
  await assert.rejects(askSara({ clinicId: A, userId: other.id, role: other.role, message: 'oi', conversationId, client: c }), { error: 'conversation_not_found' });
  assert.equal(c.calls.length, 0, 'o outro usuário não usa nem lê a conversa alheia');
  const c2 = fakeClient([text('ok')]);
  await askSara({ clinicId: A, userId: a.id, role: a.role, message: 'de novo', conversationId, client: c2 });
  assert.ok(c2.calls[0].contents.length > 1, 'o dono da conversa continua vendo o próprio histórico');
});

test('permissões por perfil: recepção não enxerga nem executa ferramentas de dinheiro', async () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  for (const dinheiro of ['revenue_by_month', 'finance_summary', 'dre', 'top_procedures', 'business_insights']) {
    assert.ok(names('owner').includes(dinheiro) && names('manager').includes(dinheiro));
    assert.ok(!names('reception').includes(dinheiro) && !names('professional').includes(dinheiro));
  }
  assert.ok(!names('professional').includes('create_appointment'), 'profissional não agenda pela Julia');
  const c = fakeClient([toolUse('finance_summary', { month: await month() }), text('ok')]);
  await asReception(c);
  assert.ok(!c.calls[0].tools.some((x) => x.name === 'finance_summary'), 'o modelo nem recebe a ferramenta');
  assert.match(lastResponse(c).error, /indisponível/, 'e, se pedir mesmo assim, a execução recusa');
});

test('ferramentas do cliente final: só a consulta de horários livres está marcada para esse público', () => {
  assert.deepEqual(toolsFor('owner', 'client').map((x) => x.name), ['available_slots']);
});

test('find_patient: devolve só nome, nascimento e telefone, só da própria clínica, e deixa trilha de auditoria', async () => {
  const c = fakeClient([toolUse('find_patient', { name: 'Paciente' }), text('ok')]);
  await ask(A, c);
  const rows = lastResponse(c).result;
  assert.ok(rows.length >= 1 && rows.length <= 5);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'nascimento', 'nome', 'telefone']);
  assert.ok(!rows.some((r) => r.nome === 'Paciente B'));
  assert.ok((await t.sql(`SELECT 1 FROM audit_log WHERE action='sara.find_patient'`)).length >= 1);
  const curto = fakeClient([toolUse('find_patient', { name: 'ab' }), text('ok')]);
  await ask(A, curto);
  assert.equal(lastResponse(curto).error, 'argumentos inválidos');
});

test('available_slots: respeita o horário de atendimento e a agenda real', async () => {
  const c = fakeClient([toolUse('available_slots', { date: MONDAY }), text('ok')]);
  await ask(A, c);
  const { slots } = lastResponse(c).result;
  assert.ok(slots.includes('08:00') && slots.includes('10:30') && slots.includes('13:00') && slots.includes('17:30'));
  assert.ok(!slots.includes('11:00') && !slots.includes('12:30') && !slots.includes('18:00'));
  const dom = fakeClient([toolUse('available_slots', { date: SUNDAY }), text('ok')]);
  await ask(A, dom);
  assert.deepEqual(lastResponse(dom).result.slots, []);
});

test('create_appointment: agenda de verdade, recusa horário ocupado, paciente de outra clínica e falta de confirmação', async () => {
  const patient = '20000000-0000-0000-0000-000000000001';
  // Confirmação humana: a 1ª chamada só propõe; a mesma chamada numa mensagem seguinte da conversa executa.
  const book = async (args) => {
    const conversationId = randomUUID();
    await ask(A, fakeClient([toolUse('create_appointment', args), text('confirma?')]), { conversationId });
    const c = fakeClient([toolUse('create_appointment', args), text('ok')]);
    await ask(A, c, { conversationId });
    return c;
  };
  const base = { patientId: patient, startsAt: `${MONDAY}T14:30:00-03:00`, confirmed: true };

  const before = (await t.sql('SELECT count(*)::int n FROM appointments'))[0].n;
  const ok = await book(base);
  assert.equal(lastResponse(ok).result.ok, true);
  const [row] = await t.sql(`SELECT clinic_id, to_char(starts_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') h, status FROM appointments WHERE patient_id=$1 AND starts_at > now() + interval '1 year'`, [patient]);
  assert.deepEqual([row.clinic_id, row.h, row.status], [A, '14:30', 'scheduled']);
  assert.ok((await t.sql(`SELECT 1 FROM audit_log WHERE action='sara.create_appointment'`)).length >= 1);

  assert.match(lastResponse(await book(base)).error, /indisponível/, 'mesmo horário não agenda duas vezes');
  assert.match(lastResponse(await book({ ...base, startsAt: `${MONDAY}T12:00:00-03:00` })).error, /indisponível/, 'fora do expediente');
  assert.match(lastResponse(await book({ ...base, startsAt: `${MONDAY}T15:00:00-03:00`, patientId: '2b000000-0000-0000-0000-000000000001' })).error, /não foi possível/, 'paciente da clínica B');
  assert.equal(lastResponse(await book({ ...base, startsAt: `${MONDAY}T16:00:00-03:00`, confirmed: false })).error, 'argumentos inválidos');
  assert.equal((await t.sql('SELECT count(*)::int n FROM appointments'))[0].n, before + 1, 'nada além do primeiro agendamento foi criado');

  await t.sql(`UPDATE users SET role='professional' WHERE email='recepcao@demo.test'`);
  const asProf = fakeClient([toolUse('create_appointment', { ...base, startsAt: `${MONDAY}T16:00:00-03:00` }), text('ok')]);
  await asReception(asProf);
  assert.match(lastResponse(asProf).error, /indisponível/, 'profissional não tem a ferramenta de agendar');
});

test('confirmação humana: ação da Julia não roda na mesma rodada em que foi proposta, nem com dados trocados', async () => {
  const patient = '20000000-0000-0000-0000-000000000001';
  const args = { patientId: patient, startsAt: `${MONDAY}T14:30:00-03:00`, confirmed: true };
  const count = async () => (await t.sql('SELECT count(*)::int n FROM appointments'))[0].n;
  const n0 = await count();
  const conversationId = randomUUID();
  // injeção: o modelo propõe e chama de novo na mesma requisição
  const same = fakeClient([toolUse('create_appointment', args), toolUse('create_appointment', args), text('feito')]);
  await ask(A, same, { conversationId });
  assert.match(lastResponse(same).needsConfirmation, /NÃO executada/);
  assert.equal(await count(), n0, 'nada criado sem nova mensagem da pessoa');
  // próxima mensagem, mas com outro horário: não vale a proposta anterior
  const other = fakeClient([toolUse('create_appointment', { ...args, startsAt: `${MONDAY}T15:00:00-03:00` }), text('x')]);
  await ask(A, other, { conversationId });
  assert.ok(lastResponse(other).needsConfirmation);
  assert.equal(await count(), n0);
  // outro usuário não confirma proposta alheia (histórico é por usuário)
  const intruder = fakeClient([toolUse('create_appointment', args), text('x')]);
  await assert.rejects(asReception(intruder, { conversationId }), { error: 'conversation_not_found' });
  assert.equal(intruder.calls.length, 0);
  assert.equal(await count(), n0);
  // a proposta mais antiga (14:30) expirou: só vale a da rodada imediatamente anterior
  const stale = fakeClient([toolUse('create_appointment', args), text('x')]);
  await ask(A, stale, { conversationId: conversationId.toUpperCase() }); // id em maiúsculas é a mesma conversa
  assert.ok(lastResponse(stale).needsConfirmation, 'proposta de duas mensagens atrás não executa');
  assert.equal(await count(), n0);
  // mesma ação na mensagem seguinte do mesmo usuário: executa uma vez
  const ok = fakeClient([toolUse('create_appointment', args), text('ok')]);
  await ask(A, ok, { conversationId });
  assert.equal(lastResponse(ok).result.ok, true);
  assert.equal(await count(), n0 + 1);
  // replay: repetir a ação em mensagem posterior não reaproveita a confirmação já usada
  const again = fakeClient([toolUse('cancel_appointment', { appointmentId: lastResponse(ok).result.appointmentId, confirmed: true }), text('x')]);
  await ask(A, again, { conversationId });
  assert.ok(lastResponse(again).needsConfirmation);
  const replay = fakeClient([toolUse('create_appointment', args), text('x')]);
  await ask(A, replay, { conversationId });
  assert.ok(lastResponse(replay).needsConfirmation, 'confirmação usada não vale de novo');
  assert.equal(await count(), n0 + 1);
  const hist = await t.sql(`SELECT content FROM sara_messages WHERE conversation_id=$1`, [conversationId]);
  assert.ok(hist.every((r) => !String(r.content).includes(patient)), 'proposta pendente fica cifrada no histórico');
});

test('orçamento mensal de tokens: bloqueia a clínica ao estourar, sem chamar o provedor', async () => {
  const u = await userOf(A);
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content,tokens_in,tokens_out)
               VALUES ($1,$2,gen_random_uuid(),'assistant','[]',600000,500000)`, [A, u.id]);
  const c = fakeClient([text('não deveria chamar')]);
  await assert.rejects(ask(A, c), BudgetError);
  assert.equal(c.calls.length, 0);
  assert.equal((await t.call('POST', '/sara/chat', { token: await t.tokenFor('gestor@demo.test'), body: { message: 'oi' } })).json.error, 'ai_budget');
  const cB = fakeClient([text('ok')]);
  assert.equal((await ask(B, cB)).reply, 'ok', 'outra clínica não é afetada pelo limite da primeira');
});

test('orçamento total (todas as clínicas) também bloqueia', async () => {
  const u = await userOf(A);
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content,tokens_in,tokens_out)
               VALUES ($1,$2,gen_random_uuid(),'assistant','[]',10,10)`, [A, u.id]);
  process.env.GEMINI_TOTAL_MONTHLY_TOKENS = '15';
  try { await assert.rejects(ask(B, fakeClient([text('x')])), BudgetError); }
  finally { delete process.env.GEMINI_TOTAL_MONTHLY_TOKENS; }
});

test('rota /sara/chat: valida a mensagem e exige login; recepção entra (com ferramentas restritas)', async () => {
  const token = await t.tokenFor('gestor@demo.test');
  assert.equal((await t.call('POST', '/sara/chat', { body: { message: 'oi' } })).status, 401);
  assert.equal((await t.call('POST', '/sara/chat', { token, body: { message: '' } })).status, 400);
  assert.equal((await t.call('POST', '/sara/chat', { token, body: { message: 'x'.repeat(2001) } })).status, 400);
  const rec = await t.tokenFor('recepcao@demo.test');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Oi!' }] } }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 8 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const r = await t.call('POST', '/sara/chat', { token: rec, body: { message: 'oi' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.reply, 'Oi!');
    const [m] = await t.sql(`SELECT tokens_in, tokens_out FROM sara_messages WHERE role='assistant' ORDER BY id DESC LIMIT 1`);
    assert.deepEqual([m.tokens_in, m.tokens_out], [5, 3], 'uso de tokens registrado para o orçamento');
  } finally { globalThis.fetch = real; }
});

test('chave da API vai só no cabeçalho do servidor e nunca na URL nem na resposta ao front', async () => {
  const rec = await t.tokenFor('recepcao@demo.test');
  const real = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url: String(url), headers: init.headers }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const r = await t.call('POST', '/sara/chat', { token: rec, body: { message: 'oi' } });
    assert.ok(!seen.url.includes('test') || !seen.url.includes('key='), 'chave fora da URL');
    assert.equal(seen.headers['x-goog-api-key'], 'test');
    assert.ok(!JSON.stringify(r.json).includes('x-goog'));
  } finally { globalThis.fetch = real; }
});

test('histórico da Julia fica cifrado no banco e ainda é reaproveitado (auditoria V-01)', async () => {
  const r1 = await ask(A, fakeClient([text('Alergia a dipirona registrada no prontuário')]));
  const rows = await t.sql('SELECT content::text c FROM sara_messages WHERE conversation_id=$1', [r1.conversationId]);
  assert.ok(rows.length >= 2 && rows.every((r) => r.c.startsWith('"v1:') && !r.c.includes('dipirona')), 'nada em claro');
  const c2 = fakeClient([text('ok')]);
  await ask(A, c2, { conversationId: r1.conversationId });
  assert.equal(c2.calls[0].contents[1].parts[0].text, 'Alergia a dipirona registrada no prontuário');
});

test('histórico antigo em claro: script cifra tudo, apaga resultado de ferramenta e a conversa continua (S-03)', async () => {
  const { sealLegacyHistory } = await import('../src/sara.js');
  const u = await userOf(A);
  const conv = randomUUID();
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content) VALUES
    ($1,$2,$3,'user',to_jsonb('prontuário da Maria?'::text)),
    ($1,$2,$3,'assistant',$4::jsonb),
    ($1,$2,$3,'user',$5::jsonb),
    ($1,$2,$3,'assistant',$6::jsonb)`, [A, u.id, conv,
    JSON.stringify([{ functionCall: { name: 'patient_records', args: {} } }]),
    JSON.stringify([{ functionResponse: { name: 'patient_records', response: { result: { cpf: '529.982.247-25', alergia: 'dipirona' } } } }]),
    JSON.stringify([{ text: 'Alergia registrada: dipirona' }])]);
  assert.deepEqual(await sealLegacyHistory({ batch: 2, dryRun: true }), { scanned: 4, sealed: 4, alreadySealed: 0, failed: 0 }, 'dry-run conta e não grava');
  assert.equal((await t.sql(`SELECT count(*)::int n FROM sara_messages WHERE conversation_id=$1 AND content::text LIKE '"v1:%'`, [conv]))[0].n, 0);
  assert.deepEqual(await sealLegacyHistory({ batch: 2 }), { scanned: 4, sealed: 4, alreadySealed: 0, failed: 0 });
  assert.deepEqual(await sealLegacyHistory(), { scanned: 4, sealed: 0, alreadySealed: 4, failed: 0 }, 'idempotente');
  const raw = JSON.stringify(await t.sql('SELECT content FROM sara_messages WHERE conversation_id=$1', [conv]));
  assert.ok(!/dipirona|529|Maria/.test(raw), 'nada em claro');
  const c = fakeClient([text('ok')]);
  await ask(A, c, { conversationId: conv, message: 'e agora?' });
  const sent = JSON.stringify(c.calls[0].contents);
  assert.match(sent, /prontuário da Maria\?/); assert.match(sent, /Alergia registrada: dipirona/);
  assert.ok(!sent.includes('529.982.247-25'), 'resultado de ferramenta antigo não volta ao modelo');
});

// ---------- Rodada final: selagem verificável, persistência da conversa, reenvio e isolamento ----------
test('script de selagem: verificação conta claro/cifrado/ilegível; "v1:" digitado por pessoa em claro é selado; chave errada nunca grava', async () => {
  const { sealLegacyHistory, verifySealedHistory } = await import('../src/sara.js');
  const u = await userOf(A);
  const conv = randomUUID();
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content) VALUES
    ($1,$2,$3,'user',to_jsonb('v1:isto é só um texto que a pessoa digitou'::text)),
    ($1,$2,$3,'assistant',$4::jsonb)`, [A, u.id, conv, JSON.stringify([{ text: 'resposta antiga' }])]);
  await ask(A, fakeClient([text('nova')]), { conversationId: randomUUID() }); // uma conversa nova, já cifrada
  assert.deepEqual(await verifySealedHistory(), { total: 4, sealed: 2, plaintext: 2, unreadable: 0 });
  assert.equal((await sealLegacyHistory()).sealed, 2);
  assert.deepEqual(await verifySealedHistory(), { total: 4, sealed: 4, plaintext: 0, unreadable: 0 });
  const h = await t.call('GET', '/sara/history', { token: await t.tokenFor('gestor@demo.test') });
  assert.equal(h.status, 200);
  // chave trocada: tudo vira "ilegível", nada é regravado
  const keep = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  try {
    const v = await verifySealedHistory();
    assert.equal(v.unreadable, 4);
    const before = JSON.stringify(await t.sql('SELECT id, content FROM sara_messages ORDER BY id'));
    await sealLegacyHistory();
    assert.equal(JSON.stringify(await t.sql('SELECT id, content FROM sara_messages ORDER BY id')), before, 'dado ilegível nunca é regravado');
  } finally { process.env.ENCRYPTION_KEY = keep; }
});

test('conversa persiste: GET /sara/history devolve só texto, na ordem, e só da própria pessoa (B-JULIA-persistência)', async () => {
  const owner = await t.tokenFor('gestor@demo.test'), rec = await t.tokenFor('recepcao@demo.test'), ownerB = await t.tokenFor('b@demo.test');
  assert.deepEqual((await t.call('GET', '/sara/history', { token: owner })).json, { conversationId: null, messages: [] });
  assert.equal((await t.call('GET', '/sara/history')).status, 401);
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `resposta ${++n}` }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const a = await t.call('POST', '/sara/chat', { token: owner, body: { message: 'primeira' } });
    const b = await t.call('POST', '/sara/chat', { token: owner, body: { message: 'segunda', conversationId: a.json.conversationId } });
    assert.equal(b.json.conversationId, a.json.conversationId);
    const h = await t.call('GET', '/sara/history', { token: owner });
    assert.equal(h.json.conversationId, a.json.conversationId);
    assert.deepEqual(h.json.messages, [{ role: 'user', text: 'primeira' }, { role: 'sara', text: 'resposta 1' }, { role: 'user', text: 'segunda' }, { role: 'sara', text: 'resposta 2' }]);
    assert.deepEqual((await t.call('GET', '/sara/history', { token: rec })).json.messages, [], 'colega da mesma clínica não vê');
    assert.deepEqual((await t.call('GET', '/sara/history', { token: ownerB })).json.messages, [], 'outra clínica não vê');
    // usar o id de conversa de outra pessoa/clínica: 404, sem gravar nada nela
    const steal = await t.call('POST', '/sara/chat', { token: ownerB, body: { message: 'oi', conversationId: a.json.conversationId } });
    assert.equal(steal.status, 404);
    const own = (await t.sql('SELECT count(*)::int n FROM sara_messages WHERE conversation_id=$1', [a.json.conversationId]))[0].n;
    assert.equal(own, 4);
    // no banco nada em claro
    assert.ok(!JSON.stringify(await t.sql('SELECT content FROM sara_messages')).includes('primeira'));
    // conversa parada há mais de 12 h não reabre
    await t.sql(`UPDATE sara_messages SET created_at = now() - interval '13 hours'`);
    assert.deepEqual((await t.call('GET', '/sara/history', { token: owner })).json.messages, []);
  } finally { globalThis.fetch = real; }
});

test('reenvio da mesma mensagem (messageId) devolve a resposta já dada, sem gastar IA nem duplicar; ao mesmo tempo, 409', async () => {
  const owner = await t.tokenFor('gestor@demo.test');
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 60)); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok único' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const conversationId = randomUUID(), messageId = randomUUID();
    const body = { message: 'oi', conversationId, messageId };
    const [x, y] = await Promise.all([t.call('POST', '/sara/chat', { token: owner, body }), t.call('POST', '/sara/chat', { token: owner, body })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], 'simultâneo: um processa, o outro espera');
    assert.equal(calls, 1);
    const again = await t.call('POST', '/sara/chat', { token: owner, body });
    assert.equal(again.status, 200); assert.equal(again.json.reply, 'ok único'); assert.equal(again.json.duplicate, true);
    assert.equal(calls, 1, 'não chamou a IA de novo');
    assert.equal((await t.sql(`SELECT count(*)::int n FROM sara_messages WHERE conversation_id=$1`, [conversationId]))[0].n, 2, 'uma pergunta e uma resposta');
  } finally { globalThis.fetch = real; }
});

test('script seal-sara-history.js: sem flag só simula; --apply cifra e confere; roda de novo sem mexer (banco isolado)', async () => {
  const { main } = await import('../scripts/seal-sara-history.js');
  const run = async (...args) => { let out = ''; const code = await main(args, (...a) => { out += `${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`; }); return { code, out }; };
  const u = await userOf(A);
  const conv = randomUUID();
  await t.sql(`INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content) VALUES ($1,$2,$3,'user',to_jsonb('CPF 529.982.247-25'::text))`, [A, u.id, conv]);
  const dry = await run();
  assert.equal(dry.code, 0, dry.out); assert.match(dry.out, /Simulação/); assert.match(dry.out, /"plaintext":1/);
  assert.match((await t.sql('SELECT content::text c FROM sara_messages WHERE conversation_id=$1', [conv]))[0].c, /529/, 'simulação não gravou');
  const applied = await run('--apply');
  assert.equal(applied.code, 0); assert.match(applied.out, /Depois:.*"plaintext":0/);
  assert.ok(!(await t.sql('SELECT content::text c FROM sara_messages WHERE conversation_id=$1', [conv]))[0].c.includes('529'));
  const again = await run('--apply');
  assert.equal(again.code, 0); assert.match(again.out, /"sealed":0,"alreadySealed"/);
  // chave errada: aborta com código 1 e não grava
  const keep = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
  try { const bad = await run('--apply'); assert.equal(bad.code, 1); assert.match(bad.out, /ilegíveis/); } finally { process.env.ENCRYPTION_KEY = keep; }
});
