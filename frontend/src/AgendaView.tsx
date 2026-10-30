import { useEffect, useState } from 'react';
import { api } from './api';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { useHours, toMin } from './hours';
import { AppointmentSheet, RescheduleSheet } from './Cadastros';
import { ApptSheet, isLate } from './Timeline';
import { ConcluirAtendimento } from './Atendimento';
import { Empty, ListSkeleton, useRole, useToast } from './ui';

// Calendário da Agenda (mês, semana, dia, lista). Toda conta de data é feita em strings "AAAA-MM-DD" no fuso da
// clínica: toISOString é UTC e depois das 21h já seria amanhã.
const TZ = 'America/Sao_Paulo';
export const dayISO = (plusDays = 0) => new Date(Date.now() + plusDays * 864e5).toLocaleDateString('sv-SE', { timeZone: TZ });
const asDate = (d: string) => new Date(`${d}T12:00:00Z`); // meio-dia UTC: só para aritmética e rótulos (timeZone UTC)
const addDays = (d: string, n: number) => new Date(asDate(d).getTime() + n * 864e5).toISOString().slice(0, 10);
const weekday = (d: string) => asDate(d).getUTCDay();
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => asDate(d).toLocaleDateString('pt-BR', { ...o, timeZone: 'UTC' });
const addMonths = (d: string, n: number) => { const x = asDate(d.slice(0, 8) + '01'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const apptDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ });
const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const span = (a: Appt) => `${hm(a.starts_at)}${a.ends_at ? `–${hm(a.ends_at)}` : ''}`;

type Appt = { id: string; starts_at: string; ends_at?: string; status: string; patient: string; patient_id: string; procedure: string | null; birth_date?: string | null };
type View = 'month' | 'week' | 'day' | 'list';
const VIEWS: { id: View; label: string; icon: 'calendar' | 'grid' | 'clock' | 'list' }[] = [
  { id: 'month', label: 'Mês', icon: 'calendar' }, { id: 'week', label: 'Semana', icon: 'grid' },
  { id: 'day', label: 'Dia', icon: 'clock' }, { id: 'list', label: 'Lista', icon: 'list' },
];
const STATUS: Record<string, string> = { scheduled: 'Agendado', confirmed: 'Confirmado', late: 'Atrasado', done: 'Concluído', no_show: 'Faltou', canceled: 'Cancelado' };
const statusOf = (a: Appt) => (isLate(a) ? 'late' : a.status);
const WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Atendimento no calendário; no desktop, passar o mouse mostra um cartão com os detalhes.
const Event = ({ a, detail = false, onOpen }: { a: Appt; detail?: boolean; onOpen: (a: Appt) => void }) => (
  <button type="button" className={`ag-ev s-${statusOf(a)}${detail ? ' big' : ''}`} onClick={() => onOpen(a)}>
    {detail
      ? <><b>{a.patient}</b><span>{span(a)} · {a.procedure ?? 'Sem procedimento'}</span><em className={`ag-st s-${statusOf(a)}`}>{STATUS[statusOf(a)]}</em></>
      : <><time>{hm(a.starts_at)}</time> <b>{a.patient}</b></>}
    {!detail && (
      <span className="ag-pop" aria-hidden="true">
        <b>{a.patient}</b><span>{a.procedure ?? 'Sem procedimento'}</span>
        <span>{fmt(apptDay(a.starts_at), { day: 'numeric', month: 'short' })} · {span(a)}</span>
        <em className={`ag-st s-${statusOf(a)}`}>{STATUS[statusOf(a)]}</em>
      </span>
    )}
  </button>
);

// Filtro em lista suspensa nativa (<details>) com caixas de seleção.
const Filter = ({ label, options, value, set }: { label: string; options: string[]; value: string[]; set: (v: string[]) => void }) => (
  <details className="ag-dd">
    <summary><Icon name="filter" size={16} />{label}{value.length > 0 && <i className="ag-count">{value.length}</i>}</summary>
    <div className="ag-menu">
      {options.length === 0 && <p className="muted">Nenhuma opção</p>}
      {options.map((o) => (
        <label key={o}><input type="checkbox" checked={value.includes(o)} onChange={(e) => set(e.target.checked ? [...value, o] : value.filter((v) => v !== o))} />{STATUS[o] ?? o}</label>
      ))}
    </div>
  </details>
);

