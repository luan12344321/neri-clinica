import { z } from 'zod';
import { q, pool } from './db.js';
import { encrypt } from './crypto.js';
import { ensureSchema } from './schema.js';
import { suggestReturn } from './retornos.js';
import { createTraceabilityDocument } from './rastreabilidade.js';

const guid = z.guid();
const MAX_PHOTO_BYTES = 400 * 1024; // foto da etiqueta já reduzida no cliente (~1280 px, JPEG 0,7)
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const body = z.object({
  confirmed: z.literal(true), // nenhuma baixa de estoque sem confirmação explícita
  applications: z.array(z.object({
    productId: guid,
    lotId: guid.optional().nullable(),
    units: z.number().positive().max(100000),
    labelPhoto: z.string().max(2_000_000).optional().nullable(), // data URL ou base64 de JPEG
  })).max(40),
});

// Erro de regra de negócio: aborta a transação (ROLLBACK) e vira resposta HTTP.
class Rule extends Error { constructor(status, error, extra = {}) { super(error); this.status = status; this.payload = { error, ...extra }; } }

// Valida e decodifica a foto da etiqueta. Devolve a string base64 pura (JPEG) ou null.
function readPhoto(raw) {
  if (!raw) return null;
  const b64 = raw.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Rule(400, 'invalid_photo');
  const bytes = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (bytes > MAX_PHOTO_BYTES) throw new Rule(413, 'photo_too_large');
  if (!b64.startsWith('/9j/')) throw new Rule(400, 'invalid_photo'); // não é JPEG
  return b64;
}

