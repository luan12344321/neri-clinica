import app from '../backend/src/app.js';

// Função Node da Vercel -> Fastify: repassa a requisição direto ao servidor HTTP do app (sem `inject`,
// cujo pacote light-my-request usa require() de módulo ESM e quebra neste runtime).
// O prefixo /api é removido pelo `rewriteUrl` do app; o vercel.json encaminha todo /api/* para esta função.
export default async function handler(req, res) {
  await app.ready();
  app.server.emit('request', req, res);
}
