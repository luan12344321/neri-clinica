import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { availableSlots, createAppointment, ToolError } from './sara.js';

// RETORNO INTELIGENTE: o intervalo vem SEMPRE da regra que a doutora configura por procedimento.
// Nenhuma IA decide intervalo, diagnóstico ou conduta, e nada aqui envia mensagem (a fila de retornos
// é decidida por datas e acionada por uma pessoa).

const TZ = 'America/Sao_Paulo';

// ---- Mensagem sem promessa de resultado (CFM) ----
// Termos que prometem resultado/garantia. A comparação ignora maiúsculas e acentos.
// Para ampliar a lista basta incluir novas entradas aqui (texto simples ou expressão regular).
export const FORBIDDEN_PROMISES = [
  'garantido', 'garantida', 'garantimos', 'garantia de resultado', 'resultado garantido', 'efeito garantido',
  '100%', 'cem por cento', 'sem risco', 'sem riscos', 'definitivo', 'definitiva', 'milagre', 'milagroso',
  'rejuvenesca', 'rejuvenescimento garantido', 'antes e depois',
];
// Variáveis permitidas no texto da mensagem.
export const ALLOWED_VARS = ['nome', 'procedimento', 'data'];

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const findForbiddenPromise = (text) => {
  const t = plain(text);
  return FORBIDDEN_PROMISES.find((w) => t.includes(plain(w))) ?? null;
};

// Troca {{nome}}, {{procedimento}} e {{data}}; variável desconhecida some.
export const renderReturnMessage = (messageText, { nome = '', procedimento = '', data = '' } = {}) =>
  String(messageText).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ({ nome, procedimento, data })[k] ?? '');

const ruleSchema = z.object({
  targetDays: z.number().int().positive(),
  windowMinDays: z.number().int().positive(),
  windowMaxDays: z.number().int().positive(),
  messageText: z.string().trim().min(5, 'A mensagem precisa ter ao menos 5 caracteres.').max(600, 'A mensagem pode ter no máximo 600 caracteres.'),
  active: z.boolean().default(true),
}).superRefine((b, ctx) => {
  if (b.windowMinDays > b.targetDays || b.targetDays > b.windowMaxDays)
    ctx.addIssue({ code: 'custom', path: ['windowMinDays'], message: 'A janela precisa respeitar: mínimo <= intervalo-alvo <= máximo.' });
  const bad = findForbiddenPromise(b.messageText);
  if (bad) ctx.addIssue({ code: 'custom', path: ['messageText'], message: `A mensagem não pode prometer resultado ou garantia (termo "${bad}"). Descreva apenas o convite para a avaliação de retorno.` });
  const unknown = [...b.messageText.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).find((v) => !ALLOWED_VARS.includes(v));
  if (unknown) ctx.addIssue({ code: 'custom', path: ['messageText'], message: `Variável {{${unknown}}} não existe. Use apenas: ${ALLOWED_VARS.map((v) => `{{${v}}}`).join(', ')}.` });
});

const toDto = (r) => ({ configured: true, id: r.id, procedureId: r.procedure_id, targetDays: r.target_days, windowMinDays: r.window_min_days,
  windowMaxDays: r.window_max_days, messageText: r.message_text, active: r.active });

// ---- Sugestão (dentro da transação do atendimento) ----
// `client` é a conexão do pg com BEGIN aberto: usa SOMENTE client.query (nunca o pool).
export async function suggestReturn(client, { clinicId, appointmentId, patientId, procedureId }) {
  if (!procedureId) return null;
  const { rows: [rule] } = await client.query(
    `SELECT target_days, window_min_days, window_max_days FROM procedure_return_rules
     WHERE clinic_id=$1 AND procedure_id=$2 AND active`, [clinicId, procedureId]);
  if (!rule) return null;
  const cols = 'id, suggested_date, window_start, window_end, procedure_id';
  const { rows: [created] } = await client.query(
    `WITH base AS (
       SELECT COALESCE((SELECT (completed_at AT TIME ZONE $7)::date FROM appointments WHERE id=$3 AND clinic_id=$1),
                       (now() AT TIME ZONE $7)::date) AS d)
     INSERT INTO returns (clinic_id, patient_id, procedure_id, source_appointment_id, suggested_date, window_start, window_end)
     SELECT $1, $2, $4, $3, d + $5::int, d + $6::int, d + $8::int FROM base
     ON CONFLICT (clinic_id, source_appointment_id, procedure_id) DO NOTHING
     RETURNING ${cols}`,
    [clinicId, patientId, appointmentId, procedureId, rule.target_days, rule.window_min_days, TZ, rule.window_max_days]);
  if (created) {
    await client.query(`INSERT INTO audit_log (clinic_id, action, entity, entity_id) VALUES ($1,'return.suggested','return',$2)`, [clinicId, created.id]);
    return created;
  }
  const { rows: [existing] } = await client.query(
    `SELECT ${cols} FROM returns WHERE clinic_id=$1 AND source_appointment_id=$2 AND procedure_id=$3`, [clinicId, appointmentId, procedureId]);
  return existing ?? null;
}

