// Uso: npm run db:init  (cria schema + dados demo no DATABASE_URL). Login: gestor@demo.test / demo1234
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const read = (f) => readFileSync(new URL(`../../db/${f}`, import.meta.url), 'utf8');
const hash = await bcrypt.hash('demo1234', 10);
await pool.query(read('schema.sql'));
await pool.query(read('seed.sql').replaceAll(':hash', () => hash));
console.log('ok: schema + seed aplicados');
await pool.end();
