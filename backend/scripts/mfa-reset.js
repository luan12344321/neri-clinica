// Recuperação de acesso: desliga a verificação em duas etapas de UM usuário (ex.: dono que perdeu o celular E os códigos de recuperação).
// Uso (procedimento em backend/docs/PROCEDIMENTOS.md):
//   node --env-file=.env scripts/mfa-reset.js dono@clinica.com            -> só mostra o que seria feito
//   node --env-file=.env scripts/mfa-reset.js dono@clinica.com --apply    -> desliga e registra na auditoria
// Exige acesso ao servidor/banco (quem tem DATABASE_URL já controla tudo). Confirme a identidade da pessoa antes, por outro canal.
import { fileURLToPath } from 'node:url';
import { q } from '../src/db.js';
import { ensureSchema } from '../src/schema.js';

export async function main(argv = [], log = console.log) {
  const email = argv.find((a) => !a.startsWith('--'))?.toLowerCase();
  const apply = argv.includes('--apply');
  if (!email) { log('Informe o e-mail do usuário.'); return 1; }
  await ensureSchema();
  const [u] = await q('SELECT id, clinic_id, name, role, totp_enabled_at FROM users WHERE email=$1', [email]);
  if (!u) { log('Usuário não encontrado.'); return 1; }
  log(`${u.name} (${u.role}): verificação em duas etapas ${u.totp_enabled_at ? 'LIGADA' : 'desligada'}.`);
  if (!u.totp_enabled_at) return 0;
  if (!apply) { log('Nada alterado. Rode de novo com --apply para desligar.'); return 0; }
  await q('UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1', [u.id]);
  await q('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [u.id]);
  await q(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id) VALUES ($1,NULL,'mfa.reset_by_operator','user',$2)`, [u.clinic_id, u.id]);
  log('Desligada. A pessoa entra só com a senha e deve ativar de novo em Configurações.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('../src/db.js');
  process.exitCode = await main(process.argv.slice(2));
  await pool.end();
}
