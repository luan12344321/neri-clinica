// Uso: npm run db:schema   (aplica db/schema.sql no DATABASE_URL, SEM dados de demonstração)
// Recusa rodar se o schema já existir, para nunca sobrescrever dados por engano.
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const [{ exists }] = (await pool.query(`SELECT to_regclass('public.clinics') IS NOT NULL AS exists`)).rows;
if (exists) {
  console.error('O schema já existe neste banco. Nada foi alterado.');
  await pool.end();
  process.exit(1);
}
await pool.query(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
console.log('ok: schema aplicado');
await pool.end();
