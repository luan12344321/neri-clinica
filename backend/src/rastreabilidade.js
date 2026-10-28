import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { decrypt, encrypt } from './crypto.js';

// Comprovante de rastreabilidade (produtos injetáveis rastreáveis). Dado de saúde (LGPD): o PDF é gerado em memória,
// cifrado inteiro em repouso (AAD amarrado ao id) e só sai por rota autenticada, sem link público nem token na URL.
const CLINICAL = ['owner', 'manager', 'professional'];
const TRACEABLE = ['hyaluronic_acid', 'plla', 'pmma', 'calcium_hydroxylapatite'];
const TYPE_LABEL = {
  hyaluronic_acid: 'Ácido hialurônico', plla: 'Ácido poli-L-láctico (PLLA)',
  pmma: 'PMMA', calcium_hydroxylapatite: 'Hidroxiapatita de cálcio',
};
const aad = (id) => `traceability.pdf:${id}`;
const GREEN = '#2f5d46';
const INK = '#2b2b26';
const MUTED = '#6f6a5c';
const LINE = '#d9d0bb';

const fmtDate = (v) => {
  const s = String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  const [y, m, d] = s.split('-');
  return y && m && d ? `${d}/${m}/${y}` : s;
};
const fmtUnits = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function renderPdf({ docId, clinicName, patientName, professionalName, startsAt, procedureName, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 50, compress: process.env.NODE_ENV !== 'test',
      info: { Title: 'Comprovante de rastreabilidade', Producer: 'Neri Clínica' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 100;
    doc.font('Helvetica-Bold').fontSize(20).fillColor(GREEN).text(clinicName, 50, 50, { width: W });
    doc.moveDown(0.3).font('Helvetica').fontSize(15).fillColor(INK).text('Comprovante de rastreabilidade');
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.8);

    const field = (label, value) => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label.toUpperCase(), 50, doc.y, { width: W });
      doc.font('Helvetica').fontSize(12).fillColor(INK).text(value || '—', { width: W });
      doc.moveDown(0.5);
    };
    field('Paciente', patientName);
    field('Profissional', professionalName);
    field('Data do atendimento', new Date(startsAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    field('Procedimento', procedureName);

    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor(GREEN).text('Produtos aplicados', 50, doc.y);
    doc.moveDown(0.4);
    for (const it of items) {
      const top = doc.y;
      doc.rect(50, top, W, 78).strokeColor(LINE).lineWidth(0.8).stroke();
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(it.name, 60, top + 8, { width: W - 20 });
      doc.font('Helvetica').fontSize(10).fillColor(MUTED)
        .text(`Tipo: ${TYPE_LABEL[it.device_type] ?? it.device_type}   |   Fabricante: ${it.manufacturer || '—'}`, 60, top + 26, { width: W - 20 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
        .text(`Lote: ${it.lot_code ?? '—'}`, 60, top + 44, { width: W / 2 - 10, continued: false });
      doc.font('Helvetica').fontSize(11).fillColor(INK)
        .text(`Validade: ${it.expires_at ? fmtDate(it.expires_at) : '—'}`, 60 + W / 2 - 10, top + 44, { width: W / 2 - 10 });
      doc.font('Helvetica').fontSize(10).fillColor(MUTED)
        .text(`Unidades aplicadas: ${fmtUnits(it.units)}`, 60, top + 60, { width: W - 20 });
      doc.y = top + 78 + 10;
    }

    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`Documento ${docId}. Emitido por ${clinicName}. Guarde este comprovante com seus registros de saúde.`, 50, 770, { width: W, align: 'center' });
    doc.end();
  });
}

