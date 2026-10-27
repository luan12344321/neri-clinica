import { test } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';

// Garante que as expressões e o fuso usados em jobs.js continuam válidos na versão instalada do node-cron.
const SCHEDULES = ['0 9 * * *', '*/15 * * * *', '5 * * * *', '0 6 1 * *', '* * * * *', '*/5 * * * *'];

test('expressões cron de jobs.js são válidas', () => {
  for (const s of SCHEDULES) assert.equal(cron.validate(s), true, s);
});

test('agendar com timezone e parar não lança erro', () => {
  const task = cron.schedule('0 9 * * *', () => {}, { timezone: 'America/Sao_Paulo' });
  assert.ok(task);
  task.stop();
});
