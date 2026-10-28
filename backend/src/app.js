import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q } from './db.js';
import { audit } from './audit.js';
import { ensureSchema } from './schema.js';
import { askSara, aiFailure, pingSara } from './sara.js';
import googleRoutes, { pushAppointment } from './google.js';
import { getDashboard, getFinanceSummary, getTopProcedures, getRestock, getCashFlow, buildDre } from './queries.js';

const isTest = process.env.NODE_ENV === 'test';
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
// O app é público em /api/* (Vercel, Netlify, proxy do vite), mas as rotas são registradas na raiz: removemos o prefixo aqui.
const app = Fastify({
  logger: isTest ? false : { redact: ['req.headers.authorization'] },
  trustProxy: Boolean(process.env.VERCEL), // atrás da Vercel o IP do cliente vem em x-forwarded-for (auditoria e limite de login)
  rewriteUrl: (req) => req.url.replace(/^\/api(?=\/|\?|$)/, '') || '/',
});
// Em produção o app e a API são da mesma origem (/api), então CORS fica desligado, salvo lista explícita.
await app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false });
if (!isTest) await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(jwt, { secret: process.env.JWT_SECRET });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation', issues: err.issues });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  // LGPD: só tipo, código e mensagem; os campos extras do erro do pg (detail, where, parameters) podem trazer valores de linhas
  req.log.error({ err: { type: err.name, code: err.code, message: err.message, stack: err.stack } }, 'erro interno');
  reply.code(500).send({ error: 'internal' });
});

app.decorate('auth', async (req, reply) => {
  try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
  if (!req.user.clinicId) return reply.code(401).send({ error: 'unauthorized' }); // ex.: token de `state` do OAuth não autentica
  const [u] = await q(`SELECT role FROM users WHERE id=$1 AND clinic_id=$2 AND password_hash <> '!'`, [req.user.userId, req.user.clinicId]);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  req.user.role = u.role;
});
const guard = { onRequest: [app.auth] };
// Dinheiro (financeiro, DRE, Julia) só para dono e gerente: recepção e profissional não veem.
const MANAGERS = ['owner', 'manager'];
const manager = { onRequest: [app.auth, async (req, reply) => {
  if (!MANAGERS.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
}] };
const owner = { onRequest: [app.auth, async (req, reply) => {
  if (req.user.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
}] };
await app.register((await import('./cadastros.js')).default);
await app.register(googleRoutes);
await app.register((await import('./team.js')).default);
await app.register((await import('./presence.js')).default);
await app.register((await import('./banks.js')).default);
await app.register((await import('./payments.js')).default);
await app.register((await import('./hours.js')).default);
await app.register((await import('./prontuario.js')).default);
await app.register((await import('./whatsapp.js')).default);
await app.register((await import('./atendimento.js')).default);
await app.register((await import('./rastreabilidade.js')).default);
await app.register((await import('./retornos.js')).default);
await app.register((await import('./fila.js')).default);
await app.register((await import('./painel_ciclo.js')).default);
await app.register((await import('./lotes.js')).default);
const clinic = (req) => req.user.clinicId;

// ---------- Auth ----------
app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
  const [u] = await q('SELECT id, clinic_id, role, password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
  // Limite de tentativas no banco (o rate limit em memória não vale entre invocações serverless):
  // 5 falhas em 15 min para o mesmo usuário vindas do mesmo IP bloqueiam esse IP, sem trancar o dono da conta.
  if (u) {
    const [{ n }] = await q(`SELECT count(*)::int n FROM audit_log WHERE user_id=$1 AND ip=$2
      AND action='auth.login_failed' AND created_at > now() - interval '15 minutes'`, [u.id, req.ip]);
    if (n >= 5) return reply.code(429).send({ error: 'too many attempts' });
  }
  // compara sempre (mesmo sem usuário) para o tempo de resposta não revelar se o e-mail existe
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) {
    if (u) await audit({ clinicId: u.clinic_id, userId: u.id, ip: req.ip }, 'auth.login_failed', 'user', u.id);
    return reply.code(401).send({ error: 'invalid credentials' });
  }
  await audit({ clinicId: u.clinic_id, userId: u.id, ip: req.ip }, 'auth.login', 'user', u.id);
  return { token: app.jwt.sign({ userId: u.id, clinicId: u.clinic_id, role: u.role }, { expiresIn: '12h' }) };
});

