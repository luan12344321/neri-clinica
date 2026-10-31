import { z } from 'zod';
import { q, pool } from './db.js';
import { audit, auditCtx } from './audit.js';
import { decrypt } from './crypto.js';
import { ensureSchema } from './schema.js';
import { normalizePhone } from './fila.js';
import { pushAppointment } from './google.js';

// Governança de dados pessoais (LGPD): exportar, corrigir, reter, bloquear por obrigação legal e anonimizar.
// O que NÃO está aqui de propósito: prazo de guarda e exclusão de prontuário. Quanto tempo guardar e quando apagar prontuário
// é decisão da clínica com assessoria jurídica/CFM; o sistema só guarda o prazo que a clínica informar e LISTA candidatos
// para revisão humana. Nada é apagado automaticamente, e o conteúdo do prontuário nunca é tocado pela anonimização.
const cpfAad = (id) => `patients.cpf:${id}`;
const recordAad = (id) => `medical_records.data:${id}`;
export const ANON_NAME = 'Paciente anonimizado';
// O mesmo celular chega do WhatsApp com ou sem o 9º dígito: casa as duas formas (com DDI 55).
const phoneVariants = (raw) => {
  const d = normalizePhone(raw);
  if (!d) return [];
  if (d.length === 13 && d.startsWith('55')) return [d, d.slice(0, 4) + d.slice(5)];
  if (d.length === 12 && d.startsWith('55')) return [d, `${d.slice(0, 4)}9${d.slice(4)}`];
  return [d];
};

