// Uso: npm run clinic:export -- <id-da-clinica> [arquivo.json]
// Gera um backup portátil de UMA clínica. Campos cifrados saem cifrados (precisa da ENCRYPTION_KEY para abrir).
// Guarde o arquivo em local seguro: ele contém dados de pacientes.
import { writeFileSync } from 'node:fs';
import { exportClinic } from '../src/export.js';
import { pool } from '../src/db.js';

const [id, out] = process.argv.slice(2);
if (!id) { console.error('Uso: npm run clinic:export -- <id-da-clinica> [arquivo.json]'); process.exit(1); }
try {
  const data = await exportClinic(id);
  const file = out ?? `clinica-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Exportado: ${file} (${Object.values(data.tables).reduce((n, r) => n + r.length, 0)} registros em ${Object.keys(data.tables).length} tabelas)`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
