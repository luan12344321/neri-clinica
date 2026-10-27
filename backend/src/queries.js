// Fonte única das consultas: usadas pelas rotas REST e pelas ferramentas da Sara.
import { q } from './db.js';

export async function getDashboard(clinicId) {
  const [today, revenue, top] = await Promise.all([
    q(`SELECT a.id, a.starts_at, a.status, p.full_name AS patient, pr.name AS procedure
       FROM appointments a JOIN patients p ON p.id=a.patient_id
       LEFT JOIN procedures pr ON pr.id=a.procedure_id
       JOIN clinics c ON c.id=a.clinic_id
       WHERE a.clinic_id=$1 AND a.status<>'canceled'
         AND (a.starts_at AT TIME ZONE c.timezone)::date = (now() AT TIME ZONE c.timezone)::date
       ORDER BY a.starts_at`, [clinicId]),
    getRevenueByMonth(clinicId, 6),
    getTopProcedures(clinicId, 6),
  ]);
  return { today, revenueByMonth: revenue, topProcedures: top };
}

export const getRevenueByMonth = (clinicId, months) =>
  q(`WITH since AS (SELECT (date_trunc('month', current_date) - ($2::int - 1) * interval '1 month')::date AS d),
     rev AS (SELECT date_trunc('month', competence_date)::date AS mon, SUM(amount)::float AS revenue
             FROM transactions, since
             WHERE clinic_id=$1 AND type='income' AND status<>'canceled' AND competence_date >= since.d
             GROUP BY 1),
     pat AS (SELECT date_trunc('month', completed_at)::date AS mon, COUNT(DISTINCT patient_id)::int AS patients
             FROM appointments, since
             WHERE clinic_id=$1 AND status='done' AND completed_at >= since.d
             GROUP BY 1)
     SELECT to_char(rev.mon,'YYYY-MM') AS month, rev.revenue, COALESCE(pat.patients,0) AS patients
     FROM rev LEFT JOIN pat USING (mon) ORDER BY rev.mon`, [clinicId, months]);

export const getTopProcedures = (clinicId, months) =>
  q(`SELECT pr.name, COUNT(*)::int AS total, SUM(a.price)::float AS revenue
     FROM appointments a JOIN procedures pr ON pr.id=a.procedure_id
     WHERE a.clinic_id=$1 AND a.status='done'
       AND a.completed_at >= date_trunc('month', current_date) - ($2::int - 1) * interval '1 month'
     GROUP BY pr.name ORDER BY total DESC LIMIT 10`, [clinicId, months]);

export async function getFinanceSummary(clinicId, monthStart) {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0)::float AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense'),0)::float AS expense
     FROM transactions
     WHERE clinic_id=$1 AND status<>'canceled'
       AND competence_date >= $2::date AND competence_date < $2::date + interval '1 month'`, [clinicId, monthStart]);
  const [t] = await q(
    `SELECT COUNT(*)::int AS n FROM appointments
     WHERE clinic_id=$1 AND status='done' AND price IS NOT NULL
       AND completed_at >= $2::date AND completed_at < $2::date + interval '1 month'`, [clinicId, monthStart]);
  return { ...r, balance: r.income - r.expense,
           averageTicket: t.n ? +(r.income / t.n).toFixed(2) : 0, proceduresDone: t.n };
}

// Fluxo de caixa (regime de caixa): o que entrou e saiu de fato (status 'paid') em cada um dos últimos meses.
export const getCashFlow = (clinicId, months) =>
  q(`WITH tz AS (SELECT timezone AS z FROM clinics WHERE id=$1),
     m AS (SELECT generate_series(date_trunc('month', now() AT TIME ZONE z) - ($2::int - 1) * interval '1 month',
                                  date_trunc('month', now() AT TIME ZONE z), interval '1 month')::date AS start FROM tz)
     SELECT to_char(m.start, 'YYYY-MM') AS month,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='income'), 0)::float AS income,
            COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense'), 0)::float AS expense
     FROM m CROSS JOIN tz
     LEFT JOIN transactions t ON t.clinic_id=$1 AND t.status='paid'
       AND (t.paid_at AT TIME ZONE tz.z)::date >= m.start AND (t.paid_at AT TIME ZONE tz.z)::date < m.start + interval '1 month'
     GROUP BY m.start ORDER BY m.start`, [clinicId, months]);

export const getRestock = (clinicId) =>
  q(`SELECT name, quantity::float, min_quantity::float, qty_to_buy::float FROM v_restock WHERE clinic_id=$1 ORDER BY name`, [clinicId]);

// DRE por regime de competência
export async function buildDre(clinicId, monthStart) {
  const rows = await q(
    `SELECT c.dre_group, SUM(t.amount)::float AS total
     FROM transactions t JOIN categories c ON c.id=t.category_id
     WHERE t.clinic_id=$1 AND t.status<>'canceled'
       AND t.competence_date >= $2::date AND t.competence_date < $2::date + interval '1 month'
     GROUP BY c.dre_group`, [clinicId, monthStart]);
  const g = Object.fromEntries(rows.map((r) => [r.dre_group, r.total]));
  const v = (k) => g[k] ?? 0;
  const receitaLiquida = v('receita_bruta') - v('deducoes');
  const lucroBruto = receitaLiquida - v('custos_variaveis');
  const resultadoOperacional = lucroBruto - v('despesas_operacionais');
  const resultadoAntesImpostos = resultadoOperacional - v('despesas_financeiras');
  return { month: monthStart, receitaBruta: v('receita_bruta'), deducoes: v('deducoes'), receitaLiquida,
    custosVariaveis: v('custos_variaveis'), lucroBruto, despesasOperacionais: v('despesas_operacionais'),
    resultadoOperacional, despesasFinanceiras: v('despesas_financeiras'), resultadoAntesImpostos,
    impostosLucro: v('impostos_lucro'), lucroLiquido: resultadoAntesImpostos - v('impostos_lucro') };
}

// "Consultoria" v1: regras determinísticas sobre os dados (a Sara pode narrar o resultado).
export async function getInsights(clinicId) {
  const now = new Date();
  const m = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [cur, old] = await Promise.all([getFinanceSummary(clinicId, m(now)), getFinanceSummary(clinicId, m(prev))]);
  const out = [];
  if (old.averageTicket && cur.averageTicket < old.averageTicket)
    out.push({ type: 'ticket_down', msg: `Ticket médio caiu de R$ ${old.averageTicket} para R$ ${cur.averageTicket}. Considere combos/upsell dos procedimentos mais vendidos.` });
  if (cur.income && cur.expense / cur.income > 0.7)
    out.push({ type: 'margin', msg: 'Despesas acima de 70% da receita no mês; revise custos fixos e precificação.' });
  const [late] = await q(`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::float total FROM transactions
    WHERE clinic_id=$1 AND type='income' AND status='pending' AND due_date < current_date`, [clinicId]);
  if (late.n) out.push({ type: 'overdue', msg: `${late.n} recebíveis vencidos somando R$ ${late.total}.` });
  return { current: cur, previous: old, insights: out };
}
