import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q, pool } from './db.js';
import { audit, auditCtx } from './audit.js';
import { blindIndex, decrypt, encrypt } from './crypto.js';
import { ensureSchema } from './schema.js';

// Verificação em duas etapas (TOTP, RFC 6238: HMAC-SHA1, 30 s, 6 dígitos) para dono e gerente.
// É opt-in: ninguém é obrigado a ativar, então nenhum administrador existente fica trancado para fora.
// O segredo fica cifrado (AAD amarrada ao usuário) e só aparece uma vez, na ativação. Os códigos de recuperação
// (10, uso único) só existem em claro na tela de ativação; no banco ficam apenas como HMAC.
export const MFA_ROLES = ['owner', 'manager'];
const STEP = 30, DIGITS = 6, WINDOW = 1, ISSUER = 'Neri Clinica';
const secretAad = (id) => `users.totp:${id}`;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32 = (buf) => {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
};
export const unbase32 = (s) => {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('base32 inválido');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

export const totpAt = (secret, step) => {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 10 ** DIGITS)).padStart(DIGITS, '0');
};
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// Devolve o intervalo (step) do código aceito, ou null. Janela de ±1 intervalo cobre relógio levemente desajustado.
export const matchTotp = (secret, code, now = Date.now()) => {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 1000 / STEP);
  for (let d = -WINDOW; d <= WINDOW; d++) if (same(totpAt(secret, cur + d), code)) return cur + d;
  return null;
};

const newRecoveryCode = () => { const r = base32(crypto.randomBytes(7)).toLowerCase(); return `${r.slice(0, 5)}-${r.slice(5, 10)}`; };
const normRecovery = (c) => String(c).trim().toLowerCase();
const looksRecovery = (c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(normRecovery(c));
const recoveryHash = (c) => blindIndex('mfa-recovery', normRecovery(c));

async function issueRecoveryCodes(c, userId) {
  await c.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  for (const code of codes) await c.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, recoveryHash(code)]);
  return codes;
}