export default async function lgpd(app) {
  const roles = (list) => ({ onRequest: [app.auth, async (req, reply) => {
    if (!list.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] });
  const manager = roles(['owner', 'manager']);
  const owner = roles(['owner']);
  const staff = { onRequest: [app.auth] };
  const cid = (req) => req.user.clinicId;
  const idParam = (req) => z.object({ id: z.guid() }).parse(req.params).id;
  const find = async (req, reply, cols = 'id, full_name, anonymized_at, legal_hold_at') => {
    const id = idParam(req);
    const [p] = await q(`SELECT ${cols} FROM patients WHERE id=$1 AND clinic_id=$2`, [id, cid(req)]);
    if (!p) { reply.code(404).send({ error: 'not found' }); return null; }
    return p;
  };

  // Situação do titular para a tela (sem dados pessoais): bloqueio legal e anonimização.
  app.get('/lgpd/patients/:id', manager, async (req, reply) => {
    await ensureSchema();
    const p = await find(req, reply, 'id, legal_hold_at, legal_hold_reason, anonymized_at');
    if (!p) return;
    return { legalHold: p.legal_hold_at ? { since: p.legal_hold_at, reason: p.legal_hold_reason } : null, anonymizedAt: p.anonymized_at };
  });

  // ---- Exportação dos dados de UM titular (art. 18, II e V): tudo que o sistema guarda sobre a pessoa, em JSON ----
  app.get('/lgpd/patients/:id/export', { ...manager, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    await ensureSchema();
    const p = await find(req, reply, 'id, full_name, birth_date, phone, email, address, cpf_enc, marketing_consent, notes, created_at, legal_hold_reason, legal_hold_at, anonymized_at');
    if (!p) return;
    const id = p.id, clinicId = cid(req);
    const phone = normalizePhone(p.phone);
    const [appointments, applications, transactions, returns, consents, messages, records, traceability, waMessages, accessLog] = await Promise.all([
      q(`SELECT a.id, a.starts_at, a.ends_at, a.status, a.price::float AS price, pr.name AS procedure FROM appointments a
         LEFT JOIN procedures pr ON pr.id=a.procedure_id AND pr.clinic_id=a.clinic_id WHERE a.patient_id=$1 AND a.clinic_id=$2 ORDER BY a.starts_at`, [id, clinicId]),
      q(`SELECT ap.id, ap.appointment_id, pr.name AS product, l.lot_code, ap.units_used::float AS units, ap.created_at FROM applications ap
         JOIN products pr ON pr.id=ap.product_id LEFT JOIN product_lots l ON l.id=ap.lot_id WHERE ap.patient_id=$1 AND ap.clinic_id=$2 ORDER BY ap.created_at`, [id, clinicId]),
      q(`SELECT t.id, t.description, t.amount::float AS amount, t.status, t.due_date, t.paid_at FROM transactions t
         JOIN appointments a ON a.id=t.appointment_id WHERE a.patient_id=$1 AND t.clinic_id=$2 ORDER BY t.due_date`, [id, clinicId]),
      q(`SELECT id, suggested_date, state, contacted_at FROM returns WHERE patient_id=$1 AND clinic_id=$2 ORDER BY suggested_date`, [id, clinicId]),
      q(`SELECT purpose, granted, recorded_at FROM contact_consents WHERE patient_id=$1 AND clinic_id=$2 ORDER BY recorded_at, id`, [id, clinicId]),
      q(`SELECT kind, body, status, sent_at FROM message_queue WHERE patient_id=$1 AND clinic_id=$2 ORDER BY send_after`, [id, clinicId]),
      q(`SELECT r.id, r.data_enc, r.created_at, u.name AS author FROM medical_records r LEFT JOIN users u ON u.id=r.author_id
         WHERE r.patient_id=$1 AND r.clinic_id=$2 ORDER BY r.created_at`, [id, clinicId]),
      q('SELECT id, appointment_id, created_at FROM traceability_documents WHERE patient_id=$1 AND clinic_id=$2 ORDER BY created_at', [id, clinicId]),
      phone ? q('SELECT direction, body, created_at FROM wa_messages WHERE clinic_id=$1 AND contact=$2 ORDER BY id', [clinicId, phone]) : [],
      q(`SELECT l.action, l.created_at, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
         WHERE l.clinic_id=$1 AND l.entity_id=$2 ORDER BY l.id`, [clinicId, id]),
    ]);
    await audit(auditCtx(req), 'lgpd.export', 'patient', id); // antes de devolver (fail-closed)
    const body = {
      exportedAt: new Date().toISOString(),
      note: 'Cópia dos dados pessoais deste titular guardados pelo sistema. Fotos de rótulo, PDFs de rastreabilidade (só metadados aqui) e a conversa interna com a Julia não entram. O IP e os registros de acesso de outras pessoas ficam fora.',
      patient: { id, fullName: p.full_name, birthDate: p.birth_date, phone: p.phone, email: p.email, cpf: p.cpf_enc ? decrypt(p.cpf_enc, cpfAad(id)) : null,
        marketingConsent: p.marketing_consent, address: p.address, notes: p.notes, createdAt: p.created_at, legalHold: p.legal_hold_at ? { since: p.legal_hold_at, reason: p.legal_hold_reason } : null,
        anonymizedAt: p.anonymized_at },
      appointments, applications, transactions, returns, consents, messages,
      medicalRecords: records.map((r) => ({ id: r.id, author: r.author, createdAt: r.created_at, ...JSON.parse(decrypt(r.data_enc, recordAad(r.id))) })),
      traceabilityDocuments: traceability, whatsappMessages: waMessages, accessLog,
    };
    reply.header('content-disposition', `attachment; filename="titular-${id}.json"`);
    return body;
  });

  // ---- Correção (art. 18, III): identificação e contato. O prontuário não é editado (é registro clínico): corrige-se com novo registro. ----
  app.patch('/patients/:id', staff, async (req, reply) => {
    await ensureSchema();
    const b = z.object({
      fullName: z.string().trim().min(2).max(120).optional(), birthDate: z.string().date().nullable().optional(),
      phone: z.string().nullable().optional().refine((v) => !v || normalizePhone(v), 'Telefone inválido'),
      email: z.string().email().nullable().optional(), notes: z.string().max(5000).nullable().optional(),
      address: z.string().trim().max(300).nullable().optional(),
    }).refine((v) => Object.keys(v).length > 0, 'nada para alterar').parse(req.body);
    const p = await find(req, reply);
    if (!p) return;
    if (p.anonymized_at) return reply.code(409).send({ error: 'anonymized' });
    const sets = [], vals = [p.id, cid(req)];
    for (const [k, col] of [['fullName', 'full_name'], ['birthDate', 'birth_date'], ['phone', 'phone'], ['email', 'email'], ['address', 'address'], ['notes', 'notes']]) {
      if (b[k] === undefined) continue;
      if (k === 'fullName' && b[k] === null) continue;
      vals.push(b[k] ?? null); sets.push(`${col}=$${vals.length}`);
    }
    await q(`UPDATE patients SET ${sets.join(', ')} WHERE id=$1 AND clinic_id=$2 AND anonymized_at IS NULL`, vals);
    await audit(auditCtx(req), `patient.update:${Object.keys(b).sort().join(',')}`, 'patient', p.id); // só os nomes dos campos, nunca os valores
    // só o que a recepção já vê na lista de pacientes: e-mail e observações voltariam a qualquer perfil por esta rota
    const [row] = await q('SELECT id, full_name, birth_date, phone FROM patients WHERE id=$1 AND clinic_id=$2', [p.id, cid(req)]);
    return row;
  });

  // ---- Retenção legal: com bloqueio ativo nada é anonimizado nem entra na lista de revisão ----
  app.put('/lgpd/patients/:id/hold', owner, async (req, reply) => {
    await ensureSchema();
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const p = await find(req, reply);
    if (!p) return;
    await q('UPDATE patients SET legal_hold_reason=$3, legal_hold_at=COALESCE(legal_hold_at, now()) WHERE id=$1 AND clinic_id=$2', [p.id, cid(req), reason]);
    await audit(auditCtx(req), 'lgpd.hold_set', 'patient', p.id);
    return { ok: true };
  });
  app.delete('/lgpd/patients/:id/hold', owner, async (req, reply) => {
    await ensureSchema();
    const p = await find(req, reply);
    if (!p) return;
    await q('UPDATE patients SET legal_hold_reason=NULL, legal_hold_at=NULL WHERE id=$1 AND clinic_id=$2', [p.id, cid(req)]);
    await audit(auditCtx(req), 'lgpd.hold_cleared', 'patient', p.id);
    return reply.code(204).send();
  });

  // ---- Prazo de guarda: a clínica informa; o sistema só lista quem passou dele, para revisão humana ----
  app.get('/lgpd/retention', manager, async (req) => {
    await ensureSchema();
    const [c] = await q('SELECT retention_years FROM clinics WHERE id=$1', [cid(req)]);
    const years = c.retention_years;
    const candidates = years == null ? [] : await q(
      `SELECT p.id, p.full_name, GREATEST(p.created_at, COALESCE(max(a.starts_at), p.created_at), COALESCE(max(r.created_at), p.created_at)) AS last_activity
       FROM patients p LEFT JOIN appointments a ON a.patient_id=p.id LEFT JOIN medical_records r ON r.patient_id=p.id
       WHERE p.clinic_id=$1 AND p.anonymized_at IS NULL AND p.legal_hold_at IS NULL
       GROUP BY p.id HAVING GREATEST(p.created_at, COALESCE(max(a.starts_at), p.created_at), COALESCE(max(r.created_at), p.created_at)) < now() - make_interval(years => $2)
       ORDER BY last_activity LIMIT 200`, [cid(req), years]);
    return { retentionYears: years, decisionPending: years == null, candidates: candidates.map((r) => ({ id: r.id, fullName: r.full_name, lastActivity: r.last_activity })) };
  });
  app.put('/lgpd/retention', owner, async (req) => {
    await ensureSchema();
    const { retentionYears } = z.object({ retentionYears: z.number().int().min(1).max(100).nullable() }).parse(req.body);
    await q('UPDATE clinics SET retention_years=$2 WHERE id=$1', [cid(req), retentionYears]);
    await audit(auditCtx(req), 'lgpd.retention_set', 'clinic', cid(req));
    return { retentionYears };
  });

  // ---- Quem acessou os dados deste titular ----
  app.get('/lgpd/patients/:id/access-log', owner, async (req, reply) => {
    await ensureSchema();
    const p = await find(req, reply);
    if (!p) return;
    await audit(auditCtx(req), 'lgpd.access_log_read', 'patient', p.id);
    return q(`SELECT l.action, l.created_at AS "createdAt", u.name AS "userName", l.ip FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
              WHERE l.clinic_id=$1 AND l.entity_id=$2 ORDER BY l.id DESC LIMIT 200`, [cid(req), p.id]);
  });

  // ---- Anonimização (art. 18, IV e VI): remove a identificação; mantém prontuário, financeiro e trilha (obrigações de guarda) ----
  app.post('/lgpd/patients/:id/anonymize', { ...owner, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    await ensureSchema();
    const b = z.object({ confirmName: z.string(), acknowledge: z.literal(true) }).parse(req.body);
    const p = await find(req, reply);
    if (!p) return;
    if (p.anonymized_at) return reply.code(409).send({ error: 'already anonymized' });
    if (p.legal_hold_at) return reply.code(409).send({ error: 'legal_hold' });
    if (b.confirmName.trim() !== p.full_name.trim()) return reply.code(400).send({ error: 'name mismatch' });
    const clinicId = cid(req);
    const c = await pool.connect();
    let toResync = [];
    try {
      await c.query('BEGIN');
      // bloqueia a linha: duas anonimizações ou uma correção ao mesmo tempo não se atropelam
      const { rows: [cur] } = await c.query('SELECT phone, anonymized_at, legal_hold_at FROM patients WHERE id=$1 AND clinic_id=$2 FOR UPDATE', [p.id, clinicId]);
      if (cur.anonymized_at) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'already anonymized' }); }
      if (cur.legal_hold_at) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'legal_hold' }); }
      const { rows: [{ n }] } = await c.query(`SELECT count(*)::int n FROM appointments WHERE patient_id=$1 AND clinic_id=$2 AND status IN ('scheduled','confirmed') AND ends_at > now()`, [p.id, clinicId]);
      if (n) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'open appointments', count: n }); }
      const phones = phoneVariants(cur.phone);
      await c.query(`UPDATE patients SET full_name=$3, birth_date=NULL, phone=NULL, email=NULL, address=NULL, cpf_enc=NULL, cpf_hash=NULL, notes=NULL,
                       marketing_consent=false, anonymized_at=now() WHERE id=$1 AND clinic_id=$2`, [p.id, clinicId, ANON_NAME]);
      // sem novos contatos: consentimentos revogados, mensagens pendentes canceladas, textos já enviados sem o nome, retornos encerrados
      await c.query(`INSERT INTO contact_consents (clinic_id, patient_id, purpose, granted, recorded_by) SELECT $1,$2,x,false,$3 FROM unnest(ARRAY['return','birthday','marketing']) x`, [clinicId, p.id, req.user.userId]);
      await c.query(`UPDATE message_queue SET body='[removido]', status=CASE WHEN status IN ('pending','sending') THEN 'failed' ELSE status END,
                       error=CASE WHEN status IN ('pending','sending') THEN 'paciente anonimizado' ELSE error END WHERE patient_id=$1 AND clinic_id=$2`, [p.id, clinicId]);
      await c.query(`UPDATE returns SET state='declined', updated_at=now() WHERE patient_id=$1 AND clinic_id=$2 AND state IN ('suggested','remind_later','no_response')`, [p.id, clinicId]);
      if (phones.length) {
        await c.query(`UPDATE wa_messages SET body='[removido]' WHERE clinic_id=$1 AND contact = ANY($2)`, [clinicId, phones]);
        await c.query(`UPDATE wa_contacts SET display_name=NULL WHERE clinic_id=$1 AND contact = ANY($2)`, [clinicId, phones]);
      }
      ({ rows: toResync } = await c.query(`SELECT id FROM appointments WHERE patient_id=$1 AND clinic_id=$2 AND google_event_id IS NOT NULL`, [p.id, clinicId]));
      await c.query(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2,'lgpd.anonymize','patient',$3,$4)`, [clinicId, req.user.userId, p.id, req.ip ?? null]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    // Eventos já enviados ao Google Agenda levavam o nome: reenvia (agora com o nome anonimizado) e ESPERA, para dizer se algum falhou
    // (o cron de sincronização só reenvia agendamentos sem evento, então uma falha aqui não se corrige sozinha).
    const pushed = await Promise.allSettled(toResync.map((a) => pushAppointment(a.id)));
    const googleFailed = pushed.filter((r) => r.status === 'rejected').length;
    if (googleFailed) req.log.error({ failed: googleFailed }, 'google: ressincronizar após anonimizar');
    return { ok: true, anonymizedAt: new Date().toISOString(), googleEventsFailed: googleFailed,
      kept: ['prontuário (conteúdo clínico)', 'lançamentos financeiros', 'rastreabilidade de lotes', 'trilha de auditoria'],
      notCovered: ['cópias de segurança do banco', 'PDFs de comprovante já emitidos', 'conversas internas com a Julia (cifradas; histórico antigo em claro só some com o script de selagem)', 'o número de telefone como identificador do contato no WhatsApp', 'dados já enviados a terceiros (Google, WhatsApp/Meta, Asaas)', ...(googleFailed ? [`${googleFailed} evento(s) do Google Agenda ainda com o nome antigo: edite-os na agenda`] : [])] };
  });
}
