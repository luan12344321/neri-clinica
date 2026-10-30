// Uso: npm run dev:local  (Postgres embutido PGlite em .pglite-data, ignora DATABASE_URL do .env)
// Login demo: gestor@demo.test / demo1234
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';

const read = (f) => readFileSync(new URL(`../../db/${f}`, import.meta.url), 'utf8');
const db = await PGlite.create('./.pglite-data');
const [{ exists }] = (await db.query(`SELECT to_regclass('public.clinics') IS NOT NULL AS exists`)).rows;
if (!exists) {
  await db.exec(read('schema.sql'));
  await db.exec(read('seed.sql').replaceAll(':hash', () => bcrypt.hashSync('demo1234', 10)));
  console.log('ok: schema + seed aplicados');
}
const port = 5433;
await new PGLiteSocketServer({ db, port, host: '127.0.0.1' }).start();
process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
process.env.LISTEN_HOST ||= '127.0.0.1'; // dev: só esta máquina (o segredo e a chave de dev abaixo são públicos no repositório)
process.env.PG_POOL_MAX = '1'; // PGlite aceita uma conexão por vez
process.env.JWT_SECRET ||= 'dev-secret-dev-secret-dev-secret-1234';
process.env.ENCRYPTION_KEY ||= 'ab'.repeat(32);
await import('../src/server.js');
