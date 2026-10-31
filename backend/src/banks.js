import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { q } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';
import { maskKey, normalizePixKey, pixPayload } from './pix.js';

// Contas bancárias onde o dinheiro cai. Só dono e gerente. Não guardamos número de conta completo: só os 4 últimos dígitos.
// A chave Pix (dado pessoal) fica cifrada em repouso e as listagens devolvem apenas uma versão mascarada.
const KINDS = ['checking', 'savings', 'payment', 'cash'];
const PIX_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'random'];
const pixAad = (id) => `bank_accounts.pix:${id}`;

const body = z.object({
  name: z.string().trim().min(2).max(60),
  institution: z.string().trim().min(2).max(40),
  kind: z.enum(KINDS),
  last4: z.string().regex(/^\d{4}$/, 'últimos 4 dígitos').optional(),
  pixKeyType: z.enum(PIX_TYPES).optional(),
  pixKey: z.string().max(100).optional(),
  openingBalance: z.number().min(-1e9).max(1e9).optional(),
  isDefault: z.boolean().optional(),
});

const view = (r) => ({
  id: r.id, name: r.name, institution: r.institution, kind: r.kind, last4: r.last4, isDefault: r.is_default, active: r.active,
  openingBalance: Number(r.opening_balance), balance: Number(r.balance ?? r.opening_balance),
  pixKeyType: r.pix_key_type, pixKeyMasked: r.pix_key_enc ? maskKey(decrypt(r.pix_key_enc, pixAad(r.id))) : null,
});

const LIST = `SELECT b.*, b.opening_balance + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount ELSE -t.amount END)
                FILTER (WHERE t.status='paid'), 0) AS balance
              FROM bank_accounts b LEFT JOIN transactions t ON t.bank_account_id=b.id`;

export default async function banks(app) {
  const manager = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const pixOf = (b, reply) => {
    if (!b.pixKey) return { enc: null, type: null };
    if (!b.pixKeyType) { reply.code(400).send({ error: 'validation' }); return null; }
    const key = normalizePixKey(b.pixKeyType, b.pixKey);
    if (!key) { reply.code(400).send({ error: 'invalid pix key' }); return null; }
    return { key, type: b.pixKeyType };
  };

  app.get('/banks', manager, async (req) => {
    await ensureSchema();
    return (await q(`${LIST} WHERE b.clinic_id=$1 GROUP BY b.id ORDER BY b.active DESC, b.is_default DESC, b.name`, [cid(req)])).map(view);
  });

  app.post('/banks', manager, async (req, reply) => {
    await ensureSchema();
    const b = body.parse(req.body);
    const pix = pixOf(b, reply);
    if (!pix) return;
    const id = randomUUID();
    await q(`INSERT INTO bank_accounts (id, clinic_id, name, institution, kind, last4, pix_key_enc, pix_key_type, opening_balance, is_default)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10 OR NOT EXISTS (SELECT 1 FROM bank_accounts WHERE clinic_id=$2 AND active))`,
      [id, cid(req), b.name, b.institution, b.kind, b.last4 ?? null, pix.key ? encrypt(pix.key, pixAad(id)) : null, pix.type ?? null,
        b.openingBalance ?? 0, b.isDefault ?? false]);
    await q(`UPDATE bank_accounts SET is_default=false WHERE clinic_id=$1 AND id<>$2 AND (SELECT is_default FROM bank_accounts WHERE id=$2)`, [cid(req), id]);
    await audit(auditCtx(req), 'bank.create', 'bank_account', id);
    const [r] = await q(`${LIST} WHERE b.id=$1 GROUP BY b.id`, [id]);
    return reply.code(201).send(view(r));
  });

  app.patch('/banks/:id', manager, async (req, reply) => {
    await ensureSchema();
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const b = body.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    const [cur] = await q('SELECT id FROM bank_accounts WHERE id=$1 AND clinic_id=$2', [id, cid(req)]);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    // pixKey '' limpa a chave; omitido mantém.
    let enc, type;
    if (b.pixKey !== undefined) {
      if (b.pixKey === '') { enc = null; type = null; } else {
        const pix = pixOf(b, reply);
        if (!pix) return;
        enc = encrypt(pix.key, pixAad(id)); type = pix.type;
      }
    }
    await q(`UPDATE bank_accounts SET name=COALESCE($3,name), institution=COALESCE($4,institution), kind=COALESCE($5,kind),
               last4=COALESCE($6,last4), opening_balance=COALESCE($7,opening_balance), active=COALESCE($8,active),
               pix_key_enc = CASE WHEN $9 THEN $10 ELSE pix_key_enc END, pix_key_type = CASE WHEN $9 THEN $11 ELSE pix_key_type END
             WHERE id=$1 AND clinic_id=$2`,
      [id, cid(req), b.name ?? null, b.institution ?? null, b.kind ?? null, b.last4 ?? null, b.openingBalance ?? null, b.active ?? null,
        b.pixKey !== undefined, enc ?? null, type ?? null]);
    if (b.isDefault) {
      await q('UPDATE bank_accounts SET is_default = (id=$2) WHERE clinic_id=$1', [cid(req), id]);
    }
    await audit(auditCtx(req), 'bank.update', 'bank_account', id);
    const [r] = await q(`${LIST} WHERE b.id=$1 GROUP BY b.id`, [id]);
    return view(r);
  });

  // Últimas movimentações (pagas e pendentes), para o painel e o financeiro.
  app.get('/finance/transactions', manager, async (req) => {
    await ensureSchema();
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(8) }).parse(req.query);
    return q(`SELECT t.id, t.type, t.description, t.amount::float AS amount, t.status, t.due_date, t.paid_at,
                     c.name AS category, b.name AS bank, p.full_name AS patient
              FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN bank_accounts b ON b.id=t.bank_account_id
              LEFT JOIN appointments a ON a.id=t.appointment_id AND a.clinic_id=t.clinic_id
              LEFT JOIN patients p ON p.id=a.patient_id AND p.clinic_id=t.clinic_id
              WHERE t.clinic_id=$1 AND t.status<>'canceled' ORDER BY COALESCE(t.paid_at, t.created_at) DESC LIMIT $2`, [cid(req), limit]);
  });

  // Pix "copia e cola" de uma conta a receber, na chave da conta escolhida (ou da padrão).
  app.get('/finance/transactions/:id/pix', manager, async (req, reply) => {
    await ensureSchema();
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const { bankAccountId } = z.object({ bankAccountId: z.guid().optional() }).parse(req.query);
    const [t] = await q(`SELECT t.id, t.amount::float AS amount, c.name AS clinic FROM transactions t JOIN clinics c ON c.id=t.clinic_id
                         WHERE t.id=$1 AND t.clinic_id=$2 AND t.type='income' AND t.status='pending'`, [id, cid(req)]);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const [acct] = await q(`SELECT id, name, pix_key_enc FROM bank_accounts
      WHERE clinic_id=$1 AND active AND pix_key_enc IS NOT NULL AND ($2::uuid IS NULL OR id=$2)
      ORDER BY is_default DESC, created_at LIMIT 1`, [cid(req), bankAccountId ?? null]);
    // Sem chave Pix cadastrada não é erro nem conflito: é o estado inicial da clínica. 200 com motivo evita 4xx no console da tela.
    if (!acct) return { available: false, reason: 'no_pix_key' };
    const key = decrypt(acct.pix_key_enc, pixAad(acct.id));
    return { payload: pixPayload({ key, name: t.clinic, amount: t.amount, txid: `T${t.id.replace(/-/g, '')}` }),
      amount: t.amount, bank: acct.name, keyMasked: maskKey(key) };
  });
}
