-- ATENCAO: este script NAO roda automaticamente. Execute manualmente, so se precisar desfazer o ciclo do procedimento.
-- Remove as tabelas e colunas criadas por db/schema.sql / backend/src/schema.js (CYCLE_STEPS). Apaga os dados dessas estruturas.
-- Faca backup antes. Os dados antigos (produtos, movimentos, pacientes) permanecem, sem as colunas novas.
BEGIN;

DROP TABLE IF EXISTS ai_record_usage;
DROP TABLE IF EXISTS traceability_documents;
DROP TABLE IF EXISTS contact_consents;
DROP TABLE IF EXISTS returns;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS procedure_return_rules;

-- stock_movements.lot_id referencia product_lots: remover a coluna antes da tabela.
DROP INDEX IF EXISTS stock_movements_application;
ALTER TABLE stock_movements DROP COLUMN IF EXISTS lot_id, DROP COLUMN IF EXISTS application_id;
DROP TABLE IF EXISTS product_lots;

ALTER TABLE products
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS manufacturer,
  DROP COLUMN IF EXISTS device_type,
  DROP COLUMN IF EXISTS units_per_package;

COMMIT;
