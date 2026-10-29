import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { decrypt, encrypt } from './crypto.js';
import { ensureSchema } from './schema.js';
import { answerClient } from './sara_client.js';

// WhatsApp (Cloud API da Meta) por clínica: cadastro do número, webhook de entrada e resposta da Julia.
// Token e segredo do app ficam cifrados e nunca voltam pela API; o webhook só processa mensagens com assinatura válida.
const GRAPH = process.env.WHATSAPP_GRAPH_BASE ?? 'https://graph.facebook.com/v21.0';
const tokenAad = (id) => `clinics.whatsapp_token:${id}`;
const secretAad = (id) => `clinics.whatsapp_secret:${id}`;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const FALLBACK = 'Desculpa, tive um probleminha aqui. Já avisei a equipe e logo alguém te responde, tá?';

class WaError extends Error { constructor(status, detail) { super(`WhatsApp ${status}`); this.status = status; this.detail = detail; } }
// Mensagem de erro da Meta reduzida ao essencial: sem cabeçalhos, sem token.
const metaDetail = async (res) => { try { const j = await res.json(); return String(j?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 160); } catch { return ''; } };

async function graph(clinic, path, init = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${decrypt(clinic.whatsapp_token_enc, tokenAad(clinic.id))}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new WaError(res.status, await metaDetail(res));
  return res.json();
}
const sendText = async (clinic, to, text) => (await graph(clinic, `${clinic.whatsapp_phone_id}/messages`, {
  method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }) })).messages?.[0]?.id ?? null;

const validSignature = (raw, header, secret) => {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
};

