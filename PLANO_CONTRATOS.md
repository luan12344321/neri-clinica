# CONTRATOS DO CICLO DO PROCEDIMENTO (leia junto com PLANO.md)

## Decisões do usuário (28/10/2026)
- Neri = **só estética/injetáveis**. Nada de multiespecialidade.
- **Perfis ficam como estão** (`owner`, `manager`, `professional`, `reception`). Doutora = `owner` (ou `professional` no clínico). Custo e margem: só `owner`/`manager`.
- **Aplicar as 3 mudanças:** (1) baixa de estoque só com confirmação explícita; o protocolo vira só sugestão. (2) Desligar o job automático `followup` (o Retorno novo o substitui; aniversário não muda). (3) Consentimento por finalidade (`return` é próprio e explícito).
- Trabalho só na `dev`. **Nenhum agent faz commit, push, merge ou deploy.** Só mudanças aditivas; nada que apague dados.

## Banco (Agent 1 cria em `db/schema.sql` E como passos aditivos idempotentes em `backend/src/schema.js`)
- `products` +colunas: `category text`, `manufacturer text`, `device_type text NOT NULL DEFAULT 'other' CHECK IN ('toxin','hyaluronic_acid','plla','pmma','calcium_hydroxylapatite','other')`, `units_per_package numeric(12,2) NOT NULL DEFAULT 1 CHECK (>0)`. `products.quantity` continua em EMBALAGENS (legado; usado no "repor").
- `product_lots`: `id uuid pk`, `clinic_id`, `product_id → products`, `lot_code text NOT NULL`, `expires_at date NOT NULL`, `manufacturer text`, `quantity_units numeric(12,2) NOT NULL CHECK (>=0)` (saldo em UNIDADES de aplicação), `initial_units numeric(12,2) NOT NULL`, `created_at`. UNIQUE `(clinic_id, product_id, lot_code)`. Índices `(clinic_id, expires_at)` e `(clinic_id, product_id)`.
- `stock_movements` +colunas: `lot_id uuid REFERENCES product_lots`, `application_id uuid` (sem FK circular; com índice).
- `procedure_return_rules`: `id`, `clinic_id`, `procedure_id → procedures`, `target_days int`, `window_min_days int`, `window_max_days int` (CHECK min<=target<=max e min>0), `message_text text NOT NULL`, `active boolean DEFAULT true`, `created_at`, `updated_at`. UNIQUE `(clinic_id, procedure_id)`.
- `applications`: `id`, `clinic_id`, `appointment_id → appointments`, `patient_id → patients`, `product_id → products`, `lot_id → product_lots NULL`, `units_used numeric(12,2) CHECK (>0)`, `unit_cost numeric(12,4)` (custo por unidade no momento), `cost numeric(12,2)` (units_used × unit_cost), `label_photo_enc text NULL` (cifrado), `created_by uuid → users`, `created_at`. Índices `(clinic_id, appointment_id)` e `(clinic_id, created_at)`.
- `returns`: `id`, `clinic_id`, `patient_id`, `procedure_id`, `source_appointment_id → appointments`, `suggested_date date NOT NULL`, `window_start date`, `window_end date`, `state text NOT NULL DEFAULT 'suggested' CHECK IN ('suggested','scheduled','declined','no_response','remind_later','done')`, `contacted_at timestamptz`, `remind_on date`, `generated_appointment_id uuid NULL`, `created_at`, `updated_at`. UNIQUE `(clinic_id, source_appointment_id, procedure_id)`. Índice `(clinic_id, suggested_date, state)`.
- `contact_consents` (histórico, só insere): `id bigserial`, `clinic_id`, `patient_id`, `purpose text CHECK IN ('return','birthday','marketing')`, `granted boolean`, `recorded_at`, `recorded_by uuid NULL`. Vale o último registro por (paciente, finalidade). Índice `(clinic_id, patient_id, purpose, recorded_at DESC)`. Preenchimento único e idempotente: `patients.marketing_consent = true` gera registros `birthday` e `marketing` concedidos. **Nunca** gerar `return` automaticamente.
- `traceability_documents`: `id uuid`, `clinic_id`, `appointment_id`, `patient_id`, `pdf_enc text` (cifrado, AAD `traceability.pdf:<id>`), `created_by`, `created_at`.
- `ai_record_usage`: `id bigserial`, `clinic_id`, `patient_id`, `user_id`, `tool text`, `created_at` (registro de uso de IA sobre prontuário).
- Auditoria (`audit_log`, nomes de ação): `stock.lot_create`, `application.create`, `appointment.complete_confirmed`, `return.suggested`, `return.result`, `return.schedule`, `consent.update`, `traceability.generate`, `traceability.read`, `return_rule.update`.
- Rastreável (exige comprovante PDF): `device_type IN ('hyaluronic_acid','plla','pmma','calcium_hydroxylapatite')`.
- Reversão: `db/rollback_ciclo_procedimento.sql` (remove tabelas/colunas novas; documentado; NÃO é executado automaticamente).

