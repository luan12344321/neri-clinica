import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { getDashboard, getRestock } from './queries.js';
import { renderReturnMessage, findForbiddenPromise } from './retornos.js';

// FILA DA SECRETARIA, CONSENTIMENTOS E "PRECISA DE ATENÇÃO".
// NADA aqui envia mensagem: a fila só entrega o texto pronto e (com autorização) o telefone; quem abre o
// WhatsApp e envia é a pessoa. Nenhuma IA decide intervalo, diagnóstico ou conduta. Telefone e dado de saúde
// não vão para log nem para URL do servidor.
//
// REGRA DE URGÊNCIA DO RETORNO (hoje = data no fuso America/Sao_Paulo, window_end = fim da janela):
//   high   = vencido (hoje > window_end)           -> daysLate = hoje - window_end (>= 1)
//   medium = na janela e faltam <= 7 dias para fechar (inclui o último dia)
//   low    = demais (janela mais folgada ou ainda não começou, no scope=all)
// Ordem: vencidos (maior atraso primeiro), depois menos dias para fechar a janela, depois suggested_date.
//
// SINCRONIA DO marketing_consent: o job de aniversário lê patients.marketing_consent. Ao gravar 'birthday' ou
// 'marketing', o campo passa a valer o último registro de 'birthday' (se existir), senão o de 'marketing', senão false.
// Assim revogar o aniversário desliga o campo mesmo que o marketing continue autorizado. 'return' NUNCA é
// inferido de outro consentimento nem altera esse campo.
//
// TABELA DE PRIORIDADE DO /attention (urgência / responsável). Ordem final: urgência, depois a ordem abaixo.
//   late_appointments  high    doctor     atendimento passou do horário sem concluir (últimos 7 dias)
//   payables_overdue   high    manager    contas a pagar vencidas (só owner/manager)
//   lots_expired       high    manager    lote vencido com saldo (só owner/manager)
//   returns_overdue    medium  secretary  retornos com a janela vencida
//   returns_closing    medium  secretary  retornos na janela com <= 7 dias para fechar
//   receivables_overdue medium manager    contas a receber vencidas (só owner/manager)
//   lots_expiring      medium  manager    lotes vencendo em <= 60 dias (só owner/manager)
//   returns_window     low     secretary  demais retornos dentro da janela
//   restock            low     secretary  produtos abaixo do ponto de reposição (sem custo)
//   birthdays          low     secretary  aniversariantes do dia
// A recepção nunca recebe item financeiro, custo ou margem.

const TZ = 'America/Sao_Paulo';
const idParam = z.object({ id: z.guid() });
const DAY = 864e5;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const todayIso = async () => iso((await q(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ]))[0].d);

export const normalizePhone = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 14) return d;
  return null;
};

const NEUTRAL = 'Olá, {{nome}}! Já está no período indicado para a avaliação de retorno do seu {{procedimento}}. Se quiser, podemos combinar um horário (sugestão: até {{data}}).';
const firstName = (n) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const ddmm = (d) => { const [, m, dd] = iso(d).split('-'); return `${dd}/${m}`; };

const urgencyOf = (daysLate, daysToClose) => (daysLate > 0 ? 'high' : daysToClose <= 7 ? 'medium' : 'low');
const URG = { high: 0, medium: 1, low: 2 };

