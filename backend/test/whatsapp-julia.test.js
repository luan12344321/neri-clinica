import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup } from './helpers.js';

let t, hours;
before(async () => { t = await setup(); hours = await import('../src/hours.js'); });
after(() => t.close());

const PHONE_ID = '123456789012', SECRET = 'segredo-do-app-meta', TOKEN = `EAAB${'x'.repeat(40)}`;
const CLIENT = '551177770001';
const realFetch = globalThis.fetch;
let gemini, sent, outId = 0, keepIntro = false;

beforeEach(async () => {
  await t.reset(); await t.addExtras();
  gemini = []; sent = []; keepIntro = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('generativelanguage.googleapis.com')) return json({ candidates: [{ content: { parts: gemini.shift() ?? [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, totalTokenCount: 2 } });
    if (u.includes('graph.facebook.com') && init?.method === 'POST') { const b = JSON.parse(init.body); if (keepIntro || b.text.body !== 'Oi, sou a Julia, assistente virtual da clínica.') sent.push(b.text.body); return json({ messages: [{ id: `wamid.OUT${++outId}` }] }); }
    throw new Error(`fetch inesperado: ${u}`);
  };
  const tk = await owner();
  await t.call('PUT', '/integrations/whatsapp', { token: tk, body: { number: '+55 11 90000-0000', phoneId: PHONE_ID, token: TOKEN, appSecret: SECRET, enabled: true } });
});
afterEach(() => { globalThis.fetch = realFetch; });

const owner = () => t.tokenFor('gestor@demo.test');
const reception = () => t.tokenFor('recepcao@demo.test');
const EVERY_DAY = (faixas) => ({ hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, faixas])) });
// Grava direto no banco para poder usar até 24:00 (a API só aceita até 23:30): 'aberto' vale em qualquer hora do dia.
const setHours = (faixas) => t.sql('UPDATE clinics SET working_hours=$1', [JSON.stringify(EVERY_DAY(faixas).hours)]);
let n = 0;
const inbound = (text) => {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, contacts: [{ profile: { name: 'Cliente' }, wa_id: CLIENT }],
    messages: [{ from: CLIENT, id: `wamid.IN${++n}`, timestamp: '1', type: 'text', text: { body: text } }] } }] }] }));
  return t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
};
const julia = async (tk) => (await t.call('GET', '/integrations/whatsapp/julia', { token: tk })).json;

test('isOpenNow respeita faixas e o fuso de São Paulo', () => {
  const h = { 3: [['08:00', '11:00'], ['13:00', '18:00']] };
  const at = (iso) => hours.isOpenNow(h, new Date(iso));
  assert.equal(at('2030-03-20T12:00:00Z'), true);   // quarta 09:00 em SP
  assert.equal(at('2030-03-20T14:30:00Z'), false);  // quarta 11:30 (almoço)
  assert.equal(at('2030-03-20T21:00:00Z'), false);  // quarta 18:00 em SP: já fechou
  assert.equal(at('2030-03-21T12:00:00Z'), false);  // quinta: sem faixas
});

test('fora do expediente a Julia responde sozinha', async () => {
  await setHours([]); // nunca abre
  const tk = await reception();
  assert.deepEqual(await julia(tk), { open: false, help: false, active: true });
  await inbound('Oi');
  assert.equal(sent.length, 1);
});

test('no expediente a Julia fica calada até a recepção ligar, e desliga de novo', async () => {
  await setHours([['00:00', '24:00']]);
  const tk = await reception();
  assert.deepEqual(await julia(tk), { open: true, help: false, active: false });
  await inbound('Oi');
  assert.equal(sent.length, 0, 'só a recepção responde');
  assert.equal((await t.sql('SELECT 1 FROM wa_messages')).length, 1, 'a mensagem fica guardada');

  const on = await t.call('PUT', '/integrations/whatsapp/julia', { token: tk, body: { help: true } });
  assert.deepEqual(on.json, { open: true, help: true, active: true });
  await inbound('Tem horário?');
  assert.equal(sent.length, 1);

  await t.call('PUT', '/integrations/whatsapp/julia', { token: tk, body: { help: false } });
  await inbound('Obrigada');
  assert.equal(sent.length, 1);
  assert.equal((await t.sql(`SELECT 1 FROM audit_log WHERE action IN ('whatsapp.julia_on','whatsapp.julia_off')`)).length, 2);
});

test('ligar vale só para o dia: no dia seguinte volta a ficar desligada', async () => {
  await setHours([['00:00', '24:00']]);
  const tk = await reception();
  await t.call('PUT', '/integrations/whatsapp/julia', { token: tk, body: { help: true } });
  await t.sql(`UPDATE clinics SET wa_julia_help_day = wa_julia_help_day - 1`);
  assert.equal((await julia(tk)).help, false);
  await inbound('Oi');
  assert.equal(sent.length, 0);
});

test('com a Julia ajudando, conversa assumida pela equipe fica com a equipe; fora do expediente a Julia retoma', async () => {
  await setHours([['00:00', '24:00']]);
  const tk = await reception();
  await t.call('PUT', '/integrations/whatsapp/julia', { token: tk, body: { help: true } });
  await inbound('Oi');                                   // Julia responde (1)
  await t.call('POST', `/integrations/whatsapp/conversations/${CLIENT}/messages`, { token: tk, body: { text: 'Aqui é a recepção.' } }); // (2)
  await inbound('Pode ser 15h?');
  assert.equal(sent.length, 2, 'equipe assumiu: Julia não responde');

  await setHours([]); // fechou o expediente
  await inbound('Ainda estão aí?');
  assert.equal(sent.length, 3, 'depois do expediente a Julia volta');
});

test('pedido de atendente humano continua esperando uma pessoa, mesmo fora do expediente', async () => {
  await setHours([]);
  await inbound('Oi');
  await t.sql(`UPDATE wa_contacts SET human_until = now() + interval '5 hours', handoff_reason = 'cliente pediu atendente'`);
  const before = sent.length;
  await inbound('Alguém aí?');
  assert.equal(sent.length, before);
});

test('só equipe de atendimento mexe no liga/desliga', async () => {
  assert.equal((await t.call('GET', '/integrations/whatsapp/julia')).status, 401);
  await t.sql(`UPDATE users SET role='professional' WHERE email='recepcao@demo.test'`);
  const pro = await reception();
  assert.equal((await t.call('PUT', '/integrations/whatsapp/julia', { token: pro, body: { help: true } })).status, 403);
  assert.equal((await t.call('PUT', '/integrations/whatsapp/julia', { token: await owner(), body: { help: 'sim' } })).status, 400);
});

test('conversa nova começa com a apresentação da Julia; dentro de 12h não repete; depois volta', async () => {
  keepIntro = true;
  await setHours([]); // fora do expediente: a Julia atende
  await inbound('Oi, tudo bem?');
  assert.equal(sent[0], 'Oi, sou a Julia, assistente virtual da clínica.');
  assert.equal(sent.length, 2, 'apresentação + resposta');

  await inbound('Qual o horário de vocês?');
  assert.equal(sent.length, 3, 'só a resposta, sem apresentar de novo');
  assert.notEqual(sent[2], 'Oi, sou a Julia, assistente virtual da clínica.');

  await t.sql(`UPDATE wa_messages SET created_at = now() - interval '13 hours'`);
  await inbound('Voltei!');
  assert.equal(sent[3], 'Oi, sou a Julia, assistente virtual da clínica.', 'conversa retomada depois de 12h');
});
