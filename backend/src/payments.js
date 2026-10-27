import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { q, pool } from './db.js';
import { decrypt } from './crypto.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { AsaasError, asaas, asaasConfigured, asaasSandbox } from './asaas.js';

// Cobrança Pix com confirmação automática pelo Asaas. O vínculo com a conta a receber é transactions.external_id = 'asaas:<id>'.
// O dinheiro cai na conta digital do Asaas, que aparece em Bancos como uma conta de pagamento (provider = 'asaas').
const ref = (paymentId) => `asaas:${paymentId}`;
const round2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

async function asaasBank(clinicId) {
  await q(`INSERT INTO bank_accounts (id, clinic_id, name, institution, kind, provider)
           SELECT $1, $2, 'Asaas (conta digital)', 'Asaas', 'payment', 'asaas'
           WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE clinic_id=$2 AND provider='asaas')`, [randomUUID(), clinicId]);
  return (await q(`SELECT id FROM bank_accounts WHERE clinic_id=$1 AND provider='asaas' ORDER BY created_at LIMIT 1`, [clinicId]))[0].id;
}

export default async function payments(app) {
  const manager = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const providerFailure = (req, reply, e) => {
    if (!(e instanceof AsaasError)) throw e;
    req.log.error(e);
    return reply.code(502).send({ error: 'provider_error', detail: e.detail }); // detail: texto do Asaas, sem segredos
  };

  app.get('/integrations', manager, async () => ({ asaas: { configured: asaasConfigured(), sandbox: asaasSandbox() } }));

  // Confere chave e conexão (botão "Testar" nas configurações).
  app.post('/integrations/asaas/test', { ...manager, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!asaasConfigured()) return reply.code(503).send({ error: 'not configured' });
    try { const b = await asaas.balance(); return { ok: true, sandbox: asaasSandbox(), balance: b.balance }; }
    catch (e) { return providerFailure(req, reply, e); }
  });

  // Cria (ou reaproveita) a cobrança Pix da conta a receber e devolve o "copia e cola".
  app.post('/finance/transactions/:id/charge', { ...manager, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!asaasConfigured()) return reply.code(503).send({ error: 'not configured' });
    await ensureSchema();
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const [t] = await q(`SELECT t.id, t.amount::float AS amount, to_char(t.due_date,'YYYY-MM-DD') AS due, t.description, t.external_id, a.patient_id
                         FROM transactions t LEFT JOIN appointments a ON a.id=t.appointment_id
                         WHERE t.id=$1 AND t.clinic_id=$2 AND t.type='income' AND t.status='pending'`, [id, cid(req)]);
    if (!t) return reply.code(404).send({ error: 'not found' });
    try {
      let paymentId = t.external_id?.startsWith('asaas:') ? t.external_id.slice(6) : null;
      if (!paymentId) {
        if (!t.patient_id) return reply.code(409).send({ error: 'no patient' });
        const [p] = await q('SELECT id, full_name, cpf_enc FROM patients WHERE id=$1 AND clinic_id=$2', [t.patient_id, cid(req)]);
        if (!p?.cpf_enc) return reply.code(409).send({ error: 'patient cpf required' });
        let customer = await asaas.findCustomer(p.id);
        if (!customer) {
          // O Asaas exige CPF/CNPJ de quem paga: é o único dado pessoal enviado (além do nome). Fica registrado na auditoria.
          customer = await asaas.createCustomer({ name: p.full_name, cpfCnpj: decrypt(p.cpf_enc, `patients.cpf:${p.id}`), externalReference: p.id, notificationDisabled: true });
          await audit(auditCtx(req), 'asaas.customer_created', 'patient', p.id);
        }
        const today = new Date().toISOString().slice(0, 10);
        const pay = await asaas.createPayment({ customer: customer.id, billingType: 'PIX', value: t.amount, dueDate: t.due < today ? today : t.due,
          description: t.description.slice(0, 500), externalReference: t.id });
        const [won] = await q('UPDATE transactions SET external_id=$3 WHERE id=$1 AND clinic_id=$2 AND external_id IS NULL RETURNING id', [t.id, cid(req), ref(pay.id)]);
        if (won) paymentId = pay.id;
        else { // outra requisição criou antes: descarta esta cobrança e usa a já gravada
          await asaas.deletePayment(pay.id).catch((e) => req.log.warn(e));
          paymentId = (await q('SELECT external_id FROM transactions WHERE id=$1', [t.id]))[0].external_id.slice(6);
        }
      }
      const qr = await asaas.pixQrCode(paymentId);
      await asaasBank(cid(req));
      await audit(auditCtx(req), 'payment.charge', 'transaction', t.id);
      return { provider: 'asaas', payload: qr.payload, expiresAt: qr.expirationDate ?? null, amount: t.amount };
    } catch (e) { return providerFailure(req, reply, e); }
  });

  // A tela consulta enquanto o Pix está aberto, para mostrar "recebido" assim que o aviso do Asaas chegar.
  app.get('/finance/transactions/:id/status', manager, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const [t] = await q('SELECT status, paid_at AS "paidAt" FROM transactions WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    return t ?? reply.code(404).send({ error: 'not found' });
  });

  // Aviso do Asaas (webhook). Sem login: a autenticação é o segredo no cabeçalho. Responde 200 também para o que ignora,
  // porque 15 falhas seguidas pausam a fila do Asaas. É idempotente: o mesmo aviso repetido não dá baixa nem registra tarifa duas vezes.
  app.post('/webhooks/asaas', { config: { rateLimit: false } }, async (req, reply) => {
    const expected = process.env.ASAAS_WEBHOOK_TOKEN, got = req.headers['asaas-access-token'];
    if (!expected || !got || !same(got, expected)) return reply.code(401).send({ error: 'unauthorized' });
    const { event, payment } = z.object({ event: z.string(), payment: z.object({ id: z.string(), value: z.number().optional(), netValue: z.number().optional() }).passthrough().optional() })
      .passthrough().parse(req.body);
    if (event !== 'PAYMENT_RECEIVED' || !payment) return { ok: true, ignored: true };
    await ensureSchema();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [t] } = await c.query(
        `UPDATE transactions SET status='paid', paid_at=now(),
           bank_account_id=(SELECT id FROM bank_accounts WHERE clinic_id=transactions.clinic_id AND provider='asaas' ORDER BY created_at LIMIT 1)
         WHERE external_id=$1 AND status='pending' RETURNING id, clinic_id, bank_account_id`, [ref(payment.id)]);
      if (t) {
        const fee = payment.value != null && payment.netValue != null ? round2(payment.value - payment.netValue) : 0;
        if (fee > 0) {
          let { rows: [cat] } = await c.query(`SELECT id FROM categories WHERE clinic_id=$1 AND kind='expense' AND dre_group='despesas_financeiras' ORDER BY name LIMIT 1`, [t.clinic_id]);
          if (!cat) ({ rows: [cat] } = await c.query(`INSERT INTO categories (clinic_id, name, kind, dre_group) VALUES ($1,'Tarifas de pagamento','expense','despesas_financeiras') RETURNING id`, [t.clinic_id]));
          await c.query(
            `INSERT INTO transactions (clinic_id,type,category_id,description,amount,competence_date,due_date,status,paid_at,bank_account_id,external_id)
             SELECT $1,'expense',$2,'Tarifa Asaas',$3,d,d,'paid',now(),$4,$5 FROM (SELECT (now() AT TIME ZONE timezone)::date AS d FROM clinics WHERE id=$1) x
             ON CONFLICT DO NOTHING`, [t.clinic_id, cat.id, fee, t.bank_account_id, `asaas-fee:${payment.id}`]);
        }
        req.log.info({ transaction: t.id }, 'recebimento Pix confirmado pelo Asaas');
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return { ok: true };
  });
}
