import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';

// Equipe da clínica. Só um proprietário cria, edita e remove usuários. Outro proprietário só pode ser criado (não é editado nem removido
// depois: o papel 'owner' fica fora do PATCH/DELETE, então ninguém tira o acesso de um dono por aqui).
const ROLES = ['manager', 'professional', 'reception'];
const password = z.string().min(10, 'A senha precisa ter pelo menos 10 caracteres').max(200);
// '!' nunca é um hash bcrypt válido: usuário com esse valor não entra e seu token deixa de valer (ver app.auth).
// Assim o acesso é removido sem apagar o registro, que auditoria e prontuário continuam referenciando.
export const REVOKED = '!';
const COLS = `id, name, email, role, created_at, password_hash = '${REVOKED}' AS revoked`;

export default async function team(app) {
  const owner = { onRequest: [app.auth, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
  }] };
  const cid = (req) => req.user.clinicId;
  const dupEmail = (e) => e.code === '23505';

  app.get('/team', owner, (req) =>
    q(`SELECT ${COLS} FROM users WHERE clinic_id=$1 ORDER BY (role='owner') DESC, name`, [cid(req)]));

  app.post('/team', owner, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(),
      password, role: z.enum(['owner', ...ROLES]) }).parse(req.body);
    try {
      const [u] = await q(`INSERT INTO users (clinic_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
        [cid(req), b.name, b.email.toLowerCase(), await bcrypt.hash(b.password, 10), b.role]);
      await audit(auditCtx(req), 'team.create', 'user', u.id);
      return reply.code(201).send(u);
    } catch (e) {
      if (dupEmail(e)) return reply.code(409).send({ error: 'email in use' });
      throw e;
    }
  });

  // Edita nome, perfil e/ou redefine a senha de um funcionário (nunca do dono).
  app.patch('/team/:id', owner, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), role: z.enum(ROLES).optional(), password: password.optional() })
      .refine((v) => Object.keys(v).length > 0, 'nada para alterar').parse(req.body);
    const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
    // Reativar alguém removido (nova senha) não religa a Agenda Google antiga dele: precisa conectar de novo.
    const [u] = await q(`UPDATE users SET name=COALESCE($3,name), role=COALESCE($4,role), password_hash=COALESCE($5,password_hash),
                           google_refresh_token_enc=CASE WHEN password_hash='!' THEN NULL ELSE google_refresh_token_enc END,
                           google_sync_token=CASE WHEN password_hash='!' THEN NULL ELSE google_sync_token END
                         WHERE id=$1 AND clinic_id=$2 AND role<>'owner' RETURNING ${COLS}`,
      [id, cid(req), b.name ?? null, b.role ?? null, hash]);
    if (!u) return reply.code(404).send({ error: 'not found' });
    await audit(auditCtx(req), b.password ? 'team.password_reset' : 'team.update', 'user', id);
    return u;
  });

  // Remove o acesso (não apaga o usuário). Para reativar, o dono redefine a senha dele.
  app.delete('/team/:id', owner, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    // Também desliga a Agenda Google dele: senão os agendamentos (nome do paciente) continuariam indo para a agenda pessoal
    // de quem saiu, e o que ele mexesse lá voltaria para a agenda da clínica.
    const [u] = await q(`UPDATE users SET password_hash=$3, google_refresh_token_enc=NULL, google_sync_token=NULL
                         WHERE id=$1 AND clinic_id=$2 AND role<>'owner' RETURNING id`, [id, cid(req), REVOKED]);
    if (!u) return reply.code(404).send({ error: 'not found' });
    await audit(auditCtx(req), 'team.revoke', 'user', id);
    return reply.code(204).send();
  });
}
