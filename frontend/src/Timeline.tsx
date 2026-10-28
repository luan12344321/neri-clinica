import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { dayIntervals, fromMin, type Hours } from './hours';
import { Avatar, Empty, Sheet } from './ui';

export const ageOf = (birth?: string | null) => {
  if (!birth) return null;
  const b = new Date(`${birth}T12:00`), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
};
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mins = (d: Date) => d.getHours() * 60 + d.getMinutes();
const HOUR = 56; // altura de uma hora, em px

type Appt = { id: string; starts_at: string; ends_at?: string; status: string; patient: string; procedure: string | null; patient_id: string; birth_date?: string | null };

// Agenda de hoje: mostra SÓ o horário de atendimento da clínica, faixa por faixa (por padrão 08:00–11:00, depois
// 13:00–18:00), uma logo abaixo da outra, sem o quadro do intervalo. Atendimentos fora dessas faixas não aparecem aqui
// (continuam na tela Agenda). Blocos concluídos ficam esmaecidos com check; há uma marca no "agora".
export function DayTimeline({ appts, hours, onOpen, onBook, onSeeAll }: { appts: Appt[]; hours: Hours; onOpen: (a: Appt) => void; onBook: () => void; onSeeAll: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);

  const iv = dayIntervals(hours, now);
  const GAP = 28; // separador entre as faixas (almoço)
  const len = (s: number, e: number) => ((e - s) / 60) * HOUR;
  const segs = iv.map(([s, e], i) => ({ s, e, top: iv.slice(0, i).reduce((a, [ps, pe]) => a + len(ps, pe) + GAP, 0) }));
  const last = segs[segs.length - 1];
  const total = last ? last.top + len(last.s, last.e) : 0;

  const items = appts.filter((a) => a.status !== 'canceled').map((a) => {
    const s = new Date(a.starts_at);
    const e = a.ends_at ? new Date(a.ends_at) : new Date(s.getTime() + 3600e3);
    return { a, s: mins(s), e: Math.max(mins(e), mins(s) + 15) };
  }).sort((x, y) => x.s - y.s);
  const shown = items.flatMap((it) => { const seg = segs.find((sg) => it.e > sg.s && it.s < sg.e); return seg ? [{ ...it, seg }] : []; });
  const lanes: number[] = [];
  const placed = shown.map((it) => {
    let l = lanes.findIndex((e) => e <= it.s);
    if (l < 0) { l = lanes.length; lanes.push(0); }
    lanes[l] = it.e;
    return { ...it, lane: l };
  });
  const nLanes = Math.max(1, lanes.length);

  // horas livres = tempo de atendimento da clínica não ocupado por atendimentos (blocos sobrepostos contam uma vez)
  const merged: [number, number][] = [];
  for (const it of shown) { const l = merged[merged.length - 1]; if (l && it.s <= l[1]) l[1] = Math.max(l[1], it.e); else merged.push([it.s, it.e]); }
  const worked = iv.reduce((a, [s, e]) => a + (e - s), 0);
  const covered = iv.reduce((a, [s, e]) => a + merged.reduce((b, [ms, me]) => b + Math.max(0, Math.min(e, me) - Math.max(s, ms)), 0), 0);
  const h = (m: number) => (m / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const sub = !iv.length ? 'Clínica fechada hoje' : shown.length ? `${h(Math.max(0, worked - covered))} h livres de ${h(worked)} h de atendimento` : 'Dia livre';

  const nowMin = mins(now);
  const nowSeg = segs.find((sg) => nowMin >= sg.s && nowMin <= sg.e);
  const ticks = segs.flatMap((sg) => {
    const hoursIn = Array.from({ length: Math.ceil(sg.e / 60) - Math.ceil(sg.s / 60) }, (_, i) => (Math.ceil(sg.s / 60) + i) * 60).filter((m) => m > sg.s && m < sg.e);
    return [sg.s, ...hoursIn, sg.e].map((m) => ({ m, top: sg.top + len(sg.s, m) }));
  });

  return (
    <section className="card g-timeline" id="agenda-hoje">
      <div className="between">
        <div><h2>Agenda de hoje</h2><p className="muted tl-free">{sub}</p></div>
        <button className="link" onClick={onSeeAll}>Ver agenda completa</button>
      </div>
      {!iv.length ? <Empty icon="calendar" title="Clínica fechada hoje" text="Não há horário de atendimento configurado para hoje."><button className="primary sm" onClick={onBook}>Agendar</button></Empty> : (
        <div className="tl" style={{ height: total + 8 }}>
          {segs.slice(1).map((sg, i) => <div key={sg.s} className="tl-gap" style={{ top: segs[i]!.top + len(segs[i]!.s, segs[i]!.e), height: GAP }}><span>Intervalo · {fromMin(segs[i]!.e)} às {fromMin(sg.s)}</span></div>)}
          {ticks.map(({ m, top }) => <div key={`${m}-${top}`} className="tl-hour" style={{ top }}><span>{fromMin(m)}</span></div>)}
          {nowSeg && <div className="tl-now" style={{ top: nowSeg.top + len(nowSeg.s, nowMin) }}><i>{clock(now)}</i></div>}
          {placed.map(({ a, s, e, seg, lane }) => {
            const done = a.status === 'done';
            const late = !done && e < nowMin;
            const cs = Math.max(s, seg.s), ce = Math.min(e, seg.e); // parte que cabe na faixa
            const bh = Math.max(28, len(cs, ce) - 3);
            return (
              <button key={a.id} className={`tl-item${done ? ' done' : ''}${late ? ' late' : ''}`} onClick={() => onOpen(a)}
                style={{ top: seg.top + len(seg.s, cs) + 1, height: bh, left: `calc(52px + (100% - 52px) * ${lane / nLanes})`, width: `calc((100% - 52px) / ${nLanes} - 4px)` }}>
                <b>{clock(new Date(a.starts_at))} · {a.patient}</b>
                {bh >= 44 && <span>{a.procedure ?? 'Sem procedimento'}{late ? ' · atrasado' : ''}</span>}
                {done && <em aria-label="Concluído"><Icon name="check" size={14} /></em>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Detalhes de um atendimento (toque num bloco da linha do tempo).
export function ApptSheet({ appt, clinical, busy, onClose, onStart, onChart, onComplete, onMove }: {
  appt: Appt; clinical: boolean; busy: boolean; onClose: () => void;
  onStart: () => void; onChart: () => void; onComplete: () => void; onMove: () => void;
}) {
  const age = ageOf(appt.birth_date);
  const s = new Date(appt.starts_at), e = appt.ends_at ? new Date(appt.ends_at) : null;
  const done = appt.status === 'done';
  return (
    <Sheet title="Atendimento" onClose={onClose}>
      <div className="appt-head">
        <Avatar name={appt.patient} size={56} />
        <div className="grow"><b>{appt.patient}</b><span className="muted">{[age !== null ? `${age} anos` : null, appt.procedure ?? 'Sem procedimento'].filter(Boolean).join(' · ')}</span></div>
        <span className={`pill ${done ? 'ok' : ''}`}>{done ? 'Concluído' : 'Agendado'}</span>
      </div>
      <p className="muted"><Icon name="calendar" size={16} /> {clock(s)}{e ? ` às ${clock(e)}` : ''}</p>
      <div className="actions col">
        {clinical && !done && <button className="primary" onClick={onStart}>Iniciar atendimento</button>}
        {clinical && <button className="ghost" onClick={onChart}>Ver prontuário</button>}
        {!done && (clinical ? <button className="ghost" onClick={onComplete}>Concluir atendimento</button> : <button className="primary" disabled={busy} onClick={onComplete}>Concluir atendimento</button>)}
        {!done && <button className="ghost" onClick={onMove}>Reagendar</button>}
      </div>
    </Sheet>
  );
}

// Faixa do dia: pílula verde com os atendimentos de hoje como pontos sobre as horas (07h–20h) e a marca do "agora".
export function DayStrip({ appts, onOpen }: { appts: Appt[]; onOpen: (a: Appt) => void }) {
  const list = appts.filter((a) => a.status !== 'canceled');
  if (!list.length) return null;
  const T0 = 7 * 60, T1 = 20 * 60;
  const at = (m: number) => `${Math.min(100, Math.max(0, ((m - T0) / (T1 - T0)) * 100))}%`;
  const now = mins(new Date());
  return (
    <section className="day-strip" aria-label="Linha do dia">
      <span className="ds-title">Hoje</span>
      <div className="ds-track">
        {[8, 10, 12, 14, 16, 18].map((h) => <i key={h} className="ds-tick" style={{ left: at(h * 60) }}><small>{h}h</small></i>)}
        {list.map((a) => (
          <button key={a.id} type="button" className={`ds-dot${a.status === 'done' ? ' done' : ''}`} style={{ left: at(mins(new Date(a.starts_at))) }}
            aria-label={`${clock(new Date(a.starts_at))} ${a.patient}`} onClick={() => onOpen(a)}>{a.patient.trim()[0]?.toUpperCase()}</button>
        ))}
        {now >= T0 && now <= T1 && <i className="ds-now" style={{ left: at(now) }} aria-hidden="true" />}
      </div>
    </section>
  );
}
