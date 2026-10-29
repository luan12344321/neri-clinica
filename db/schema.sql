-- PostgreSQL 16 | multi-tenant: toda tabela de negócio tem clinic_id

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  cnpj text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  working_hours jsonb,                       -- horário de atendimento por dia da semana (NULL = padrão; ver backend/src/hours.js)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','manager','professional','reception')),
  google_refresh_token_enc text,          -- criptografado (AES-GCM) na aplicação
  google_calendar_id text,                -- NULL = 'primary'
  google_sync_token text,                 -- cursor incremental do Google Calendar
  last_seen_at timestamptz,               -- último sinal do app aberto (presença; ver backend/src/presence.js)
  terms_accepted_at timestamptz,          -- aceite dos Termos de Uso / Política de Privacidade
  terms_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  full_name text NOT NULL,
  birth_date date,
  phone text,                              -- E.164
  email text,
  cpf_enc text,                            -- dado sensível (LGPD): AES-256-GCM, ver backend/src/crypto.js
  cpf_hash text,                           -- HMAC do CPF: deduplica/busca sem guardar o CPF em claro
  marketing_consent boolean NOT NULL DEFAULT false,  -- base legal p/ mensagens
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON patients (clinic_id, full_name);
CREATE UNIQUE INDEX ON patients (clinic_id, cpf_hash) WHERE cpf_hash IS NOT NULL;

-- Ficha médica / prontuário (dado de saúde = sensível pela LGPD)
CREATE TABLE medical_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients ON DELETE CASCADE,
  author_id uuid REFERENCES users,
  data_enc text NOT NULL,                    -- {alergias, anamnese, evolução} em JSON, cifrado (AES-256-GCM)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON medical_records (clinic_id, patient_id, created_at DESC);

CREATE TABLE procedures (                    -- catálogo
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  name text NOT NULL,
  default_price numeric(12,2) NOT NULL,
  duration_min int NOT NULL DEFAULT 60,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients,
  professional_id uuid REFERENCES users,
  procedure_id uuid REFERENCES procedures,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','done','canceled','no_show')),
  price numeric(12,2),                       -- preço efetivamente cobrado
  completed_at timestamptz,
  google_event_id text,                      -- sync bidirecional
  google_etag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON appointments (clinic_id, starts_at);
CREATE UNIQUE INDEX ON appointments (clinic_id, google_event_id) WHERE google_event_id IS NOT NULL;

-- ===== Financeiro =====
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  dre_group text NOT NULL CHECK (dre_group IN
    ('receita_bruta','deducoes','custos_variaveis','despesas_operacionais','despesas_financeiras','impostos_lucro'))
);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  name text NOT NULL,
  provider text,                             -- ex.: pluggy/belvo
  provider_item_id text,
  institution text NOT NULL DEFAULT 'Outro',
  kind text NOT NULL DEFAULT 'checking' CHECK (kind IN ('checking','savings','payment','cash')),
  last4 text,                                -- só os 4 últimos dígitos; nunca o número completo
  pix_key_enc text,                          -- chave Pix cifrada (AES-GCM) na aplicação
  pix_key_type text CHECK (pix_key_type IN ('cpf','cnpj','email','phone','random')),
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Contas a receber/pagar + fluxo de caixa (uma tabela, status distingue)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('income','expense')),
  category_id uuid REFERENCES categories,
  appointment_id uuid REFERENCES appointments,
  bank_account_id uuid REFERENCES bank_accounts,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  competence_date date NOT NULL,             -- regime de competência (DRE)
  due_date date NOT NULL,                    -- vencimento (fluxo de caixa)
  paid_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','canceled')),
  external_id text,                          -- conciliação bancária
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON transactions (clinic_id, competence_date);
CREATE INDEX ON transactions (clinic_id, status, due_date);
CREATE UNIQUE INDEX ON transactions (clinic_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE dre_reports (                   -- snapshot mensal gerado por cron
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  month date NOT NULL,                       -- 1º dia do mês
  data jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, month)
);

-- ===== Estoque e protocolos =====
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'un',
  quantity numeric(12,2) NOT NULL DEFAULT 0,
  min_quantity numeric(12,2) NOT NULL DEFAULT 0,   -- ponto de reposição
  target_quantity numeric(12,2) NOT NULL DEFAULT 0, -- estoque alvo -> "quanto repor"
  unit_cost numeric(12,2),
  expires_at date
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products,
  delta numeric(12,2) NOT NULL,              -- + entrada / - saída
  reason text NOT NULL CHECK (reason IN ('purchase','usage','adjustment','loss')),
  appointment_id uuid REFERENCES appointments,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  procedure_id uuid REFERENCES procedures,
  name text NOT NULL,
  instructions text NOT NULL
);
CREATE TABLE protocol_items (                -- consumo padrão -> baixa automática
  protocol_id uuid NOT NULL REFERENCES protocols ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products,
  quantity numeric(12,2) NOT NULL,
  PRIMARY KEY (protocol_id, product_id)
);

-- ===== CRM / automações =====
CREATE TABLE message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('birthday','followup','reminder')),
  body text NOT NULL                          -- ex.: "Olá {{nome}}, ..."
);

