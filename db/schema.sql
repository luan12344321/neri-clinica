-- PostgreSQL 16 | multi-tenant: toda tabela de negócio tem clinic_id

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  cnpj text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
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
  provider_item_id text
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
