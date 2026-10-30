import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { decrypt, encrypt } from './crypto.js';

// REST direto (sem SDK). As URLs são configuráveis só para permitir testar contra um Google falso.
const cfg = () => ({
  id: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect: process.env.GOOGLE_REDIRECT_URI,
  auth: process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  api: process.env.GOOGLE_API_BASE ?? 'https://www.googleapis.com/calendar/v3',
});

// refresh token criptografado em repouso, preso ao usuário dono (ver crypto.js)
const tokenAad = (userId) => `users.google_refresh_token:${userId}`;

const form = (o) => new URLSearchParams(o).toString();

export function authUrl(state) {
  const c = cfg();
  return `${c.auth}?${form({ client_id: c.id, redirect_uri: c.redirect, response_type: 'code', state,
    scope: 'https://www.googleapis.com/auth/calendar.events', access_type: 'offline', prompt: 'consent' })}`;
}

export async function exchangeCode(code) {
  const c = cfg();
  const r = await fetch(c.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
    body: form({ code, client_id: c.id, client_secret: c.secret, redirect_uri: c.redirect, grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`google token exchange failed: ${j.error ?? r.status}`);
  return j.refresh_token;
}

const tokens = new Map(); // userId -> { token, exp }
async function accessToken(user) {
  const hit = tokens.get(user.id);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const c = cfg();
  const r = await fetch(c.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
    body: form({ refresh_token: decrypt(user.google_refresh_token_enc, tokenAad(user.id)), client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`google refresh failed: ${j.error ?? r.status}`), { status: r.status });
  tokens.set(user.id, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

async function gcal(user, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${cfg().api}/calendars/${encodeURIComponent(user.google_calendar_id ?? 'primary')}${path}`, {
    method, headers: { Authorization: `Bearer ${await accessToken(user)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`google ${method} ${path}: ${r.status}`), { status: r.status });
  return j;
}

// Agenda de quem atende (ou o 1º usuário conectado da clínica).
const calendarOwner = async (clinicId, professionalId) => (await q(
  `SELECT id, google_refresh_token_enc, google_calendar_id, google_sync_token FROM users
   WHERE clinic_id=$1 AND google_refresh_token_enc IS NOT NULL AND password_hash <> '!' ORDER BY (id=$2) DESC, created_at LIMIT 1`,
  [clinicId, professionalId]))[0];

// ---- push: app -> Google ----
export async function pushAppointment(appointmentId) {
  const [a] = await q(
    `SELECT a.*, p.full_name AS patient, pr.name AS procedure, c.timezone
     FROM appointments a JOIN patients p ON p.id=a.patient_id AND p.clinic_id=a.clinic_id JOIN clinics c ON c.id=a.clinic_id
     LEFT JOIN procedures pr ON pr.id=a.procedure_id AND pr.clinic_id=a.clinic_id WHERE a.id=$1`, [appointmentId]);
  if (!a) return;
  const owner = await calendarOwner(a.clinic_id, a.professional_id);
  if (!owner) return; // clínica sem Google conectado

  if (a.status === 'canceled') {
    if (a.google_event_id) await gcal(owner, `/events/${encodeURIComponent(a.google_event_id)}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 410 && e.status !== 404) throw e; });
    return;
  }
  const event = {
    summary: [a.patient, a.procedure].filter(Boolean).join(' · '),   // sem dados clínicos no Google
    start: { dateTime: a.starts_at.toISOString(), timeZone: a.timezone },
    end: { dateTime: a.ends_at.toISOString(), timeZone: a.timezone },
  };
  const ev = a.google_event_id
    ? await gcal(owner, `/events/${encodeURIComponent(a.google_event_id)}`, { method: 'PATCH', body: event })
    : await gcal(owner, '/events', { method: 'POST', body: event });
  await q('UPDATE appointments SET google_event_id=$2, google_etag=$3 WHERE id=$1', [a.id, ev.id, ev.etag]);
}

// ---- pull: Google -> app (syncToken incremental) ----
async function applyEvent(clinicId, ev) {
  if (ev.status === 'cancelled') {
    await q(`UPDATE appointments SET status='canceled', updated_at=now()
             WHERE clinic_id=$1 AND google_event_id=$2 AND status IN ('scheduled','confirmed')`, [clinicId, ev.id]);
  } else if (ev.start?.dateTime && ev.end?.dateTime) {
    // etag igual ao gravado = eco da nossa própria escrita; não faz nada (evita loop)
    await q(`UPDATE appointments SET starts_at=$3, ends_at=$4, google_etag=$5, updated_at=now()
             WHERE clinic_id=$1 AND google_event_id=$2 AND google_etag IS DISTINCT FROM $5
               AND status IN ('scheduled','confirmed')`, [clinicId, ev.id, ev.start.dateTime, ev.end.dateTime, ev.etag]);
  }
}

async function pullChanges(user, clinicId) {
  let syncToken = user.google_sync_token, pageToken, next, pages = 0;
  do {
    if (++pages > 50) throw new Error('google pull: páginas demais'); // teto contra laço (410 repetido, paginação sem fim)
    const params = new URLSearchParams(syncToken ? { syncToken } : { timeMin: new Date(Date.now() - 30 * 864e5).toISOString(), singleEvents: 'true' });
    if (pageToken) params.set('pageToken', pageToken);
    let res;
    try { res = await gcal(user, `/events?${params}`); }
    catch (e) {
      if (e.status === 410) { syncToken = undefined; pageToken = undefined; continue; } // token expirou: ressincroniza
      throw e;
    }
    for (const ev of res.items ?? []) await applyEvent(clinicId, ev);
    pageToken = res.nextPageToken; next = res.nextSyncToken ?? next;
  } while (pageToken || (syncToken === undefined && next === undefined));
  if (next) await q('UPDATE users SET google_sync_token=$2 WHERE id=$1', [user.id, next]);
}

// Roda no cron e no "Sincronizar agora". Também reenvia o que falhou no push.
export async function syncClinic(clinicId) {
  const pending = await q(
    `SELECT id FROM appointments WHERE clinic_id=$1 AND google_event_id IS NULL
       AND status IN ('scheduled','confirmed') AND starts_at > now() ORDER BY starts_at LIMIT 50`, [clinicId]);
  for (const p of pending) await pushAppointment(p.id).catch(() => {});
  const users = await q(`SELECT id, google_refresh_token_enc, google_calendar_id, google_sync_token FROM users
                         WHERE clinic_id=$1 AND google_refresh_token_enc IS NOT NULL AND password_hash <> '!'`, [clinicId]);
  for (const u of users) await pullChanges(u, clinicId);
}

export const syncAllClinics = async () => {
  for (const c of await q(`SELECT DISTINCT clinic_id FROM users WHERE google_refresh_token_enc IS NOT NULL AND password_hash <> '!'`)) {
    await syncClinic(c.clinic_id).catch((e) => console.error('google sync', c.clinic_id, e.message));
  }
};

// ---- rotas ----
export default async function googleRoutes(app) {
  const read = { onRequest: [app.auth] };

  app.get('/google/status', read, async (req) => {
    const [u] = await q('SELECT google_refresh_token_enc IS NOT NULL AS connected FROM users WHERE id=$1', [req.user.userId]);
    return { connected: !!u?.connected };
  });

  app.post('/google/connect', read, async (req) => ({
    url: authUrl(app.jwt.sign({ userId: req.user.userId, purpose: 'google-oauth' }, { expiresIn: '10m' })) }));

  // Callback chamado pelo Google (sem Bearer): a identidade vem do `state` assinado.
  app.get('/google/callback', async (req, reply) => {
    const { code, state } = req.query;
    let s;
    try { s = app.jwt.verify(state); } catch { return reply.code(400).send({ error: 'invalid state' }); }
    if (s.purpose !== 'google-oauth' || !code) return reply.code(400).send({ error: 'invalid state' });
    const refresh = await exchangeCode(code);
    const [u] = await q(`UPDATE users SET google_refresh_token_enc=$2, google_sync_token=NULL WHERE id=$1 AND password_hash <> '!' RETURNING clinic_id`,
      [s.userId, encrypt(refresh, tokenAad(s.userId))]);
    if (u) await audit({ clinicId: u.clinic_id, userId: s.userId, ip: req.ip }, 'google.connect', 'user', s.userId);
    return reply.redirect(process.env.APP_URL ?? 'http://localhost:5173');
  });

  app.post('/google/sync', read, async (req) => { await syncClinic(req.user.clinicId); return { ok: true }; });

  app.delete('/google', read, async (req) => {
    await q('UPDATE users SET google_refresh_token_enc=NULL, google_sync_token=NULL WHERE id=$1', [req.user.userId]);
    tokens.delete(req.user.userId);
    await audit(auditCtx(req), 'google.disconnect', 'user', req.user.userId);
    return { ok: true };
  });
}
