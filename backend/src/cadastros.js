import { z } from 'zod';
import { q, pool } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { unknownVars, VARS } from './avisos.js';

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
  // Nome repetido deixava a lista ambígua ("Limpeza de pele" duas vezes, preços diferentes): barra, sem diferenciar maiúsculas.
  const nameTaken = async (clinicId, name, exceptId = null) =>
    (await q(`SELECT 1 FROM procedures WHERE clinic_id=$1 AND active AND lower(btrim(name))=lower(btrim($2)) AND ($3::uuid IS NULL OR id<>$3) LIMIT 1`,
      [clinicId, name, exceptId])).length > 0;
  app.post('/procedures', write, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), defaultPrice: money, durationMin: z.number().int().positive().default(60) }).parse(req.body);
    if (await nameTaken(cid(req), b.name)) return reply.code(409).send({ error: 'Já existe um procedimento com este nome.' });
    const [r] = await q('INSERT INTO procedures (clinic_id,name,default_price,duration_min) VALUES ($1,$2,$3,$4) RETURNING *',
      [cid(req), b.name, b.defaultPrice, b.durationMin]);
    return reply.code(201).send(r);
  });
  // Corrige nome, preço, duração ou desativa (sai das listas; atendimentos antigos mantêm o procedimento e o preço gravado).
  app.patch('/procedures/:id', write, async (req, reply) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), defaultPrice: money.optional(),
      durationMin: z.number().int().positive().optional(), active: z.boolean().optional() })
      .refine((v) => Object.keys(v).length > 0, 'nada para alterar').parse(req.body);
    if (b.name && await nameTaken(cid(req), b.name, pid)) return reply.code(409).send({ error: 'Já existe um procedimento com este nome.' });
    const [r] = await q(`UPDATE procedures SET name=COALESCE($3,name), default_price=COALESCE($4,default_price),
                           duration_min=COALESCE($5,duration_min), active=COALESCE($6,active)
                         WHERE id=$1 AND clinic_id=$2 RETURNING *`, [pid, cid(req), b.name ?? null, b.defaultPrice ?? null, b.durationMin ?? null, b.active ?? null]);
    if (!r) return reply.code(404).send({ error: 'not found' });
    await audit(auditCtx(req), 'procedure.update', 'procedure', pid);
    return r;
  });

  // ---- Categorias financeiras ----
  app.get('/categories', write, (req) => q('SELECT * FROM categories WHERE clinic_id=$1 ORDER BY name', [cid(req)]));
  app.post('/categories', write, async (req, reply) => {
    const b = z.object({ name: z.string().min(2).max(120), kind: z.enum(['income', 'expense']),
      dreGroup: z.enum(['receita_bruta', 'deducoes', 'custos_variaveis', 'despesas_operacionais', 'despesas_financeiras', 'impostos_lucro']) }).parse(req.body);
    const [r] = await q('INSERT INTO categories (clinic_id,name,kind,dre_group) VALUES ($1,$2,$3,$4) RETURNING *',
      [cid(req), b.name, b.kind, b.dreGroup]);
    return reply.code(201).send(r);
  });

  // ---- Lançamentos (contas a pagar/receber) ----
  app.post('/finance/transactions', write, async (req, reply) => {
    const b = z.object({ type: z.enum(['income', 'expense']), categoryId: id, description: z.string().min(2).max(500),
      amount: z.number().positive(), competenceDate: z.string().date(), dueDate: z.string().date(),
      paid: z.boolean().default(false), bankAccountId: id.optional() }).parse(req.body);
    // Lançamento já pago entra na conta escolhida (ou na padrão), como na baixa: sem isso o valor ficava fora de todos os saldos.
    let bankId = null;
    if (b.paid) {
      const [acct] = await q(`SELECT id FROM bank_accounts WHERE clinic_id=$1 AND active AND ($2::uuid IS NULL OR id=$2)
                              ORDER BY is_default DESC, created_at LIMIT 1`, [cid(req), b.bankAccountId ?? null]);
      if (b.bankAccountId && !acct) return reply.code(404).send({ error: 'bank account not found' });
      bankId = acct?.id ?? null;
    }
    const [r] = await q(
      `INSERT INTO transactions (clinic_id,type,category_id,description,amount,competence_date,due_date,status,paid_at,bank_account_id)
       SELECT $1,$2,c.id,$4,$5,$6,$7,$8,CASE WHEN $8='paid' THEN now() END,$9::uuid
       FROM categories c WHERE c.id=$3 AND c.clinic_id=$1 RETURNING *`,
      [cid(req), b.type, b.categoryId, b.description, b.amount, b.competenceDate, b.dueDate, b.paid ? 'paid' : 'pending', bankId]);
    return r ? reply.code(201).send(r) : reply.code(404).send({ error: 'category not found' });
  });
  // Corrige um lançamento ainda pendente. O que já foi pago não se edita (o saldo da conta depende dele).
  app.patch('/finance/transactions/:id', write, async (req, reply) => {
    const { id: tid } = z.object({ id }).parse(req.params);
    const b = z.object({ description: z.string().trim().min(2).max(500).optional(), amount: z.number().positive().optional(),
      dueDate: z.string().date().optional(), competenceDate: z.string().date().optional() })
      .refine((v) => Object.keys(v).length > 0, 'nada para alterar').parse(req.body);
    const [r] = await q(`UPDATE transactions SET description=COALESCE($3,description), amount=COALESCE($4,amount),
                           due_date=COALESCE($5,due_date), competence_date=COALESCE($6,competence_date)
                         WHERE id=$1 AND clinic_id=$2 AND status='pending' RETURNING *`,
      [tid, cid(req), b.description ?? null, b.amount ?? null, b.dueDate ?? null, b.competenceDate ?? null]);
    if (!r) return reply.code(404).send({ error: 'not found or already paid' });
    await audit(auditCtx(req), 'finance.update', 'transaction', tid);
    return r;
  });
  // Cancela um lançamento pendente (fica no histórico como cancelado e some dos totais). Pago não cancela: precisa de estorno.
  app.delete('/finance/transactions/:id', write, async (req, reply) => {
    const { id: tid } = z.object({ id }).parse(req.params);
    const [r] = await q(`UPDATE transactions SET status='canceled' WHERE id=$1 AND clinic_id=$2 AND status='pending' RETURNING id`, [tid, cid(req)]);
    if (!r) return reply.code(404).send({ error: 'not found or already paid' });
    await audit(auditCtx(req), 'finance.cancel', 'transaction', tid);
    return reply.code(204).send();
  });

  // ---- Estoque ----
  // Dono, gerente e recepção cuidam do estoque e da reposição. O CUSTO dos produtos é dado financeiro: só dono/gerente leem ou gravam.
  const sees$ = (req) => ['owner', 'manager'].includes(req.user.role);
  const noCost = (req, row) => { if (sees$(req) || !row) return row; const { unit_cost, ...rest } = row; return rest; };
  app.get('/products', read, async (req) => (await ensureSchema(), await q('SELECT * FROM products WHERE clinic_id=$1 ORDER BY name', [cid(req)])).map((p) => noCost(req, p)));
  app.post('/products', read, async (req, reply) => {
    const b = z.object({ name: z.string().min(2).max(120), unit: z.string().max(20).default('un'), minQuantity: money, targetQuantity: money,
      unitCost: money.optional(), expiresAt: z.string().date().optional(),
      category: z.string().trim().min(1).max(80).optional(), manufacturer: z.string().trim().min(1).max(120).optional(),
      deviceType: z.enum(['toxin', 'hyaluronic_acid', 'plla', 'pmma', 'calcium_hydroxylapatite', 'other']).default('other'),
      unitsPerPackage: z.number().positive().default(1), quantity: money.default(0) }).parse(req.body);
    await ensureSchema();
    // Nome repetido confunde a reposição e o consumo (dois "Luvas M"): barra, sem diferenciar maiúsculas.
    const [dup] = await q('SELECT 1 FROM products WHERE clinic_id=$1 AND lower(btrim(name))=lower(btrim($2)) LIMIT 1', [cid(req), b.name]);
    if (dup) return reply.code(409).send({ error: 'Já existe um produto com este nome.' });
    const [r] = await q(`INSERT INTO products (clinic_id,name,unit,min_quantity,target_quantity,unit_cost,expires_at,category,manufacturer,device_type,units_per_package,quantity)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [cid(req), b.name, b.unit, b.minQuantity, b.targetQuantity, sees$(req) ? (b.unitCost ?? null) : null, b.expiresAt ?? null,
        b.category ?? null, b.manufacturer ?? null, b.deviceType, b.unitsPerPackage, b.quantity]);
    // O saldo inicial entra no histórico como compra, para o histórico fechar com o saldo.
    if (b.quantity > 0) await q('INSERT INTO stock_movements (clinic_id,product_id,delta,reason) VALUES ($1,$2,$3,$4)', [cid(req), r.id, b.quantity, 'purchase']);
    await audit(auditCtx(req), 'stock.product_create', 'product', r.id);
    return reply.code(201).send(noCost(req, r));
  });
  // Corrige os dados do produto (o saldo só muda por movimento, para o histórico continuar fechando).
  app.patch('/products/:id', read, async (req, reply) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), unit: z.string().max(20).optional(),
      minQuantity: money.optional(), targetQuantity: money.optional(), unitCost: money.nullable().optional(),
      category: z.string().trim().min(1).max(80).nullable().optional(), manufacturer: z.string().trim().min(1).max(120).nullable().optional(),
      expiresAt: z.string().date().nullable().optional() }).refine((v) => Object.keys(v).length > 0, 'nada para alterar').parse(req.body);
    if ('unitCost' in b && !sees$(req)) return reply.code(403).send({ error: 'forbidden' }); // custo é dado financeiro
    if (b.name) {
      const [dup] = await q('SELECT 1 FROM products WHERE clinic_id=$1 AND id<>$3 AND lower(btrim(name))=lower(btrim($2)) LIMIT 1', [cid(req), b.name, pid]);
      if (dup) return reply.code(409).send({ error: 'Já existe um produto com este nome.' });
    }
    const has = (k) => k in b; // permite limpar um campo (null) sem confundir com "não enviado"
    const [r] = await q(`UPDATE products SET name=COALESCE($3,name), unit=COALESCE($4,unit), min_quantity=COALESCE($5,min_quantity),
        target_quantity=COALESCE($6,target_quantity), unit_cost=CASE WHEN $7 THEN $8 ELSE unit_cost END,
        category=CASE WHEN $9 THEN $10 ELSE category END, manufacturer=CASE WHEN $11 THEN $12 ELSE manufacturer END,
        expires_at=CASE WHEN $13 THEN $14::date ELSE expires_at END
      WHERE id=$1 AND clinic_id=$2 RETURNING *`,
      [pid, cid(req), b.name ?? null, b.unit ?? null, b.minQuantity ?? null, b.targetQuantity ?? null,
        has('unitCost'), b.unitCost ?? null, has('category'), b.category ?? null, has('manufacturer'), b.manufacturer ?? null, has('expiresAt'), b.expiresAt ?? null]);
    if (!r) return reply.code(404).send({ error: 'not found' });
    await audit(auditCtx(req), 'stock.product_update', 'product', pid);
    return noCost(req, r);
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
    const b = z.object({ name: z.string().min(2).max(120), procedureId: id.optional(), instructions: z.string().min(2).max(5000),
      items: z.array(z.object({ productId: id, quantity: z.number().positive() })).max(50).default([]) }).parse(req.body);
    if (b.procedureId && !(await q('SELECT 1 FROM procedures WHERE id=$1 AND clinic_id=$2', [b.procedureId, cid(req)])).length) {
      return reply.code(404).send({ error: 'procedure not found' });
    }
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
    // Variável que não existe sairia em branco na mensagem do paciente ("Olá , seu  é dia "): recusa ao salvar.
    const bad = unknownVars(b.body)[0];
    if (bad) return reply.code(400).send({ error: `Variável {{${bad}}} não existe. Use apenas: ${VARS.map((v) => `{{${v}}}`).join(', ')}.` });
    const [r] = await q('INSERT INTO message_templates (clinic_id,kind,body) VALUES ($1,$2,$3) RETURNING *', [cid(req), b.kind, b.body]);
    return reply.code(201).send(r);
  });
  app.post('/automation/followup-rules', write, async (req, reply) => {
    const b = z.object({ procedureId: id.optional(), daysAfter: z.number().int().min(0).max(365), templateId: id }).parse(req.body);
    const [r] = await q(
      `INSERT INTO followup_rules (clinic_id,procedure_id,days_after,template_id)
       SELECT $1,$2,$3,t.id FROM message_templates t WHERE t.id=$4 AND t.clinic_id=$1
         AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM procedures WHERE id=$2 AND clinic_id=$1)) RETURNING *`,
      [cid(req), b.procedureId ?? null, b.daysAfter, b.templateId]);
    return r ? reply.code(201).send(r) : reply.code(404).send({ error: 'template or procedure not found' });
  });

  // ---- Alertas ----
  app.get('/alerts', read, (req) => q('SELECT * FROM alerts WHERE clinic_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50', [cid(req)]));
}
