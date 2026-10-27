import { tick } from '../../backend/src/jobs.js';

// Cron do Netlify (UTC, limite de 30 s, só no deploy publicado). Um único job idempotente roda tudo
// (aniversários, pós-procedimento, estoque, DRE, envio de mensagens, Google Agenda) e decide sozinho o que está na hora.
// Se o seu plano não aceitar frequência menor que 1 hora, troque por "@hourly": tudo continua funcionando.
export default async () => {
  const result = await tick();
  console.log(JSON.stringify({ jobs: result }));
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/5 * * * *' };
