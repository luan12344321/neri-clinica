import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExplicitSsl } from '../src/db.js';

test('sslmode require/prefer/verify-ca viram verify-full; o resto (senha, host, parâmetros) fica igual', () => {
  const base = 'postgresql://user:p%40ss%2Fw0rd@ep-x-pooler.sa-east-1.aws.neon.tech/neondb';
  for (const m of ['require', 'prefer', 'verify-ca']) {
    const out = withExplicitSsl(`${base}?sslmode=${m}&channel_binding=require`);
    assert.equal(out, `${base}?sslmode=verify-full&channel_binding=require`);
  }
  assert.equal(withExplicitSsl(`${base}?sslmode=verify-full`), `${base}?sslmode=verify-full`);
  assert.equal(withExplicitSsl(`${base}`), base, 'sem sslmode não muda (banco de teste local)');
  assert.equal(withExplicitSsl(undefined), undefined);
  assert.equal(withExplicitSsl('isso nao e url'), 'isso nao e url');
});