// Confere um código de 6 dígitos ou de recuperação. TOTP: nunca duas vezes o mesmo intervalo (atômico no banco).
// Recuperação: uso único (UPDATE ... WHERE used_at IS NULL). Devolve 'totp' | 'recovery' | null.
export async function verifySecondFactor(userId, code) {
  const [u] = await q('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id=$1', [userId]);
  if (!u?.totp_enabled_at) return null;
  const input = String(code ?? '').replace(/\s/g, '');
  if (looksRecovery(input)) {
    const used = await q('UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [userId, recoveryHash(input)]);
    return used.length ? 'recovery' : null;
  }
  const step = matchTotp(unbase32(decrypt(u.totp_secret_enc, secretAad(userId))), input);
  if (step === null) return null;
  const won = await q('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [userId, step]);
  return won.length ? 'totp' : null;
}

export default async function mfa(app) {
  const eligible = { onRequest: [app.auth, async (req, reply) => {
    if (!MFA_ROLES.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };
  // Agem só sobre a PRÓPRIA conta: quem já tem MFA e foi rebaixado de perfil ainda precisa poder ver, desligar e renovar os códigos.
  const own = { onRequest: [app.auth] };
  const owner = { onRequest: [app.auth, async (req, reply) => {
    if (req.user.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
  }] };
  const limit = (max) => ({ rateLimit: { max, timeWindow: '1 minute' } });
  // O código de 6 dígitos tem 1 milhão de combinações: sem trava por usuário (vale para qualquer IP), daria para adivinhar.
  // A tentativa é RESERVADA antes de conferir o código, num UPDATE atômico da linha do usuário: uma rajada de requisições em paralelo
  // gasta as 5 tentativas da janela de 15 min (contada desde a primeira) em vez de passar todas pela checagem antes de qualquer falha ser gravada.
  // Custo conhecido: quem sabe a senha pode manter o dono travado repetindo isso; saída: script mfa-reset.js (PROCEDIMENTOS.md).
  const reserve = async (userId) => {
    const [r] = await q(`UPDATE users SET mfa_fails = CASE WHEN mfa_fail_at IS NULL OR mfa_fail_at < now() - interval '15 minutes' THEN 1 ELSE mfa_fails + 1 END,
      mfa_fail_at = CASE WHEN mfa_fail_at IS NULL OR mfa_fail_at < now() - interval '15 minutes' THEN now() ELSE mfa_fail_at END
      WHERE id=$1 RETURNING mfa_fails`, [userId]);
    return r.mfa_fails <= 5;
  };
  const clearFails = (userId) => q('UPDATE users SET mfa_fails=0, mfa_fail_at=NULL WHERE id=$1', [userId]);
  const needPassword = async (req, reply, password) => {
    const [u] = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.userId]);
    if (!(await bcrypt.compare(password, u.password_hash))) { reply.code(403).send({ error: 'wrong password' }); return false; }
    return true;
  };
  // Para desligar ou gerar códigos novos: senha + um segundo fator válido (com trava de tentativas).
  const reauth = async (req, reply, { password, code }) => {
    if (!(await needPassword(req, reply, password))) return false;
    if (!(await reserve(req.user.userId))) { reply.code(429).send({ error: 'too many attempts' }); return false; }
    if (!(await verifySecondFactor(req.user.userId, code))) {
      await audit(auditCtx(req), 'auth.mfa_failed', 'user', req.user.userId);
      reply.code(403).send({ error: 'invalid code' }); return false;
    }
    await clearFails(req.user.userId);
    return true;
  };

  app.get('/me/mfa', own, async (req) => {
    await ensureSchema();
    const [u] = await q('SELECT totp_enabled_at, (totp_secret_enc IS NOT NULL) AS pending FROM users WHERE id=$1', [req.user.userId]);
    const [{ n }] = await q('SELECT count(*)::int n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [req.user.userId]);
    return { enabled: !!u.totp_enabled_at, pending: !u.totp_enabled_at && u.pending, recoveryCodesLeft: u.totp_enabled_at ? n : 0 };
  });

  // 1) Gera o segredo (ainda desligado) e devolve o link para o app autenticador. Pede a senha.
  app.post('/me/mfa/setup', { ...eligible, config: limit(5) }, async (req, reply) => {
    await ensureSchema();
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    if (!(await needPassword(req, reply, password))) return;
    const [cur] = await q('SELECT email, totp_enabled_at FROM users WHERE id=$1', [req.user.userId]);
    if (cur.totp_enabled_at) return reply.code(409).send({ error: 'already enabled' });
    const secret = base32(crypto.randomBytes(20));
    await q('UPDATE users SET totp_secret_enc=$2, totp_last_step=NULL WHERE id=$1', [req.user.userId, encrypt(secret, secretAad(req.user.userId))]);
    await audit(auditCtx(req), 'mfa.setup_started', 'user', req.user.userId);
    const label = encodeURIComponent(`${ISSUER}:${cur.email}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}` };
  });

  // 2) Prova que o app autenticador foi configurado: liga o MFA e mostra os códigos de recuperação UMA vez.
  app.post('/me/mfa/enable', { ...eligible, config: limit(10) }, async (req, reply) => {
    await ensureSchema();
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    if (!(await reserve(req.user.userId))) return reply.code(429).send({ error: 'too many attempts' });
    const [u] = await q('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id=$1', [req.user.userId]);
    if (u.totp_enabled_at) return reply.code(409).send({ error: 'already enabled' });
    if (!u.totp_secret_enc) return reply.code(409).send({ error: 'setup first' });
    const step = matchTotp(unbase32(decrypt(u.totp_secret_enc, secretAad(req.user.userId))), code);
    if (step === null) { await audit(auditCtx(req), 'auth.mfa_failed', 'user', req.user.userId); return reply.code(403).send({ error: 'invalid code' }); }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rowCount } = await c.query('UPDATE users SET totp_enabled_at=now(), totp_last_step=$2 WHERE id=$1 AND totp_enabled_at IS NULL', [req.user.userId, step]);
      if (!rowCount) { await c.query('ROLLBACK'); return reply.code(409).send({ error: 'already enabled' }); }
      await c.query('UPDATE users SET mfa_fails=0, mfa_fail_at=NULL WHERE id=$1', [req.user.userId]);
      const recoveryCodes = await issueRecoveryCodes(c, req.user.userId);
      await c.query(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2::uuid,'mfa.enabled','user',$2::text,$3)`, [req.user.clinicId, req.user.userId, req.ip ?? null]);
      await c.query('COMMIT');
      return { enabled: true, recoveryCodes };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  app.post('/me/mfa/disable', { ...own, config: limit(5) }, async (req, reply) => {
    await ensureSchema();
    const b = z.object({ password: z.string().max(200), code: z.string().max(20) }).parse(req.body);
    if (!(await reauth(req, reply, b))) return;
    await q('UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1', [req.user.userId]);
    await q('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [req.user.userId]);
    await audit(auditCtx(req), 'mfa.disabled', 'user', req.user.userId);
    return { enabled: false };
  });

  app.post('/me/mfa/recovery-codes', { ...own, config: limit(5) }, async (req, reply) => {
    await ensureSchema();
    const b = z.object({ password: z.string().max(200), code: z.string().max(20) }).parse(req.body);
    if (!(await reauth(req, reply, b))) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const recoveryCodes = await issueRecoveryCodes(c, req.user.userId);
      await c.query(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2::uuid,'mfa.recovery_regenerated','user',$2::text,$3)`, [req.user.clinicId, req.user.userId, req.ip ?? null]);
      await c.query('COMMIT');
      return { recoveryCodes };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  });

  // Gerente que perdeu o celular e os códigos: o dono desliga o MFA dele (fica na auditoria). Ele ativa de novo depois.
  // Se for o DONO que ficou sem acesso, o procedimento é o script backend/scripts/mfa-reset.js (acesso ao servidor).
  app.post('/team/:id/mfa/reset', { ...owner, config: limit(10) }, async (req, reply) => {
    await ensureSchema();
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const r = await q(`UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL
                       WHERE id=$1 AND clinic_id=$2 AND role<>'owner' RETURNING id`, [id, req.user.clinicId]);
    if (!r.length) return reply.code(404).send({ error: 'not found' });
    await q('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [id]);
    await audit(auditCtx(req), 'mfa.reset_by_owner', 'user', id);
    return { ok: true };
  });

  // Segunda etapa do login: troca o token provisório (só vale para isto, 5 min) + código por uma sessão.
  app.post('/auth/mfa', { config: limit(10) }, async (req, reply) => {
    await ensureSchema();
    const { mfaToken, code } = z.object({ mfaToken: z.string().max(2000), code: z.string().max(20) }).parse(req.body);
    let p; try { p = app.jwt.verify(mfaToken); } catch { return reply.code(401).send({ error: 'invalid credentials' }); }
    if (p.purpose !== 'mfa' || !p.userId) return reply.code(401).send({ error: 'invalid credentials' });
    const [u] = await q(`SELECT id, clinic_id, role, password_hash FROM users WHERE id=$1 AND password_hash <> '!' AND totp_enabled_at IS NOT NULL`, [p.userId]);
    if (!u) return reply.code(401).send({ error: 'invalid credentials' });
    if (!(await reserve(u.id))) return reply.code(429).send({ error: 'too many attempts' });
    const how = await verifySecondFactor(u.id, code);
    if (!how) {
      await audit({ clinicId: u.clinic_id, userId: u.id, ip: req.ip }, 'auth.mfa_failed', 'user', u.id);
      return reply.code(401).send({ error: 'invalid code' });
    }
    await clearFails(u.id);
    await audit({ clinicId: u.clinic_id, userId: u.id, ip: req.ip }, how === 'recovery' ? 'auth.login_recovery_code' : 'auth.login', 'user', u.id);
    const [{ left }] = await q('SELECT count(*)::int left FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [u.id]);
    return { token: app.signSession(u), ...(how === 'recovery' ? { recoveryCodesLeft: left } : {}) };
  });
}