## API (nomes fixos; permissões entre parênteses; sempre `clinic_id` do token)
- **Lotes (Agent 1):** `GET /products/:id/lots` (todos os perfis); `POST /products/:id/lots {lotCode, expiresAt, packages, manufacturer?}` (todos os perfis; soma `packages × units_per_package` em unidades no lote e `packages` em `products.quantity`; movimento `purchase` com `lot_id`; auditoria `stock.lot_create`).
- **Agent 2 (`backend/src/atendimento.js`):** `GET /appointments/:id/conclusion-context` e `POST /appointments/:id/conclude {confirmed:true, applications:[{productId, lotId?, units, labelPhoto?}]}` (owner, manager, professional). Em UMA transação: fecha o atendimento, cria a receita (mesma regra do `complete` atual), grava `applications` (custo = units × unit_cost / units_per_package), baixa o lote e `products.quantity` (movimento `usage`, com `lot_id` e `application_id`), chama `suggestReturn` (Agent 4) e audita. Bloqueia lote vencido (409 `lot_expired`), saldo insuficiente (409) e falta de `confirmed:true` (400). Resposta: `{appointment, applications:[{id, product, lot, units, cost?}], totalCost?, margin?, returnSuggested, traceability}`; `cost`, `totalCost` e `margin` só para owner/manager. O `POST /appointments/:id/complete` antigo continua existindo, mas **sem baixa automática pelo protocolo**.
- **Agent 3 (`backend/src/rastreabilidade.js`):** exporta `createTraceabilityDocument({clinicId, appointmentId, userId})` (chamada pelo Agent 2 DEPOIS do commit; falha dela não desfaz a aplicação) e rotas `GET /appointments/:id/traceability` (lista) e `GET /traceability/:id/pdf` (owner, manager, professional; auditoria `traceability.read`; sem link público).
- **Agent 4 (`backend/src/retornos.js`):** `GET|PUT /procedures/:id/return-rule` (GET: owner, manager, professional; PUT: owner, manager); exporta `suggestReturn(client, {clinicId, appointmentId, patientId, procedureId})`; `POST /returns/:id/schedule {startsAt}` ("agendar agora": cria o agendamento com as regras de disponibilidade e marca `scheduled`); tarefa `returnsTick()` dentro do `tick` de `jobs.js`.
- **Agent 5 (`backend/src/fila.js`):** `GET /returns/queue` (owner, manager, professional, reception; o telefone SÓ vai se houver consentimento `return`); `POST /returns/:id/result {result:'scheduled'|'declined'|'no_response'|'remind_later', remindOn?}`; `GET|PUT /patients/:id/consents` (leitura: todos; escrita: owner, manager, professional, reception); `GET /attention` (todos, filtrado por perfil).
- **Agent 6 (`backend/src/painel_ciclo.js`):** `GET /dashboard/cycle` (owner, manager): `{forecast30d:{count, amount}, onTimeRate:{current, baseline6m}, lotsExpiring60d:[], avgMarginByProcedure:[], lotCoverage:{pct, withLot, total}, idleMoney?}`.
- **Job (`backend/src/jobs.js`, Agent 4):** `tick` deixa de rodar `followup` (e o agendamento `cron` local também) e passa a rodar `returnsTick` (idempotente; só atualiza estado; NUNCA envia nada).
- **Registro das rotas:** cada agent adiciona UMA linha em `backend/src/app.js` logo depois da linha de `./whatsapp.js` (padrão `await app.register((await import('./arquivo.js')).default);`).

## Front (arquivos novos por agent; integração mínima nos existentes)
- Agent 2: `frontend/src/Atendimento.tsx` (folha "Concluir atendimento") e troca do botão em `Timeline.tsx`.
- Agent 3: `frontend/src/Comprovante.tsx` (botão "Comprovante" na conclusão e no prontuário).
- Agent 4: `frontend/src/RegraRetorno.tsx` (regra, ligada em Procedimentos no `Cadastros.tsx`) e `AgendarRetorno.tsx`.
- Agent 5: `frontend/src/RetornosDoDia.tsx`, `Consentimento.tsx` e a seção "Precisa de atenção" em `App.tsx` (`Today`).
- Agent 6: `frontend/src/PainelCiclo.tsx` (card na home de owner/manager).

## Regras gerais para todos
- Reaproveitar padrões (zod, `q`, `audit`, `crypto.js`, `useLoad`, `Sheet`, estilos `card/rows/pill`); sem módulos duplicados e sem dependência nova sem motivo (única prevista: `pdfkit`, Agent 3).
- Arquivos do repositório podem ser CRLF: se uma edição por texto exato falhar, normalize as quebras de linha ao editar (script node), sem reformatar o arquivo.
- Heredocs longos quebram neste ambiente: crie arquivos com a ferramenta de escrita.
- Visual existente: **somente bege, branco e verde** (terracota só para erro/atraso/saída).
- Testes: `cd backend && npm test` (node:test + PGlite; hoje 158 passam); front: `cd frontend && npm run build`. Dados de teste só fictícios.
- Nenhuma mensagem automática; nada que prometa resultado; nenhuma IA decide intervalo, diagnóstico ou conduta; dados de saúde sem aparecer em logs ou URLs.
