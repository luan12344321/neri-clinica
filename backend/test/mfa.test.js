import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, A } from './helpers.js';

let t, M;
before(async () => { t = await setup(); M = await import('../src/mfa.js'); });
after(() => t.close());
beforeEach(async () => {
  await t.reset(); await t.addExtras();
  await t.sql(`INSERT INTO users (clinic_id, name, email, password_hash, role)
    SELECT $1, 'Gerente', 'gerente@demo.test', password_hash, 'manager' FROM users WHERE email='gestor@demo.test'`, [A]);
});

const step = () => Math.floor(Date.now() / 30000);
const codeFor = (secret, d = 0) => M.totpAt(M.unbase32(secret), step() + d);
const login = (email, password = 'demo1234') => t.call('POST', '/auth/login', { body: { email, password } });
const enroll = async (email) => {
  const token = await t.tokenFor(email);
  const s = await t.call('POST', '/me/mfa/setup', { token, body: { password: 'demo1234' } });
  assert.equal(s.status, 200);
  const en = await t.call('POST', '/me/mfa/enable', { token, body: { code: codeFor(s.json.secret) } });
  assert.equal(en.status, 200);
  return { token, secret: s.json.secret, codes: en.json.recoveryCodes };
};

test('TOTP: vetores do RFC 6238 (SHA-1) e base32 ida e volta', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(M.totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(M.totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(M.totpAt(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(M.base32(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(M.unbase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), secret);
  assert.equal(M.matchTotp(secret, '287082', 59_000), 1);
  assert.equal(M.matchTotp(secret, '287082', 59_000 + 30_000), 1, 'tolera 1 intervalo de relógio');
  assert.equal(M.matchTotp(secret, '287082', 59_000 + 95_000), null, 'fora da janela');
  assert.equal(M.matchTotp(secret, '12345', 59_000), null);
  assert.equal(M.matchTotp(secret, 'abcdef', 59_000), null);
});

test('ativação: pede senha, só dono/gerente, código errado não liga, certo liga e mostra 10 códigos uma vez', async () => {
  const owner = await t.tokenFor('gestor@demo.test');
  assert.equal((await t.call('POST', '/me/mfa/setup', { token: await t.tokenFor('recepcao@demo.test'), body: { password: 'demo1234' } })).status, 403);
  assert.equal((await t.call('POST', '/me/mfa/setup', { body: { password: 'demo1234' } })).status, 401);
  assert.equal((await t.call('POST', '/me/mfa/setup', { token: owner, body: { password: 'errada' } })).status, 403);
  const s = await t.call('POST', '/me/mfa/setup', { token: owner, body: { password: 'demo1234' } });
  assert.match(s.json.otpauthUrl, /^otpauth:\/\/totp\/Neri%20Clinica%3Agestor%40demo\.test\?secret=[A-Z2-7]+&issuer=Neri%20Clinica&algorithm=SHA1&digits=6&period=30$/);
  assert.deepEqual((await t.call('GET', '/me/mfa', { token: owner })).json, { enabled: false, pending: true, recoveryCodesLeft: 0 });
  assert.equal((await t.call('POST', '/me/mfa/enable', { token: owner, body: { code: '000000' } })).status, 403);
  assert.equal((await login('gestor@demo.test')).json.mfaRequired, undefined, 'segredo pendente não liga nada');
  const en = await t.call('POST', '/me/mfa/enable', { token: owner, body: { code: codeFor(s.json.secret) } });
  assert.equal(en.json.recoveryCodes.length, 10);
  assert.ok(en.json.recoveryCodes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)) && new Set(en.json.recoveryCodes).size === 10);
  assert.deepEqual((await t.call('GET', '/me/mfa', { token: owner })).json, { enabled: true, pending: false, recoveryCodesLeft: 10 });
  assert.equal((await t.call('POST', '/me/mfa/enable', { token: owner, body: { code: codeFor(s.json.secret, 1) } })).status, 409, 'já ligado');
  assert.equal((await t.call('POST', '/me/mfa/setup', { token: owner, body: { password: 'demo1234' } })).status, 409, 'não troca o segredo ligado sem desligar');
});

test('login com MFA: senha sozinha não dá sessão; token provisório não abre nada; código certo abre; repetir o mesmo código falha', async () => {
  const { secret } = await enroll('gestor@demo.test');
  const l = await login('gestor@demo.test');
  assert.equal(l.status, 200); assert.equal(l.json.token, undefined); assert.equal(l.json.mfaRequired, true);
  assert.equal((await t.call('GET', '/me', { token: l.json.mfaToken })).status, 401, 'token provisório não é sessão');
  assert.equal((await t.call('GET', '/sara/history', { token: l.json.mfaToken })).status, 401);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: l.json.mfaToken, code: '000000' } })).status, 401);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: 'lixo', code: '123456' } })).status, 401);
  const sessao = await t.tokenFor('gestor@demo.test');
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: sessao, code: codeFor(secret, 1) } })).status, 401, 'token de sessão não serve como provisório');
  // o código usado na ativação (intervalo atual) não vale de novo; o do próximo intervalo vale
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: l.json.mfaToken, code: codeFor(secret) } })).status, 401, 'replay');
  const ok = await t.call('POST', '/auth/mfa', { body: { mfaToken: l.json.mfaToken, code: codeFor(secret, 1) } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call('GET', '/me', { token: ok.json.token })).json.email, 'gestor@demo.test');
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: l.json.mfaToken, code: codeFor(secret, 1) } })).status, 401, 'o mesmo código não entra duas vezes');
  assert.ok((await login('recepcao@demo.test')).json.token, 'quem não ativou continua entrando só com a senha');
});

