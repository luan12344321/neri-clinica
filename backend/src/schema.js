import { q } from './db.js';

// O banco em produção não tem sistema de migração. Estas etapas são só ADIÇÕES, idempotentes: cada uma confere se
// já foi aplicada e só então altera, uma vez por instância. db/schema.sql já traz tudo isso para instalações novas.
const col = (table, column) => `SELECT 1 FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name='${table}' AND column_name='${column}'`;

const STEPS = [
  { has: col('users', 'last_seen_at'),
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz' },
  { has: col('clinics', 'working_hours'),
    sql: 'ALTER TABLE clinics ADD COLUMN IF NOT EXISTS working_hours jsonb' },
  { has: col('bank_accounts', 'institution'),
    sql: `ALTER TABLE bank_accounts
            ADD COLUMN IF NOT EXISTS institution text NOT NULL DEFAULT 'Outro',
            ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'checking' CHECK (kind IN ('checking','savings','payment','cash')),
            ADD COLUMN IF NOT EXISTS last4 text,
            ADD COLUMN IF NOT EXISTS pix_key_enc text,
            ADD COLUMN IF NOT EXISTS pix_key_type text CHECK (pix_key_type IN ('cpf','cnpj','email','phone','random')),
            ADD COLUMN IF NOT EXISTS opening_balance numeric(14,2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()` },
];

let ready;
export const ensureSchema = () => (ready ??= (async () => {
  for (const s of STEPS) if (!(await q(s.has)).length) await q(s.sql);
})().catch((e) => { ready = undefined; throw e; }));
