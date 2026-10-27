import cron from 'node-cron';
import { q } from './db.js';
import { buildDre } from './queries.js';
import { syncAllClinics } from './google.js';

const TZ = 'America/Sao_Paulo';
const render = (body, vars) => body.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

// Todos os jobs são idempotentes (dedupe_key + ON CONFLICT DO NOTHING): rodar duas vezes não duplica envio.
// Em produção com várias instâncias, rode os crons em UM worker (ou use pg-boss/BullMQ).
export const tasks = {
  // só quem deu consentimento de marketing
  birthday: () => q(
    `INSERT INTO message_queue (clinic_id, patient_id, kind, body, dedupe_key)
     SELECT p.clinic_id, p.id, 'birthday', t.body, 'bday:' || p.id || ':' || extract(year from now())
     FROM patients p JOIN message_templates t ON t.clinic_id=p.clinic_id AND t.kind='birthday'
     WHERE p.marketing_consent AND p.birth_date IS NOT NULL
       AND to_char(p.birth_date,'MM-DD') = to_char(now() AT TIME ZONE $1,'MM-DD')
     ON CONFLICT DO NOTHING`, [TZ]),

  followup: () => q(
    `INSERT INTO message_queue (clinic_id, patient_id, kind, body, dedupe_key)
     SELECT a.clinic_id, a.patient_id, 'followup', t.body, 'fu:' || r.id || ':' || a.id
     FROM appointments a
     JOIN followup_rules r ON r.clinic_id=a.clinic_id AND (r.procedure_id IS NULL OR r.procedure_id=a.procedure_id)
     JOIN message_templates t ON t.id=r.template_id
     JOIN patients p ON p.id=a.patient_id
     WHERE a.status='done' AND p.phone IS NOT NULL
       AND a.completed_at + r.days_after * interval '1 day' <= now()
       AND a.completed_at + (r.days_after + 2) * interval '1 day' > now()   -- não dispara "atrasado" demais
     ON CONFLICT DO NOTHING`),

  stock: () => q(
    `INSERT INTO alerts (clinic_id, kind, payload, dedupe_key)
     SELECT clinic_id, 'low_stock', jsonb_build_object('product', name, 'quantity', quantity, 'buy', qty_to_buy),
            'stock:' || product_id || ':' || current_date
     FROM v_restock ON CONFLICT DO NOTHING`),

  // fecha o mês anterior
  async dre() {
    const clinics = await q('SELECT id FROM clinics');
    for (const c of clinics) {
      const [{ m }] = await q(`SELECT to_char(date_trunc('month', now() AT TIME ZONE $1) - interval '1 month','YYYY-MM-DD') AS m`, [TZ]);
      const data = await buildDre(c.id, m);
      await q(`INSERT INTO dre_reports (clinic_id, month, data) VALUES ($1,$2,$3)
               ON CONFLICT (clinic_id, month) DO UPDATE SET data=EXCLUDED.data, generated_at=now()`, [c.id, m, data]);
    }
  },

  googleSync: syncAllClinics,

  // outbox: envia a fila (uma instância de worker)
  async outbox() {
    // Reserva atômica. Reserva travada há mais de 10 min (função morreu no meio do envio) volta para a fila:
    // entrega "pelo menos uma vez", então numa falha rara a mensagem pode sair duplicada, nunca se perder.
    const batch = await q(
      `UPDATE message_queue SET status='sending', claimed_at=now() WHERE id IN (
         SELECT id FROM message_queue
         WHERE send_after <= now() AND (status='pending' OR (status='sending' AND claimed_at < now() - interval '10 minutes'))
         ORDER BY send_after LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING id, patient_id, body`);
    for (const m of batch) {
      try {
        const [p] = await q('SELECT phone, full_name FROM patients WHERE id=$1', [m.patient_id]);
        await sendWhatsApp(p.phone, render(m.body, { nome: p.full_name.split(' ')[0] }));
        await q(`UPDATE message_queue SET status='sent', sent_at=now() WHERE id=$1`, [m.id]);
      } catch (e) {
        await q(`UPDATE message_queue SET status='failed', error=$2 WHERE id=$1`, [m.id, String(e.message)]);
      }
    }
  },
};

const spNow = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: Number(p.day), hour: Number(p.hour) };
};

// Execução única e idempotente para plataformas com cron simples (ex.: Netlify, em UTC e frequência fixa).
// Funciona com qualquer frequência: cada tarefa decide sozinha se já está na hora e nunca repete trabalho.
export async function tick(now = new Date()) {
  const { day, hour } = spNow(now);
  const [missing] = await q(
    `SELECT 1 AS m FROM clinics c WHERE NOT EXISTS (SELECT 1 FROM dre_reports d WHERE d.clinic_id=c.id
       AND d.month = (date_trunc('month', $1::timestamptz AT TIME ZONE $2) - interval '1 month')::date) LIMIT 1`, [now.toISOString(), TZ]);
  const order = [hour >= 9 && 'birthday', 'followup', 'stock', missing && !(day === 1 && hour < 6) && 'dre', 'outbox', 'googleSync'].filter(Boolean);
  const result = {};
  for (const name of order) {
    try { await tasks[name](); result[name] = 'ok'; } catch (e) { result[name] = `erro: ${e.message}`; }
  }
  return result;
}

export function startJobs(log) {
  const at = (expr, name, opts) => cron.schedule(expr, async () => {
    try { await tasks[name](); } catch (e) { log.error({ err: e }, `job ${name}`); }
  }, opts);
  at('0 9 * * *', 'birthday', { timezone: TZ });
  at('*/15 * * * *', 'followup');
  at('5 * * * *', 'stock');
  at('0 6 1 * *', 'dre', { timezone: TZ });
  at('* * * * *', 'outbox');
  at('*/5 * * * *', 'googleSync');
}

// WhatsApp Cloud API (Meta). Sem WHATSAPP_TOKEN/WHATSAPP_PHONE_ID o envio falha e a mensagem fica 'failed':
// nunca é marcada como enviada sem ter saído. Fora da janela de 24h a Meta só aceita modelo aprovado:
// com WHATSAPP_TEMPLATE o texto vai como variável {{1}} desse modelo (idioma pt_BR).
async function sendWhatsApp(phone, text) {
  const { WHATSAPP_TOKEN: token, WHATSAPP_PHONE_ID: id, WHATSAPP_TEMPLATE: template } = process.env;
  if (!token || !id) throw new Error('WhatsApp não configurado (WHATSAPP_TOKEN e WHATSAPP_PHONE_ID)');
  const to = String(phone ?? '').replace(/\D/g, '');
  if (!to) throw new Error('paciente sem telefone');
  const content = template
    ? { type: 'template', template: { name: template, language: { code: 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n+\s*/g, ' ') }] }] } }
    : { type: 'text', text: { body: text } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${id}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...content }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
