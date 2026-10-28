import { q } from './db.js';
import { ensureSchema } from './schema.js';

// PAINEL DA DOUTORA (ciclo do procedimento). Só owner/manager. Tudo é calculado do banco, sempre com o clinic_id do token
// e com "hoje" no fuso America/Sao_Paulo. Nenhum indicador promete ganho de faturamento nem redução de faltas: onde não há
// dados suficientes o valor vem null e a tela mostra "sem dados ainda".

const TZ = 'America/Sao_Paulo';
const MIN_CASES = 5;                                 // abaixo disso a taxa não é informada (rate: null)
const TODAY = `(now() AT TIME ZONE '${TZ}')::date`;
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const rate = (onTime, total) => (total < MIN_CASES ? null : r1((onTime / total) * 100));

export default async function painelCiclo(app) {
  const managers = { onRequest: [app.auth, async (req, reply) => {
    if (!['owner', 'manager'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  }] };

  app.get('/dashboard/cycle', managers, async (req) => {
    await ensureSchema();
    const c = req.user.clinicId;

    // 1) RETORNOS PREVISTOS EM 30 DIAS: retornos em 'suggested'/'remind_later' cuja data sugerida cai de hoje até hoje+30,
    //    mais os que já estão na janela (data sugerida passada, mas window_end ainda não passou). amount = soma do PREÇO PADRÃO
    //    (procedures.default_price) dos procedimentos desses retornos: é uma previsão de agenda, não receita garantida.
    const [fc] = await q(
      `SELECT count(*)::int AS count, COALESCE(sum(p.default_price),0)::float AS amount
       FROM returns r JOIN procedures p ON p.id=r.procedure_id AND p.clinic_id=r.clinic_id
       WHERE r.clinic_id=$1 AND r.state IN ('suggested','remind_later')
         AND r.suggested_date <= ${TODAY} + 30 AND COALESCE(r.window_end, r.suggested_date) >= ${TODAY}`, [c]);

    // 2) RETORNO NO PRAZO: realizado até 30 dias depois da data sugerida. "Realizado" = próximo atendimento concluído do mesmo
    //    paciente e procedimento, depois do atendimento de origem. Retornos recusados (declined) ficam de fora.
    //    current = retornos cuja (suggested_date + 30) já passou, nos últimos 90 dias. rate null se total < 5.
    const [cur] = await q(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE nx.d IS NOT NULL AND nx.d <= r.suggested_date + 30)::int AS on_time
       FROM returns r
       JOIN appointments src ON src.id=r.source_appointment_id AND src.clinic_id=r.clinic_id
       LEFT JOIN LATERAL (
         SELECT min((COALESCE(a.completed_at, a.starts_at) AT TIME ZONE '${TZ}')::date) AS d FROM appointments a
         WHERE a.clinic_id=r.clinic_id AND a.patient_id=r.patient_id AND a.procedure_id=r.procedure_id
           AND a.status='done' AND a.id<>r.source_appointment_id
           AND COALESCE(a.completed_at, a.starts_at) > COALESCE(src.completed_at, src.starts_at)) nx ON true
       WHERE r.clinic_id=$1 AND r.state<>'declined'
         AND r.suggested_date + 30 < ${TODAY} AND r.suggested_date + 30 >= ${TODAY} - 90`, [c]);

    //    baseline6m = ESTIMATIVA pela história de atendimentos concluídos (a tabela returns é nova): para cada atendimento
    //    concluído de procedimento com regra ativa, ocorrido entre 270 e 90 dias atrás e cuja observação já terminou
    //    (data + janela máxima + 30 <= hoje), conta se o paciente repetiu o mesmo procedimento entre
    //    [data + janela mínima, data + janela máxima + 30]. Sempre marcado estimated:true.
    const [base] = await q(
      `WITH src AS (
         SELECT a.id, a.clinic_id, a.patient_id, a.procedure_id, (COALESCE(a.completed_at, a.starts_at) AT TIME ZONE '${TZ}')::date AS d,
                ru.window_min_days AS mn, ru.window_max_days AS mx
         FROM appointments a JOIN procedure_return_rules ru ON ru.clinic_id=a.clinic_id AND ru.procedure_id=a.procedure_id AND ru.active
         WHERE a.clinic_id=$1 AND a.status='done')
       SELECT count(*)::int AS total,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM appointments b WHERE b.clinic_id=s.clinic_id AND b.patient_id=s.patient_id AND b.procedure_id=s.procedure_id
             AND b.status='done' AND b.id<>s.id
             AND (COALESCE(b.completed_at, b.starts_at) AT TIME ZONE '${TZ}')::date BETWEEN s.d + s.mn AND s.d + s.mx + 30))::int AS on_time
       FROM src s
       WHERE s.d >= ${TODAY} - 270 AND s.d < ${TODAY} - 90 AND s.d + s.mx + 30 <= ${TODAY}`, [c]);

    // 3) LOTES COM SALDO vencendo em até 60 dias (inclui vencidos com saldo: expired:true). daysLeft negativo = já venceu.
    const lots = await q(
      `SELECT l.id, p.name AS product_name, l.lot_code, l.expires_at::text AS expires_at, l.quantity_units::float AS units,
              (l.expires_at - ${TODAY})::int AS days_left
       FROM product_lots l JOIN products p ON p.id=l.product_id AND p.clinic_id=l.clinic_id
       WHERE l.clinic_id=$1 AND l.quantity_units > 0 AND l.expires_at <= ${TODAY} + 60
       ORDER BY l.expires_at, p.name LIMIT 100`, [c]);

    // 4) MARGEM MÉDIA POR PROCEDIMENTO (últimos 6 meses): atendimentos concluídos cujas aplicações TODAS têm custo conhecido;
    //    margem = preço do atendimento (ou preço padrão se vazio) - soma dos custos. Sem aplicação ou com custo faltando
    //    entram em missingCost e ficam fora da média. pct = soma das margens / soma dos preços (ponderada).
    const margin = await q(
      `WITH base AS (
         SELECT a.id, a.procedure_id, COALESCE(a.price, p.default_price)::float AS price, count(ap.id) AS napps, count(ap.cost) AS ncost,
                COALESCE(sum(ap.cost),0)::float AS cost
         FROM appointments a JOIN procedures p ON p.id=a.procedure_id AND p.clinic_id=a.clinic_id
         LEFT JOIN applications ap ON ap.appointment_id=a.id AND ap.clinic_id=a.clinic_id
         WHERE a.clinic_id=$1 AND a.status='done'
           AND (COALESCE(a.completed_at, a.starts_at) AT TIME ZONE '${TZ}')::date >= ${TODAY} - interval '6 months'
         GROUP BY a.id, a.procedure_id, p.default_price)
       SELECT b.procedure_id, pr.name,
              count(*) FILTER (WHERE b.napps>0 AND b.napps=b.ncost)::int AS n,
              count(*) FILTER (WHERE NOT (b.napps>0 AND b.napps=b.ncost))::int AS missing,
              COALESCE(sum(b.price) FILTER (WHERE b.napps>0 AND b.napps=b.ncost),0)::float AS price_sum,
              COALESCE(sum(b.cost) FILTER (WHERE b.napps>0 AND b.napps=b.ncost),0)::float AS cost_sum
       FROM base b JOIN procedures pr ON pr.id=b.procedure_id AND pr.clinic_id=$1
       GROUP BY b.procedure_id, pr.name ORDER BY pr.name`, [c]);

    // 5) COBERTURA DE LOTE: % das aplicações dos últimos 90 dias com lot_id. Meta 95%.
    const [cov] = await q(
      `SELECT count(*)::int AS total, count(lot_id)::int AS with_lot FROM applications
       WHERE clinic_id=$1 AND created_at >= now() - interval '90 days'`, [c]);

    // 6) DINHEIRO PARADO: retornos vencidos (hoje > window_end) ainda em aberto, valorizados pelo ticket médio do procedimento
    //    (média de appointments.price concluídos; se não houver, o preço padrão). Quantidade = pacientes distintos.
    const [idle] = await q(
      `SELECT count(DISTINCT r.patient_id)::int AS patients,
              COALESCE(sum(COALESCE((SELECT avg(a.price) FROM appointments a WHERE a.clinic_id=r.clinic_id AND a.procedure_id=r.procedure_id
                AND a.status='done' AND a.price IS NOT NULL), p.default_price)),0)::float AS amount
       FROM returns r JOIN procedures p ON p.id=r.procedure_id AND p.clinic_id=r.clinic_id
       WHERE r.clinic_id=$1 AND r.state IN ('suggested','remind_later','no_response') AND r.window_end < ${TODAY}`, [c]);

    return {
      forecast30d: { count: fc.count, amount: r2(fc.amount) },
      onTimeRate: {
        current: { rate: rate(cur.on_time, cur.total), onTime: cur.on_time, total: cur.total },
        baseline6m: { rate: rate(base.on_time, base.total), total: base.total, estimated: true },
        note: 'Comparação estimada: a linha de base vem do histórico de atendimentos (quem repetiu o procedimento no intervalo da regra), não de retornos registrados. Não indica ganho de faturamento nem redução de faltas.',
      },
      lotsExpiring60d: lots.map((l) => ({ lotId: l.id, productName: l.product_name, lotCode: l.lot_code, expiresAt: l.expires_at,
        units: l.units, daysLeft: l.days_left, ...(l.days_left < 0 ? { expired: true } : {}) })),
      avgMarginByProcedure: margin.map((m) => ({
        procedureId: m.procedure_id, procedure: m.name, n: m.n, missingCost: m.missing,
        avgMargin: m.n ? r2((m.price_sum - m.cost_sum) / m.n) : null,
        pct: m.n && m.price_sum > 0 ? r1(((m.price_sum - m.cost_sum) / m.price_sum) * 100) : null,
      })),
      lotCoverage: { pct: cov.total ? r1((cov.with_lot / cov.total) * 100) : null, withLot: cov.with_lot, total: cov.total, target: 95 },
      idleMoney: { patients: idle.patients, amount: r2(idle.amount), action: 'open_queue' },
    };
  });
}
