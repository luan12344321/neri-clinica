import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { dayIntervals, type Hours } from './hours';
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
// Faixas fora do horário de atendimento (almoço, antes e depois) ficam sombreadas; os buracos entre os blocos são
// os horários livres; concluídos ficam esmaecidos com um check.
export function DayTimeline({ appts, hours, onOpen, onBook, onSeeAll }: { appts: Appt[]; hours: Hours; onOpen: (a: Appt) => void; onBook: () => void; onSeeAll: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);

  const iv = dayIntervals(hours, now);
  const items = appts.filter((a) => a.status !== 'canceled').map((a) => {
    const s = new Date(a.starts_at);
    const e = a.ends_at ? new Date(a.ends_at) : new Date(s.getTime() + 3600e3);
    return { a, s: mins(s), e: Math.max(mins(e), mins(s) + 15) };
  }).sort((x, y) => x.s - y.s);

  // O quadro mostra só o horário de atendimento da clínica. Atendimentos fora dele (por exemplo, um lançamento de
  // madrugada) vão para uma lista abaixo em vez de esticar a agenda. Em dia fechado, mostra só o intervalo dos que existirem.
  const open0 = iv.length ? iv[0]![0] : items.length ? Math.min(...items.map((i) => i.s)) : 8 * 60;
  const close0 = iv.length ? iv[iv.length - 1]![1] : items.length ? Math.max(...items.map((i) => i.e)) : 18 * 60;
  const start = Math.floor(open0 / 60) * 60;
  const end = Math.ceil(close0 / 60) * 60;
  const shown = items.filter((it) => it.e > start && it.s < end);
  const outside = items.filter((it) => !(it.e > start && it.s < end));
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
  for (const it of items) { const last = merged[merged.length - 1]; if (last && it.s <= last[1]) last[1] = Math.max(last[1], it.e); else merged.push([it.s, it.e]); }
  const worked = iv.reduce((a, [s, e]) => a + (e - s), 0);
  const covered = iv.reduce((a, [s, e]) => a + merged.reduce((b, [ms, me]) => b + Math.max(0, Math.min(e, me) - Math.max(s, ms)), 0), 0);
  const free = Math.max(0, worked - covered);
  const h = (m: number) => (m / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

  // trechos fora do atendimento dentro da faixa exibida
  const off: { s: number; e: number; label?: string }[] = [];
  if (iv.length) {
    let cur = start;
    iv.forEach(([s, e], i) => { if (s > cur) off.push({ s: cur, e: s, label: i > 0 ? 'Intervalo' : undefined }); cur = e; });
    if (end > cur) off.push({ s: cur, e: end });
  }
  const nowMin = mins(now);
  const y = (m: number) => ((m - start) / 60) * HOUR;
  const hoursList = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);
  const sub = !iv.length ? (items.length ? 'Clínica fechada hoje (há atendimentos agendados)' : 'Clínica fechada hoje')
    : items.length ? `${h(free)} h livres de ${h(worked)} h de atendimento` : 'Dia livre';

  return (
    <section className="card g-timeline" id="agenda-hoje">
      <div className="between">
        <div><h2>Agenda de hoje</h2><p className="muted tl-free">{sub}</p></div>
        <button className="link" onClick={onSeeAll}>Ver agenda completa</button>
      </div>
      {items.length === 0 ? <Empty icon="calendar" title={iv.length ? 'Nenhum atendimento hoje' : 'Clínica fechada hoje'} text={iv.length ? 'O dia está livre.' : 'Não há horário de atendimento configurado para hoje.'}><button className="primary sm" onClick={onBook}>Agendar</button></Empty> : (
        <>
        <div className="tl" style={{ height: y(end) + 8 }}>
          {off.map((o) => <div key={o.s} className="tl-off" style={{ top: y(o.s), height: y(o.e) - y(o.s) }}>{o.label && <span>{o.label}</span>}</div>)}
          {hoursList.map((m) => <div key={m} className="tl-hour" style={{ top: y(m) }}><span>{pad(Math.floor(m / 60))}:00</span></div>)}
          {nowMin >= start && nowMin <= end && <div className="tl-now" style={{ top: y(nowMin) }}><i>{clock(now)}</i></div>}
          {placed.map(({ a, s, e, lane }) => {
            const done = a.status === 'done';
            const late = !done && e < nowMin;
            const cs = Math.max(s, start), ce = Math.min(e, end); // parte visível dentro do expediente
            const bh = Math.max(28, ((ce - cs) / 60) * HOUR - 3);
            return (
              <button key={a.id} className={`tl-item${done ? ' done' : ''}${late ? ' late' : ''}`} onClick={() => onOpen(a)}
                style={{ top: y(cs) + 1, height: bh, left: `calc(52px + (100% - 52px) * ${lane / nLanes})`, width: `calc((100% - 52px) / ${nLanes} - 4px)` }}>
                <b>{clock(new Date(a.starts_at))} · {a.patient}</b>
                {bh >= 44 && <span>{a.procedure ?? 'Sem procedimento'}{late ? ' · atrasado' : ''}</span>}
                {done && <em aria-label="Concluído"><Icon name="check" size={14} /></em>}
              </button>
            );
          })}
        </div>
        {outside.length > 0 && (
          <div className="tl-out">
            <p className="muted">Fora do horário de atendimento</p>
            <div>{outside.map(({ a }) => (
              <button key={a.id} className={a.status === 'done' ? 'done' : ''} onClick={() => onOpen(a)}>
                {clock(new Date(a.starts_at))} · {a.patient}{a.status === 'done' && <Icon name="check" size={14} />}
              </button>
            ))}</div>
          </div>
        )}
        </>
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
