import { q } from './db.js';

// Avisos ao paciente sobre o próprio atendimento (agendado, remarcado, cancelado, lembrete).
// Concluir o atendimento NÃO enfileira nada: o pós-atendimento é feito pelos Retornos (decisão da clínica, testada em ciclo-conformidade).
// Entram na mesma fila (message_queue) dos demais envios e seguem a mesma regra: só quem tem telefone e autorizou mensagens.
// Nada é enviado daqui: o outbox envia, e sem WhatsApp configurado a mensagem fica 'failed', nunca "enviada".

export const VARS = ['nome', 'procedimento', 'data', 'hora'];
const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

// Troca {{nome}}, {{procedimento}}, {{data}} e {{hora}} (com ou sem espaços); variável desconhecida some.
export const renderMsg = (body, vars) => String(body).replace(VAR_RE, (_, k) => vars[k] ?? '');
// Variáveis usadas no texto que não existem (para recusar o modelo ao salvar).
export const unknownVars = (body) => [...String(body).matchAll(VAR_RE)].map((m) => m[1]).filter((v) => !VARS.includes(v));

const DEFAULTS = {
  booked: 'Olá, {{nome}}! Seu horário de {{procedimento}} está agendado para {{data}} às {{hora}}. Se precisar remarcar, é só responder esta mensagem.',
  rescheduled: 'Olá, {{nome}}! Seu atendimento de {{procedimento}} foi remarcado para {{data}} às {{hora}}.',
  canceled: 'Olá, {{nome}}. Seu atendimento de {{procedimento}} de {{data}} às {{hora}} foi cancelado. Quando quiser remarcar, é só nos chamar.',
  reminder: 'Olá, {{nome}}! Lembrando do seu atendimento de {{procedimento}} amanhã, {{data}}, às {{hora}}. Podemos contar com você?',
};
export const NOTICE_KINDS = Object.keys(DEFAULTS);

const when = (d, tz) => ({
  data: new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(d),
  hora: new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d),
});

// Enfileira o aviso de um atendimento. Idempotente (dedupe_key): repetir a chamada não duplica o envio.
// A chave inclui o horário, então um atendimento remarcado gera um novo aviso.
export async function queueNotice(appointmentId, kind) {
  if (!DEFAULTS[kind]) throw new Error(`aviso desconhecido: ${kind}`);
  const [a] = await q(
    `SELECT a.id, a.clinic_id, a.patient_id, a.starts_at, c.timezone, p.full_name, pr.name AS procedure,
            (SELECT t.body FROM message_templates t WHERE t.clinic_id=a.clinic_id AND t.kind='reminder' LIMIT 1) AS reminder_template
     FROM appointments a JOIN patients p ON p.id=a.patient_id AND p.clinic_id=a.clinic_id
     JOIN clinics c ON c.id=a.clinic_id LEFT JOIN procedures pr ON pr.id=a.procedure_id
     WHERE a.id=$1 AND p.marketing_consent AND p.phone IS NOT NULL AND p.anonymized_at IS NULL`, [appointmentId]);
  if (!a) return false; // sem telefone ou sem autorização: não se envia
  const body = renderMsg(kind === 'reminder' && a.reminder_template ? a.reminder_template : DEFAULTS[kind],
    { nome: a.full_name.split(' ')[0], procedimento: a.procedure ?? 'atendimento', ...when(new Date(a.starts_at), a.timezone) });
  const key = `aviso:${kind}:${a.id}:${kind === 'canceled' ? 'x' : new Date(a.starts_at).getTime()}`;
  await q(`INSERT INTO message_queue (clinic_id, patient_id, kind, body, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [a.clinic_id, a.patient_id, kind, body, key]);
  return true;
}

// Lembrete: atendimentos de amanhã (dia da clínica) ainda marcados. Idempotente; rodar de hora em hora não repete.
export async function reminderTask() {
  const rows = await q(
    `SELECT a.id FROM appointments a JOIN clinics c ON c.id=a.clinic_id
     WHERE a.status IN ('scheduled','confirmed')
       AND (a.starts_at AT TIME ZONE c.timezone)::date = (now() AT TIME ZONE c.timezone)::date + 1`);
  for (const r of rows) await queueNotice(r.id, 'reminder');
}

// Dispara sem derrubar a operação principal: o aviso é secundário, o atendimento já foi gravado.
export const notify = (log, appointmentId, kind) =>
  queueNotice(appointmentId, kind).catch((e) => log?.error({ err: { message: e?.message } }, `aviso ${kind}`));