export default async function whatsapp(app) {
  const only = (roles) => ({ onRequest: [app.auth, async (req, reply) => {
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] });
  const owner = only(['owner']);
  const staff = only(['owner', 'manager', 'reception']);
  const cid = (req) => req.user.clinicId;
  const load = async (clinicId) => (await q(`SELECT id, name, whatsapp_enabled, whatsapp_number, whatsapp_phone_id, whatsapp_token_enc, whatsapp_secret_enc, whatsapp_verify_token
                                           FROM clinics WHERE id=$1`, [clinicId]))[0];

  // ---------- configuração (só o dono) ----------
  app.get('/integrations/whatsapp', owner, async (req) => {
    await ensureSchema();
    const c = await load(cid(req));
    return { enabled: c.whatsapp_enabled, number: c.whatsapp_number ?? '', phoneId: c.whatsapp_phone_id ?? '',
      tokenSet: !!c.whatsapp_token_enc, secretSet: !!c.whatsapp_secret_enc, verifyToken: c.whatsapp_verify_token ?? null };
  });

  const body = z.object({
    number: z.string().transform(digits).pipe(z.string().min(10).max(15)),
    phoneId: z.string().trim().regex(/^\d{5,30}$/, 'Phone Number ID inválido'),
    token: z.string().trim().min(20).max(1000).optional(),
    appSecret: z.string().trim().min(8).max(200).optional(),
    enabled: z.boolean(),
  });
  app.put('/integrations/whatsapp', owner, async (req, reply) => {
    await ensureSchema();
    const b = body.parse(req.body);
    const cur = await load(cid(req));
    const tokenEnc = b.token ? encrypt(b.token, tokenAad(cur.id)) : cur.whatsapp_token_enc;
    const secretEnc = b.appSecret ? encrypt(b.appSecret, secretAad(cur.id)) : cur.whatsapp_secret_enc;
    if (b.enabled && (!tokenEnc || !secretEnc)) return reply.code(400).send({ error: 'incomplete', detail: 'Para ligar, informe o token de acesso e o segredo do app.' });
    try {
      await q(`UPDATE clinics SET whatsapp_enabled=$2, whatsapp_number=$3, whatsapp_phone_id=$4, whatsapp_token_enc=$5, whatsapp_secret_enc=$6,
                 whatsapp_verify_token=COALESCE(whatsapp_verify_token, $7) WHERE id=$1`,
        [cur.id, b.enabled, b.number, b.phoneId, tokenEnc, secretEnc, randomBytes(16).toString('hex')]);
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'duplicate', detail: 'Este Phone Number ID já está em uso por outra clínica.' });
      throw e;
    }
    await audit(auditCtx(req), 'whatsapp.config', 'clinic', cur.id); // nunca grava token nem segredo
    return { ok: true };
  });

  // Confere se o token enxerga o número na Meta (não envia nada a ninguém).
  app.post('/integrations/whatsapp/test', { ...owner, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    await ensureSchema();
    const c = await load(cid(req));
    if (!c.whatsapp_phone_id || !c.whatsapp_token_enc) return reply.code(400).send({ error: 'incomplete', detail: 'Salve o Phone Number ID e o token antes de testar.' });
    try {
      const info = await graph(c, `${c.whatsapp_phone_id}?fields=display_phone_number,verified_name`);
      return { ok: true, number: info.display_phone_number ?? null, name: info.verified_name ?? null };
    } catch (e) {
      if (!(e instanceof WaError)) throw e;
      req.log.error({ status: e.status }, 'whatsapp test');
      return reply.code(502).send({ error: 'provider_error', detail: e.detail || `A Meta recusou (HTTP ${e.status}).` });
    }
  });

  // ---------- conversas que a equipe precisa assumir ----------
  app.get('/integrations/whatsapp/waiting', staff, async (req) => {
    await ensureSchema();
    return q(`SELECT c.contact, c.display_name AS name, c.handoff_reason AS reason, c.human_until AS until,
                     (SELECT body FROM wa_messages m WHERE m.clinic_id=c.clinic_id AND m.contact=c.contact AND m.direction='in' ORDER BY id DESC LIMIT 1) AS last_message
              FROM wa_contacts c WHERE c.clinic_id=$1 AND c.human_until > now() ORDER BY c.human_until DESC LIMIT 50`, [cid(req)]);
  });
  app.post('/integrations/whatsapp/contacts/:contact/resume', staff, async (req, reply) => {
    await ensureSchema();
    const { contact } = z.object({ contact: z.string().regex(/^\d{8,15}$/) }).parse(req.params);
    const r = await q(`UPDATE wa_contacts SET human_until=NULL, handoff_reason=NULL WHERE clinic_id=$1 AND contact=$2 RETURNING contact`, [cid(req), contact]);
    if (!r.length) return reply.code(404).send({ error: 'not found' });
    await audit(auditCtx(req), 'whatsapp.resume', 'wa_contact', null);
    return { ok: true };
  });

  // ---------- caixa de entrada da equipe (estilo WhatsApp) ----------
  const phone = z.object({ contact: z.string().regex(/^\d{8,15}$/) });
  app.get('/integrations/whatsapp/conversations', staff, async (req) => {
    await ensureSchema();
    return q(`SELECT c.contact, c.display_name AS name, (c.human_until > now()) AS human, c.handoff_reason AS reason,
                     l.body AS last_body, l.direction AS last_direction, l.created_at AS last_at,
                     (SELECT count(*)::int FROM wa_messages m WHERE m.clinic_id=c.clinic_id AND m.contact=c.contact AND m.direction='in' AND m.id > c.read_upto) AS unread,
                     (SELECT p.full_name FROM patients p WHERE p.clinic_id=c.clinic_id AND regexp_replace(coalesce(p.phone,''),'\\D','','g') = c.contact LIMIT 1) AS patient
              FROM wa_contacts c
              JOIN LATERAL (SELECT body, direction, created_at FROM wa_messages m WHERE m.clinic_id=c.clinic_id AND m.contact=c.contact ORDER BY id DESC LIMIT 1) l ON true
              WHERE c.clinic_id=$1 ORDER BY l.created_at DESC LIMIT 100`, [cid(req)]);
  });

  app.get('/integrations/whatsapp/conversations/:contact/messages', staff, async (req, reply) => {
    await ensureSchema();
    const { contact } = phone.parse(req.params);
    const [c] = await q('SELECT 1 FROM wa_contacts WHERE clinic_id=$1 AND contact=$2', [cid(req), contact]);
    if (!c) return reply.code(404).send({ error: 'not found' });
    const rows = await q(`SELECT id, direction, body, created_at, (staff_user_id IS NOT NULL) AS staff FROM (
                            SELECT * FROM wa_messages WHERE clinic_id=$1 AND contact=$2 ORDER BY id DESC LIMIT 200) t ORDER BY id`, [cid(req), contact]);
    await q('UPDATE wa_contacts SET read_upto = GREATEST(read_upto, $3) WHERE clinic_id=$1 AND contact=$2', [cid(req), contact, rows.at(-1)?.id ?? 0]);
    return rows;
  });

  // A equipe responde pelo app. A resposta pausa a Julia nesta conversa por 12h (a pessoa assumiu).
  // Texto livre só vale até 24h depois da última mensagem do cliente (regra da Meta).
  app.post('/integrations/whatsapp/conversations/:contact/messages', { ...staff, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    await ensureSchema();
    const { contact } = phone.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const clinic = await load(cid(req));
    if (!clinic.whatsapp_enabled || !clinic.whatsapp_token_enc || !clinic.whatsapp_phone_id) return reply.code(400).send({ error: 'not_configured', detail: 'O WhatsApp da clínica não está ligado.' });
    const [last] = await q(`SELECT created_at FROM wa_messages WHERE clinic_id=$1 AND contact=$2 AND direction='in' ORDER BY id DESC LIMIT 1`, [clinic.id, contact]);
    if (!last) return reply.code(404).send({ error: 'not found' });
    if (Date.now() - new Date(last.created_at).getTime() > 24 * 3600_000) return reply.code(409).send({ error: 'window_closed', detail: 'Passaram mais de 24h desde a última mensagem do cliente. O WhatsApp só permite responder dentro desse prazo.' });
    let id;
    try { id = await sendText(clinic, contact, text); }
    catch (e) {
      if (!(e instanceof WaError)) throw e;
      req.log.error({ status: e.status }, 'whatsapp staff send');
      return reply.code(502).send({ error: 'provider_error', detail: e.detail || `A Meta recusou (HTTP ${e.status}).` });
    }
    const [msg] = await q(`INSERT INTO wa_messages (clinic_id, contact, direction, wa_message_id, body, staff_user_id) VALUES ($1,$2,'out',$3,$4,$5) RETURNING id, direction, body, created_at, true AS staff`,
      [clinic.id, contact, id, text, req.user.userId]);
    await q(`UPDATE wa_contacts SET human_until = now() + interval '12 hours', handoff_reason = COALESCE(handoff_reason, 'equipe respondeu') WHERE clinic_id=$1 AND contact=$2`, [clinic.id, contact]);
    await audit(auditCtx(req), 'whatsapp.staff_reply', 'wa_contact', null); // sem o texto: pode ter dado do paciente
    return reply.code(201).send(msg);
  });

  // ---------- webhook da Meta (público; o corpo precisa chegar CRU para validar a assinatura) ----------
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, buf, done) => done(null, buf));

    // Verificação inicial: a Meta chama com o "verify token" que o dono colou lá.
    hook.get('/webhooks/whatsapp', async (req, reply) => {
      await ensureSchema();
      const { 'hub.mode': mode, 'hub.verify_token': tok, 'hub.challenge': challenge } = req.query ?? {};
      if (mode === 'subscribe' && tok && challenge) {
        const [ok] = await q('SELECT 1 FROM clinics WHERE whatsapp_verify_token=$1', [String(tok)]);
        if (ok) return reply.type('text/plain').send(String(challenge));
      }
      return reply.code(403).send({ error: 'forbidden' });
    });

    hook.post('/webhooks/whatsapp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      let payload;
      try { payload = JSON.parse(req.body.toString('utf8')); } catch { return reply.code(400).send({ error: 'bad request' }); }
      if (payload?.object !== 'whatsapp_business_account') return { ok: true };
      await ensureSchema();
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value;
          const phoneId = v?.metadata?.phone_number_id;
          if (!phoneId || !v.messages?.length) continue; // status de entrega e afins: nada a responder
          const [clinic] = await q(`SELECT id, name, whatsapp_enabled, whatsapp_phone_id, whatsapp_token_enc, whatsapp_secret_enc FROM clinics WHERE whatsapp_phone_id=$1`, [String(phoneId)]);
          if (!clinic?.whatsapp_enabled || !clinic.whatsapp_secret_enc) continue; // desligado ou desconhecido: ignora (200 evita reenvio)
          if (!validSignature(req.body, req.headers['x-hub-signature-256'], decrypt(clinic.whatsapp_secret_enc, secretAad(clinic.id)))) {
            return reply.code(401).send({ error: 'invalid signature' });
          }
          for (const m of v.messages) {
            const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
            await inbound(req, clinic, m, name).catch((e) => req.log.error({ err: e?.name, status: e?.status }, 'whatsapp inbound'));
          }
        }
      }
      return { ok: true }; // sempre 200 depois de processar: a Meta reenvia se demorar ou falhar
    });
  });

  async function inbound(req, clinic, m, profileName) {
    const contact = digits(m.from);
    const text = m.type === 'text' ? m.text?.body
      : m.type === 'button' ? m.button?.text
      : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
    const bodyText = String(text ?? `[o cliente enviou ${m.type ?? 'uma mensagem'} que não é texto]`).slice(0, 2000);
    const [fresh] = await q(`INSERT INTO wa_messages (clinic_id, contact, direction, wa_message_id, body) VALUES ($1,$2,'in',$3,$4)
                             ON CONFLICT DO NOTHING RETURNING id`, [clinic.id, contact, m.id ?? null, bodyText]);
    if (!fresh) return; // reenvio da Meta: já tratado
    await q(`INSERT INTO wa_contacts (clinic_id, contact, display_name) VALUES ($1,$2,$3)
             ON CONFLICT (clinic_id, contact) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, wa_contacts.display_name)`,
      [clinic.id, contact, profileName ? String(profileName).slice(0, 80) : null]);

    const [st] = await q('SELECT human_until FROM wa_contacts WHERE clinic_id=$1 AND contact=$2', [clinic.id, contact]);
    if (st?.human_until && new Date(st.human_until) > new Date()) return; // a equipe assumiu esta conversa
    const [{ n }] = await q(`SELECT count(*)::int n FROM wa_messages WHERE clinic_id=$1 AND contact=$2 AND direction='in' AND created_at > now() - interval '1 hour'`, [clinic.id, contact]);
    if (n > 40) return; // flood: guarda a mensagem, não gasta modelo

    const record = (id, body, usage) => q(`INSERT INTO wa_messages (clinic_id, contact, direction, wa_message_id, body, tokens_in, tokens_out) VALUES ($1,$2,'out',$3,$4,$5,$6)`,
      [clinic.id, contact, id, body, usage?.input ?? null, usage?.output ?? null]);
    const handoff = (reason) => q(`UPDATE wa_contacts SET human_until = now() + interval '12 hours', handoff_reason=$3 WHERE clinic_id=$1 AND contact=$2`, [clinic.id, contact, reason]);
    try {
      const r = await answerClient({ clinic, contact });
      const texts = r.texts.length ? r.texts : [FALLBACK];
      let usage = r.usage;
      for (const t of texts) { const id = await sendText(clinic, contact, t); await record(id, t, usage); usage = null; }
      if (!r.texts.length) await handoff(r.handoff ?? 'resposta vazia');
    } catch (e) {
      req.log.error({ err: e?.name, status: e?.status }, 'whatsapp answer');
      await handoff(e?.name === 'BudgetError' ? 'limite mensal de IA' : 'erro técnico').catch(() => {});
      try { await record(await sendText(clinic, contact, FALLBACK), FALLBACK, null); } catch { /* sem como avisar: a conversa fica na lista da equipe */ }
    }
  }
}
