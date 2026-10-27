import { useEffect, useState } from 'react';
import { Icon } from './Icon';
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

// Linha do tempo do dia (estilo agenda): horas na lateral, blocos posicionados pelo horário, e uma marca no "agora".
// Os buracos entre os blocos são os horários livres; concluídos ficam esmaecidos com um check.
export function DayTimeline({ appts, onOpen, onBook, onSeeAll }: { appts: Appt[]; onOpen: (a: Appt) => void; onBook: () => void; onSeeAll: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);

  const items = appts.filter((a) => a.status !== 'canceled').map((a) => {
    const s = new Date(a.starts_at);
    const e = a.ends_at ? new Date(a.ends_at) : new Date(s.getTime() + 3600e3);
    return { a, s: mins(s), e: Math.max(mins(e), mins(s) + 15) };
  }).sort((x, y) => x.s - y.s);

  const start = Math.floor(Math.min(8 * 60, ...items.map((i) => i.s)) / 60) * 60;
  const end = Math.ceil(Math.max(18 * 60, ...items.map((i) => i.e)) / 60) * 60;
  const lanes: number[] = [];
  const placed = items.map((it) => {
    let l = lanes.findIndex((e) => e <= it.s);
    if (l < 0) { l = lanes.length; lanes.push(0); }
    lanes[l] = it.e;
    return { ...it, lane: l };
  });
  const nLanes = Math.max(1, lanes.length);

  // horas livres entre 08:00 e 18:00 (une blocos sobrepostos antes de somar)
  let covered = 0, cursor = 8 * 60;
  for (const it of items) {
    const s = Math.max(it.s, cursor), e = Math.min(it.e, 18 * 60);
    if (e > s) { covered += e - s; cursor = e; }
  }
  const free = Math.max(0, 10 * 60 - covered);
  const nowMin = mins(now);
  const y = (m: number) => ((m - start) / 60) * HOUR;
  const hours = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);

  return (
    <section className="card g-timeline" id="agenda-hoje">
      <div className="between">
        <div><h2>Agenda de hoje</h2><p className="muted tl-free">{items.length ? `${(free / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h livres entre 08:00 e 18:00` : 'Dia livre'}</p></div>
        <button className="link" onClick={onSeeAll}>Ver agenda completa</button>
      </div>
      {items.length === 0 ? <Empty icon="calendar" title="Nenhum atendimento hoje" text="O dia está livre."><button className="primary sm" onClick={onBook}>Agendar</button></Empty> : (
        <div className="tl" style={{ height: y(end) + 8 }}>
          {hours.map((m) => <div key={m} className="tl-hour" style={{ top: y(m) }}><span>{pad(Math.floor(m / 60))}:00</span></div>)}
          {nowMin >= start && nowMin <= end && <div className="tl-now" style={{ top: y(nowMin) }}><i>{clock(now)}</i></div>}
          {placed.map(({ a, s, e, lane }) => {
            const done = a.status === 'done';
            const late = !done && e < nowMin;
            const h = Math.max(28, ((e - s) / 60) * HOUR - 3);
            return (
              <button key={a.id} className={`tl-item${done ? ' done' : ''}${late ? ' late' : ''}`} onClick={() => onOpen(a)}
                style={{ top: y(s) + 1, height: h, left: `calc(52px + (100% - 52px) * ${lane / nLanes})`, width: `calc((100% - 52px) / ${nLanes} - 4px)` }}>
                <b>{clock(new Date(a.starts_at))} · {a.patient}</b>
                {h >= 44 && <span>{a.procedure ?? 'Sem procedimento'}{late ? ' · atrasado' : ''}</span>}
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
        {!clinical && !done && <button className="primary" disabled={busy} onClick={onComplete}>Concluir atendimento</button>}
        {!done && <button className="ghost" onClick={onMove}>Reagendar</button>}
      </div>
    </Sheet>
  );
}
