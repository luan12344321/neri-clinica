import { q } from './db.js';
import { ensureSchema } from './schema.js';

// Quem está com o app aberto. Sem conexão permanente (serverless), o app avisa a cada ~45 s ("ping")
// e quem avisou nos últimos 2 min está online. Só o proprietário consulta a lista.
const ONLINE_WINDOW = '2 minutes';
const MIN_GAP = '30 seconds'; // não grava mais de uma vez a cada 30 s por usuário

export default async function presence(app) {
  const owner = { onRequest: [app.auth, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
  }] };

  // Melhor esforço: falhar aqui nunca deve atrapalhar quem está usando o app.
  app.post('/presence/ping', { onRequest: [app.auth] }, async (req, reply) => {
    try {
      await ensureSchema();
      await q(`UPDATE users SET last_seen_at = now()
               WHERE id=$1 AND clinic_id=$2 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '${MIN_GAP}')`,
        [req.user.userId, req.user.clinicId]);
    } catch (e) { req.log.warn(e); }
    return reply.code(204).send();
  });

  app.get('/presence', owner, async (req) => {
    try {
      await ensureSchema();
      return await q(`SELECT id, name, role, last_seen_at AS "lastSeenAt",
                             COALESCE(last_seen_at > now() - interval '${ONLINE_WINDOW}', false) AS online
                      FROM users WHERE clinic_id=$1 AND password_hash <> '!'
                      ORDER BY online DESC, last_seen_at DESC NULLS LAST, name`, [req.user.clinicId]);
    } catch (e) { req.log.warn(e); return []; }
  });
}
