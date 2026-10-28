import { q } from './db.js';

// Exportação de uma clínica inteira (backup portátil e saída de dados no fim do contrato).
// Cada tabela com clinic_id é lida só com o id da clínica pedida. Senhas, tokens e segredos NUNCA saem.
// Campos cifrados (*_enc: CPF, prontuário, PDFs, fotos) saem cifrados: só abrem com a ENCRYPTION_KEY do servidor.
const SECRET = /(password|token|secret)/i;
const strip = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET.test(k)));

export async function exportClinic(clinicId) {
  const tables = (await q(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema=current_schema() AND column_name='clinic_id' ORDER BY table_name`)).map((r) => r.table_name);
  const [clinic] = await q('SELECT * FROM clinics WHERE id=$1', [clinicId]);
  if (!clinic) throw new Error('clínica não encontrada');
  const data = {};
  for (const t of tables) data[t] = (await q(`SELECT * FROM "${t}" WHERE clinic_id=$1`, [clinicId])).map(strip);
  return { exportedAt: new Date().toISOString(), clinic: strip(clinic), tables: data };
}
