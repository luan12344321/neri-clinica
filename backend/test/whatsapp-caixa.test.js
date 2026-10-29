import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());

const PHONE_ID = '123456789012', SECRET = 'segredo-do-app-meta', TOKEN = `EAAB${'x'.repeat(40)}`;
const CLIENT = '551177770001';
const realFetch = globalThis.fetch;
let gemini, sent;

beforeEach(async () => {
  await t.reset(); await t.addExtras();
  gemini = []; sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('generativelanguage.googleapis.com')) {
      const next = gemini.shift();
      return json({ candidates: [{ content: { parts: next } }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 15 } });
    }
    if (u.includes('graph.facebook.com') && init?.method === 'POST') {
      const b = JSON.parse(init.body);
      sent.push({ to: b.to, text: b.text.body });
      return json({ messages: [{ id: `wamid.OUT${sent.length}` }] });
    }
    throw new Error(`fetch inesperado: ${u}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const owner = () => t.tokenFor('gestor@demo.test');
const reception = () => t.tokenFor('recepcao@demo.test');
let n = 0;
const inbound = (from, text) => {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, contacts: [{ profile: { name: 'Cliente Teste' }, wa_id: from }],
    messages: [{ from, id: `wamid.IN${++n}`, timestamp: '1', type: 'text', text: { body: text } }] } }] }] }));
  return t.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
};
const configure = async () => {
  const r = await t.call('PUT', '/integrations/whatsapp', { token: await owner(),
    body: { number: '+55 11 90000-0000', phoneId: PHONE_ID, token: TOKEN, appSecret: SECRET, enabled: true } });
  await t.sql("UPDATE clinics SET wa_julia_help_day = (now() AT TIME ZONE 'America/Sao_Paulo')::date");
  return r;
};
const base = `/integrations/whatsapp/conversations`;

test('lista conversas, abre, marca como lida e a equipe responde (pausa a Julia)', async () => {
  await configure();
  await t.call('PUT', '/clinic/hours', { token: await owner(), body: { hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:30']]])) } }); // sempre no expediente
  gemini.push([{ text: 'Oi! Em que posso ajudar?' }]);
  await inbound(CLIENT, 'Quero agendar uma avaliação');

  const tk = await reception();
  let list = await t.call('GET', base, { token: tk });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].contact, CLIENT);
  assert.equal(list.json[0].unread, 1);
  assert.equal(list.json[0].last_direction, 'out');

  const msgs = await t.call('GET', `${base}/${CLIENT}/messages`, { token: tk });
  assert.deepEqual(msgs.json.map((m) => m.direction), ['in', 'out']);
  assert.equal(msgs.json[1].staff, false);
  list = await t.call('GET', base, { token: tk });
  assert.equal(list.json[0].unread, 0, 'abrir marca como lida');

  const r = await t.call('POST', `${base}/${CLIENT}/messages`, { token: tk, body: { text: 'Terça às 15h serve?' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.staff, true);
  assert.deepEqual(sent.at(-1), { to: CLIENT, text: 'Terça às 15h serve?' });
  assert.equal((await t.call('GET', base, { token: tk })).json[0].human, true, 'a Julia fica pausada');

  const before = gemini.length;
  await inbound(CLIENT, 'Serve sim!');
  assert.equal(sent.length, 2, 'Julia não responde com a equipe no comando');
  assert.equal(gemini.length, before);
  assert.equal((await t.call('GET', base, { token: tk })).json[0].unread, 1);
});

test('não responde com mais de 24h, sem WhatsApp ligado, contato desconhecido ou sem permissão', async () => {
  await configure();
  gemini.push([{ text: 'Oi!' }]);
  await inbound(CLIENT, 'Oi');
  const tk = await owner();
  await t.sql(`UPDATE wa_messages SET created_at = now() - interval '25 hours' WHERE direction='in'`);
  const late = await t.call('POST', `${base}/${CLIENT}/messages`, { token: tk, body: { text: 'Olá' } });
  assert.equal(late.status, 409); assert.equal(late.json.error, 'window_closed');
  assert.equal(sent.length, 1, 'nada foi enviado');

  assert.equal((await t.call('GET', `${base}/551100000000/messages`, { token: tk })).status, 404);
  assert.equal((await t.call('POST', `${base}/551100000000/messages`, { token: tk, body: { text: 'x' } })).status, 404);
  assert.equal((await t.call('POST', `${base}/${CLIENT}/messages`, { token: tk, body: { text: '   ' } })).status, 400);
  assert.equal((await t.call('GET', base)).status, 401);

  await t.sql(`UPDATE clinics SET whatsapp_enabled=false`);
  assert.equal((await t.call('POST', `${base}/${CLIENT}/messages`, { token: tk, body: { text: 'Olá' } })).status, 400);
});

test('conversas de uma clínica não aparecem em outra', async () => {
  await configure();
  gemini.push([{ text: 'Oi!' }]);
  await inbound(CLIENT, 'Oi');
  await t.sql(`INSERT INTO users (clinic_id, email, name, password_hash, role) SELECT '00000000-0000-0000-0000-0000000000b1','dono-b@t.test','Dono B',password_hash,'owner' FROM users LIMIT 1`);
  const b = await t.tokenFor('dono-b@t.test');
  assert.deepEqual((await t.call('GET', base, { token: b })).json, []);
  assert.equal((await t.call('GET', `${base}/${CLIENT}/messages`, { token: b })).status, 404);
});
