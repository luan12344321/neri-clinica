import { q } from './db.js';
import { decrypt } from './crypto.js';

// Consultas detalhadas da Júlia: somente leitura, SQL fixo e parametrizado, sempre com clinic_id e com teto de linhas.
// A permissão por perfil é decidida em sara.js; aqui ficam só os dados (CPF sempre mascarado, prontuário truncado).
const TZ = 'America/Sao_Paulo';
const dayStart = (p) => `(${p}::date)::timestamp AT TIME ZONE '${TZ}'`;
const dayAfter = (p) => `((${p}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;
const like = (s) => (s ? `%${String(s).replace(/[\\%_]/g, '\\$&')}%` : null);
const cut = (s, n = 1500) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const maskCpf = (c) => `***.***.***-${String(c).slice(-2)}`;
const page = (rows, limit) => ({ itens: rows.slice(0, limit), truncado: rows.length > limit });

export async function countPatients(clinicId) {
  const [r] = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS novos_30_dias,
            (SELECT count(DISTINCT patient_id)::int FROM appointments
              WHERE clinic_id=$1 AND status IN ('done','scheduled','confirmed') AND starts_at >= now() - interval '90 days') AS com_atendimento_90_dias
     FROM patients WHERE clinic_id=$1`, [clinicId]);
  return r;
}

// Ficha + histórico. CPF só mascarado e só para perfis clínicos; valor gasto só para dono/gerente (flags do chamador).
export async function patientProfile(clinicId, patientId, { cpf = false, money = false } = {}) {
  const [p] = await q(
    `SELECT full_name AS nome, to_char(birth_date,'YYYY-MM-DD') AS nascimento, phone AS telefone, email,
            marketing_consent AS aceita_marketing, cpf_enc, to_char(created_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS cadastrado_em
     FROM patients WHERE id=$1 AND clinic_id=$2`, [patientId, clinicId]);
  if (!p) return null;
  const [s] = await q(
    `SELECT count(*) FILTER (WHERE status='done')::int AS concluidos,
            count(*) FILTER (WHERE status='canceled')::int AS cancelados,
            count(*) FILTER (WHERE status='no_show')::int AS faltas,
            coalesce(sum(price) FILTER (WHERE status='done'),0)::float AS total_gasto,
            to_char((max(starts_at) FILTER (WHERE status='done')) AT TIME ZONE '${TZ}','YYYY-MM-DD') AS ultimo_atendimento,
            to_char((min(starts_at) FILTER (WHERE status IN ('scheduled','confirmed') AND starts_at > now())) AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS proximo_agendamento
     FROM appointments WHERE patient_id=$1 AND clinic_id=$2`, [patientId, clinicId]);
  const procedimentos = await q(
    `SELECT pr.name AS procedimento, count(*)::int AS vezes FROM appointments a
     JOIN procedures pr ON pr.id=a.procedure_id AND pr.clinic_id=a.clinic_id
     WHERE a.patient_id=$1 AND a.clinic_id=$2 AND a.status='done' GROUP BY pr.name ORDER BY vezes DESC LIMIT 10`, [patientId, clinicId]);
  const ultimos = await q(
    `SELECT to_char(a.starts_at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS inicio, pr.name AS procedimento, a.status
     FROM appointments a LEFT JOIN procedures pr ON pr.id=a.procedure_id
     WHERE a.patient_id=$1 AND a.clinic_id=$2 ORDER BY a.starts_at DESC LIMIT 10`, [patientId, clinicId]);
  const { cpf_enc, ...ficha } = p;
  const { total_gasto, ...contagens } = s;
  return { ...ficha, ...(cpf && cpf_enc ? { cpf: maskCpf(decrypt(cpf_enc, `patients.cpf:${patientId}`)) } : {}),
    ...contagens, ...(money ? { total_gasto } : {}), procedimentos, ultimos_atendimentos: ultimos };
}

// Prontuário (cifrado em repouso): devolve só os últimos registros, com texto limitado.
export async function patientRecords(clinicId, patientId, limit = 5) {
  const [ok] = await q('SELECT 1 FROM patients WHERE id=$1 AND clinic_id=$2', [patientId, clinicId]);
  if (!ok) return null;
  const rows = await q(
    `SELECT r.id, r.data_enc, to_char(r.created_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS data, u.name AS autor
     FROM medical_records r LEFT JOIN users u ON u.id=r.author_id
     WHERE r.patient_id=$1 AND r.clinic_id=$2 ORDER BY r.created_at DESC LIMIT $3`, [patientId, clinicId, limit]);
  return rows.map((r) => {
    const d = JSON.parse(decrypt(r.data_enc, `medical_records.data:${r.id}`));
    return { data: r.data, autor: r.autor, alergias: cut(d.allergies), evolucao: cut(d.evolution),
      ...(d.anamnesis && { anamnese: Object.fromEntries(Object.entries(d.anamnesis).map(([k, v]) => [k, cut(v, 500)])) }) };
  });
}

