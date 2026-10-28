import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, A, B } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());

const PHONE_ID = '123456789012', SECRET = 'segredo-do-app-meta', TOKEN = `EAAB${'x'.repeat(40)}`;
const KNOWN = '551199990001'; // telefone do "Paciente 1" do seed (+551199990001)
const MONDAY = '2030-03-18';
const realFetch = globalThis.fetch;
let gemini, sent, graphInfo, geminiBodies;

// Simula Gemini e Graph API da Meta (nada sai para a internet).
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  gemini = []; sent = []; geminiBodies = []; graphInfo = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('generativelanguage.googleapis.com')) {
      geminiBodies.push(JSON.parse(init.body));
      const next = gemini.shift();
      if (!next) return json({ error: { message: 'sem resposta programada' } }, 500);
      if (next.status) return json({ error: { message: 'falha' } }, next.status);
      return json({ candidates: [{ content: { parts: next.parts } }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 15 } });
    }
    if (u.includes('graph.facebook.com') && init?.method === 'POST') {
      const b = JSON.parse(init.body);
      sent.push({ phoneId: u.split('/').at(-2), to: b.to, text: b.text.body, auth: init.headers.authorization });
      return json({ messages: [{ id: `wamid.OUT${sent.length}` }] });
    }
    if (u.includes('graph.facebook.com')) return graphInfo ?? json({ display_phone_number: '+55 11 90000-0000', verified_name: 'Clínica Demo' });
    throw new Error(`fetch inesperado: ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const fc = (name, args = {}) => ({ parts: [{ functionCall: { name, args } }] });
const txt = (s) => ({ parts: [{ text: s }] });
const ownerToken = () => t.tokenFor('gestor@demo.test');
const receptionToken = () => t.tokenFor('recepcao@demo.test');
const configure = async (extra = {}) => (await t.call('PUT', '/integrations/whatsapp', { token: await ownerToken(),
  body: { number: '+55 11 90000-0000', phoneId: PHONE_ID, token: TOKEN, appSecret: SECRET, enabled: true, ...extra } }));

let n = 0;
const payload = (from, text, id = `wamid.IN${++n}`, phoneId = PHONE_ID, type = 'text') => ({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '5511900000000', phone_number_id: phoneId },
  contacts: [{ profile: { name: 'Fulana' }, wa_id: from }],
  messages: [{ from, id, timestamp: '1', type, ...(type === 'text' ? { text: { body: text } } : {}) }] } }] }] });
const post = (obj, { secret = SECRET, sig } = {}) => {
  const raw = Buffer.from(JSON.stringify(obj));
  return t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
};
const say = (from, text, id) => post(payload(from, text, id));
const rows = (sql, p = []) => t.sql(sql, p);
const audited = async (action) => (await rows('SELECT 1 FROM audit_log WHERE action=$1', [action])).length;

test('configuração: só o dono; token e segredo cifrados e nunca devolvidos; Phone Number ID único', async () => {
  const rec = await receptionToken();
  assert.equal((await t.call('GET', '/integrations/whatsapp', { token: rec })).status, 403);
  assert.equal((await t.call('PUT', '/integrations/whatsapp', { token: rec, body: {} })).status, 403);
  assert.equal((await t.call('GET', '/integrations/whatsapp')).status, 401);
  const owner = await ownerToken();
  assert.equal((await t.call('PUT', '/integrations/whatsapp', { token: owner, body: { number: '123', phoneId: 'abc', enabled: false } })).status, 400);
  assert.equal((await configure({ token: undefined })).status, 400, 'ligar sem token é recusado');
  assert.equal((await configure()).status, 200);
  const cfg = (await t.call('GET', '/integrations/whatsapp', { token: owner })).json;
  assert.deepEqual([cfg.enabled, cfg.number, cfg.phoneId, cfg.tokenSet, cfg.secretSet], [true, '5511900000000', PHONE_ID, true, true]);
  assert.match(cfg.verifyToken, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(cfg).includes(TOKEN) && !JSON.stringify(cfg).includes(SECRET), 'a API nunca devolve token nem segredo');
  const [db] = await rows('SELECT whatsapp_token_enc, whatsapp_secret_enc FROM clinics WHERE id=$1', [A]);
  assert.ok(!db.whatsapp_token_enc.includes(TOKEN) && !db.whatsapp_secret_enc.includes(SECRET), 'cifrados no banco');
  assert.ok(await audited('whatsapp.config'));
  assert.ok(!JSON.stringify(await rows('SELECT * FROM audit_log')).includes(TOKEN), 'auditoria sem token');
  // salvar de novo sem token mantém o que já existe e o mesmo verify token
  assert.equal((await configure({ token: undefined, appSecret: undefined })).status, 200);
  assert.equal((await t.call('GET', '/integrations/whatsapp', { token: owner })).json.verifyToken, cfg.verifyToken);
  // outra clínica não pode usar o mesmo número
  const b = await t.tokenFor('b@demo.test');
  assert.equal((await t.call('PUT', '/integrations/whatsapp', { token: b, body: { number: '5511911111111', phoneId: PHONE_ID, token: TOKEN, appSecret: SECRET, enabled: true } })).status, 409);
});

test('testar conexão: confere o número na Meta e não vaza o token nos erros', async () => {
  const owner = await ownerToken();
  assert.equal((await t.call('POST', '/integrations/whatsapp/test', { token: owner })).status, 400, 'antes de salvar');
  await configure();
  const ok = await t.call('POST', '/integrations/whatsapp/test', { token: owner });
  assert.deepEqual([ok.status, ok.json.ok, ok.json.name], [200, true, 'Clínica Demo']);
  graphInfo = new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const bad = await t.call('POST', '/integrations/whatsapp/test', { token: owner });
  assert.equal(bad.status, 502);
  assert.ok(!JSON.stringify(bad.json).includes(TOKEN));
});

test('webhook: verificação da Meta aceita só o verify token certo', async () => {
  await configure();
  const { verifyToken } = (await t.call('GET', '/integrations/whatsapp', { token: await ownerToken() })).json;
  const ok = await t.app.inject({ method: 'GET', url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345` });
  assert.deepEqual([ok.statusCode, ok.body], [200, '12345']);
  assert.equal((await t.app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' })).statusCode, 403);
  assert.equal((await t.app.inject({ method: 'GET', url: '/webhooks/whatsapp' })).statusCode, 403);
});

