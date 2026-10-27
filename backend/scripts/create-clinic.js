// Uso (a senha vem do ambiente, para não ficar no histórico do terminal):
//   $env:OWNER_PASSWORD='senha-forte'; npm run clinic:create -- "Nome da Clínica" dono@email.com "Nome do Dono"
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const [clinicName, email, ownerName] = process.argv.slice(2);
const password = process.env.OWNER_PASSWORD;
if (!clinicName || !email || !ownerName || !password) {
  console.error('Uso: OWNER_PASSWORD=... npm run clinic:create -- "Clínica" email "Nome do dono"');
  process.exit(1);
}
if (password.length < 10) { console.error('Use uma senha com pelo menos 10 caracteres.'); process.exit(1); }

const c = await pool.connect();
try {
  await c.query('BEGIN');
  const { rows: [clinic] } = await c.query('INSERT INTO clinics (name) VALUES ($1) RETURNING id', [clinicName]);
  await c.query(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner')`,
    [clinic.id, ownerName, email.toLowerCase(), await bcrypt.hash(password, 12)]);
  await c.query('COMMIT');
  console.log(`ok: clínica "${clinicName}" criada; login: ${email.toLowerCase()}`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error(e.code === '23505' ? 'Já existe um usuário com esse e-mail.' : e.message);
  process.exitCode = 1;
} finally { c.release(); await pool.end(); }
