import { z } from 'zod';
import { q } from './db.js';
import { audit, auditCtx } from './audit.js';
import { ensureSchema } from './schema.js';

// Horário de atendimento da clínica: por dia da semana (0 = domingo … 6 = sábado), com até 3 faixas "HH:MM" em
// intervalos de 30 min. O padrão é 08:00–11:00 e 13:00–18:00 de segunda a sexta. Serve para a agenda oferecer
// só os horários em que a clínica atende; não é uma regra de segurança (um encaixe fora do expediente é possível na tela).
const WORK = [['08:00', '11:00'], ['13:00', '18:00']];
export const DEFAULT_HOURS = { 0: [], 1: WORK, 2: WORK, 3: WORK, 4: WORK, 5: WORK, 6: [] };

const TZ = 'America/Sao_Paulo';
// Data (YYYY-MM-DD) e minuto do dia em São Paulo, e se a clínica está dentro de alguma faixa do expediente.
export function spClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}
export function isOpenNow(workingHours, now = new Date()) {
  const { minutes, weekday } = spClock(now);
  return ((workingHours ?? DEFAULT_HOURS)[weekday] ?? []).some(([s, e]) => minutes >= toMin(s) && minutes < toMin(e));
}

const time = z.string().regex(/^([01]\d|2[0-3]):(00|30)$/, 'horário em HH:00 ou HH:30');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const day = z.array(z.tuple([time, time])).max(3).superRefine((faixas, ctx) => {
  let prevEnd = -1;
  for (const [s, e] of faixas) {
    if (toMin(e) <= toMin(s)) ctx.addIssue({ code: 'custom', message: 'o fim precisa ser depois do início' });
    if (toMin(s) < prevEnd) ctx.addIssue({ code: 'custom', message: 'faixas em ordem e sem sobreposição' });
    prevEnd = toMin(e);
  }
});
const body = z.object({ hours: z.object({ 0: day, 1: day, 2: day, 3: day, 4: day, 5: day, 6: day }) });

export default async function hours(app) {
  const manager = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };

  // Qualquer usuário logado lê (a agenda precisa); só dono e gerente alteram.
  app.get('/clinic/hours', { onRequest: [app.auth] }, async (req) => {
    await ensureSchema();
    const [c] = await q('SELECT working_hours FROM clinics WHERE id=$1', [req.user.clinicId]);
    return { hours: c?.working_hours ?? DEFAULT_HOURS, isDefault: !c?.working_hours };
  });

  app.put('/clinic/hours', manager, async (req) => {
    await ensureSchema();
    const { hours: h } = body.parse(req.body);
    await q('UPDATE clinics SET working_hours=$2 WHERE id=$1', [req.user.clinicId, JSON.stringify(h)]);
    await audit(auditCtx(req), 'clinic.hours_update', 'clinic', req.user.clinicId);
    return { hours: h, isDefault: false };
  });
}