export async function searchAppointments(clinicId, { from, to, status, patient, procedure }) {
  const args = [clinicId, from, to, status ?? null, like(patient), like(procedure)];
  const where = `a.clinic_id=$1 AND a.starts_at >= ${dayStart('$2')} AND a.starts_at < ${dayAfter('$3')}
     AND ($4::text IS NULL OR a.status=$4) AND ($5::text IS NULL OR p.full_name ILIKE $5) AND ($6::text IS NULL OR pr.name ILIKE $6)`;
  const src = `FROM appointments a JOIN patients p ON p.id=a.patient_id AND p.clinic_id=a.clinic_id LEFT JOIN procedures pr ON pr.id=a.procedure_id`;
  const resumo = await q(`SELECT a.status, count(*)::int AS n ${src} WHERE ${where} GROUP BY a.status`, args);
  const rows = await q(
    `SELECT a.id, to_char(a.starts_at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS inicio,
            to_char(a.ends_at AT TIME ZONE '${TZ}','HH24:MI') AS fim, p.full_name AS paciente, pr.name AS procedimento,
            u.name AS profissional, a.status
     ${src} LEFT JOIN users u ON u.id=a.professional_id
     WHERE ${where} ORDER BY a.starts_at LIMIT 101`, args);
  return { resumo_por_status: Object.fromEntries(resumo.map((r) => [r.status, r.n])), ...page(rows, 100) };
}

export async function listProducts(clinicId, { search, onlyOut }) {
  const rows = await q(
    `SELECT name AS produto, unit AS unidade, quantity::float AS quantidade, min_quantity::float AS minimo,
            target_quantity::float AS alvo, to_char(expires_at,'YYYY-MM-DD') AS validade
     FROM products WHERE clinic_id=$1 AND ($2::text IS NULL OR name ILIKE $2) AND (NOT $3::boolean OR quantity <= 0)
     ORDER BY name LIMIT 101`, [clinicId, like(search), !!onlyOut]);
  return page(rows, 100);
}

export async function stockMovements(clinicId, { product, days }) {
  const rows = await q(
    `SELECT to_char(m.created_at AT TIME ZONE '${TZ}','YYYY-MM-DD HH24:MI') AS quando, p.name AS produto,
            m.delta::float AS variacao, m.reason AS motivo
     FROM stock_movements m JOIN products p ON p.id=m.product_id AND p.clinic_id=m.clinic_id
     WHERE m.clinic_id=$1 AND m.created_at >= now() - ($2::int * interval '1 day') AND ($3::text IS NULL OR p.name ILIKE $3)
     ORDER BY m.created_at DESC LIMIT 101`, [clinicId, days, like(product)]);
  return page(rows, 100);
}

// Lançamentos individuais. status 'overdue' = pendente com vencimento já passado.
export async function listTransactions(clinicId, { type, status, from, to, limit = 30, offset = 0 }) {
  const args = [clinicId, type ?? null, status ?? null, from ?? null, to ?? null];
  const where = `t.clinic_id=$1 AND ($2::text IS NULL OR t.type=$2)
     AND ($3::text IS NULL OR (CASE WHEN $3='overdue' THEN t.status='pending' AND t.due_date < (now() AT TIME ZONE '${TZ}')::date ELSE t.status=$3 END))
     AND ($4::date IS NULL OR t.competence_date >= $4::date) AND ($5::date IS NULL OR t.competence_date <= $5::date)`;
  const [tot] = await q(`SELECT count(*)::int AS n, coalesce(sum(t.amount),0)::float AS soma FROM transactions t WHERE ${where}`, args);
  const rows = await q(
    `SELECT t.id, t.type AS tipo, t.description AS descricao, t.amount::float AS valor, to_char(t.competence_date,'YYYY-MM-DD') AS competencia,
            to_char(t.due_date,'YYYY-MM-DD') AS vencimento, to_char(t.paid_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS pago_em,
            t.status, c.name AS categoria
     FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
     WHERE ${where} ORDER BY t.competence_date DESC, t.created_at DESC LIMIT $6 OFFSET $7`, [...args, limit, offset]);
  return { total_registros: tot.n, soma_total: tot.soma, itens: rows, truncado: offset + rows.length < tot.n };
}

// Resumo de um intervalo (dia, semana ou mês). A parte de dinheiro só entra quando `money` é verdadeiro.
export async function reportSummary(clinicId, { from, to }, { money = false } = {}) {
  const args = [clinicId, from, to];
  const ap = await q(`SELECT status, count(*)::int AS n FROM appointments
                      WHERE clinic_id=$1 AND starts_at >= ${dayStart('$2')} AND starts_at < ${dayAfter('$3')} GROUP BY status`, args);
  const [pt] = await q(`SELECT count(*)::int AS n FROM patients WHERE clinic_id=$1 AND created_at >= ${dayStart('$2')} AND created_at < ${dayAfter('$3')}`, args);
  const [st] = await q('SELECT count(*)::int AS n FROM v_restock WHERE clinic_id=$1', [clinicId]);
  const out = { periodo: { de: from, ate: to }, atendimentos_por_status: Object.fromEntries(ap.map((r) => [r.status, r.n])),
    pacientes_novos: pt.n, produtos_abaixo_do_minimo: st.n };
  if (money) {
    const [f] = await q(`SELECT coalesce(sum(amount) FILTER (WHERE type='income'),0)::float AS receitas,
                                coalesce(sum(amount) FILTER (WHERE type='expense'),0)::float AS despesas
                         FROM transactions WHERE clinic_id=$1 AND status<>'canceled' AND competence_date BETWEEN $2::date AND $3::date`, args);
    out.financeiro = { ...f, saldo: +(f.receitas - f.despesas).toFixed(2) };
  }
  return out;
}
