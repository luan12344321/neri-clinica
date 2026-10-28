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

const tbl = (name) => `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name='${name}'`;
STEPS.push(
  { has: col('clinics', 'whatsapp_verify_token'), sql: "ALTER TABLE clinics\n  ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false,\n  ADD COLUMN IF NOT EXISTS whatsapp_number text,\n  ADD COLUMN IF NOT EXISTS whatsapp_phone_id text,\n  ADD COLUMN IF NOT EXISTS whatsapp_token_enc text,      -- cifrado (AES-256-GCM), nunca devolvido pela API\n  ADD COLUMN IF NOT EXISTS whatsapp_secret_enc text,     -- segredo do app da Meta (valida a assinatura do webhook), cifrado\n  ADD COLUMN IF NOT EXISTS whatsapp_verify_token text;\nCREATE UNIQUE INDEX IF NOT EXISTS clinics_wa_phone_id ON clinics (whatsapp_phone_id) WHERE whatsapp_phone_id IS NOT NULL;\n" },
  { has: tbl('wa_messages'), sql: "CREATE TABLE IF NOT EXISTS wa_messages (\n  id bigserial PRIMARY KEY,\n  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,\n  contact text NOT NULL,                     -- telefone do cliente (só dígitos)\n  direction text NOT NULL CHECK (direction IN ('in','out')),\n  wa_message_id text,                        -- id da Meta: evita responder duas vezes ao mesmo reenvio\n  body text NOT NULL,\n  tokens_in int, tokens_out int,             -- uso do modelo (entra no orçamento mensal)\n  created_at timestamptz NOT NULL DEFAULT now()\n);\nCREATE UNIQUE INDEX IF NOT EXISTS wa_messages_dedupe ON wa_messages (clinic_id, wa_message_id) WHERE wa_message_id IS NOT NULL;\nCREATE INDEX IF NOT EXISTS wa_messages_contact ON wa_messages (clinic_id, contact, id DESC);\n" },
  { has: tbl('wa_contacts'), sql: "CREATE TABLE IF NOT EXISTS wa_contacts (\n  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,\n  contact text NOT NULL,\n  display_name text,\n  human_until timestamptz,                   -- enquanto no futuro, a Julia não responde (a equipe assumiu)\n  handoff_reason text,\n  PRIMARY KEY (clinic_id, contact)\n);\n" },
);

let ready;
export const ensureSchema = () => (ready ??= (async () => {
  for (const s of STEPS) if (!(await q(s.has)).length) await q(s.sql);
})().catch((e) => { ready = undefined; throw e; }));
