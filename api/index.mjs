import app from '../backend/src/app.js';

// Função Node da Vercel -> Fastify, usando o `inject` do próprio Fastify (mesmo padrão de netlify/functions/api.mjs).
// O prefixo /api é removido pelo `rewriteUrl` do app. O vercel.json encaminha todo /api/* para esta função.
const SKIP_IN = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);
const SKIP_OUT = new Set(['connection', 'transfer-encoding']);

export default async function handler(req, res) {
  await app.ready();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !SKIP_IN.has(k)));
  const out = await app.inject({
    method: req.method,
    url: req.url,
    headers,
    payload: chunks.length ? Buffer.concat(chunks) : undefined,
    // IP real do cliente (auditoria e limite de tentativas de login); a Vercel preenche x-forwarded-for.
    remoteAddress: String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress,
  });
  res.statusCode = out.statusCode;
  for (const [k, v] of Object.entries(out.headers)) if (!SKIP_OUT.has(k)) res.setHeader(k, v);
  res.end(out.rawPayload);
}
