import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { blindIndex, decrypt, encrypt, normalizeCpf } from './crypto.js';
import { normalizePhone } from './fila.js';

// Dados sensíveis (LGPD art. 5º, II): CPF e prontuário. Só perfis clínicos leem; toda leitura/escrita é auditada.
const CLINICAL = ['owner', 'manager', 'professional'];
const cpfAad = (id) => `patients.cpf:${id}`;
const recordAad = (id) => `medical_records.data:${id}`;
const cpfSchema = z.string().transform((v, ctx) => {
  const d = normalizeCpf(v);
  if (!d) ctx.addIssue({ code: 'custom', message: 'CPF inválido' });
  return d;
});

export default async function prontuario(app) {
  const base = { onRequest: [app.auth] };
  const clinical = { onRequest: [app.auth, async (req, reply) => {
    if (!CLINICAL.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const dupCpf = (e) => e.code === '23505'; // violação de unicidade (clinic_id, cpf_hash)

  app.post('/patients', base, async (req, reply) => {
    const b = z.object({ fullName: z.string().min(2), birthDate: z.string().date().optional(),
      // telefone que não vira número de WhatsApp seria salvo e o paciente nunca receberia o retorno
      phone: z.string().optional().refine((v) => !v || normalizePhone(v), 'Telefone inválido'), email: z.string().email().optional(), cpf: cpfSchema.optional(),
      marketingConsent: z.boolean().default(false) }).parse(req.body);
    const id = randomUUID(); // gerado aqui para poder amarrar o CPF cifrado a este id
    try {
      const [row] = await q(
        `INSERT INTO patients (id,clinic_id,full_name,birth_date,phone,email,marketing_consent,cpf_enc,cpf_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (clinic_id, cpf_hash) WHERE cpf_hash IS NOT NULL DO NOTHING
         RETURNING id, full_name`,
        [id, cid(req), b.fullName, b.birthDate ?? null, b.phone ?? null, b.email ?? null, b.marketingConsent,
         b.cpf ? encrypt(b.cpf, cpfAad(id)) : null, b.cpf ? blindIndex(`cpf:${cid(req)}`, b.cpf) : null]);
      if (!row) return reply.code(409).send({ error: 'CPF já cadastrado nesta clínica' });
      await audit(auditCtx(req), 'patient.create', 'patient', id);
      return reply.code(201).send(row);
    } catch (e) {
      if (dupCpf(e)) return reply.code(409).send({ error: 'CPF já cadastrado nesta clínica' }); // corrida entre duas requisições
      throw e;
    }
  });

  app.put('/patients/:id/cpf', base, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const { cpf } = z.object({ cpf: cpfSchema }).parse(req.body);
    try {
      const hash = blindIndex(`cpf:${cid(req)}`, cpf);
      const rows = await q(
        `UPDATE patients SET cpf_enc=$3, cpf_hash=$4 WHERE id=$1 AND clinic_id=$2
           AND NOT EXISTS (SELECT 1 FROM patients o WHERE o.clinic_id=$2 AND o.cpf_hash=$4 AND o.id<>$1)
         RETURNING id`, [id, cid(req), encrypt(cpf, cpfAad(id)), hash]);
      if (!rows.length) {
        const [exists] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
        return exists ? reply.code(409).send({ error: 'CPF já cadastrado nesta clínica' }) : reply.code(404).send({ error: 'not found' });
      }
      await audit(auditCtx(req), 'patient.cpf_update', 'patient', id);
      return { ok: true };
    } catch (e) {
      if (dupCpf(e)) return reply.code(409).send({ error: 'CPF já cadastrado nesta clínica' });
      throw e;
    }
  });

  // Ficha do paciente com CPF em claro: acesso clínico + auditado.
  app.get('/patients/:id', clinical, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const [p] = await q(`SELECT id, full_name, birth_date, phone, email, marketing_consent, notes, cpf_enc
                         FROM patients WHERE id=$1 AND clinic_id=$2`, [id, cid(req)]);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const cpf = p.cpf_enc ? decrypt(p.cpf_enc, cpfAad(id)) : null;
    await audit(auditCtx(req), 'patient.read', 'patient', id);
    const { cpf_enc, ...rest } = p;
    return { ...rest, cpf };
  });

  // ---- Prontuário: o conteúdo clínico inteiro fica em uma única coluna cifrada ----
  app.post('/patients/:id/records', clinical, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const b = z.object({ allergies: z.string().max(5000).optional(), evolution: z.string().max(20000).optional(),
      anamnesis: z.record(z.string(), z.string().max(5000)).optional() })
      .refine((v) => v.allergies || v.evolution || (v.anamnesis && Object.keys(v.anamnesis).length), 'registro vazio')
      .parse(req.body);
    const [ok] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    const recordId = randomUUID();
    await q(`INSERT INTO medical_records (id, clinic_id, patient_id, author_id, data_enc) VALUES ($1,$2,$3,$4,$5)`,
      [recordId, cid(req), id, req.user.userId, encrypt(JSON.stringify(b), recordAad(recordId))]);
    await audit(auditCtx(req), 'record.create', 'medical_record', recordId);
    return reply.code(201).send({ id: recordId });
  });

  app.get('/patients/:id/records', clinical, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const [ok] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    const rows = await q(
      `SELECT r.id, r.data_enc, r.created_at, u.name AS author FROM medical_records r
       LEFT JOIN users u ON u.id=r.author_id
       WHERE r.patient_id=$1 AND r.clinic_id=$2 ORDER BY r.created_at DESC LIMIT 100`, [id, cid(req)]);
    const records = rows.map((r) => ({ id: r.id, author: r.author, createdAt: r.created_at,
      ...JSON.parse(decrypt(r.data_enc, recordAad(r.id))) }));
    await audit(auditCtx(req), 'record.read', 'patient', id);
    return records;
  });

  // Vezes em que a Julia (IA) consultou o prontuário deste paciente. Só perfis clínicos; recepção não vê.
  app.get('/patients/:id/ai-usage', clinical, async (req, reply) => {
    const p = z.object({ id: z.guid() }).safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not found' });
    const [ok] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [p.data.id, cid(req)]);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await ensureSchema();
    const rows = await q(
      `SELECT u.tool, us.name AS user_name, u.created_at FROM ai_record_usage u LEFT JOIN users us ON us.id=u.user_id
       WHERE u.clinic_id=$1 AND u.patient_id=$2 ORDER BY u.created_at DESC, u.id DESC LIMIT 50`, [cid(req), p.data.id]);
    return rows.map((r) => ({ tool: r.tool, userName: r.user_name, createdAt: r.created_at }));
  });

  // Quem acessou o quê: apenas o dono da clínica.
  app.get('/audit', { onRequest: [app.auth, async (req, reply) => {
    if (req.user.role !== 'owner') reply.code(403).send({ error: 'forbidden' });
  }] }, (req) => q(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.ip, u.name AS user_name
     FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.clinic_id=$1 ORDER BY a.id DESC LIMIT 200`, [cid(req)]));
}
