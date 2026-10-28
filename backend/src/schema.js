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

// ---- Ciclo do procedimento (lotes, aplicações, retorno, consentimento, rastreabilidade) ----
// Só ADIÇÕES. db/schema.sql recebe exatamente estes mesmos comandos (CYCLE_STEPS) para instalações novas.
export const CYCLE_STEPS = [
  { has: col('products', 'device_type'), sql: `ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  ADD COLUMN IF NOT EXISTS device_type text NOT NULL DEFAULT 'other'
    CHECK (device_type IN ('toxin','hyaluronic_acid','plla','pmma','calcium_hydroxylapatite','other')),
  ADD COLUMN IF NOT EXISTS units_per_package numeric(12,2) NOT NULL DEFAULT 1 CHECK (units_per_package > 0);
` },
  { has: tbl('product_lots'), sql: `CREATE TABLE IF NOT EXISTS product_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products,
  lot_code text NOT NULL,
  expires_at date NOT NULL,
  manufacturer text,
  quantity_units numeric(12,2) NOT NULL CHECK (quantity_units >= 0),   -- saldo em UNIDADES de aplicação
  initial_units numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, product_id, lot_code)
);
CREATE INDEX IF NOT EXISTS product_lots_expiry ON product_lots (clinic_id, expires_at);
CREATE INDEX IF NOT EXISTS product_lots_product ON product_lots (clinic_id, product_id);
` },
  { has: col('stock_movements', 'lot_id'), sql: `ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES product_lots,
  ADD COLUMN IF NOT EXISTS application_id uuid;
CREATE INDEX IF NOT EXISTS stock_movements_application ON stock_movements (application_id);
` },
  { has: tbl('procedure_return_rules'), sql: `CREATE TABLE IF NOT EXISTS procedure_return_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  procedure_id uuid NOT NULL REFERENCES procedures,
  target_days int NOT NULL,
  window_min_days int NOT NULL,
  window_max_days int NOT NULL,
  message_text text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_min_days > 0 AND window_min_days <= target_days AND target_days <= window_max_days),
  UNIQUE (clinic_id, procedure_id)
);
` },
  { has: tbl('applications'), sql: `CREATE TABLE IF NOT EXISTS applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments,
  patient_id uuid NOT NULL REFERENCES patients,
  product_id uuid NOT NULL REFERENCES products,
  lot_id uuid REFERENCES product_lots,
  units_used numeric(12,2) NOT NULL CHECK (units_used > 0),
  unit_cost numeric(12,4),                    -- custo por unidade no momento da aplicação
  cost numeric(12,2),                         -- units_used x unit_cost
  label_photo_enc text,                       -- foto do rótulo, cifrada
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS applications_appointment ON applications (clinic_id, appointment_id);
CREATE INDEX IF NOT EXISTS applications_created ON applications (clinic_id, created_at);
` },
  { has: tbl('returns'), sql: `CREATE TABLE IF NOT EXISTS returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients,
  procedure_id uuid NOT NULL REFERENCES procedures,
  source_appointment_id uuid NOT NULL REFERENCES appointments,
  suggested_date date NOT NULL,
  window_start date,
  window_end date,
  state text NOT NULL DEFAULT 'suggested'
    CHECK (state IN ('suggested','scheduled','declined','no_response','remind_later','done')),
  contacted_at timestamptz,
  remind_on date,
  generated_appointment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, source_appointment_id, procedure_id)
);
CREATE INDEX IF NOT EXISTS returns_due ON returns (clinic_id, suggested_date, state);
` },
  { has: tbl('contact_consents'), sql: `CREATE TABLE IF NOT EXISTS contact_consents (   -- histórico: só insere; vale o último registro por (paciente, finalidade)
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients,
  purpose text NOT NULL CHECK (purpose IN ('return','birthday','marketing')),
  granted boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS contact_consents_latest ON contact_consents (clinic_id, patient_id, purpose, recorded_at DESC);
` },
  { has: tbl('traceability_documents'), sql: `CREATE TABLE IF NOT EXISTS traceability_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments,
  patient_id uuid NOT NULL REFERENCES patients,
  pdf_enc text NOT NULL,                      -- cifrado (AAD traceability.pdf:<id>)
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traceability_appointment ON traceability_documents (clinic_id, appointment_id);
` },
  { has: tbl('ai_record_usage'), sql: `CREATE TABLE IF NOT EXISTS ai_record_usage (
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid REFERENCES patients,
  user_id uuid REFERENCES users,
  tool text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_record_usage_clinic ON ai_record_usage (clinic_id, created_at);
` },
];

// Preenchimento único e idempotente: quem já autorizava marketing passa a ter 'birthday' e 'marketing' concedidos.
// NUNCA gera 'return' (consentimento próprio e explícito).
export const BACKFILL_CONSENTS_SQL = `INSERT INTO contact_consents (clinic_id, patient_id, purpose, granted)
SELECT p.clinic_id, p.id, x.purpose, true
FROM patients p CROSS JOIN (VALUES ('birthday'), ('marketing')) AS x(purpose)
WHERE p.marketing_consent = true
  AND NOT EXISTS (SELECT 1 FROM contact_consents c
                  WHERE c.clinic_id = p.clinic_id AND c.patient_id = p.id AND c.purpose = x.purpose)`;
export const backfillConsents = () => q(BACKFILL_CONSENTS_SQL);
STEPS.push(...CYCLE_STEPS, { has: 'SELECT 1 WHERE false', sql: BACKFILL_CONSENTS_SQL });

let ready;
export const ensureSchema = () => (ready ??= (async () => {
  for (const s of STEPS) if (!(await q(s.has)).length) await q(s.sql);
})().catch((e) => { ready = undefined; throw e; }));