// ---- Tarefa diária: só atualiza estado, nunca envia nada ----
export async function returnsTick() {
  await ensureSchema();
  // (a) lembrar depois: chegou o dia
  await q(`UPDATE returns SET state='suggested', updated_at=now()
           WHERE state='remind_later' AND remind_on IS NOT NULL AND remind_on <= (now() AT TIME ZONE $1)::date`, [TZ]);
  // (b) agendamento gerado já foi concluído
  await q(`UPDATE returns r SET state='done', updated_at=now()
           WHERE r.state='scheduled' AND EXISTS (
             SELECT 1 FROM appointments a WHERE a.id=r.generated_appointment_id AND a.clinic_id=r.clinic_id AND a.status='done')`);
  // (c) o paciente já refez o mesmo procedimento depois da origem
  await q(`UPDATE returns r SET state='done', updated_at=now()
           WHERE r.state IN ('suggested','remind_later','no_response') AND EXISTS (
             SELECT 1 FROM appointments a, appointments src
             WHERE src.id=r.source_appointment_id AND a.clinic_id=r.clinic_id AND a.patient_id=r.patient_id
               AND a.procedure_id=r.procedure_id AND a.status='done' AND a.id<>src.id
               AND COALESCE(a.completed_at, a.starts_at) > COALESCE(src.completed_at, src.starts_at))`);
}

export default async function retornos(app) {
  const roles = (...allowed) => ({ onRequest: [app.auth, async (req, reply) => {
    if (!allowed.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] });
  const readRule = roles('owner', 'manager', 'professional');
  const writeRule = roles('owner', 'manager');
  const anyStaff = roles('owner', 'manager', 'professional', 'reception');
  const idParam = z.object({ id: z.guid() });

  const loadProcedure = async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(404).send({ error: 'not found' }); return null; }
    const [proc] = await q('SELECT id, name FROM procedures WHERE id=$1 AND clinic_id=$2', [p.data.id, req.user.clinicId]);
    if (!proc) { reply.code(404).send({ error: 'not found' }); return null; }
    return proc;
  };

  app.get('/procedures/:id/return-rule', readRule, async (req, reply) => {
    const proc = await loadProcedure(req, reply); if (!proc) return;
    await ensureSchema();
    const [r] = await q('SELECT * FROM procedure_return_rules WHERE clinic_id=$1 AND procedure_id=$2', [req.user.clinicId, proc.id]);
    return r ? toDto(r) : { configured: false, procedureId: proc.id, active: false };
  });

  app.put('/procedures/:id/return-rule', writeRule, async (req, reply) => {
    const proc = await loadProcedure(req, reply); if (!proc) return;
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' });
    const b = parsed.data;
    await ensureSchema();
    const [r] = await q(
      `INSERT INTO procedure_return_rules (clinic_id, procedure_id, target_days, window_min_days, window_max_days, message_text, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (clinic_id, procedure_id) DO UPDATE SET target_days=EXCLUDED.target_days, window_min_days=EXCLUDED.window_min_days,
         window_max_days=EXCLUDED.window_max_days, message_text=EXCLUDED.message_text, active=EXCLUDED.active, updated_at=now()
       RETURNING *`,
      [req.user.clinicId, proc.id, b.targetDays, b.windowMinDays, b.windowMaxDays, b.messageText, b.active]);
    await audit(auditCtx(req), 'return_rule.update', 'procedure', proc.id);
    return toDto(r);
  });

  const loadReturn = async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(404).send({ error: 'not found' }); return null; }
    await ensureSchema();
    const [r] = await q('SELECT * FROM returns WHERE id=$1 AND clinic_id=$2', [p.data.id, req.user.clinicId]);
    if (!r) { reply.code(404).send({ error: 'not found' }); return null; }
    return r;
  };

  // Horários livres para a tela "Agendar agora"
  app.get('/returns/:id/slots', anyStaff, async (req, reply) => {
    const r = await loadReturn(req, reply); if (!r) return;
    const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Informe a data no formato AAAA-MM-DD.' });
    const { slots } = await availableSlots(req.user.clinicId, { date: parsed.data.date, durationMin: 30 });
    return { date: parsed.data.date, slots };
  });

  app.post('/returns/:id/schedule', anyStaff, async (req, reply) => {
    const r = await loadReturn(req, reply); if (!r) return;
    if (!['suggested', 'remind_later'].includes(r.state)) return reply.code(409).send({ error: 'Este retorno não está disponível para agendar.' });
    const parsed = z.object({ startsAt: z.string().datetime({ offset: true }) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Informe o horário (startsAt) em formato de data e hora.' });
    let made;
    try {
      made = await createAppointment({ clinicId: req.user.clinicId },
        { patientId: r.patient_id, startsAt: parsed.data.startsAt, procedureId: r.procedure_id, durationMin: 30, confirmed: true });
    } catch (e) {
      if (e instanceof ToolError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    const [upd] = await q(
      `UPDATE returns SET state='scheduled', generated_appointment_id=$3, updated_at=now()
       WHERE id=$1 AND clinic_id=$2 AND state IN ('suggested','remind_later') RETURNING id, state, generated_appointment_id`,
      [r.id, req.user.clinicId, made.appointmentId]);
    if (!upd) return reply.code(409).send({ error: 'Este retorno acabou de ser alterado por outra pessoa.' });
    await audit(auditCtx(req), 'return.schedule', 'return', r.id);
    return { id: upd.id, state: upd.state, appointmentId: upd.generated_appointment_id, inicio: made.inicio };
  });
}