export default async function fila(app) {
  const roles = (...allowed) => ({ onRequest: [app.auth, async (req, reply) => {
    if (!allowed.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] });
  const anyStaff = roles('owner', 'manager', 'professional', 'reception');
  const PURPOSES = ['return', 'birthday', 'marketing'];

  // ---------------- Fila de retornos ----------------
  app.get('/returns/queue', anyStaff, async (req, reply) => {
    const parsed = z.object({ scope: z.enum(['today', 'all']).default('today') }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'scope inválido (today ou all).' });
    await ensureSchema();
    const today = await todayIso();
    const states = parsed.data.scope === 'today' ? ['suggested'] : ['suggested', 'remind_later', 'no_response'];
    const rows = await q(
      `SELECT r.id, r.state, r.suggested_date::text AS suggested_date, COALESCE(r.window_start, r.suggested_date)::text AS window_start,
              COALESCE(r.window_end, r.suggested_date)::text AS window_end,
              p.id AS patient_id, p.full_name, p.phone, pr.id AS procedure_id, pr.name AS procedure_name,
              rule.message_text,
              (SELECT c.granted FROM contact_consents c WHERE c.clinic_id=r.clinic_id AND c.patient_id=r.patient_id AND c.purpose='return'
               ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1) AS consent
       FROM returns r
       JOIN patients p ON p.id=r.patient_id AND p.clinic_id=r.clinic_id
       JOIN procedures pr ON pr.id=r.procedure_id AND pr.clinic_id=r.clinic_id
       LEFT JOIN procedure_return_rules rule ON rule.clinic_id=r.clinic_id AND rule.procedure_id=r.procedure_id AND rule.active
       WHERE r.clinic_id=$1 AND r.state = ANY($2::text[])
         AND ($3::boolean OR COALESCE(r.window_start, r.suggested_date) <= $4::date)
       LIMIT 500`,
      [req.user.clinicId, states, parsed.data.scope === 'all', today]);
    const items = rows.map((r) => {
      const daysLate = Math.max(0, diffDays(today, r.window_end));
      const daysToClose = diffDays(r.window_end, today);
      const granted = r.consent === true;
      const base = r.message_text && !findForbiddenPromise(r.message_text) ? r.message_text : NEUTRAL;
      return {
        id: r.id,
        patient: { id: r.patient_id, name: r.full_name },
        procedure: { id: r.procedure_id, name: r.procedure_name },
        suggestedDate: r.suggested_date, windowStart: r.window_start, windowEnd: r.window_end, state: r.state,
        urgency: urgencyOf(daysLate, daysToClose), daysLate,
        message: renderReturnMessage(base, { nome: firstName(r.full_name), procedimento: r.procedure_name, data: ddmm(r.window_end) }),
        consent: granted && !!normalizePhone(r.phone),
        phone: granted ? normalizePhone(r.phone) : null,
        _late: daysLate, _close: daysToClose,
      };
    });
    items.sort((a, b) => (b._late > 0) - (a._late > 0) || b._late - a._late || a._close - b._close
      || a.suggestedDate.localeCompare(b.suggestedDate));
    return { scope: parsed.data.scope, items: items.map(({ _late, _close, ...it }) => it) };
  });

  app.post('/returns/:id/result', anyStaff, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not found' });
    const b = z.object({
      result: z.enum(['scheduled', 'declined', 'no_response', 'remind_later']),
      remindOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Resultado inválido.' });
    await ensureSchema();
    const [r] = await q('SELECT id, state FROM returns WHERE id=$1 AND clinic_id=$2', [p.data.id, req.user.clinicId]);
    if (!r) return reply.code(404).send({ error: 'not found' });
    if (!['suggested', 'remind_later', 'no_response'].includes(r.state))
      return reply.code(409).send({ error: 'Este retorno já foi resolvido.' });
    let remindOn = null;
    if (b.data.result === 'remind_later') {
      const today = await todayIso();
      remindOn = b.data.remindOn ?? null;
      if (!remindOn || Number.isNaN(Date.parse(`${remindOn}T00:00:00Z`)) || new Date(`${remindOn}T00:00:00Z`).toISOString().slice(0, 10) !== remindOn)
        return reply.code(400).send({ error: 'Informe a data do lembrete (remindOn).' });
      if (remindOn < addDays(today, 1) || remindOn > addDays(today, 180))
        return reply.code(400).send({ error: 'A data do lembrete deve ser entre amanhã e 180 dias.' });
    }
    const [upd] = await q(
      `UPDATE returns SET state=$3, contacted_at=now(), remind_on=$4, updated_at=now()
       WHERE id=$1 AND clinic_id=$2 AND state IN ('suggested','remind_later','no_response') RETURNING id, state, remind_on::text AS remind_on`,
      [r.id, req.user.clinicId, b.data.result, remindOn]);
    if (!upd) return reply.code(409).send({ error: 'Este retorno acabou de ser alterado por outra pessoa.' });
    await audit(auditCtx(req), 'return.result', 'return', r.id);
    return { id: upd.id, state: upd.state, remindOn: upd.remind_on };
  });

  // ---------------- Consentimentos (histórico só de inserção) ----------------
  const loadPatient = async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(404).send({ error: 'not found' }); return null; }
    const [pat] = await q('SELECT id FROM patients WHERE id=$1 AND clinic_id=$2', [p.data.id, req.user.clinicId]);
    if (!pat) { reply.code(404).send({ error: 'not found' }); return null; }
    return pat;
  };

  app.get('/patients/:id/consents', anyStaff, async (req, reply) => {
    const pat = await loadPatient(req, reply); if (!pat) return;
    await ensureSchema();
    const rows = await q(
      `SELECT DISTINCT ON (purpose) purpose, granted, recorded_at FROM contact_consents
       WHERE clinic_id=$1 AND patient_id=$2 ORDER BY purpose, recorded_at DESC, id DESC`, [req.user.clinicId, pat.id]);
    const out = { return: null, birthday: null, marketing: null };
    for (const r of rows) out[r.purpose] = { granted: r.granted, recordedAt: new Date(r.recorded_at).toISOString() };
    return out;
  });

  app.put('/patients/:id/consents', anyStaff, async (req, reply) => {
    const pat = await loadPatient(req, reply); if (!pat) return;
    const b = z.object({ purpose: z.enum(PURPOSES), granted: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Informe a finalidade e se foi autorizado.' });
    await ensureSchema();
    const [row] = await q(
      `INSERT INTO contact_consents (clinic_id, patient_id, purpose, granted, recorded_by) VALUES ($1,$2,$3,$4,$5)
       RETURNING granted, recorded_at`, [req.user.clinicId, pat.id, b.data.purpose, b.data.granted, req.user.userId]);
    if (b.data.purpose !== 'return') {
      await q(
        `UPDATE patients SET marketing_consent = COALESCE(
           (SELECT granted FROM contact_consents WHERE clinic_id=$1 AND patient_id=$2 AND purpose='birthday' ORDER BY recorded_at DESC, id DESC LIMIT 1),
           (SELECT granted FROM contact_consents WHERE clinic_id=$1 AND patient_id=$2 AND purpose='marketing' ORDER BY recorded_at DESC, id DESC LIMIT 1),
           false)
         WHERE id=$2 AND clinic_id=$1`, [req.user.clinicId, pat.id]);
    }
    await audit(auditCtx(req), 'consent.update', 'patient', pat.id);
    return { purpose: b.data.purpose, granted: row.granted, recordedAt: new Date(row.recorded_at).toISOString() };
  });

  // ---------------- Precisa de atenção ----------------
  app.get('/attention', anyStaff, async (req) => {
    await ensureSchema();
    const cid = req.user.clinicId;
    const finance = ['owner', 'manager'].includes(req.user.role);
    const today = await todayIso();
    const items = [];
    const push = (it) => items.push({ count: 1, nextActions: [], ...it });

    // atendimentos que passaram do horário sem concluir
    const late = await q(
      `SELECT a.id, p.full_name, to_char(a.starts_at AT TIME ZONE $2,'HH24:MI') AS hhmm
       FROM appointments a JOIN patients p ON p.id=a.patient_id
       WHERE a.clinic_id=$1 AND a.status IN ('scheduled','confirmed') AND a.ends_at < now() AND a.starts_at > now() - interval '7 days'
       ORDER BY a.starts_at LIMIT 50`, [cid, TZ]);
    if (late.length) push({
      id: 'late_appointments', kind: 'late_appointments', urgency: 'high', owner: 'doctor', count: late.length,
      title: late.length === 1 ? 'Atendimento sem conclusão' : `${late.length} atendimentos sem conclusão`,
      detail: late.slice(0, 3).map((a) => `${firstName(a.full_name)} (${a.hhmm})`).join(', '),
      refs: late.slice(0, 10).map((a) => ({ id: a.id, label: firstName(a.full_name) })),
      nextActions: [{ kind: 'check_status', label: 'Verificar status' }, { kind: 'register', label: 'Registrar' },
        { kind: 'reschedule', label: 'Reagendar' }, { kind: 'forward', label: 'Encaminhar' }],
    });

    // retornos (mesma regra de urgência da fila)
    const [rc] = await q(
      `SELECT count(*) FILTER (WHERE $2::date > COALESCE(window_end, suggested_date))::int AS overdue,
              count(*) FILTER (WHERE $2::date <= COALESCE(window_end, suggested_date) AND COALESCE(window_end, suggested_date) - $2::date <= 7)::int AS closing,
              count(*) FILTER (WHERE COALESCE(window_end, suggested_date) - $2::date > 7)::int AS open
       FROM returns WHERE clinic_id=$1 AND state='suggested' AND COALESCE(window_start, suggested_date) <= $2::date`, [cid, today]);
    const retAct = [{ kind: 'open_returns', label: 'Ver retornos do dia' }];
    if (rc.overdue) push({ id: 'returns_overdue', kind: 'returns_overdue', urgency: 'medium', owner: 'secretary', count: rc.overdue,
      title: `${rc.overdue} ${rc.overdue === 1 ? 'retorno vencido' : 'retornos vencidos'}`, detail: 'A janela de retorno já fechou.', nextActions: retAct });
    if (rc.closing) push({ id: 'returns_closing', kind: 'returns_closing', urgency: 'medium', owner: 'secretary', count: rc.closing,
      title: `${rc.closing} ${rc.closing === 1 ? 'retorno fecha' : 'retornos fecham'} em até 7 dias`, detail: 'Pacientes dentro da janela de retorno.', nextActions: retAct });
    if (rc.open) push({ id: 'returns_window', kind: 'returns_window', urgency: 'low', owner: 'secretary', count: rc.open,
      title: `${rc.open} ${rc.open === 1 ? 'retorno na janela' : 'retornos na janela'}`, detail: 'Ainda há tempo para chamar.', nextActions: retAct });

    if (finance) {
      const [pay] = await q(`SELECT count(*)::int n, COALESCE(sum(amount),0)::float total FROM transactions
        WHERE clinic_id=$1 AND type='expense' AND status='pending' AND due_date < $2::date`, [cid, today]);
      if (pay.n) push({ id: 'payables_overdue', kind: 'payables_overdue', urgency: 'high', owner: 'manager', count: pay.n, amount: pay.total,
        title: `${pay.n} ${pay.n === 1 ? 'conta a pagar vencida' : 'contas a pagar vencidas'}`, detail: 'Pagamentos com vencimento passado.',
        nextActions: [{ kind: 'open_payables', label: 'Ver contas a pagar' }] });
      const [rec] = await q(`SELECT count(*)::int n, COALESCE(sum(amount),0)::float total FROM transactions
        WHERE clinic_id=$1 AND type='income' AND status='pending' AND due_date < $2::date`, [cid, today]);
      if (rec.n) push({ id: 'receivables_overdue', kind: 'receivables_overdue', urgency: 'medium', owner: 'manager', count: rec.n, amount: rec.total,
        title: `${rec.n} ${rec.n === 1 ? 'conta a receber vencida' : 'contas a receber vencidas'}`, detail: 'Recebimentos com vencimento passado.',
        nextActions: [{ kind: 'open_receivables', label: 'Ver contas a receber' }] });
      const lots = await q(`SELECT l.expires_at::text AS exp FROM product_lots l
        WHERE l.clinic_id=$1 AND l.quantity_units > 0 AND l.expires_at <= $2::date + 60`, [cid, today]);
      const expired = lots.filter((l) => l.exp < today).length;
      const soon = lots.length - expired;
      if (expired) push({ id: 'lots_expired', kind: 'lots_expired', urgency: 'high', owner: 'manager', count: expired,
        title: `${expired} ${expired === 1 ? 'lote vencido com saldo' : 'lotes vencidos com saldo'}`, detail: 'Separe para descarte conforme o procedimento da clínica.',
        nextActions: [{ kind: 'open_lots', label: 'Ver lotes' }] });
      if (soon) push({ id: 'lots_expiring', kind: 'lots_expiring', urgency: 'medium', owner: 'manager', count: soon,
        title: `${soon} ${soon === 1 ? 'lote vence' : 'lotes vencem'} em até 60 dias`, detail: 'Use os mais próximos do vencimento primeiro.',
        nextActions: [{ kind: 'open_lots', label: 'Ver lotes' }] });
    }

    const restock = await getRestock(cid);
    if (restock.length) push({ id: 'restock', kind: 'restock', urgency: 'low', owner: 'secretary', count: restock.length,
      title: `${restock.length} ${restock.length === 1 ? 'produto para repor' : 'produtos para repor'}`,
      detail: restock.slice(0, 3).map((r) => r.name).join(', '), nextActions: [{ kind: 'open_restock', label: 'Ver reposição' }] });

    const { birthdays } = await getDashboard(cid);
    if (birthdays.length) push({ id: 'birthdays', kind: 'birthdays', urgency: 'low', owner: 'secretary', count: birthdays.length,
      title: `${birthdays.length} ${birthdays.length === 1 ? 'aniversariante hoje' : 'aniversariantes hoje'}`,
      detail: birthdays.slice(0, 3).map((b) => firstName(b.full_name)).join(', '), nextActions: [{ kind: 'open_birthdays', label: 'Ver aniversariantes' }] });

    const order = items.map((i) => i.id);
    items.sort((a, b) => URG[a.urgency] - URG[b.urgency] || order.indexOf(a.id) - order.indexOf(b.id));
    return { items };
  });
}