test('assinatura inválida ou ausente: 401, nada é gravado, o modelo e a Meta não são chamados', async () => {
  await configure();
  gemini.push(txt('não deveria falar'));
  assert.equal((await post(payload(KNOWN, 'oi'), { secret: 'outro-segredo' })).statusCode, 401);
  assert.equal((await post(payload(KNOWN, 'oi'), { sig: 'sha256=00' })).statusCode, 401);
  assert.equal((await t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload(KNOWN, 'oi')) })).statusCode, 401);
  assert.deepEqual([geminiBodies.length, sent.length, (await rows('SELECT 1 FROM wa_messages')).length], [0, 0, 0]);
  assert.equal((await t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: 'isso não é json' })).statusCode, 400);
});

test('cliente cadastrado conversa: a Julia consulta a agenda dele, responde com as próprias palavras e registra tudo', async () => {
  await configure();
  const [p] = await rows(`SELECT id FROM patients WHERE phone='+${KNOWN}'`);
  await rows(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'scheduled')`,
    [A, p.id, `${MONDAY}T10:00:00-03:00`, `${MONDAY}T10:30:00-03:00`]);
  gemini.push(fc('my_appointments'), txt('Oi, Paciente! Você tem uma consulta marcada para segunda, 18/03, às 10h. Quer mudar alguma coisa?'));
  const r = await say(KNOWN, 'oi, que dia é minha consulta?');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent.map((s) => [s.phoneId, s.to]), [[PHONE_ID, KNOWN]]);
  assert.match(sent[0].text, /segunda, 18\/03, às 10h/);
  assert.equal(sent[0].auth, `Bearer ${TOKEN}`, 'usa o token da própria clínica');
  const log = await rows('SELECT direction, body, tokens_in, tokens_out FROM wa_messages ORDER BY id');
  assert.deepEqual(log.map((l) => l.direction), ['in', 'out']);
  assert.deepEqual([log[1].tokens_in, log[1].tokens_out], [20, 10], 'uso dos dois passos do modelo entra no orçamento');
  const first = geminiBodies[0];
  assert.match(first.systemInstruction.parts[0].text, /assistente virtual/);
  assert.match(first.systemInstruction.parts[0].text, /Paciente/, 'sabe quem é, pelo telefone');
  const tools = first.tools[0].functionDeclarations.map((x) => x.name).sort();
  assert.deepEqual(tools, ['available_slots', 'book_appointment', 'cancel_appointment', 'clinic_info', 'my_appointments', 'register_contact', 'reschedule_appointment', 'transfer_to_human']);
  assert.ok(!tools.some((x) => /patient|record|finance|transaction|revenue|dre|cash|product|stock/.test(x)), 'nenhuma ferramenta interna chega ao cliente');
  // segunda mensagem: o histórico volta ao modelo
  gemini.push(txt('Claro!'));
  await say(KNOWN, 'valeu');
  assert.equal(geminiBodies.at(-1).contents.length, 3, 'pergunta, resposta e nova mensagem');
});

test('reenvio da Meta (mesmo id de mensagem) é tratado uma vez só', async () => {
  await configure();
  gemini.push(txt('Oi!'), txt('de novo?'));
  await say(KNOWN, 'oi', 'wamid.IGUAL');
  await say(KNOWN, 'oi', 'wamid.IGUAL');
  assert.deepEqual([geminiBodies.length, sent.length], [1, 1]);
});

test('número novo: pede o nome, cadastra só com nome e telefone e agenda no horário livre', async () => {
  await configure();
  const NEW = '5511988887777';
  gemini.push(fc('register_contact', { fullName: 'Carla Nunes' }),
    fc('book_appointment', { startsAt: `${MONDAY}T14:30:00-03:00`, confirmed: true, patientId: '20000000-0000-0000-0000-000000000002' }),
    txt('Pronto, Carla! Marquei para segunda, 18/03, às 14h30.'));
  await say(NEW, 'quero marcar uma consulta segunda 14h30, meu nome é Carla Nunes');
  const [p] = await rows(`SELECT id, full_name, phone, cpf_enc, marketing_consent FROM patients WHERE clinic_id=$1 AND full_name='Carla Nunes'`, [A]);
  assert.deepEqual([p.phone, p.cpf_enc, p.marketing_consent], [`+${NEW}`, null, false]);
  const [ap] = await rows(`SELECT patient_id, clinic_id, to_char(starts_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') h FROM appointments WHERE patient_id=$1`, [p.id]);
  assert.deepEqual([ap.clinic_id, ap.h], [A, '14:30'], 'o paciente é o de quem escreveu, mesmo com patientId diferente vindo do modelo');
  assert.equal(sent.length, 1);
  assert.ok(await audited('whatsapp.patient_created') && await audited('whatsapp.book_appointment'));
  // horário ocupado: não duplica
  gemini.push(fc('book_appointment', { startsAt: `${MONDAY}T14:30:00-03:00`, confirmed: true }), txt('Esse horário acabou de ser ocupado, quer outro?'));
  await say(KNOWN, 'quero segunda 14h30 também');
  const results = geminiBodies.at(-1).contents.at(-1).parts[0].functionResponse.response;
  assert.match(results.error, /indisponível|identificada/);
  assert.equal((await rows('SELECT count(*)::int n FROM appointments WHERE starts_at=$1', [`${MONDAY}T14:30:00-03:00`]))[0].n, 1);
});

test('isolamento: o cliente só remarca e cancela os próprios agendamentos', async () => {
  await configure();
  const [me] = await rows(`SELECT id FROM patients WHERE phone='+${KNOWN}'`);
  const [other] = await rows(`SELECT id FROM patients WHERE phone='+551199990002'`);
  const mk = async (patient, hh) => (await rows(`INSERT INTO appointments (clinic_id, patient_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'scheduled') RETURNING id`,
    [A, patient, `${MONDAY}T${hh}:00-03:00`, new Date(new Date(`${MONDAY}T${hh}:00-03:00`).getTime() + 1800000).toISOString()]))[0].id;
  const mine = await mk(me.id, '09:00'), theirs = await mk(other.id, '11:30');
  const state = async (id) => (await rows(`SELECT status, to_char(starts_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') h FROM appointments WHERE id=$1`, [id]))[0];

  gemini.push(fc('cancel_appointment', { appointmentId: theirs, confirmed: true }), fc('reschedule_appointment', { appointmentId: theirs, startsAt: `${MONDAY}T16:00:00-03:00`, confirmed: true }), txt('Não encontrei esse horário no seu nome.'));
  await say(KNOWN, 'cancela a consulta da minha amiga');
  assert.deepEqual(await state(theirs), { status: 'scheduled', h: '11:30' }, 'agendamento de outro paciente intacto');
  const errs = geminiBodies.at(-1).contents.slice(-3).map((c) => c.parts[0].functionResponse?.response?.error);
  assert.ok(errs.filter(Boolean).length >= 1);

  gemini.push(fc('reschedule_appointment', { appointmentId: mine, startsAt: `${MONDAY}T15:00:00-03:00`, confirmed: true }), txt('Remarquei para 15h.'));
  await say(KNOWN, 'muda a minha para 15h');
  assert.deepEqual(await state(mine), { status: 'scheduled', h: '15:00' });
  gemini.push(fc('cancel_appointment', { appointmentId: mine, confirmed: false }), txt('Preciso da sua confirmação.'));
  await say(KNOWN, 'cancela');
  assert.equal((await state(mine)).status, 'scheduled', 'sem confirmed=true nada muda');
  gemini.push(fc('cancel_appointment', { appointmentId: mine, confirmed: true }), txt('Cancelado.'));
  await say(KNOWN, 'confirmo');
  assert.equal((await state(mine)).status, 'canceled');
  assert.ok(await audited('whatsapp.cancel_appointment') && await audited('whatsapp.reschedule_appointment'));
});

test('passar para a equipe: a Julia para de responder, a equipe vê a conversa e pode retomar', async () => {
  await configure();
  gemini.push(fc('transfer_to_human', { reason: 'cliente relata reação alérgica' }), txt('Vou chamar a equipe agora, ok? Se for urgente, ligue 192.'));
  await say(KNOWN, 'fiquei com a pele vermelha depois do procedimento');
  assert.equal(sent.length, 1);
  gemini.push(txt('não deveria responder'));
  await say(KNOWN, 'alguém aí?');
  assert.deepEqual([geminiBodies.length, sent.length], [2, 1], 'em atendimento humano a Julia fica quieta (nenhuma chamada nova ao modelo)');
  assert.equal((await rows('SELECT count(*)::int n FROM wa_messages WHERE direction=$1', ['in']))[0].n, 2, 'mas a mensagem fica guardada');
  const rec = await receptionToken();
  const waiting = (await t.call('GET', '/integrations/whatsapp/waiting', { token: rec })).json;
  assert.equal(waiting.length, 1);
  assert.deepEqual([waiting[0].contact, waiting[0].reason, waiting[0].last_message], [KNOWN, 'cliente relata reação alérgica', 'alguém aí?']);
  assert.equal((await t.call('POST', `/integrations/whatsapp/contacts/${KNOWN}/resume`, { token: rec })).status, 200);
  assert.equal((await t.call('GET', '/integrations/whatsapp/waiting', { token: rec })).json.length, 0);
  gemini.push(txt('Oi! Voltei por aqui.'));
  await say(KNOWN, 'voltou?');
  assert.equal(sent.length, 2);
  assert.ok(await audited('whatsapp.handoff') && await audited('whatsapp.resume'));
  assert.equal((await t.call('GET', '/integrations/whatsapp/waiting', { token: await t.tokenFor('b@demo.test') })).json.length, 0, 'outra clínica não vê');
});

test('número desligado ou desconhecido é ignorado; cada clínica só atende pelo próprio número', async () => {
  await configure({ enabled: false });
  assert.equal((await say(KNOWN, 'oi')).statusCode, 200);
  assert.deepEqual([geminiBodies.length, sent.length, (await rows('SELECT 1 FROM wa_messages')).length], [0, 0, 0]);
  await configure();
  assert.equal((await post(payload(KNOWN, 'oi', undefined, '999999999999'))).statusCode, 200);
  assert.equal(sent.length, 0);
  // clínica B com número próprio: o telefone de um paciente da A é desconhecido lá
  const b = await t.tokenFor('b@demo.test');
  assert.equal((await t.call('PUT', '/integrations/whatsapp', { token: b, body: { number: '5511911111111', phoneId: '555555555555', token: TOKEN, appSecret: 'segredo-b-segredo', enabled: true } })).status, 200);
  gemini.push(txt('Oi! Qual é o seu nome?'));
  await post(payload(KNOWN, 'oi', undefined, '555555555555'), { secret: 'segredo-b-segredo' });
  assert.match(geminiBodies[0].systemInstruction.parts[0].text, /ainda não tem cadastro/);
  assert.deepEqual(sent.map((s) => s.phoneId), ['555555555555']);
  assert.equal((await post(payload(KNOWN, 'oi', undefined, '555555555555'), { secret: SECRET })).statusCode, 401, 'o segredo de uma clínica não vale na outra');
});

test('orçamento esgotado, flood e falha do modelo: resposta curta, equipe avisada, sem gastar mais', async () => {
  await configure();
  await rows(`INSERT INTO wa_messages (clinic_id, contact, direction, body, tokens_in, tokens_out) VALUES ($1,'5511000000000','out','x',600000,500000)`, [A]);
  gemini.push(txt('não deveria chamar'));
  await say(KNOWN, 'oi');
  assert.equal(geminiBodies.length, 0);
  assert.match(sent[0].text, /avisei a equipe/);
  assert.equal((await rows('SELECT handoff_reason FROM wa_contacts WHERE contact=$1', [KNOWN]))[0].handoff_reason, 'limite mensal de IA');

  await rows('DELETE FROM wa_messages'); await rows('DELETE FROM wa_contacts'); sent.length = 0;
  await rows(`INSERT INTO wa_messages (clinic_id, contact, direction, body) SELECT $1, $2, 'in', 'spam' FROM generate_series(1, 41)`, [A, KNOWN]);
  await say(KNOWN, 'mais uma');
  assert.deepEqual([geminiBodies.length, sent.length], [0, 0], 'flood: guarda e não responde');

  await rows('DELETE FROM wa_messages'); await rows('DELETE FROM wa_contacts');
  gemini.length = 0; gemini.push({ status: 500 });
  await say(KNOWN, 'oi');
  assert.match(sent.at(-1).text, /avisei a equipe/);
  assert.equal((await rows('SELECT handoff_reason FROM wa_contacts WHERE contact=$1', [KNOWN]))[0].handoff_reason, 'erro técnico');
});

test('áudio e imagem não quebram; resposta longa vira até 3 mensagens curtas', async () => {
  await configure();
  gemini.push(txt('Oi! Eu ainda não consigo ouvir áudio.\n\nPode me escrever o que precisa?\n\nAssim eu te ajudo rapidinho.\n\nCombinado?'));
  await post(payload(KNOWN, '', undefined, PHONE_ID, 'audio'));
  assert.match(JSON.stringify(geminiBodies[0].contents), /não é texto/);
  assert.equal(sent.length, 3);
  assert.equal((await rows(`SELECT count(*)::int n FROM wa_messages WHERE direction='out'`))[0].n, 3);
});

test('o orçamento mensal já existente também conta as conversas do WhatsApp', async () => {
  await configure();
  gemini.push(txt('Oi!'));
  await say(KNOWN, 'oi');
  const { checkBudget } = await import('../src/sara.js');
  process.env.GEMINI_CLINIC_MONTHLY_TOKENS = '10';
  try { await assert.rejects(checkBudget(A), /orçamento/); } finally { delete process.env.GEMINI_CLINIC_MONTHLY_TOKENS; }
  await checkBudget(B);
});
