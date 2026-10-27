import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, tasks, tasks_tick;
before(async () => {
  t = await setup();
  ({ tasks, tick: tasks_tick } = await import('../src/jobs.js'));
  mock.method(console, 'log', () => {});
  Object.assign(process.env, { WHATSAPP_TOKEN: 'token-de-teste', WHATSAPP_PHONE_ID: '123' });
  mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 })); // WhatsApp não sai de verdade
});
after(() => t.close());
beforeEach(async () => { await t.reset(); });

const queue = () => t.sql('SELECT kind, status FROM message_queue ORDER BY kind');

test('aniversário: enfileira uma vez, mesmo rodando o job duas vezes', async () => {
  await tasks.birthday(); await tasks.birthday();
  assert.deepEqual(await queue(), [{ kind: 'birthday', status: 'pending' }]);
});

test('aniversário: sem consentimento de marketing não envia', async () => {
  await t.sql('UPDATE patients SET marketing_consent=false');
  await tasks.birthday();
  assert.equal((await queue()).length, 0);
});

test('pós-procedimento: dispara na janela certa e só uma vez', async () => {
  await t.sql(`UPDATE appointments SET completed_at = now() - interval '30 days' WHERE status='done'`);
  const [one] = await t.sql(`SELECT id FROM appointments WHERE status='done' LIMIT 1`);
  await t.sql(`UPDATE appointments SET completed_at = now() - interval '36 hours' WHERE id=$1`, [one.id]);
  await tasks.followup(); await tasks.followup();
  assert.deepEqual(await queue(), [{ kind: 'followup', status: 'pending' }]);
});

test('pós-procedimento: atendimento antigo demais ou sem telefone não dispara', async () => {
  await t.sql(`UPDATE appointments SET completed_at = now() - interval '30 days' WHERE status='done'`);
  await tasks.followup();
  assert.equal((await queue()).length, 0);
  await t.sql(`UPDATE appointments SET completed_at = now() - interval '36 hours' WHERE status='done'`);
  await t.sql('UPDATE patients SET phone=NULL');
  await tasks.followup();
  assert.equal((await queue()).length, 0);
});

test('estoque: um alerta por produto abaixo do mínimo por dia', async () => {
  await tasks.stock(); await tasks.stock();
  const alerts = await t.sql('SELECT kind, payload FROM alerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].payload.product, 'Toxina botulínica 100U');
  assert.equal(alerts[0].payload.buy, 5);
});

test('outbox: envia pendentes, marca como enviado e não reenvia', async () => {
  await tasks.birthday();
  await tasks.outbox();
  assert.deepEqual(await queue(), [{ kind: 'birthday', status: 'sent' }]);
  const calls = fetch.mock.calls;
  const sent = calls.length;
  await tasks.outbox();
  assert.equal(calls.length, sent);
  const [url, init] = calls.at(-1).arguments;
  assert.match(url, /graph\.facebook\.com\/.+\/123\/messages$/);
  assert.equal(init.headers.authorization, 'Bearer token-de-teste');
  const body = JSON.parse(init.body);
  assert.match(body.to, /^\d+$/); // só dígitos, sem "+"
  assert.match(body.text.body, /Parabéns, Paciente/); // {{nome}} = 1º nome
});

test('outbox: sem WhatsApp configurado a mensagem fica failed, não enviada', async () => {
  const { WHATSAPP_TOKEN } = process.env;
  delete process.env.WHATSAPP_TOKEN;
  try {
    await tasks.birthday();
    await tasks.outbox();
  } finally { process.env.WHATSAPP_TOKEN = WHATSAPP_TOKEN; }
  assert.deepEqual(await queue(), [{ kind: 'birthday', status: 'failed' }]);
});

test('outbox: reserva travada há muito tempo é reenviada; reserva recente não', async () => {
  const ins = (key, claimed) => t.sql(
    `INSERT INTO message_queue (clinic_id, patient_id, kind, body, dedupe_key, status, claimed_at)
     VALUES ($1,'20000000-0000-0000-0000-000000000001','followup','Oi {{nome}}',$2,'sending', now() - $3::interval)`, [A, key, claimed]);
  await ins('velha', '1 hour'); await ins('recente', '1 minute');
  await tasks.outbox();
  const rows = await t.sql(`SELECT dedupe_key k, status FROM message_queue ORDER BY dedupe_key`);
  assert.deepEqual(rows, [{ k: 'recente', status: 'sending' }, { k: 'velha', status: 'sent' }]);
});

test('tick: às 10h em São Paulo roda tudo, na ordem certa, e é idempotente', async () => {
  const at10 = new Date('2030-03-15T13:00:00Z'); // 10:00 em São Paulo
  const first = await tasks_tick(at10);
  assert.deepEqual(Object.keys(first), ['birthday', 'followup', 'stock', 'dre', 'outbox', 'googleSync']);
  assert.ok(Object.values(first).every((v) => v === 'ok'), JSON.stringify(first));
  const sent = (await t.sql(`SELECT count(*)::int n FROM message_queue`))[0].n;
  await tasks_tick(at10);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM message_queue`))[0].n, sent, 'sem mensagens duplicadas');
});

test('tick: aniversário só depois das 9h em São Paulo; DRE não roda no dia 1 antes das 6h', async () => {
  const early = await tasks_tick(new Date('2030-03-15T11:00:00Z')); // 08:00 em São Paulo
  assert.ok(!('birthday' in early));
  const day1 = await tasks_tick(new Date('2030-04-01T07:00:00Z'));  // 04:00 do dia 1 em São Paulo
  assert.ok(!('dre' in day1));
});

test('tick: uma tarefa que falha não impede as outras', async () => {
  await t.sql('ALTER TABLE alerts RENAME TO alerts_off');
  try {
    const r = await tasks_tick(new Date('2030-03-15T13:00:00Z'));
    assert.match(r.stock, /^erro:/);
    assert.equal(r.outbox, 'ok');
  } finally { await t.sql('ALTER TABLE alerts_off RENAME TO alerts'); }
});

test('DRE mensal: grava o mês anterior e regrava sem duplicar', async () => {
  await tasks.dre(); await tasks.dre();
  const rows = await t.sql(`SELECT to_char(month,'YYYY-MM') m, data FROM dre_reports WHERE clinic_id=$1`, [A]);
  assert.equal(rows.length, 1);
  const [{ prev }] = await t.sql(`SELECT to_char(date_trunc('month', now()) - interval '1 month','YYYY-MM') prev`);
  assert.equal(rows[0].m, prev);
  assert.equal(rows[0].data.receitaBruta, 3000);
});
