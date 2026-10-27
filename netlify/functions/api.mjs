import app from '../../backend/src/app.js';

// Adaptador Netlify Functions (Request/Response) -> Fastify, usando o `inject` do próprio Fastify.
// O app é o mesmo de backend/src/server.js; aqui só traduzimos a requisição e a resposta.
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

export default async (req, context) => {
  await app.ready();
  const url = new URL(req.url);
  const headers = Object.fromEntries([...req.headers].filter(([k]) => !HOP_BY_HOP.has(k)));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());

  const res = await app.inject({
    method: req.method,
    url: url.pathname.replace(/^\/api/, '') + url.search,
    headers,
    payload: body,
    remoteAddress: context?.ip, // IP real do cliente (auditoria e limite de tentativas de login)
  });

  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) for (const item of [].concat(v)) out.append(k, String(item));
  const empty = res.statusCode === 204 || res.statusCode === 304;
  return new Response(empty ? null : res.rawPayload, { status: res.statusCode, headers: out });
};

// Limite por IP na borda do Netlify (vale entre invocações, ao contrário de um contador em memória).
export const config = {
  path: '/api/*',
  rateLimit: { windowLimit: 300, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
