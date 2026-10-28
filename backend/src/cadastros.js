import { z } from 'zod';
import { q, pool } from './db.js';
import { audit, auditCtx } from './audit.js';

const money = z.number().nonnegative();
const id = z.guid();

// Cadastros de apoio. Escrita restrita a owner/manager; leitura para qualquer usuário autenticado.
export default async function cadastros(app) {
  const read = { onRequest: [app.auth] };
  const write = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;

  // ---- Procedimentos ----
  app.get('/procedures', read, (req) => q('SELECT * FROM procedures WHERE clinic_id=$1 AND active ORDER BY name', [cid(req)]));
  app.post('/procedures', write, async (req, reply) => {
    const b = z.object({ name: z.string().min(2), defaultPrice: money, durationMin: z.number().int().positive().default(60) }).parse(req.body);
    const [r] = await q('INSERT INTO procedures (clinic_id,name,default_price,duration_min) VALUES ($1,$2,$3,$4) RETURNING *',
      [cid(req), b.name, b.defaultPrice, b.durationMin]);
    return reply.code(201).send(r);
  });

  // ---- Categorias financeiras ----
  app.get('/categories', write, (req) => q('SELECT * FROM categories WHERE clinic_id=$1 ORDER BY name', [cid(req)]));
  app.post('/categories', write, async (req, reply) => {
    const b = z.object({ name: z.string().min(2), kind: z.enum(['income', 'expense']),
      dreGroup: z.enum(['receita_bruta', 'deducoes', 'custos_variaveis', 'despesas_operacionais', 'despesas_financeiras', 'impostos_lucro']) }).parse(req.body);
    const [r] = await q('INSERT INTO categories (clinic_id,name,kind,dre_group) VALUES ($1,$2,$3,$4) RETURNING *',
      [cid(req), b.name, b.kind, b.dreGroup]);
    return reply.code(201).send(r);
  });

  // ---- Lançamentos (contas a pagar/receber) ----
  app.post('/finance/transactions', write, async (req, reply) => {
    const b = z.object({ type: z.enum(['income', 'expense']), categoryId: id, description: z.string().min(2),
      amount: z.number().positive(), competenceDate: z.string().date(), dueDate: z.string().date(),
      paid: z.boolean().default(false) }).parse(req.body);
    const [r] = await q(
      `INSERT INTO transactions (clinic_id,type,category_id,description,amount,competence_date,due_date,status,paid_at)
       SELECT $1,$2,c.id,$4,$5,$6,$7,$8,CASE WHEN $8='paid' THEN now() END
       FROM categories c WHERE c.id=$3 AND c.clinic_id=$1 RETURNING *`,
      [cid(req), b.type, b.categoryId, b.description, b.amount, b.competenceDate, b.dueDate, b.paid ? 'paid' : 'pending']);
    return r ? reply.code(201).send(r) : reply.code(404).send({ error: 'category not found' });
  });

  // ---- Estoque ----
  // Dono, gerente e recepção cuidam do estoque e da reposição. O CUSTO dos produtos é dado financeiro: só dono/gerente leem ou gravam.
  const sees$ = (req) => ['owner', 'manager'].includes(req.user.role);
  const noCost = (req, row) => { if (sees$(req) || !row) return row; const { unit_cost, ...rest } = row; return rest; };
  app.get('/products', read, async (req) => (await q('SELECT * FROM products WHERE clinic_id=$1 ORDER BY name', [cid(req)])).map((p) => noCost(req, p)));
  app.post('/products', read, async (req, reply) => {
    const b = z.object({ name: z.string().min(2), unit: z.string().default('un'), minQuantity: money, targetQuantity: money,
      unitCost: money.optional(), expiresAt: z.string().date().optional() }).parse(req.body);
    const [r] = await q(`INSERT INTO products (clinic_id,name,unit,min_quantity,target_quantity,unit_cost,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid(req), b.name, b.unit, b.minQuantity, b.targetQuantity, sees$(req) ? (b.unitCost ?? null) : null, b.expiresAt ?? null]);
    await audit(auditCtx(req), 'stock.product_create', 'product', r.id);
    return reply.code(201).send(noCost(req, r));
  });
  // Movimento manual (compra, ajuste, perda). Atualiza saldo e histórico atomicamente.
  app.post('/products/:id/movements', read, async (req, reply) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({ delta: z.number().refine((n) => n !== 0), reason: z.enum(['purchase', 'adjustment', 'loss']) }).parse(req.body);
    const c = await pool.connect();
    let out;
    try {
      await c.query('BEGIN');
      const { rows: [p] } = await c.query(
        `UPDATE products SET quantity = quantity + $3 WHERE id=$1 AND clinic_id=$2 AND quantity + $3 >= 0 RETURNING *`,
        [pid, cid(req), b.delta]);
      if (!p) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'product not found or insufficient stock' }); }
      await c.query('INSERT INTO stock_movements (clinic_id,product_id,delta,reason) VALUES ($1,$2,$3,$4)', [cid(req), pid, b.delta, b.reason]);
      await c.query('COMMIT');
      out = noCost(req, p);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    await audit(auditCtx(req), 'stock.movement', 'product', pid); // só depois de soltar a conexão (o pool pode ter uma só)
    return out;
  });

  // ---- Protocolos ----
  app.post('/protocols', write, async (req, reply) => {
    const b = z.object({ name: z.string().min(2), procedureId: id.optional(), instructions: z.string().min(2),
      items: z.array(z.object({ productId: id, quantity: z.number().positive() })).max(50).default([]) }).parse(req.body);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [p] } = await c.query(
        'INSERT INTO protocols (clinic_id,procedure_id,name,instructions) VALUES ($1,$2,$3,$4) RETURNING *',
        [cid(req), b.procedureId ?? null, b.name, b.instructions]);
      for (const it of b.items) {
        const r = await c.query(
          `INSERT INTO protocol_items (protocol_id,product_id,quantity)
           SELECT $1,id,$3 FROM products WHERE id=$2 AND clinic_id=$4`, [p.id, it.productId, it.quantity, cid(req)]);
        if (!r.rowCount) { await c.query('ROLLBACK'); return reply.code(404).send({ error: 'product not found' }); }
      }
      await c.query('COMMIT');
      return reply.code(201).send(p);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });

  // ---- Automação: templates e regras ----
  app.get('/automation', write, async (req) => ({
    templates: await q('SELECT * FROM message_templates WHERE clinic_id=$1', [cid(req)]),
    followupRules: await q('SELECT * FROM followup_rules WHERE clinic_id=$1', [cid(req)]) }));
  app.post('/automation/templates', write, async (req, reply) => {
    const b = z.object({ kind: z.enum(['birthday', 'followup', 'reminder']), body: z.string().min(5).max(1000) }).parse(req.body);
    const [r] = await q('INSERT INTO message_templates (clinic_id,kind,body) VALUES ($1,$2,$3) RETURNING *', [cid(req), b.kind, b.body]);
    return reply.code(201).send(r);
  });
  app.post('/automation/followup-rules', write, async (req, reply) => {
    const b = z.object({ procedureId: id.optional(), daysAfter: z.number().int().min(0).max(365), templateId: id }).parse(req.body);
    const [r] = await q(
      `INSERT INTO followup_rules (clinic_id,procedure_id,days_after,template_id)
       SELECT $1,$2,$3,t.id FROM message_templates t WHERE t.id=$4 AND t.clinic_id=$1 RETURNING *`,
      [cid(req), b.procedureId ?? null, b.daysAfter, b.templateId]);
    return r ? reply.code(201).send(r) : reply.code(404).send({ error: 'template not found' });
  });

  // ---- Alertas ----
  app.get('/alerts', read, (req) => q('SELECT * FROM alerts WHERE clinic_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50', [cid(req)]));
}
