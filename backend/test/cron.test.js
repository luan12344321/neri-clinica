import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => { t = await setup(); });
after(() => t.close());
beforeEach(() => t.reset());

test('cron/tick: fechado sem segredo, recusa token errado e aceita o certo', async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await t.app.inject({ method: 'GET', url: '/cron/tick' })).statusCode, 503);
  process.env.CRON_SECRET = 'segredo-de-teste';
  assert.equal((await t.app.inject({ method: 'GET', url: '/cron/tick' })).statusCode, 401);
  assert.equal((await t.app.inject({ method: 'GET', url: '/cron/tick', headers: { authorization: 'Bearer errado-errado' } })).statusCode, 401);
  const ok = await t.app.inject({ method: 'GET', url: '/cron/tick', headers: { authorization: 'Bearer segredo-de-teste' } });
  assert.equal(ok.statusCode, 200);
  delete process.env.CRON_SECRET;
});
