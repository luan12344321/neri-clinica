import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, waitFor } from './helpers.js';

// Google Calendar falso, dentro do processo de teste.
function fakeGoogle() {
  const events = new Map(); const log = []; let n = 0, ver = 0; let pending = [];
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(); const url = new URL(req.url, 'http://x');
    const body = raw.startsWith('{') ? JSON.parse(raw) : raw;
    const sync = url.searchParams.get('syncToken');
    log.push(`${req.method} ${url.pathname}${req.method === 'GET' && url.pathname.endsWith('/events') ? (sync ? `?sync=${sync}` : '?full') : ''}`);
    if (url.pathname === '/token') {
      const grant = new URLSearchParams(raw).get('grant_type');
      return send(res, 200, { access_token: `at-${grant}`, ...(grant === 'authorization_code' ? { refresh_token: 'rt-secret' } : {}), expires_in: 3600 });
    }
    const m = url.pathname.match(/^\/calendars\/primary\/events(?:\/(.+))?$/);
    if (m && !m[1] && req.method === 'POST') { const id = `ev${++n}`; const ev = { ...body, id, etag: `"a${n}"`, status: 'confirmed' }; events.set(id, ev); return send(res, 200, ev); }
    if (m?.[1] && req.method === 'PATCH') { const ev = { ...events.get(m[1]), ...body, etag: `"p${++n}"` }; events.set(m[1], ev); return send(res, 200, ev); }
    if (m?.[1] && req.method === 'DELETE') { events.delete(m[1]); return send(res, 204); }
    if (m && !m[1] && req.method === 'GET') {
      if (sync === 'expired') return send(res, 410, { error: 'gone' });
      const items = pending; pending = []; return send(res, 200, { items, nextSyncToken: `sync-${++ver}` });
    }
    send(res, 404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, log, events,
    inject: (ev) => pending.push(ev),
    reset: () => { events.clear(); log.length = 0; pending = []; n = 0; ver = 0; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

let t, g, token, decrypt;
before(async () => {
  t = await setup(); g = await fakeGoogle();
  Object.assign(process.env, { GOOGLE_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_API_BASE: `http://127.0.0.1:${g.port}` });
  ({ decrypt } = await import('../src/crypto.js'));
});
after(async () => { await g.close(); await t.close(); });
beforeEach(async () => { await t.reset(); g.reset(); token = await t.tokenFor('gestor@demo.test'); });

async function connect() {
  const { json } = await t.call('POST', '/google/connect', { token });
  const state = new URL(json.url).searchParams.get('state');
  return t.call('GET', `/google/callback?code=abc&state=${state}`);
}
const book = async (start = '2030-05-01T13:00:00Z', end = '2030-05-01T14:00:00Z') => (await t.call('POST', '/appointments', { token,
  body: { patientId: '20000000-0000-0000-0000-000000000003', procedureId: '10000000-0000-0000-0000-000000000002', startsAt: start, endsAt: end } })).json;
const row = async (id) => (await t.sql('SELECT status, starts_at, google_event_id, google_etag FROM appointments WHERE id=$1', [id]))[0];

test('OAuth: o callback grava o refresh token criptografado e rejeita state inválido', async () => {
  assert.equal((await connect()).status, 302);
  assert.equal((await t.call('GET', '/google/status', { token })).json.connected, true);
  const [u] = await t.sql(`SELECT id, google_refresh_token_enc e FROM users WHERE email='gestor@demo.test'`);
  assert.ok(!u.e.includes('rt-secret'));
  assert.equal(decrypt(u.e, `users.google_refresh_token:${u.id}`), 'rt-secret');
  assert.throws(() => decrypt(u.e, 'users.google_refresh_token:outro-id'), 'preso ao usuário dono');
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='google.connect'`))[0].n, 1);
  assert.equal((await t.call('GET', '/google/callback?code=abc&state=lixo')).status, 400);
  const wrongPurpose = t.app.jwt.sign({ userId: 'x' });
  assert.equal((await t.call('GET', `/google/callback?code=abc&state=${wrongPurpose}`)).status, 400);
});

test('desconectar apaga o token', async () => {
  await connect();
  await t.call('DELETE', '/google', { token });
  assert.equal((await t.call('GET', '/google/status', { token })).json.connected, false);
});

test('sem Google conectado, agendar funciona e nada é enviado', async () => {
  const a = await book();
  assert.ok(a.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(g.log.filter((l) => l.includes('/events')).length, 0);
  assert.equal((await row(a.id)).google_event_id, null);
});

test('app → Google: criar, reagendar e cancelar refletem no evento', async () => {
  await connect();
  const a = await book();
  const created = await waitFor(async () => (await row(a.id)).google_event_id && row(a.id));
  assert.equal(created.google_event_id, 'ev1');
  assert.equal(g.events.get('ev1').summary, 'Paciente 3 · Limpeza de pele'); // sem dados clínicos
  await t.call('PATCH', `/appointments/${a.id}`, { token, body: { startsAt: '2030-05-02T13:00:00Z', endsAt: '2030-05-02T14:00:00Z' } });
  await waitFor(() => g.log.includes('PATCH /calendars/primary/events/ev1'));
  await t.call('PATCH', `/appointments/${a.id}`, { token, body: { status: 'canceled' } });
  await waitFor(() => g.log.includes('DELETE /calendars/primary/events/ev1'));
});

test('Google → app: reagendar e cancelar no Google atualiza o agendamento', async () => {
  await connect();
  const a = await book();
  await waitFor(async () => (await row(a.id)).google_event_id);
  g.inject({ id: 'ev1', status: 'confirmed', etag: '"edit1"', start: { dateTime: '2030-05-03T15:00:00Z' }, end: { dateTime: '2030-05-03T16:00:00Z' } });
  await t.call('POST', '/google/sync', { token });
  let r = await row(a.id);
  assert.equal(r.starts_at.toISOString(), '2030-05-03T15:00:00.000Z');
  assert.equal(r.google_etag, '"edit1"');
  g.inject({ id: 'ev1', status: 'cancelled' });
  await t.call('POST', '/google/sync', { token });
  assert.equal((await row(a.id)).status, 'canceled');
});

test('eco: evento com o mesmo etag que gravamos não sobrescreve o app', async () => {
  await connect();
  const a = await book();
  const before = await waitFor(async () => (await row(a.id)).google_event_id && row(a.id));
  g.inject({ id: 'ev1', status: 'confirmed', etag: before.google_etag, start: { dateTime: '2031-01-01T09:00:00Z' }, end: { dateTime: '2031-01-01T10:00:00Z' } });
  await t.call('POST', '/google/sync', { token });
  assert.equal((await row(a.id)).starts_at.toISOString(), '2030-05-01T13:00:00.000Z');
});

test('Google não reabre atendimento já concluído', async () => {
  await connect();
  const a = await book();
  await waitFor(async () => (await row(a.id)).google_event_id);
  await t.call('POST', `/appointments/${a.id}/complete`, { token });
  g.inject({ id: 'ev1', status: 'cancelled' });
  await t.call('POST', '/google/sync', { token });
  assert.equal((await row(a.id)).status, 'done');
});

test('sync usa syncToken incremental e se recupera de 410 com ressincronização completa', async () => {
  await connect();
  await t.call('POST', '/google/sync', { token });
  await t.call('POST', '/google/sync', { token });
  const gets = g.log.filter((l) => l.startsWith('GET') && l.includes('/events'));
  assert.equal(gets[0].endsWith('?full'), true);
  assert.match(gets[1], /\?sync=sync-1$/);
  await t.sql(`UPDATE users SET google_sync_token='expired' WHERE email='gestor@demo.test'`);
  g.log.length = 0;
  await t.call('POST', '/google/sync', { token });
  assert.deepEqual(g.log.filter((l) => l.startsWith('GET') && l.includes('/events')).map((l) => l.split('?')[1]), ['sync=expired', 'full']);
  assert.match((await t.sql(`SELECT google_sync_token s FROM users WHERE email='gestor@demo.test'`))[0].s, /^sync-/);
});

test('o sync reenvia agendamentos futuros que não chegaram ao Google', async () => {
  const a = await book();            // criado antes de conectar
  await connect();
  await t.call('POST', '/google/sync', { token });
  // o seed tem um atendimento 'hoje às 14h' que, antes das 14h, também é futuro e recebe o primeiro id: não dependa do número
  assert.match((await row(a.id)).google_event_id ?? '', /^ev[0-9]+$/);
});