// "Concluir atendimento" em menos de 30 s: contexto (sugestões + lotes) e conclusão transacional com baixa de estoque.
export default async function atendimento(app) {
  const pro = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager', 'professional'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const sees$ = (req) => ['owner', 'manager'].includes(req.user.role);

  app.get('/appointments/:id/conclusion-context', pro, async (req, reply) => {
    await ensureSchema();
    const { id } = z.object({ id: guid }).parse(req.params);
    const [a] = await q(
      `SELECT a.id, a.status, a.price, a.starts_at, a.procedure_id, a.patient_id, p.full_name AS patient, pr.name AS procedure
       FROM appointments a JOIN patients p ON p.id=a.patient_id LEFT JOIN procedures pr ON pr.id=a.procedure_id
       WHERE a.id=$1 AND a.clinic_id=$2`, [id, cid(req)]);
    if (!a) return reply.code(404).send({ error: 'not found' });

    // Produtos com lotes que ainda têm saldo. FEFO: lote não vencido com a validade mais próxima primeiro; vencidos por último e bloqueados.
    const products = await q(
      `SELECT pr.id, pr.name, pr.unit, pr.device_type, pr.units_per_package::float AS units_per_package, pr.quantity::float AS packages,
         COALESCE((SELECT json_agg(json_build_object('id', l.id, 'code', l.lot_code, 'expiresAt', l.expires_at,
              'units', l.quantity_units::float, 'expired', l.expires_at < t.today, 'blocked', l.expires_at < t.today)
              ORDER BY (l.expires_at < t.today), l.expires_at, l.lot_code)
            FROM product_lots l WHERE l.clinic_id=pr.clinic_id AND l.product_id=pr.id AND l.quantity_units > 0), '[]'::json) AS lots
       FROM products pr CROSS JOIN (SELECT (now() AT TIME ZONE timezone)::date AS today FROM clinics WHERE id=$1) t
       WHERE pr.clinic_id=$1 ORDER BY pr.name`, [cid(req)]);

    // SÓ SUGESTÃO pré-preenchida: protocol_items.quantity está em EMBALAGENS (mesma unidade de products.quantity),
    // então units = quantity × units_per_package (ex.: 0,5 frasco de 100 U = 50 U). Nada é baixado sem o POST /conclude confirmado.
    const suggestions = a.procedure_id ? await q(
      `SELECT pi.product_id AS "productId", pr.name AS product, pi.quantity::float AS packages,
              round(pi.quantity * pr.units_per_package, 2)::float AS units
       FROM protocols p JOIN protocol_items pi ON pi.protocol_id=p.id JOIN products pr ON pr.id=pi.product_id AND pr.clinic_id=p.clinic_id
       WHERE p.clinic_id=$1 AND p.procedure_id=$2 ORDER BY pr.name`, [cid(req), a.procedure_id]) : [];

    const [rule] = a.procedure_id ? await q(
      `SELECT target_days AS "targetDays", window_min_days AS "windowMinDays", window_max_days AS "windowMaxDays", message_text AS "messageText"
       FROM procedure_return_rules WHERE clinic_id=$1 AND procedure_id=$2 AND active`, [cid(req), a.procedure_id]) : [];

    return {
      appointment: { id: a.id, status: a.status, startsAt: a.starts_at, ...(sees$(req) ? { price: a.price } : {}) },
      patient: { id: a.patient_id, name: a.patient },
      procedure: a.procedure_id ? { id: a.procedure_id, name: a.procedure } : null,
      suggestions, products, returnRule: rule ?? null,
    };
  });

  app.post('/appointments/:id/conclude', pro, async (req, reply) => {
    await ensureSchema();
    const { id } = z.object({ id: guid }).parse(req.params);
    const b = body.parse(req.body ?? {}); // sem confirmed:true => 400, nada é tocado
    const lines = b.applications.map((l) => ({ ...l, units: round2(l.units) }));
    if (lines.some((l) => !(l.units > 0))) return reply.code(400).send({ error: 'invalid_units' });
    let photos;
    try { photos = lines.map((l) => readPhoto(l.labelPhoto)); }
    catch (e) { if (e instanceof Rule) return reply.code(e.status).send(e.payload); throw e; }

    const userId = req.user.userId, clinicId = cid(req);
    const c = await pool.connect();
    let appt, out = [], suggested = null;
    try {
      await c.query('BEGIN');
      const { rows: [a] } = await c.query(
        `UPDATE appointments SET status='done', completed_at=now(), updated_at=now()
         WHERE id=$1 AND clinic_id=$2 AND status IN ('scheduled','confirmed') RETURNING *`, [id, clinicId]);
      if (!a) {
        const { rowCount } = await c.query('SELECT 1 FROM appointments WHERE id=$1 AND clinic_id=$2', [id, clinicId]);
        throw rowCount ? new Rule(409, 'not completable') : new Rule(404, 'not found'); // outra clínica ou inexistente: 404, sem vazar
      }
      appt = a;
      if (a.price) { // mesma regra do POST /appointments/:id/complete
        await c.query(
          `INSERT INTO transactions (clinic_id,type,category_id,appointment_id,description,amount,competence_date,due_date,status)
           SELECT $1,'income',
                  (SELECT id FROM categories WHERE clinic_id=$1 AND kind='income' AND dre_group='receita_bruta' ORDER BY name LIMIT 1),
                  $2,'Atendimento',$3, d, d, 'pending'
           FROM (SELECT (now() AT TIME ZONE timezone)::date AS d FROM clinics WHERE id=$1) c`,
          [a.clinic_id, a.id, a.price]);
      }
      const { rows: [{ today }] } = await c.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM clinics WHERE id=$1`, [clinicId]);

      for (const [i, l] of lines.entries()) {
        const { rows: [p] } = await c.query('SELECT id, name, units_per_package FROM products WHERE id=$1 AND clinic_id=$2', [l.productId, clinicId]);
        if (!p) throw new Rule(404, 'product_not_found');
        let lot = null;
        if (l.lotId) {
          ({ rows: [lot] } = await c.query(
            `SELECT id, lot_code, expires_at::text AS expires_at FROM product_lots WHERE id=$1 AND clinic_id=$2 AND product_id=$3`,
            [l.lotId, clinicId, p.id]));
          if (!lot) throw new Rule(404, 'lot_not_found');
          if (lot.expires_at < today) throw new Rule(409, 'lot_expired', { lot: lot.lot_code });
          // baixa atômica do lote: só debita se o saldo cobre as unidades (sem condição de corrida)
          const { rowCount } = await c.query(
            `UPDATE product_lots SET quantity_units = quantity_units - $3 WHERE id=$1 AND clinic_id=$2 AND quantity_units >= $3`,
            [lot.id, clinicId, l.units]);
          if (!rowCount) throw new Rule(409, 'insufficient_stock', { lot: lot.lot_code, product: p.name });
        } else {
          // Sem lote o saldo vale o do produto (em embalagens). Sem esta conferência o atendimento fechava consumindo estoque
          // que não existe: o saldo era travado em 0 e o histórico gravava a saída inteira, e os dois deixavam de bater.
          const need = round2(l.units / Number(p.units_per_package));
          const { rowCount } = await c.query(
            'SELECT 1 FROM products WHERE id=$1 AND clinic_id=$2 AND quantity >= $3 FOR UPDATE', [p.id, clinicId, need]);
          if (!rowCount) throw new Rule(409, 'insufficient_stock', { product: p.name });
        }
        // custo da aplicação: custo da embalagem ÷ unidades por embalagem (frasco fracionado rende várias pacientes)
        const { rows: [ap] } = await c.query(
          `INSERT INTO applications (clinic_id, appointment_id, patient_id, product_id, lot_id, units_used, unit_cost, cost, created_by)
           SELECT $1,$2,$3,pr.id,$5,$6,
                  pr.unit_cost / pr.units_per_package,
                  round($6 * pr.unit_cost / pr.units_per_package, 2), $7
           FROM products pr WHERE pr.id=$4 AND pr.clinic_id=$1
           RETURNING id, cost::float AS cost`,
          [clinicId, a.id, a.patient_id, p.id, lot?.id ?? null, l.units, userId]);
        if (photos[i]) {
          await c.query('UPDATE applications SET label_photo_enc=$2 WHERE id=$1', [ap.id, encrypt(photos[i], `applications.label:${ap.id}`)]);
        }
        // products.quantity fica em EMBALAGENS (legado, usado no "repor"); nunca negativo
        const packages = round2(l.units / Number(p.units_per_package));
        await c.query(`UPDATE products SET quantity = GREATEST(0, quantity - $3) WHERE id=$1 AND clinic_id=$2`, [p.id, clinicId, packages]);
        // stock_movements.delta também em EMBALAGENS (coerente com products.quantity); as unidades exatas estão em applications.units_used
        await c.query(
          `INSERT INTO stock_movements (clinic_id, product_id, delta, reason, appointment_id, lot_id, application_id)
           VALUES ($1,$2,$3,'usage',$4,$5,$6)`, [clinicId, p.id, -packages, a.id, lot?.id ?? null, ap.id]);
        await c.query(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2,'application.create','application',$3,$4)`,
          [clinicId, userId, ap.id, req.ip ?? null]);
        out.push({ id: ap.id, product: { id: p.id, name: p.name }, lot: lot ? { id: lot.id, code: lot.lot_code, expiresAt: lot.expires_at } : null,
          units: l.units, cost: ap.cost });
      }

      suggested = await suggestReturn(c, { clinicId, appointmentId: a.id, patientId: a.patient_id, procedureId: a.procedure_id });
      await c.query(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2,'appointment.complete_confirmed','appointment',$3,$4)`,
        [clinicId, userId, a.id, req.ip ?? null]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e instanceof Rule) return reply.code(e.status).send(e.payload);
      throw e;
    } finally { c.release(); }

    // Depois do COMMIT: o comprovante não desfaz a aplicação se falhar.
    let traceability = null;
    try { traceability = (await createTraceabilityDocument({ clinicId, appointmentId: appt.id, userId })) ?? null; }
    catch (e) { req.log.error({ err: { type: e?.name, code: e?.code, message: e?.message } }, 'comprovante nao gerado'); }

    const res = {
      appointment: appt,
      applications: out.map(({ cost, ...r }) => (sees$(req) ? { ...r, cost } : r)),
      returnSuggested: suggested ?? null,
      traceability,
    };
    if (sees$(req)) {
      const totalCost = round2(out.reduce((s, r) => s + (r.cost ?? 0), 0));
      const price = appt.price == null ? 0 : Number(appt.price);
      const value = round2(price - totalCost);
      res.totalCost = totalCost;
      res.missingCost = out.some((r) => r.cost == null); // há produto sem custo cadastrado: o custo total está subestimado
      res.margin = { value, pct: price > 0 ? round2((value / price) * 100) : null };
    }
    return res;
  });
}
