import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import bcrypt from 'bcryptjs';

export const A = '00000000-0000-0000-0000-000000000001'; // clínica do seed
export const B = '00000000-0000-0000-0000-0000000000b1'; // segunda clínica, para testes de isolamento

const sqlFile = (f) => readFileSync(new URL(`../../db/${f}`, import.meta.url), 'utf8');
const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// Cada arquivo de teste roda em seu próprio processo, com seu próprio Postgres embutido (PGlite).
export async function setup() {
  const port = await freePort();
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  Object.assign(process.env, {
    NODE_ENV: 'test', PG_POOL_MAX: '1', JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    ENCRYPTION_KEY: 'ab'.repeat(32), GEMINI_API_KEY: 'test',
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REDIRECT_URI: 'http://localhost/cb',
  });
  const { default: app } = await import('../src/app.js');
  const { pool } = await import('../src/db.js');
  const hash = bcrypt.hashSync('demo1234', 4);

  const sql = async (text, params) => (await db.query(text, params)).rows;
  const t = {
    app, pool, sql,
    async reset() {
      // O PGlite derruba a conexão depois de um erro de SQL; descarta a conexão morta antes do próximo teste.
      try { await pool.query('SELECT 1'); } catch { /* ECONNRESET esperado */ }
      await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await db.exec(sqlFile('schema.sql'));
      await db.exec(sqlFile('seed.sql').replaceAll(':hash', () => hash));
    },
    // Clínica B (1 usuário, 1 paciente) + usuário "recepção" na clínica A.
    async addExtras() {
      await db.exec(`
        INSERT INTO clinics (id, name) VALUES ('${B}', 'Clínica B');
        INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES
          ('${B}', 'Gestor B', 'b@demo.test', '${hash}', 'owner'),
          ('${A}', 'Recepção', 'recepcao@demo.test', '${hash}', 'reception');
        INSERT INTO patients (id, clinic_id, full_name) VALUES ('2b000000-0000-0000-0000-000000000001', '${B}', 'Paciente B');`);
    },
    async tokenFor(email) {
      const [u] = await sql('SELECT id, clinic_id, role FROM users WHERE email=$1', [email]);
      return app.jwt.sign({ userId: u.id, clinicId: u.clinic_id, role: u.role }, { expiresIn: '1h' });
    },
    async call(method, url, { token, body, ip } = {}) {
      const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: body ?? (method === 'GET' ? undefined : {}), remoteAddress: ip });
      let json = null; try { json = res.json(); } catch { /* corpo vazio */ }
      return { status: res.statusCode, json, headers: res.headers };
    },
    async close() { await app.close(); await pool.end(); await server.stop(); await db.close(); },
  };
  return t;
}

export const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
