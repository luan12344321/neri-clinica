import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // DATE como 'YYYY-MM-DD' (sem deslocamento de fuso)

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 10_000,        // serverless: não segura conexão ociosa
  connectionTimeoutMillis: 10_000,
});

// Toda consulta de negócio passa clinic_id explicitamente (isolamento multi-tenant).
export const q = (text, params) => pool.query(text, params).then((r) => r.rows);
