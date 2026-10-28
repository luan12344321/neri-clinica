import type { CSSProperties, ReactNode } from 'react';
import { useLoad } from './hooks';
import { brl } from './api';
import { ListSkeleton, mask, useHideValues } from './ui';

// Painel da doutora (owner/manager): indicadores reais do ciclo do procedimento. Sem dados suficientes, "sem dados ainda".
type Cycle = {
  forecast30d: { count: number; amount: number };
  onTimeRate: { current: { rate: number | null; onTime: number; total: number }; baseline6m: { rate: number | null; total: number; estimated: true }; note: string };
  lotsExpiring60d: { lotId: string; productName: string; lotCode: string; expiresAt: string; units: number; daysLeft: number; expired?: boolean }[];
  avgMarginByProcedure: { procedureId: string; procedure: string; n: number; missingCost: number; avgMargin: number | null; pct: number | null }[];
  lotCoverage: { pct: number | null; withLot: number; total: number; target: number };
  idleMoney?: { patients: number; amount: number; action: string };
};

const NONE = 'sem dados ainda';
const pct = (v: number | null) => (v === null ? NONE : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const dateBR = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/');
const grid: CSSProperties = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' };
const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'grid', gap: 6, alignContent: 'start' };
const big: CSSProperties = { fontSize: 22, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' };

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <div style={box}><span className="muted">{title}</span>{children}</div>
);

export default function PainelCiclo() {
  const { data: d, error, reload } = useLoad<Cycle>('/dashboard/cycle');
  const { hidden } = useHideValues();
  const goQueue = () => (document.getElementById('retornos-do-dia') ?? document.getElementById('agenda-hoje'))?.scrollIntoView({ behavior: 'smooth' });

  if (error) return (
    <section className="card span-all"><h2>Ciclo dos procedimentos</h2>
      <p className="muted" role="alert" style={{ color: 'var(--warn)' }}>Não foi possível carregar os indicadores. {error}</p>
      <button className="primary sm" onClick={reload}>Tentar de novo</button></section>
  );
  if (!d) return <section className="card span-all" aria-busy="true"><h2>Ciclo dos procedimentos</h2><ListSkeleton rows={3} /></section>;

  const cur = d.onTimeRate.current, base = d.onTimeRate.baseline6m;
  const margins = d.avgMarginByProcedure.filter((m) => m.n > 0);
  const cov = d.lotCoverage;
  const idle = d.idleMoney;

  return (
    <section className="card span-all" aria-label="Ciclo dos procedimentos">
      <div className="between"><h2>Ciclo dos procedimentos</h2><span className="muted">Dados reais da clínica</span></div>
      <div style={grid}>
        <Block title="Retornos previstos em 30 dias">
          {d.forecast30d.count === 0 ? <b style={big}>Nenhum</b> : <>
            <b style={big}>{d.forecast30d.count} {d.forecast30d.count === 1 ? 'retorno' : 'retornos'}</b>
            <span>{mask(brl(d.forecast30d.amount), hidden)} <span className="muted">pelo preço padrão</span></span></>}
        </Block>

        <Block title="Retorno no prazo (estimativa)">
          <b style={big}>{cur.rate === null ? NONE : pct(cur.rate)}</b>
          <span className="muted">{cur.rate === null ? `${cur.total} caso(s) nos últimos 90 dias; precisa de 5` : `${cur.onTime} de ${cur.total} nos últimos 90 dias`}</span>
          <span>Linha de base: {base.rate === null ? NONE : <>{pct(base.rate)} <span className="pill">estimada</span></>}</span>
          <span className="muted" style={{ fontSize: 13 }}>{d.onTimeRate.note}</span>
        </Block>

        <Block title="Lotes vencendo em 60 dias">
          {d.lotsExpiring60d.length === 0 ? <b style={big}>Nenhum</b> : (
            <ul className="rows">{d.lotsExpiring60d.slice(0, 4).map((l) => (
              <li key={l.lotId}><span><b>{l.productName}</b><br /><span className="muted">lote {l.lotCode} · {dateBR(l.expiresAt)}</span></span>
                <span className={`pill ${l.expired || l.daysLeft <= 15 ? 'warn' : ''}`}>{l.expired ? 'Vencido' : `${l.daysLeft} dia(s)`}</span></li>
            ))}</ul>)}
          {d.lotsExpiring60d.length > 4 && <span className="muted">e mais {d.lotsExpiring60d.length - 4} lote(s)</span>}
        </Block>

        <Block title="Margem média por procedimento">
          {margins.length === 0 ? <b style={big}>{NONE}</b> : (
            <ul className="rows">{margins.slice(0, 4).map((m) => (
              <li key={m.procedureId}><span><b>{m.procedure}</b><br /><span className="muted">{m.n} atendimento(s){m.missingCost ? ` · ${m.missingCost} sem custo` : ''}</span></span>
                <span style={{ textAlign: 'right' }}><b>{mask(brl(m.avgMargin ?? 0), hidden)}</b><br /><span className="muted">{pct(m.pct)}</span></span></li>
            ))}</ul>)}
        </Block>

        <Block title="Aplicações com lote registrado">
          <b style={big}>{pct(cov.pct)}</b>
          <span className="muted">{cov.total === 0 ? 'nenhuma aplicação nos últimos 90 dias' : `${cov.withLot} de ${cov.total} · meta ${cov.target}%`}</span>
          {cov.pct !== null && <span className={`pill ${cov.pct >= cov.target ? 'ok' : 'warn'}`} style={{ justifySelf: 'start' }}>{cov.pct >= cov.target ? 'Meta atingida' : 'Abaixo da meta'}</span>}
        </Block>

        <Block title="Dinheiro parado">
          {!idle || idle.patients === 0 ? <b style={big}>Nenhum retorno vencido</b> : <>
            <b style={big}>{mask(brl(idle.amount), hidden)}</b>
            <span className="muted">{idle.patients} paciente(s) com retorno vencido, pelo ticket médio</span>
            <button className="primary" onClick={goQueue} style={{ minHeight: 44 }}>Abrir fila de retornos</button></>}
        </Block>
      </div>
    </section>
  );
}