test('códigos de recuperação: uso único, aceitos em maiúsculas/espaços, avisam quantos restam', async () => {
  const { codes } = await enroll('gerente@demo.test');
  const first = (await login('gerente@demo.test')).json.mfaToken;
  const r = await t.call('POST', '/auth/mfa', { body: { mfaToken: first, code: ` ${codes[0].toUpperCase()} ` } });
  assert.equal(r.status, 200); assert.equal(r.json.recoveryCodesLeft, 9);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: first, code: codes[0] } })).status, 401, 'uso único');
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken: first, code: 'aaaaa-bbbbb' } })).status, 401);
  assert.equal((await t.sql(`SELECT 1 FROM audit_log WHERE action='auth.login_recovery_code'`)).length, 1);
});

test('força bruta: 5 códigos errados travam a conta por 15 min, mesmo com o código certo e de outro IP', async () => {
  const { secret } = await enroll('gestor@demo.test');
  const mfaToken = (await login('gestor@demo.test')).json.mfaToken;
  for (let i = 0; i < 5; i++) assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: '000000' }, ip: `10.0.0.${i + 1}` })).status, 401);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: codeFor(secret, 1) }, ip: '10.9.9.9' })).status, 429);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: codeFor(secret, 1) } })).status, 429, 'tentar de novo não prolonga nem destrava');
  await t.sql(`UPDATE users SET mfa_fail_at = now() - interval '16 minutes' WHERE email='gestor@demo.test'`);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: codeFor(secret, 1) } })).status, 200, 'destrava depois da janela');
  assert.deepEqual((await t.sql(`SELECT mfa_fails, mfa_fail_at FROM users WHERE email='gestor@demo.test'`))[0], { mfa_fails: 0, mfa_fail_at: null }, 'sucesso zera a contagem');
});

test('rajada de tentativas em paralelo: só 5 chegam a ser conferidas; o resto leva 429 (tentativa reservada antes da conferência)', async () => {
  const { secret } = await enroll('gestor@demo.test');
  const mfaToken = (await login('gestor@demo.test')).json.mfaToken;
  const wrong = await Promise.all(Array.from({ length: 20 }, (_, i) => t.call('POST', '/auth/mfa', { body: { mfaToken, code: String(100000 + i) }, ip: `10.1.0.${i + 1}` })));
  const counts = wrong.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { 401: 5, 429: 15 });
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: codeFor(secret, 1) } })).status, 429);
});

test('MFA depois de rebaixar o perfil: a própria pessoa ainda vê, renova códigos e desliga', async () => {
  const { token, secret } = await enroll('gerente@demo.test');
  await t.sql(`UPDATE users SET role='reception' WHERE email='gerente@demo.test'`);
  const rec = await t.tokenFor('gerente@demo.test');
  assert.equal((await t.call('GET', '/me/mfa', { token: rec })).json.enabled, true);
  assert.equal((await t.call('POST', '/me/mfa/setup', { token: rec, body: { password: 'demo1234' } })).status, 403, 'ativar continua só dono/gerente');
  assert.equal((await t.call('POST', '/me/mfa/disable', { token: rec, body: { password: 'demo1234', code: codeFor(secret, 1) } })).status, 200);
  void token;
});

test('segredo protegido: cifrado no banco, preso ao usuário (AAD), fora de /team e da exportação; códigos só como hash', async () => {
  const { secret, codes } = await enroll('gestor@demo.test');
  const [row] = await t.sql(`SELECT id, totp_secret_enc FROM users WHERE email='gestor@demo.test'`);
  assert.ok(row.totp_secret_enc.startsWith('v1:') && !row.totp_secret_enc.includes(secret));
  const { decrypt } = await import('../src/crypto.js');
  assert.equal(decrypt(row.totp_secret_enc, `users.totp:${row.id}`), secret);
  assert.throws(() => decrypt(row.totp_secret_enc, 'users.totp:outro'), 'copiar para outra linha não decifra');
  const all = JSON.stringify(await t.sql('SELECT * FROM mfa_recovery_codes'));
  assert.ok(codes.every((c) => !all.includes(c)), 'códigos de recuperação não ficam em claro');
  const owner = await t.tokenFor('gestor@demo.test');
  const team = JSON.stringify((await t.call('GET', '/team', { token: owner })).json);
  assert.ok(!/totp|secret/i.test(team) && !team.includes(secret));
  const { exportClinic } = await import('../src/export.js');
  const exp = JSON.stringify(await exportClinic(A));
  assert.ok(!exp.includes(secret) && !/totp_secret/.test(exp));
  assert.ok(!JSON.stringify((await t.call('GET', '/me/mfa', { token: owner })).json).includes(secret), 'o segredo só aparece na ativação');
});