function rangeOf(view: View, cur: string): [string, string] {
  if (view === 'day') return [cur, cur];
  if (view === 'list') return [cur, addDays(cur, 29)];
  if (view === 'week') { const s = addDays(cur, -weekday(cur)); return [s, addDays(s, 6)]; }
  const first = cur.slice(0, 8) + '01', s = addDays(first, -weekday(first));
  return [s, addDays(s, 41)];
}

export function AgendaView({ onStart, completeErr }: { onStart: (patientId: string, appt: any | null) => void; completeErr: (e: unknown) => string }) {
  const { isClinical } = useRole();
  const toast = useToast();
  const { hours } = useHours();
  const today = dayISO();
  // celular: Dia (7 colunas não cabem para ler); desktop: Semana, a mesma visão de 7 dias da Agenda anterior
  const [view, setView] = useState<View>(() => (matchMedia('(min-width: 640px)').matches ? 'week' : 'day'));
  const [cur, setCur] = useState(today);
  const [from, to] = rangeOf(view, cur);
  const ap = useLoad<Appt[]>(`/appointments?from=${from}&to=${to}`);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fProc, setFProc] = useState<string[]>([]);
  const [open, setOpen] = useState<Appt | null>(null);
  const [moving, setMoving] = useState<Appt | null>(null);
  const [concluding, setConcluding] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { // fecha os filtros abertos ao tocar fora deles
    const close = (e: PointerEvent) => document.querySelectorAll<HTMLDetailsElement>('.ag-dd[open]').forEach((d) => { if (!d.contains(e.target as Node)) d.open = false; });
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  async function complete(id: string) {
    if (isClinical) { setOpen(null); setConcluding(id); return; } // mesma regra do Início: perfil clínico confirma a baixa de estoque
    setBusy(true);
    try { await api(`/appointments/${id}/complete`, { method: 'POST', json: {} }); setOpen(null); ap.reload(); }
    catch (e) { toast(completeErr(e)); }
    finally { setBusy(false); }
  }

  const all = ap.data ?? [];
  const procs = [...new Set(all.map((a) => a.procedure ?? 'Sem procedimento'))].sort();
  const term = q.trim().toLowerCase();
  const list = all.filter((a) => (!term || `${a.patient} ${a.procedure ?? ''}`.toLowerCase().includes(term))
    && (!fStatus.length || fStatus.includes(statusOf(a)))
    && (!fProc.length || fProc.includes(a.procedure ?? 'Sem procedimento')))
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const byDay = new Map<string, Appt[]>();
  for (const a of list) { const k = apptDay(a.starts_at); byDay.set(k, [...(byDay.get(k) ?? []), a]); }
  const filtered = !!(term || fStatus.length || fProc.length);
  const clear = () => { setQ(''); setFStatus([]); setFProc([]); };

  const step = (n: number) => setCur((c) => view === 'month' ? addMonths(c, n) : addDays(c, n * (view === 'week' ? 7 : view === 'day' ? 1 : 30)));
  const goDay = (d: string) => { setCur(d); setView('day'); };
  const title = view === 'month' ? fmt(cur, { month: 'long', year: 'numeric' })
    : view === 'week' ? `Semana de ${fmt(from, { day: 'numeric', month: 'short' }).replace('.', '').replace(' de ', ' ')}`
    : view === 'day' ? fmt(cur, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'Todos os atendimentos';
  const sub = view === 'list' ? `${fmt(from, { day: 'numeric', month: 'short' })} a ${fmt(to, { day: 'numeric', month: 'short' })} · ${list.length} ${list.length === 1 ? 'atendimento' : 'atendimentos'}` : '';

  // faixa de horas da semana/dia: horário da clínica, ampliado para não esconder atendimentos fora dele
  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [cur];
  const ivs = (d: string) => (hours[String(weekday(d))] ?? []).map(([s, e]) => [toMin(s), toMin(e)] as const);
  let lo = Infinity, hi = -Infinity;
  for (const d of days) for (const [s, e] of ivs(d)) { lo = Math.min(lo, Math.floor(s / 60)); hi = Math.max(hi, Math.ceil(e / 60)); }
  for (const d of days) for (const a of byDay.get(d) ?? []) { const h = Number(hm(a.starts_at).slice(0, 2)); lo = Math.min(lo, h); hi = Math.max(hi, h + 1); }
  if (lo === Infinity) { lo = 8; hi = 18; }
  const hourRows = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const at = (d: string, h: number) => (byDay.get(d) ?? []).filter((a) => Number(hm(a.starts_at).slice(0, 2)) === h);
  const isOpen = (d: string, h: number) => ivs(d).some(([s, e]) => h * 60 < e && (h + 1) * 60 > s);
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;


  return (
    <div className="ag">
      <div className="ag-head">
        <div className="ag-title">
          <h2 aria-live="polite">{title}</h2>
          {sub && <p className="muted">{sub}</p>}
          <div className="ag-nav">
            <button className="icon-btn" aria-label="Anterior" onClick={() => step(-1)}><Icon name="back" size={20} /></button>
            <button className="ghost sm" onClick={() => setCur(today)}>Hoje</button>
            <button className="icon-btn" aria-label="Próximo" onClick={() => step(1)}><Icon name="arrow" size={20} /></button>
          </div>
        </div>
        <div className="ag-tools">
          <div className="ag-seg" role="tablist" aria-label="Visualização">
            {VIEWS.map((v) => <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}><Icon name={v.icon} size={16} />{v.label}</button>)}
          </div>
          <select className="ag-select" aria-label="Visualização" value={view} onChange={(e) => setView(e.target.value as View)}>
            {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <button className="primary sm" onClick={() => setCreating(true)}><Icon name="plus" size={16} />Novo agendamento</button>
        </div>
      </div>

      <div className="ag-filters">
        <label className="search ag-search">
          <Icon name="search" size={18} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar paciente ou procedimento" aria-label="Buscar atendimento" />
          {q && <button type="button" className="ag-x" aria-label="Limpar busca" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}
        </label>
        <Filter label="Status" options={Object.keys(STATUS)} value={fStatus} set={setFStatus} />
        <Filter label="Procedimento" options={procs} value={fProc} set={setFProc} />
        {filtered && <button className="ghost sm" onClick={clear}>Limpar</button>}
      </div>
      {filtered && (
        <ul className="ag-chips" aria-label="Filtros ativos">
          {term && <li><span>Busca: “{q.trim()}”</span><button aria-label="Remover busca" onClick={() => setQ('')}><Icon name="close" size={14} /></button></li>}
          {fStatus.map((s) => <li key={s}><span>{STATUS[s]}</span><button aria-label={`Remover ${STATUS[s]}`} onClick={() => setFStatus(fStatus.filter((x) => x !== s))}><Icon name="close" size={14} /></button></li>)}
          {fProc.map((p) => <li key={p}><span>{p}</span><button aria-label={`Remover ${p}`} onClick={() => setFProc(fProc.filter((x) => x !== p))}><Icon name="close" size={14} /></button></li>)}
        </ul>
      )}

      {ap.error ? <p role="alert" className="err">{ap.error}</p> : !ap.data ? <ListSkeleton rows={3} /> : (
        <section className={`card ag-body ag-v-${view}`}>
          {view === 'month' && (
            <div className="ag-month">
              {WEEK.map((w) => <div key={w} className="ag-wd"><span className="ag-long">{w}</span><span className="ag-short">{w[0]}</span></div>)}
              {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
                const evs = byDay.get(d) ?? [];
                return (
                  <div key={d} className={`ag-cell${d.slice(0, 7) !== cur.slice(0, 7) ? ' out' : ''}`}>
                    <button className={`ag-num${d === today ? ' today' : ''}`} aria-label={fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })} onClick={() => goDay(d)}>{Number(d.slice(8))}</button>
                    {evs.slice(0, 3).map((a) => <Event key={a.id} a={a} onOpen={setOpen} />)}
                    {evs.length > 3 && <button className="ag-more" onClick={() => goDay(d)}>+{evs.length - 3} mais</button>}
                    {evs.length > 0 && <button className="ag-dot" aria-label={`${evs.length} atendimento(s)`} onClick={() => goDay(d)}>{evs.length}</button>}
                  </div>
                );
              })}
            </div>
          )}

          {view === 'week' && (
            <div className="ag-week">
              <div className="ag-corner" />
              {days.map((d, i) => (
                <button key={d} className={`ag-wh${d === today ? ' today' : ''}`} onClick={() => goDay(d)}>
                  <span className="ag-long">{WEEK[i]}</span><span className="ag-short">{WEEK[i]![0]}</span><b>{Number(d.slice(8))}</b>
                </button>
              ))}
              {hourRows.map((h) => [
                <div key={`t${h}`} className="ag-time">{hh(h)}</div>,
                ...days.map((d) => <div key={d + h} className={`ag-slot${isOpen(d, h) ? '' : ' off'}`}>{at(d, h).map((a) => <Event key={a.id} a={a} onOpen={setOpen} />)}</div>),
              ])}
            </div>
          )}

          {view === 'day' && (!ivs(cur).length && !(byDay.get(cur) ?? []).length
            ? <Empty icon="calendar" title={filtered ? 'Nada encontrado' : 'Clínica fechada neste dia'} text={filtered ? 'Nenhum atendimento com esses filtros.' : 'Não há horário de atendimento configurado para este dia.'} />
            : (
              <div className="ag-day">
                {hourRows.map((h) => (
                  <div key={h} className={`ag-hour${isOpen(cur, h) ? '' : ' off'}`}>
                    <div className="ag-time">{hh(h)}</div>
                    <div className="ag-hcell">{at(cur, h).map((a) => <Event key={a.id} a={a} detail onOpen={setOpen} />)}</div>
                  </div>
                ))}
              </div>
            ))}

          {view === 'list' && (byDay.size === 0
            ? <Empty icon="calendar" title={filtered ? 'Nada encontrado' : 'Agenda livre'} text={filtered ? 'Nenhum atendimento com esses filtros.' : 'Nenhum atendimento nos próximos 30 dias.'} />
            : [...byDay].map(([d, items]) => (
              <div key={d} className="ag-group">
                <h3 className="cap">{d === today ? 'Hoje · ' : ''}{fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                <ul>
                  {items.map((a) => (
                    <li key={a.id}>
                      <button className="ag-item" onClick={() => setOpen(a)}>
                        <i className={`ag-c s-${statusOf(a)}`} aria-hidden="true" />
                        <span className="grow"><b>{a.patient}</b><span className="muted">{a.procedure ?? 'Sem procedimento'} · {span(a)}</span></span>
                        <em className={`ag-st s-${statusOf(a)}`}>{STATUS[statusOf(a)]}</em>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )))}
        </section>
      )}

      {open && <ApptSheet appt={open} clinical={isClinical} busy={busy} onClose={() => setOpen(null)}
        onStart={() => { const a = open; setOpen(null); onStart(a.patient_id, a); }} onChart={() => { const a = open; setOpen(null); onStart(a.patient_id, null); }}
        onComplete={() => complete(open.id)} onMove={() => { setMoving(open); setOpen(null); }} />}
      {moving && <RescheduleSheet appt={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); ap.reload(); }} />}
      {concluding && <ConcluirAtendimento appointmentId={concluding} onClose={() => setConcluding('')} onDone={ap.reload} />}
      {creating && <AppointmentSheet onClose={() => setCreating(false)} onCreated={() => { setCreating(false); ap.reload(); }} />}
    </div>
  );
}