// Chamada DEPOIS do commit do atendimento. Devolve { id } (existente ou novo) ou null sem produto rastreável.
export async function createTraceabilityDocument({ clinicId, appointmentId, userId }) {
  const items = await q(
    `SELECT pr.name, pr.device_type, COALESCE(l.manufacturer, pr.manufacturer) AS manufacturer,
            l.lot_code, l.expires_at::text AS expires_at, a.units_used AS units
       FROM applications a
       JOIN products pr ON pr.id = a.product_id AND pr.clinic_id = a.clinic_id
       LEFT JOIN product_lots l ON l.id = a.lot_id AND l.clinic_id = a.clinic_id
      WHERE a.clinic_id=$1 AND a.appointment_id=$2 AND pr.device_type = ANY($3)
      ORDER BY a.created_at, a.id`, [clinicId, appointmentId, TRACEABLE]);
  if (!items.length) return null;

  const [existing] = await q(
    `SELECT id FROM traceability_documents WHERE clinic_id=$1 AND appointment_id=$2 ORDER BY created_at LIMIT 1`,
    [clinicId, appointmentId]);
  if (existing) return { id: existing.id };

  const [ctx] = await q(
    `SELECT c.name AS clinic_name, pa.id AS patient_id, pa.full_name AS patient_name, ap.starts_at,
            pc.name AS procedure_name, COALESCE(u.name, pu.name) AS professional_name
       FROM appointments ap
       JOIN clinics c ON c.id = ap.clinic_id
       JOIN patients pa ON pa.id = ap.patient_id
       LEFT JOIN procedures pc ON pc.id = ap.procedure_id
       LEFT JOIN users u ON u.id = $3 AND u.clinic_id = ap.clinic_id
       LEFT JOIN users pu ON pu.id = ap.professional_id
      WHERE ap.id=$2 AND ap.clinic_id=$1`, [clinicId, appointmentId, userId ?? null]);
  if (!ctx) return null;

  const id = randomUUID(); // antes de cifrar: entra no AAD
  const pdf = await renderPdf({
    docId: id, clinicName: ctx.clinic_name, patientName: ctx.patient_name, professionalName: ctx.professional_name,
    startsAt: ctx.starts_at, procedureName: ctx.procedure_name, items,
  });
  await q(
    `INSERT INTO traceability_documents (id, clinic_id, appointment_id, patient_id, pdf_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, clinicId, appointmentId, ctx.patient_id, encrypt(pdf.toString('base64'), aad(id)), userId ?? null]);
  await audit({ clinicId, userId: userId ?? null, ip: null }, 'traceability.generate', 'traceability', id);
  return { id };
}

export default async function rastreabilidade(app) {
  const clinical = { onRequest: [app.auth, async (req, reply) => {
    if (!CLINICAL.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const idParam = (req) => z.object({ id: z.guid() }).parse(req.params).id;
  const list = (where, id, clinicId) => q(
    `SELECT id, created_at FROM traceability_documents WHERE clinic_id=$1 AND ${where}=$2 ORDER BY created_at DESC`,
    [clinicId, id]);

  app.get('/appointments/:id/traceability', clinical, async (req, reply) => {
    const id = idParam(req);
    const [ap] = await q('SELECT 1 FROM appointments WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!ap) return reply.code(404).send({ error: 'not found' });
    return list('appointment_id', id, cid(req));
  });

  app.get('/patients/:id/traceability', clinical, async (req, reply) => {
    const id = idParam(req);
    const [p] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!p) return reply.code(404).send({ error: 'not found' });
    return list('patient_id', id, cid(req));
  });

  app.post('/appointments/:id/traceability', clinical, async (req, reply) => {
    const id = idParam(req);
    const [ap] = await q('SELECT 1 FROM appointments WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!ap) return reply.code(404).send({ error: 'not found' });
    const r = await createTraceabilityDocument({ clinicId: cid(req), appointmentId: id, userId: req.user.userId });
    if (!r) return reply.code(404).send({ error: 'Nenhum produto rastreável aplicado neste atendimento' });
    return reply.code(201).send(r);
  });

  app.get('/traceability/:id/pdf', { ...clinical, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idParam(req);
    const [row] = await q('SELECT pdf_enc FROM traceability_documents WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const pdf = Buffer.from(decrypt(row.pdf_enc, aad(id)), 'base64');
    await audit(auditCtx(req), 'traceability.read', 'traceability', id);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="comprovante-rastreabilidade.pdf"')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(pdf);
  });
}
