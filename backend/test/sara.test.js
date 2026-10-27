import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A, B } from './helpers.js';

let t, askSara;
before(async () => { t = await setup(); ({ askSara } = await import('../src/sara.js')); });
after(() => t.close());
beforeEach(async () => { await t.reset(); await t.addExtras(); });

const usage = { input_tokens: 10, output_tokens: 5 };
const toolUse = (name, input, id = 't1') => ({ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id, name, input }] });
const text = (s) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: s }] });
function fakeClient(script) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(structuredClone(req)); return typeof script === 'function' ? script(calls.length) : script.shift(); } } };
}
const ask = async (clinicId, client, extra = {}) => {
  const [u] = await t.sql('SELECT id FROM users WHERE clinic_id=$1 LIMIT 1', [clinicId]);
  return askSara({ clinicId, userId: u.id, message: 'faturamento?', client, ...extra });
};
const toolResult = (client) => client.calls.at(-1).messages.at(-1).content[0];
const month = async () => (await t.sql(`SELECT to_char(date_trunc('month', now()) - interval '1 month','YYYY-MM') m`))[0].m;

test('executa a ferramenta pedida e devolve o texto final', async () => {
  const c = fakeClient([toolUse('finance_summary', { month: await month() }), text('Faturou R$ 3.000')]);
  const r = await ask(A, c);
  assert.equal(r.reply, 'Faturou R$ 3.000');
  const res = toolResult(c);
  assert.equal(res.type, 'tool_result'); assert.equal(res.tool_use_id, 't1');
  assert.equal(JSON.parse(res.content).income, 3000);
  assert.ok(c.calls[0].tools.length >= 6 && c.calls[0].tools.every((x) => !x.run), 'ferramentas enviadas sem a função run');
  assert.match(c.calls[0].system, /Julia/);
});

test('isolamento: clinic_id vindo do modelo é ignorado; vale o da sessão', async () => {
  const m = await month();
  const evil = () => [toolUse('finance_summary', { month: m, clinic_id: A, clinicId: A }), text('ok')];
  const cB = fakeClient(evil());
  await ask(B, cB);
  assert.equal(JSON.parse(toolResult(cB).content).income, 0, 'clínica B não pode ver a receita da A');
  const cA = fakeClient(evil());
  await ask(A, cA);
  assert.equal(JSON.parse(toolResult(cA).content).income, 3000);
});

test('ferramenta desconhecida ou com erro vira tool_result com is_error, sem derrubar a Julia', async () => {
  const c = fakeClient([toolUse('drop_database', {}), text('desculpe')]);
  const r = await ask(A, c);
  assert.equal(r.reply, 'desculpe');
  assert.equal(toolResult(c).is_error, true);
});

test('limite de iterações: não entra em loop infinito de ferramentas', async () => {
  const c = fakeClient(() => toolUse('restock', {}));
  const r = await ask(A, c);
  assert.equal(c.calls.length, 6);
  assert.match(r.reply, /Não consegui concluir/);
});

test('orçamento de tempo: para de consultar antes de estourar o limite da função e avisa', async () => {
  const seen = [];
  const slow = { calls: [], messages: { create: async (req, opts) => { seen.push(opts); await new Promise((r) => setTimeout(r, 30)); return toolUse('restock', {}); } } };
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
  assert.equal(c2.calls[0].messages.length, 3); // user, assistant, nova pergunta
});

test('histórico de uma conversa não vaza para outra clínica', async () => {
  const r = await ask(A, fakeClient([text('segredo da clínica A')]));
  const c = fakeClient([text('oi')]);
  await ask(B, c, { conversationId: r.conversationId });
  assert.equal(c.calls[0].messages.length, 1);
  assert.ok(!JSON.stringify(c.calls[0].messages).includes('segredo'));
});

test('rota /sara/chat: valida a mensagem e exige login', async () => {
  const token = await t.tokenFor('gestor@demo.test');
  assert.equal((await t.call('POST', '/sara/chat', { body: { message: 'oi' } })).status, 401);
  assert.equal((await t.call('POST', '/sara/chat', { token, body: { message: '' } })).status, 400);
  assert.equal((await t.call('POST', '/sara/chat', { token, body: { message: 'x'.repeat(2001) } })).status, 400);
});