// Versão dos Termos de Uso / Política de Privacidade (mesma de frontend/src/Legal.tsx). Mudou? Todos aceitam de novo.
const TERMS_VERSION = '2026-10';

app.get('/me', guard, async (req, reply) => {
  await ensureSchema();
  const [u] = await q(`SELECT u.name, u.email, u.role, c.name AS clinic, u.terms_version FROM users u JOIN clinics c ON c.id=u.clinic_id
                       WHERE u.id=$1 AND u.clinic_id=$2`, [req.user.userId, clinic(req)]);
  if (!u) return reply.code(401).send({ error: 'unauthorized' });
  const { terms_version: tv, ...me } = u;
  return { ...me, termsAccepted: tv === TERMS_VERSION };
});

app.post('/me/terms', guard, async (req, reply) => {
  await ensureSchema();
  const { version } = z.object({ version: z.string() }).parse(req.body);
  if (version !== TERMS_VERSION) return reply.code(400).send({ error: 'terms version outdated' });
  await q('UPDATE users SET terms_accepted_at=now(), terms_version=$3 WHERE id=$1 AND clinic_id=$2', [req.user.userId, clinic(req), version]);
  await q(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id) VALUES ($1,$2::uuid,'terms.accepted','user',$2::text)`, [clinic(req), req.user.userId]);
  return { ok: true, version };
});

app.post('/me/password', { ...guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { current, next } = z.object({ current: z.string(), next: z.string().min(10).max(200) }).parse(req.body);
  const [u] = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.userId]);
  if (!(await bcrypt.compare(current, u.password_hash))) return reply.code(403).send({ error: 'wrong password' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 10), req.user.userId]);
  await audit({ clinicId: clinic(req), userId: req.user.userId, ip: req.ip }, 'auth.password_changed', 'user', req.user.userId);
  return { ok: true };
});

// ---------- Dashboard / agenda ----------
app.get('/dashboard', guard, async (req) => {
  const d = await getDashboard(clinic(req));
  return MANAGERS.includes(req.user.role) ? d : { ...d, revenueByMonth: [], todayRevenue: null };
});

app.get('/appointments', guard, async (req) => {
  const { from, to } = z.object({ from: z.string().date(), to: z.string().date() }).parse(req.query);
  return q(`SELECT a.*, p.full_name AS patient, pr.name AS procedure
            FROM appointments a JOIN patients p ON p.id=a.patient_id
            LEFT JOIN procedures pr ON pr.id=a.procedure_id
            WHERE a.clinic_id=$1 AND a.starts_at >= $2 AND a.starts_at < $3::date + 1
            ORDER BY a.starts_at`, [clinic(req), from, to]);
});

const apptBody = z.object({
  patientId: z.guid(), procedureId: z.guid().optional(),
  professionalId: z.guid().optional(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime(), price: z.number().positive().optional(),
});
app.post('/appointments', guard, async (req, reply) => {
  const b = apptBody.parse(req.body);
  const [row] = await q(
    `INSERT INTO appointments (clinic_id, patient_id, procedure_id, professional_id, starts_at, ends_at, price)
     SELECT $1,$2,$3,$4,$5,$6, COALESCE($7, (SELECT default_price FROM procedures WHERE id=$3 AND clinic_id=$1))
     WHERE EXISTS (SELECT 1 FROM patients WHERE id=$2 AND clinic_id=$1)
       AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.clinic_id=$1 AND x.status NOT IN ('canceled','no_show')
                       AND x.starts_at < $6 AND x.ends_at > $5 AND ($4::uuid IS NULL OR x.professional_id=$4))
     RETURNING *`,
    [clinic(req), b.patientId, b.procedureId ?? null, b.professionalId ?? null, b.startsAt, b.endsAt, b.price ?? null]);
  if (!row) {
    const [p] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [b.patientId, clinic(req)]);
    return reply.code(p ? 409 : 404).send({ error: p ? 'slot_taken' : 'patient not found' });
  }
  pushAppointment(row.id).catch((e) => req.log.error(e)); // se falhar, o cron de sync reenvia
  return reply.code(201).send(row);
});

// Reagendar / confirmar / cancelar
app.patch('/appointments/:id', guard, async (req, reply) => {
  const { id } = z.object({ id: z.guid() }).parse(req.params);
  const b = z.object({ startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(),
    status: z.enum(['confirmed', 'canceled', 'no_show']).optional() })
    .refine((v) => (!v.startsAt) === (!v.endsAt), 'startsAt e endsAt andam juntos').parse(req.body);
  const [row] = await q(
    `UPDATE appointments SET starts_at=COALESCE($3,starts_at), ends_at=COALESCE($4,ends_at),
       status=COALESCE($5,status), updated_at=now()
     WHERE id=$1 AND clinic_id=$2 AND status IN ('scheduled','confirmed')
       AND ($3::timestamptz IS NULL OR NOT EXISTS (SELECT 1 FROM appointments x WHERE x.clinic_id=$2 AND x.id<>$1
            AND x.status NOT IN ('canceled','no_show') AND x.starts_at < $4::timestamptz AND x.ends_at > $3::timestamptz
            AND (appointments.professional_id IS NULL OR x.professional_id=appointments.professional_id)))
     RETURNING *`,
    [id, clinic(req), b.startsAt ?? null, b.endsAt ?? null, b.status ?? null]);
  if (!row) {
    const [still] = await q(`SELECT 1 FROM appointments WHERE id=$1 AND clinic_id=$2 AND status IN ('scheduled','confirmed')`, [id, clinic(req)]);
    return reply.code(still ? 409 : 404).send({ error: still ? 'slot_taken' : 'not found or already closed' });
  }
  pushAppointment(row.id).catch((e) => req.log.error(e));
  return row;
});

// Concluir atendimento (legado): fecha e gera a receita. NÃO baixa estoque; a baixa só ocorre com confirmação em POST /appointments/:id/conclude (atendimento.js)
app.post('/appointments/:id/complete', guard, async (req, reply) => {
  const { id } = z.object({ id: z.guid() }).parse(req.params);
  const { pool } = await import('./db.js');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [a] } = await c.query(
      `UPDATE appointments SET status='done', completed_at=now(), updated_at=now()
       WHERE id=$1 AND clinic_id=$2 AND status IN ('scheduled','confirmed') RETURNING *`, [id, clinic(req)]);
    if (!a) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'not completable' }); }
    if (a.price) {
      await c.query(
        `INSERT INTO transactions (clinic_id,type,category_id,appointment_id,description,amount,competence_date,due_date,status)
         SELECT $1,'income',
                (SELECT id FROM categories WHERE clinic_id=$1 AND kind='income' AND dre_group='receita_bruta' ORDER BY name LIMIT 1),
                $2,'Atendimento',$3, d, d, 'pending'
         FROM (SELECT (now() AT TIME ZONE timezone)::date AS d FROM clinics WHERE id=$1) c`,
        [a.clinic_id, a.id, a.price]);
    }
    await c.query('COMMIT');
    return a;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
});

// ---------- Pacientes ----------
app.get('/patients', guard, (req) => {
  const { search = '' } = req.query;
  return q(`SELECT id, full_name, birth_date, phone FROM patients
            WHERE clinic_id=$1 AND full_name ILIKE $2 ORDER BY full_name LIMIT 50`, [clinic(req), `%${search}%`]);
});
// POST /patients, ficha com CPF e prontuário: ver prontuario.js (dados sensíveis, cifrados e auditados)

// ---------- Financeiro ----------
app.get('/finance/summary', manager, (req) => {
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
  return getFinanceSummary(clinic(req), `${month}-01`);
});
app.get('/finance/top-procedures', manager, (req) => getTopProcedures(clinic(req), 6));
app.get('/finance/cashflow', manager, (req) => getCashFlow(clinic(req), 6));
app.get('/finance/dre', manager, (req) => {
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
  return buildDre(clinic(req), `${month}-01`);
});
app.get('/finance/payables', manager, (req) =>
  q(`SELECT * FROM transactions WHERE clinic_id=$1 AND type='expense' AND status='pending' ORDER BY due_date`, [clinic(req)]));
app.get('/finance/receivables', manager, (req) =>
  q(`SELECT * FROM transactions WHERE clinic_id=$1 AND type='income' AND status='pending' ORDER BY due_date`, [clinic(req)]));
// Dá baixa na conta (recebimento ou pagamento) e registra em qual conta bancária o dinheiro entrou/saiu:
// a escolhida ou, se nenhuma for informada, a padrão da clínica.
app.post('/finance/transactions/:id/pay', manager, async (req, reply) => {
  await ensureSchema();
  const { id } = z.object({ id: z.guid() }).parse(req.params);
  const { bankAccountId } = z.object({ bankAccountId: z.guid().optional() }).parse(req.body ?? {});
  const [acct] = await q(`SELECT id FROM bank_accounts WHERE clinic_id=$1 AND active AND ($2::uuid IS NULL OR id=$2)
                         ORDER BY is_default DESC, created_at LIMIT 1`, [clinic(req), bankAccountId ?? null]);
  if (bankAccountId && !acct) return reply.code(404).send({ error: 'bank account not found' });
  const [row] = await q(`UPDATE transactions SET status='paid', paid_at=now(), bank_account_id=$3
    WHERE id=$1 AND clinic_id=$2 AND status='pending' RETURNING *`, [id, clinic(req), acct?.id ?? null]);
  return row ?? reply.code(404).send({ error: 'not found' });
});

// ---------- Estoque ----------
app.get('/stock/restock', guard, (req) => getRestock(clinic(req)));
app.get('/protocols', guard, (req) =>
  q(`SELECT p.*, COALESCE(json_agg(json_build_object('product', pr.name, 'quantity', pi.quantity))
        FILTER (WHERE pr.id IS NOT NULL), '[]') AS items
     FROM protocols p LEFT JOIN protocol_items pi ON pi.protocol_id=p.id
     LEFT JOIN products pr ON pr.id=pi.product_id
     WHERE p.clinic_id=$1 GROUP BY p.id`, [clinic(req)]));

// ---------- Julia ----------
// Falha do provedor de IA (sem crédito, chave inválida, fora do ar, limite, tempo) vira erro específico, sem vazar detalhes.
const aiError = (req, reply, e) => {
  const f = aiFailure(e);
  if (!f) throw e;
  req.log.error({ err: e?.name, status: e?.status }, 'ia indisponivel'); // sem o corpo da resposta do provedor (pode ecoar o conteúdo enviado)
  return reply.code(f.code).send({ error: f.error });
};
app.post('/sara/chat', { ...guard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { message, conversationId } = z.object({
    message: z.string().min(1).max(2000), conversationId: z.guid().optional() }).parse(req.body);
  try { return await askSara({ clinicId: clinic(req), userId: req.user.userId, role: req.user.role, ip: req.ip, message, conversationId }); }
  catch (e) { return aiError(req, reply, e); }
});
// Teste de conexão com a IA (configurações): uma chamada mínima, só para o dono.
app.post('/sara/test', { ...owner, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
  try { await pingSara(); return { ok: true }; } catch (e) { return aiError(req, reply, e); }
});

app.get('/health', async () => ({ ok: true }));

// Cron da Vercel (vercel.json): chama GET com 'Authorization: Bearer <CRON_SECRET>'. Sem o segredo configurado a rota fica fechada.
app.get('/cron/tick', async (req, reply) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return reply.code(503).send({ error: 'cron_not_configured' });
  const got = Buffer.from(String(req.headers.authorization ?? '')), want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
  const { tick } = await import('./jobs.js');
  return tick();
});

export default app;
