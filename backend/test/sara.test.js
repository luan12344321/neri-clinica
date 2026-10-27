import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(c.calls.length, 6);
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
  await ask(B, c, { conversationId: r.conversationId });
  assert.equal(c.calls[0].contents.length, 1);
  assert.ok(!JSON.stringify(c.calls[0].contents).includes('segredo'));
});

test('histórico: outro usuário não lê a conversa mesmo sabendo o conversationId', async () => {
  const a = await userOf(A);
  const other = (await t.sql('SELECT id, role FROM users WHERE id<>$1 LIMIT 1', [a.id]))[0];
  const conversationId = '11111111-1111-4111-8111-111111111111';
  await askSara({ clinicId: A, userId: a.id, role: a.role, message: 'segredo da conversa', conversationId, client: fakeClient([text('ok')]) });
  const c = fakeClient([text('ok')]);
  await askSara({ clinicId: A, userId: other.id, role: other.role, message: 'oi', conversationId, client: c });
  assert.equal(c.calls[0].contents.length, 1, 'só a mensagem nova: o histórico do outro usuário não vem junto');
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
  const book = (args, who = (c) => ask(A, c)) => { const c = fakeClient([toolUse('create_appointment', args), text('ok')]); return who(c).then(() => c); };
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
