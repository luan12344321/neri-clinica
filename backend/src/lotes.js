import { z } from 'zod';
import { q, pool } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';

const id = z.guid();

// Lotes de produtos. Todos os perfis autenticados usam (a recepção cuida das entradas de estoque).
// O custo (unit_cost) é dado financeiro: só owner/manager o recebem.
export default async function lotes(app) {
  const read = { onRequest: [app.auth] };
  const cid = (req) => req.user.clinicId;
  const sees$ = (req) => ['owner', 'manager'].includes(req.user.role);
  const noCost = (req, row) => { if (sees$(req) || !row) return row; const { unit_cost, ...rest } = row; return rest; };

  app.get('/products/:id/lots', read, async (req, reply) => {
    await ensureSchema();
    const { id: pid } = z.object({ id }).parse(req.params);
    const [p] = await q('SELECT id FROM products WHERE id=$1 AND clinic_id=$2', [pid, cid(req)]);
    if (!p) return reply.code(404).send({ error: 'product not found' });
    return q('SELECT * FROM product_lots WHERE clinic_id=$1 AND product_id=$2 ORDER BY expires_at, lot_code', [cid(req), pid]);
  });

  app.post('/products/:id/lots', read, async (req, reply) => {
    await ensureSchema();
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({
      lotCode: z.string().trim().min(1).max(60),
      expiresAt: z.string().date(),
      packages: z.number().positive().max(100000),
      manufacturer: z.string().trim().min(1).max(120).optional(),
    }).parse(req.body);

    const c = await pool.connect();
    let lot, product;
    try {
      await c.query('BEGIN');
      const { rows: [p] } = await c.query('SELECT * FROM products WHERE id=$1 AND clinic_id=$2 FOR UPDATE', [pid, cid(req)]);
      if (!p) { await c.query('ROLLBACK'); return reply.code(404).send({ error: 'product not found' }); }
      const units = Number(b.packages) * Number(p.units_per_package);
      const { rows: [l] } = await c.query(
        `INSERT INTO product_lots (clinic_id,product_id,lot_code,expires_at,manufacturer,quantity_units,initial_units)
         VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (clinic_id, product_id, lot_code) DO NOTHING RETURNING *`,
        [cid(req), pid, b.lotCode, b.expiresAt, b.manufacturer ?? p.manufacturer ?? null, units]);
      if (!l) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'lot already exists' }); }
      const { rows: [up] } = await c.query('UPDATE products SET quantity = quantity + $3 WHERE id=$1 AND clinic_id=$2 RETURNING *',
        [pid, cid(req), b.packages]);
      await c.query(`INSERT INTO stock_movements (clinic_id,product_id,delta,reason,lot_id) VALUES ($1,$2,$3,'purchase',$4)`,
        [cid(req), pid, b.packages, l.id]);
      await c.query('COMMIT');
      lot = l; product = up;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await audit(auditCtx(req), 'stock.lot_create', 'product_lot', lot.id); // só depois de soltar a conexão (o pool pode ter uma só)
    return reply.code(201).send({ lot, product: noCost(req, product) });
  });
}