test('desligar e novos códigos exigem senha + segundo fator; dono redefine o MFA de gerente; ninguém mais', async () => {
  const { token, secret } = await enroll('gerente@demo.test');
  const owner = await t.tokenFor('gestor@demo.test');
  const body = (o) => ({ token, body: { password: 'demo1234', ...o } });
  assert.equal((await t.call('POST', '/me/mfa/disable', body({ password: 'x', code: codeFor(secret, 1) }))).status, 403);
  assert.equal((await t.call('POST', '/me/mfa/disable', body({ code: '111111' }))).status, 403);
  const regen = await t.call('POST', '/me/mfa/recovery-codes', body({ code: codeFor(secret, 1) }));
  assert.equal(regen.json.recoveryCodes.length, 10);
  assert.equal((await t.sql('SELECT count(*)::int n FROM mfa_recovery_codes WHERE used_at IS NULL'))[0].n, 10, 'os antigos foram substituídos');
  const dis = await t.call('POST', '/me/mfa/disable', body({ code: regen.json.recoveryCodes[0] }));
  assert.equal(dis.status, 200);
  assert.ok((await login('gerente@demo.test')).json.token, 'sem MFA volta a entrar só com a senha');
  assert.equal((await t.sql('SELECT count(*)::int n FROM mfa_recovery_codes'))[0].n, 0);
  const e2 = await enroll('gerente@demo.test');
  const [g] = await t.sql(`SELECT id FROM users WHERE email='gerente@demo.test'`);
  assert.equal((await t.call('POST', `/team/${g.id}/mfa/reset`, { token: e2.token })).status, 403, 'gerente não redefine');
  const [o] = await t.sql(`SELECT id FROM users WHERE email='gestor@demo.test'`);
  assert.equal((await t.call('POST', `/team/${o.id}/mfa/reset`, { token: owner })).status, 404, 'o dono não se redefine por aqui');
  assert.equal((await t.call('POST', `/team/${g.id}/mfa/reset`, { token: await t.tokenFor('b@demo.test') })).status, 404, 'outra clínica');
  assert.equal((await t.call('POST', `/team/${g.id}/mfa/reset`, { token: owner })).status, 200);
  assert.ok((await login('gerente@demo.test')).json.token);
  const actions = (await t.sql(`SELECT action FROM audit_log WHERE action LIKE 'mfa.%' OR action='auth.mfa_failed' ORDER BY id`)).map((r) => r.action);
  for (const a of ['mfa.setup_started', 'mfa.enabled', 'mfa.recovery_regenerated', 'mfa.disabled', 'mfa.reset_by_owner', 'auth.mfa_failed']) assert.ok(actions.includes(a), a);
});

test('usuário removido não passa pela segunda etapa', async () => {
  const { secret } = await enroll('gerente@demo.test');
  const mfaToken = (await login('gerente@demo.test')).json.mfaToken;
  const owner = await t.tokenFor('gestor@demo.test');
  const [g] = await t.sql(`SELECT id FROM users WHERE email='gerente@demo.test'`);
  assert.equal((await t.call('DELETE', `/team/${g.id}`, { token: owner })).status, 204);
  assert.equal((await t.call('POST', '/auth/mfa', { body: { mfaToken, code: codeFor(secret, 1) } })).status, 401);
});

test('script mfa-reset: simula por padrão, --apply desliga e audita, dono volta a entrar só com a senha', async () => {
  const { main } = await import('../scripts/mfa-reset.js');
  const run = async (...a) => { let out = ''; const code = await main(a, (x) => { out += `${x}\n`; }); return { code, out }; };
  await enroll('gestor@demo.test');
  assert.equal((await login('gestor@demo.test')).json.mfaRequired, true);
  const dry = await run('gestor@demo.test');
  assert.equal(dry.code, 0); assert.match(dry.out, /LIGADA/); assert.match(dry.out, /Nada alterado/);
  assert.equal((await login('gestor@demo.test')).json.mfaRequired, true, 'simulação não mexeu');
  assert.equal((await run('naoexiste@x.com')).code, 1);
  assert.equal((await run()).code, 1);
  assert.equal((await run('gestor@demo.test', '--apply')).code, 0);
  assert.ok((await login('gestor@demo.test')).json.token);
  assert.equal((await t.sql(`SELECT count(*)::int n FROM audit_log WHERE action='mfa.reset_by_operator'`))[0].n, 1);
  assert.equal((await t.sql('SELECT count(*)::int n FROM mfa_recovery_codes'))[0].n, 0);
});