CREATE TABLE followup_rules (               -- "X dias após o procedimento Y, enviar template Z"
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  procedure_id uuid REFERENCES procedures,   -- NULL = qualquer procedimento
  days_after int NOT NULL,
  template_id uuid NOT NULL REFERENCES message_templates
);

CREATE TABLE message_queue (                -- outbox: o cron enfileira, o worker envia
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients,
  kind text NOT NULL,
  body text NOT NULL,
  dedupe_key text NOT NULL,                  -- garante idempotência dos crons
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  send_after timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,                    -- quando um worker reservou (recupera reservas órfãs)
  sent_at timestamptz,
  error text,
  UNIQUE (clinic_id, dedupe_key)
);

CREATE TABLE alerts (                        -- estoque baixo, contas vencendo...
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, dedupe_key)
);

-- ===== Sara (IA) =====
CREATE TABLE sara_messages (
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content jsonb NOT NULL,
  tokens_in int, tokens_out int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sara_messages (conversation_id, id);

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_number text,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_id text,
  ADD COLUMN IF NOT EXISTS whatsapp_token_enc text,      -- cifrado (AES-256-GCM), nunca devolvido pela API
  ADD COLUMN IF NOT EXISTS whatsapp_secret_enc text,     -- segredo do app da Meta (valida a assinatura do webhook), cifrado
  ADD COLUMN IF NOT EXISTS whatsapp_verify_token text;
CREATE UNIQUE INDEX IF NOT EXISTS clinics_wa_phone_id ON clinics (whatsapp_phone_id) WHERE whatsapp_phone_id IS NOT NULL;

-- ===== WhatsApp (atendimento da Julia aos clientes) =====
CREATE TABLE IF NOT EXISTS wa_messages (
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  contact text NOT NULL,                     -- telefone do cliente (só dígitos)
  direction text NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id text,                        -- id da Meta: evita responder duas vezes ao mesmo reenvio
  body text NOT NULL,
  tokens_in int, tokens_out int,             -- uso do modelo (entra no orçamento mensal)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_dedupe ON wa_messages (clinic_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wa_messages_contact ON wa_messages (clinic_id, contact, id DESC);
CREATE TABLE IF NOT EXISTS wa_contacts (
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  contact text NOT NULL,
  display_name text,
  human_until timestamptz,                   -- enquanto no futuro, a Julia não responde (a equipe assumiu)
  handoff_reason text,
  read_upto bigint NOT NULL DEFAULT 0,       -- última mensagem do cliente já vista pela equipe (wa_messages.id)
  PRIMARY KEY (clinic_id, contact)
);
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS staff_user_id uuid;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS wa_julia_help_day date;  -- dia em que a recepção ligou a Julia no expediente (vale só nesse dia)  -- preenchido quando a equipe (e não a Julia) enviou

CREATE TABLE audit_log (                     -- LGPD: quem acessou/alterou o quê
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL,
  user_id uuid,
  action text NOT NULL,
  entity text, entity_id text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Append-only: ninguém (nem a aplicação) altera ou apaga a trilha de auditoria.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log é imutável'; END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- View usada pelo "o que repor"
CREATE VIEW v_restock AS
SELECT clinic_id, id AS product_id, name, quantity, min_quantity,
       GREATEST(target_quantity - quantity, 0) AS qty_to_buy
FROM products WHERE quantity <= min_quantity;

-- ===== Ciclo do procedimento (lotes, aplicações, retorno, consentimento, rastreabilidade) =====
-- Gerado a partir de CYCLE_STEPS em backend/src/schema.js (mesmos comandos, idempotentes).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  ADD COLUMN IF NOT EXISTS device_type text NOT NULL DEFAULT 'other'
    CHECK (device_type IN ('toxin','hyaluronic_acid','plla','pmma','calcium_hydroxylapatite','other')),
  ADD COLUMN IF NOT EXISTS units_per_package numeric(12,2) NOT NULL DEFAULT 1 CHECK (units_per_package > 0);

CREATE TABLE IF NOT EXISTS product_lots (
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

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES product_lots,
  ADD COLUMN IF NOT EXISTS application_id uuid;
CREATE INDEX IF NOT EXISTS stock_movements_application ON stock_movements (application_id);

CREATE TABLE IF NOT EXISTS procedure_return_rules (
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

CREATE TABLE IF NOT EXISTS applications (
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

CREATE TABLE IF NOT EXISTS returns (
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

CREATE TABLE IF NOT EXISTS contact_consents (   -- histórico: só insere; vale o último registro por (paciente, finalidade)
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients,
  purpose text NOT NULL CHECK (purpose IN ('return','birthday','marketing')),
  granted boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users
);
CREATE INDEX IF NOT EXISTS contact_consents_latest ON contact_consents (clinic_id, patient_id, purpose, recorded_at DESC);

CREATE TABLE IF NOT EXISTS traceability_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments,
  patient_id uuid NOT NULL REFERENCES patients,
  pdf_enc text NOT NULL,                      -- cifrado (AAD traceability.pdf:<id>)
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traceability_appointment ON traceability_documents (clinic_id, appointment_id);

CREATE TABLE IF NOT EXISTS ai_record_usage (
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics ON DELETE CASCADE,
  patient_id uuid REFERENCES patients,
  user_id uuid REFERENCES users,
  tool text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_record_usage_clinic ON ai_record_usage (clinic_id, created_at);
