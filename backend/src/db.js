import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // DATE como 'YYYY-MM-DD' (sem deslocamento de fuso)

// O pg trata sslmode=require/prefer/verify-ca como verify-full e avisa que isso muda na v9. Declaramos o comportamento atual
// (valida o certificado do banco) de forma explícita: mesma segurança, sem o aviso e sem depender da mudança futura.
export const withExplicitSsl = (url) => {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (['require', 'prefer', 'verify-ca'].includes(u.searchParams.get('sslmode'))) { u.searchParams.set('sslmode', 'verify-full'); return u.toString(); }
  } catch { /* string inválida: deixa o pg reclamar */ }
  return url;
};

export const pool = new pg.Pool({
  connectionString: withExplicitSsl(process.env.DATABASE_URL),
  // Serverless: cada instância tem o seu pool; poucas conexões por instância para não esgotar o Neon.
  max: Math.min(Number(process.env.PG_POOL_MAX ?? 10), process.env.VERCEL ? 2 : Infinity),
  idleTimeoutMillis: 10_000,        // serverless: não segura conexão ociosa
  connectionTimeoutMillis: 10_000,
});

// Toda consulta de negócio passa clinic_id explicitamente (isolamento multi-tenant).
export const q = (text, params) => pool.query(text, params).then((r) => r.rows);
