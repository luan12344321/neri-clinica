import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, brl } from './api';
import { useLoad } from './hooks';
import { ComprovantesDoPaciente } from './Comprovante';
import { ConcluirAtendimento } from './Atendimento';
import { ConsentimentoPaciente } from './Consentimento';
import { Icon } from './Icon';
import { dayIntervals, fromMin, slotsOf, useHours } from './hours';
import { RegraRetornoSheet } from './RegraRetorno';
import { Avatar, Empty, ListSkeleton, PageHead, Sheet, useRole, useToast } from './ui';

type Opt = { value: string; label: string };
export type Field = { name: string; label: string; type?: 'text' | 'email' | 'password' | 'number' | 'date' | 'checkbox' | 'select' | 'textarea' | 'datetime-local';
  options?: Opt[]; required?: boolean; def?: string | boolean; step?: string };
type Values = Record<string, string | boolean>;

const useList = useLoad;

const KNOWN: Record<string, string> = {
  'email in use': 'Já existe um usuário com esse e-mail.',
  'wrong password': 'Senha atual incorreta.',
};
export const errText = (e: unknown) =>
  e instanceof ApiError && e.status === 403 && e.message in KNOWN ? KNOWN[e.message]!
  : e instanceof ApiError && e.status === 403 ? 'Sem permissão para esta ação.'
  : e instanceof ApiError && e.message === 'validation' ? 'Confira os campos preenchidos (senhas precisam de 10 ou mais caracteres).'
  : e instanceof ApiError && e.message in KNOWN ? KNOWN[e.message]!
  : e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível salvar. Tente novamente.';

export function AddForm({ fields, label, onSubmit }: { fields: Field[]; label: string; onSubmit: (v: Record<string, unknown>) => Promise<void> }) {
  const init = () => Object.fromEntries(fields.map((f) => [f.name, f.def ?? (f.type === 'checkbox' ? false : '')])) as Values;
  const [v, setV] = useState<Values>(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const val = v[f.name];
      if (f.type === 'checkbox') out[f.name] = !!val;
      else if (val !== '') out[f.name] = f.type === 'number' ? Number(val) : val;
    }
    try { await onSubmit(out); setV(init()); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={submit}>
      {fields.map((f) => f.type === 'checkbox' ? (
        <label key={f.name} className="check"><input type="checkbox" checked={!!v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} />{f.label}</label>
      ) : (
        <label key={f.name}>{f.label}
          {f.type === 'select' ? (
            <select value={String(v[f.name])} required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>
              <option value="">Selecione…</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea rows={3} value={String(v[f.name])} required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          ) : (
            <input type={f.type ?? 'text'} autoComplete={f.type === 'password' ? 'new-password' : f.type === 'email' ? 'off' : undefined} step={f.step} inputMode={f.type === 'number' ? 'decimal' : undefined} value={String(v[f.name])}
              required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          )}
        </label>
      ))}
      {err && <p role="alert" className="err">{err}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Salvando…' : label}</button>
    </form>
  );
}

const Loading = ({ error, ready, rows }: { error: string; ready: boolean; rows?: number }) =>
  error ? <p role="alert" className="err">{error}</p> : !ready ? <ListSkeleton rows={rows} /> : null;

const dateBR = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00`).toLocaleDateString('pt-BR');
const isBirthday = (d?: string | null) => !!d && String(d).slice(5, 10) === new Date().toISOString().slice(5, 10);

// ---------- Agendar e reagendar: dia e horário em chips (horários ocupados e passados ficam desativados) ----------
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const SLOTS = Array.from({ length: 27 }, (_, i) => `${pad(7 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`); // 07:00 às 20:00
type Slot = { date: string; time: string };

export function SlotPicker({ value, onChange, ignoreId }: { value: Slot; onChange: (v: Slot) => void; ignoreId?: string }) {
  const { hours } = useHours();
  const [showAll, setShowAll] = useState(false); // encaixe fora do expediente
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  const isOpen = (d: Date) => dayIntervals(hours, d).length > 0;
  const selected = new Date(`${value.date}T12:00`);
  const nextDay = new Date(selected); nextDay.setDate(nextDay.getDate() + 1);
  const day = useList<any[]>(`/appointments?from=${value.date}&to=${ymd(nextDay)}`);

  // Se o dia escolhido está fechado, vai para o primeiro dia aberto (só enquanto nenhum horário foi escolhido).
  useEffect(() => {
    if (showAll || value.time || isOpen(selected)) return;
    const open = days.find(isOpen);
    if (open) onChange({ date: ymd(open), time: '' });
  }, [hours, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const intervals = dayIntervals(hours, selected);
  const groups = showAll ? [{ label: 'Qualquer horário', times: SLOTS }] : intervals.map(([s, e]) => ({ label: `${fromMin(s)} às ${fromMin(e)}`, times: slotsOf([[s, e]]) }));
  const taken = (time: string) => {
    const t0 = new Date(`${value.date}T${time}`).getTime();
    return (day.data ?? []).some((a) => a.id !== ignoreId && a.status !== 'canceled' && t0 >= new Date(a.starts_at).getTime() && t0 < new Date(a.ends_at).getTime());
  };
  const past = (time: string) => new Date(`${value.date}T${time}`).getTime() < Date.now();
  return (
    <div className="picker">
      <div className="date-strip" role="listbox" aria-label="Dia">
        {days.map((d) => {
          const closed = !showAll && !isOpen(d);
          return (
            <button key={ymd(d)} role="option" aria-selected={value.date === ymd(d)} disabled={closed} className={closed ? 'closed' : ''} onClick={() => onChange({ date: ymd(d), time: '' })}>
              <i>{d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</i><b>{d.getDate()}</b>
            </button>
          );
        })}
      </div>
      {groups.length === 0 && <p className="muted">A clínica não atende neste dia.</p>}
      {groups.map((g) => (
        <div key={g.label} className="time-group">
          <p className="muted time-cap">{g.label}</p>
          <div className="time-grid" role="listbox" aria-label={`Horários ${g.label}`}>
            {g.times.map((time) => {
              const off = past(time) || taken(time);
              return <button key={time} role="option" aria-selected={value.time === time} disabled={off} onClick={() => onChange({ ...value, time })}>{time}</button>;
            })}
          </div>
        </div>
      ))}
      <button type="button" className="link small" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Mostrar só o horário de atendimento' : 'Precisa de um horário fora do expediente?'}</button>
    </div>
  );
}

export function AppointmentSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const patients = useList<any[]>('/patients');
  const procs = useList<any[]>('/procedures');
  const [patientId, setPatientId] = useState('');
  const [procedureId, setProcedureId] = useState('');
  const [slot, setSlot] = useState<Slot>({ date: ymd(new Date()), time: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) return setErr('Escolha o paciente.');
    if (!slot.time) return setErr('Escolha o horário.');
    setBusy(true); setErr('');
    try {
      const proc = procs.data?.find((p) => p.id === procedureId);
      const start = new Date(`${slot.date}T${slot.time}`);
      const end = new Date(start.getTime() + (proc?.duration_min ?? 60) * 60_000);
      await api('/appointments', { method: 'POST', json: { patientId, procedureId: procedureId || undefined, startsAt: start.toISOString(), endsAt: end.toISOString() } });
      onCreated(); toast('Agendamento criado');
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  }
  return (
    <Sheet title="Novo agendamento" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Paciente
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)} required>
            <option value="">Selecione…</option>
            {patients.data?.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <label>Procedimento
          <select value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
            <option value="">Sem procedimento</option>
            {procs.data?.map((p) => <option key={p.id} value={p.id}>{p.name} — {brl(Number(p.default_price))}</option>)}
          </select>
        </label>
        <div className="form-label">Dia e horário<SlotPicker value={slot} onChange={setSlot} /></div>
        {err && <p role="alert" className="err">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Agendar'}</button>
      </form>
    </Sheet>
  );
}

export function RescheduleSheet({ appt, onClose, onDone }: { appt: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [slot, setSlot] = useState<Slot>({ date: ymd(new Date(appt.starts_at)), time: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    if (!slot.time) return setErr('Escolha o novo horário.');
    setBusy(true); setErr('');
    try {
      const minutes = appt.ends_at ? Math.max(15, Math.round((new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60_000)) : 60;
      const start = new Date(`${slot.date}T${slot.time}`);
      await api(`/appointments/${appt.id}`, { method: 'PATCH', json: { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() } });
      onDone(); toast('Atendimento reagendado');
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  }
  return (
    <Sheet title="Reagendar" onClose={onClose}>
      <p className="muted"><b>{appt.patient}</b> · {appt.procedure ?? 'Sem procedimento'} · hoje às {hhmm(new Date(appt.starts_at))}</p>
      <SlotPicker value={slot} onChange={setSlot} ignoreId={appt.id} />
      {err && <p role="alert" className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={go}>{busy ? 'Salvando…' : 'Confirmar novo horário'}</button>
    </Sheet>
  );
}

export function NewAppointment({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="primary sm" onClick={() => setOpen(true)}><Icon name="plus" size={16} />Agendar</button>
      {open && <AppointmentSheet onClose={() => setOpen(false)} onCreated={() => { setOpen(false); onCreated(); }} />}
    </>
  );
}

// ---------- Seções do menu ----------
export type Focus = { id: string; appt?: { id: string; label: string } };
export type Section = 'pacientes' | 'procedimentos' | 'estoque' | 'mensagens';
export function Cadastros({ section, autoOpen = false, focus = null, onFinish }: { section: Section; autoOpen?: boolean; focus?: Focus | null; onFinish?: () => void }) {
  return (
    <>
      {section === 'pacientes' && <Patients autoOpen={autoOpen} focus={focus} onFinish={onFinish} />}
      {section === 'procedimentos' && <Procedures />}
      {section === 'estoque' && <Products />}
      {section === 'mensagens' && <Messages />}
    </>
  );
}

function Patients({ autoOpen = false, focus = null, onFinish }: { autoOpen?: boolean; focus?: Focus | null; onFinish?: () => void }) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const l = useList<any[]>(`/patients?search=${encodeURIComponent(term)}`);
  const [open, setOpen] = useState<string | null>(focus?.id ?? null);
  const [adding, setAdding] = useState(autoOpen);
  const toast = useToast();
  if (open) return <PatientDetail id={open} onClose={() => setOpen(null)} session={focus?.id === open ? focus.appt : undefined} onFinish={onFinish} />;
  return (
    <>
      <PageHead title="Pacientes" hint={l.data ? `${l.data.length} ${term ? 'encontrado(s)' : 'cadastrado(s)'}` : undefined}>
        <button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Novo paciente</button>
      </PageHead>
      <label className="search"><Icon name="search" size={18} /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome" aria-label="Buscar paciente" /></label>
      <section className="card list-card">
        <Loading error={l.error} ready={!!l.data} />
        {l.data?.length === 0 && (term
          ? <Empty icon="search" title="Nenhum paciente encontrado" text={`Nada com “${term}”. Confira o nome ou cadastre um novo.`} />
          : <Empty icon="users" title="Nenhum paciente ainda" text="Cadastre o primeiro para poder agendar atendimentos."><button className="primary sm" onClick={() => setAdding(true)}>Novo paciente</button></Empty>)}
        <ul className="rows people">{l.data?.map((p) => (
          <li key={p.id}>
            <button className="row-btn" onClick={() => setOpen(p.id)}>
              <Avatar name={p.full_name} />
              <span className="grow"><b>{p.full_name}</b><span className="muted">{p.phone ?? 'sem telefone'}</span></span>
              {isBirthday(p.birth_date) ? <span className="pill hi">Aniversário hoje</span> : p.birth_date && <span className="muted">{dateBR(p.birth_date)}</span>}
            </button>
          </li>
        ))}</ul>
      </section>
      {adding && (
        <Sheet title="Novo paciente" onClose={() => setAdding(false)}>
          <AddForm label="Salvar paciente" onSubmit={async (v) => { await api('/patients', { method: 'POST', json: v }); l.reload(); setAdding(false); toast('Paciente cadastrado'); }} fields={[
            { name: 'fullName', label: 'Nome completo', required: true },
            { name: 'birthDate', label: 'Nascimento', type: 'date' },
            { name: 'phone', label: 'Telefone (com DDD)' },
            { name: 'cpf', label: 'CPF (opcional)' },
            { name: 'marketingConsent', label: 'Autoriza receber mensagens (aniversário, pós-procedimento)', type: 'checkbox' },
          ]} />
        </Sheet>
      )}
    </>
  );
}

const fmtCpf = (d: string) => d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

// Ficha clínica: CPF em claro e prontuário. A API só entrega a perfis clínicos e registra cada acesso.
function PatientDetail({ id, onClose, session, onFinish }: { id: string; onClose: () => void; session?: { id: string; label: string }; onFinish?: () => void }) {
  const [finishing, setFinishing] = useState(false); // folha "Concluir atendimento" aberta (baixa de estoque só com confirmação)
  const p = useLoad<any>(`/patients/${id}`);
  const recs = useLoad<any[]>(`/patients/${id}/records`);
  const ai = useLoad<any[]>(`/patients/${id}/ai-usage`); // vezes em que a Julia consultou o prontuário
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<'prontuario' | 'autorizacoes' | 'comprovantes'>('prontuario');
  const toast = useToast();
  const denied = p.error === 'forbidden' || recs.error === 'forbidden';
  const allergy = recs.data?.find((r) => r.allergies)?.allergies as string | undefined;
  return (
    <>
      <button className="back" onClick={onClose}><Icon name="back" size={18} />Pacientes</button>
      {session && (
        <section className="card session">
          <div className="grow"><span className="pill ok">Atendimento em andamento</span><b>{session.label}</b></div>
          <button className="primary" disabled={finishing} onClick={() => setFinishing(true)}>Concluir atendimento</button>
        </section>
      )}
      {session && finishing && <ConcluirAtendimento appointmentId={session.id} onClose={() => setFinishing(false)} onDone={() => onFinish?.()} />}
      {denied ? <section className="card"><Empty icon="alert" title="Sem acesso à ficha clínica" text="Seu perfil não tem permissão para ver dados clínicos." /></section> : (
        <>
          <Loading error={p.error} ready={!!p.data} rows={2} />
          {p.data && (
            <section className="card patient-head">
              <Avatar name={p.data.full_name} size={72} />
              <div className="grow">
                <h2>{p.data.full_name}</h2>
                {allergy && <span className="pill warn" style={{ marginBottom: 6 }}>Alergia: {allergy.length > 40 ? `${allergy.slice(0, 40)}…` : allergy}</span>}
                <dl className="facts">
                  <dt>CPF</dt><dd>{p.data.cpf ? fmtCpf(p.data.cpf) : '—'}</dd>
                  <dt>Telefone</dt><dd>{p.data.phone ?? '—'}</dd>
                  <dt>Nascimento</dt><dd>{p.data.birth_date ? dateBR(p.data.birth_date) : '—'}</dd>
                </dl>
              </div>
              <p className="muted note">Dados sensíveis: cada acesso a esta ficha é registrado.</p>
            </section>
          )}
          <div className="seg2" role="tablist" aria-label="Seções da ficha">
            {([['prontuario', 'Prontuário'], ['autorizacoes', 'Autorizações'], ['comprovantes', 'Comprovantes']] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'autorizacoes' && p.data && <section className="card"><ConsentimentoPaciente patientId={id} /></section>}
          {tab === 'prontuario' && <PageHead title="Prontuário"><button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Novo registro</button></PageHead>}
          {tab === 'prontuario' && <section className="card">
            <Loading error={recs.error} ready={!!recs.data} />
            {recs.data?.length === 0 && <Empty icon="pulse" title="Nenhum registro ainda" text="Alergias e evolução do paciente aparecem aqui, do mais recente ao mais antigo." />}
            <ul className="timeline">{recs.data?.map((r) => (
              <li key={r.id}>
                <div className="muted">{new Date(r.createdAt).toLocaleString('pt-BR')} · {r.author ?? '—'}</div>
                {r.allergies && <div><span className="pill warn">Alergias</span> {r.allergies}</div>}
                {r.evolution && <div className="pre">{r.evolution}</div>}
              </li>
            ))}</ul>
            {ai.data && ai.data.length > 0 && <p className="muted note">Julia consultou este prontuário em {new Date(ai.data[0].createdAt).toLocaleString('pt-BR')}{ai.data.length > 1 ? ` (${ai.data.length} consultas)` : ''}.</p>}
          </section>}
          {tab === 'comprovantes' && id && <ComprovantesDoPaciente patientId={id} />}
          {adding && (
            <Sheet title="Novo registro clínico" onClose={() => setAdding(false)}>
              <AddForm label="Salvar registro" onSubmit={async (v) => { await api(`/patients/${id}/records`, { method: 'POST', json: v }); recs.reload(); setAdding(false); toast('Registro salvo'); }} fields={[
                { name: 'allergies', label: 'Alergias', type: 'textarea' },
                { name: 'evolution', label: 'Evolução / observações', type: 'textarea' },
              ]} />
            </Sheet>
          )}
        </>
      )}
    </>
  );
}

function Procedures() {
  const { isManager } = useRole();
  const l = useList<any[]>('/procedures');
  const [adding, setAdding] = useState(false);
  const [ruleFor, setRuleFor] = useState<{ id: string; name: string } | null>(null);
  const toast = useToast();
  return (
    <>
      <PageHead title="Procedimentos" hint="Catálogo e preços">
        {isManager && <button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Novo procedimento</button>}
      </PageHead>
      <section className="card list-card">
        <Loading error={l.error} ready={!!l.data} />
        {l.data?.length === 0 && <Empty icon="syringe" title="Nenhum procedimento" text="Cadastre os serviços da clínica com preço e duração.">{isManager && <button className="primary sm" onClick={() => setAdding(true)}>Novo procedimento</button>}</Empty>}
        <ul className="rows">{l.data?.map((p) => (
          <li key={p.id}>
            <div className="row-btn static with-action">
              <span className="q-ico"><Icon name="syringe" size={20} /></span>
              <span className="grow"><b>{p.name}</b><span className="muted">{p.duration_min} min</span></span>
              <b className="amount">{brl(Number(p.default_price))}</b>
              <button className="ghost sm" style={{ minHeight: 44 }} onClick={() => setRuleFor({ id: p.id, name: p.name })} aria-label={`Regra de retorno de ${p.name}`}>Retorno</button>
            </div>
          </li>
        ))}</ul>
      </section>
      {ruleFor && <RegraRetornoSheet procedure={ruleFor} onClose={() => setRuleFor(null)} />}
      {adding && (
        <Sheet title="Novo procedimento" onClose={() => setAdding(false)}>
          <AddForm label="Salvar procedimento" onSubmit={async (v) => { await api('/procedures', { method: 'POST', json: v }); l.reload(); setAdding(false); toast('Procedimento salvo'); }} fields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'defaultPrice', label: 'Preço (R$)', type: 'number', step: '0.01', required: true },
            { name: 'durationMin', label: 'Duração (min)', type: 'number', def: '60' },
          ]} />
        </Sheet>
      )}
    </>
  );
}

function StockRow({ p, onDone }: { p: any; onDone: () => void }) {
  const [qty, setQty] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const toast = useToast();
  async function move(sign: 1 | -1, reason: 'purchase' | 'loss') {
    const n = Number(qty);
    if (!n || n <= 0) return;
    setErr('');
    try {
      await api(`/products/${p.id}/movements`, { method: 'POST', json: { delta: sign * n, reason } });
      setQty(''); setOpen(false); onDone(); toast(reason === 'purchase' ? 'Entrada registrada' : 'Perda registrada');
    } catch (e) { setErr(e instanceof ApiError && e.status === 409 ? 'Estoque insuficiente.' : errText(e)); }
  }
  const q = Number(p.quantity), min = Number(p.min_quantity), target = Number(p.target_quantity);
  const low = q <= min;
  const fill = target > 0 ? Math.min(100, (q / target) * 100) : 0;
  return (
    <li className="stack">
      <div className="between">
        <div><b>{p.name}</b><div className="muted">mín. {min} · alvo {target} {p.unit}</div></div>
        <span className={`pill ${low ? 'warn' : 'ok'}`}>{q} {p.unit}</span>
      </div>
      <div className={`meter${low ? ' low' : ''}`} role="img" aria-label={`${q} de ${target} ${p.unit}`}><div style={{ width: `${fill}%` }} /></div>
      {!open ? <button className="link" onClick={() => setOpen(true)}>Movimentar estoque</button> : (
        <div className="adjust">
          <input type="number" min="0" step="any" inputMode="decimal" placeholder="Quantidade" aria-label={`Quantidade de ${p.name}`} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          <button className="ghost sm" onClick={() => move(1, 'purchase')}>Entrada</button>
          <button className="ghost sm" onClick={() => move(-1, 'loss')}>Perda</button>
        </div>
      )}
      {err && <p role="alert" className="err">{err}</p>}
    </li>
  );
}

function Products() {
  const { isManager } = useRole();
  const l = useList<any[]>('/products');
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const lowCount = (l.data ?? []).filter((p) => Number(p.quantity) <= Number(p.min_quantity)).length;
  return (
    <>
      <PageHead title="Produtos" hint={l.data ? (lowCount ? `${lowCount} abaixo do mínimo` : 'Estoque em dia') : undefined}>
        <button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Novo produto</button>
      </PageHead>
      <section className="card list-card">
        <Loading error={l.error} ready={!!l.data} />
        {l.data?.length === 0 && <Empty icon="box" title="Nenhum produto" text="Cadastre insumos com estoque mínimo para receber o aviso de reposição."><button className="primary sm" onClick={() => setAdding(true)}>Novo produto</button></Empty>}
        <ul className="rows">{l.data?.map((p) => <StockRow key={p.id} p={p} onDone={l.reload} />)}</ul>
      </section>
      {adding && (
        <Sheet title="Novo produto" onClose={() => setAdding(false)}>
          <AddForm label="Salvar produto" onSubmit={async (v) => { await api('/products', { method: 'POST', json: v }); l.reload(); setAdding(false); toast('Produto cadastrado'); }} fields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'unit', label: 'Unidade', def: 'un' },
            { name: 'minQuantity', label: 'Estoque mínimo (avisar abaixo disso)', type: 'number', step: 'any', required: true },
            { name: 'targetQuantity', label: 'Estoque alvo (quanto ter após repor)', type: 'number', step: 'any', required: true },
            ...(isManager ? [{ name: 'unitCost', label: 'Custo unitário (R$)', type: 'number' as const, step: '0.01' }] : []), // custo é dado financeiro
          ]} />
        </Sheet>
      )}
    </>
  );
}

const KIND: Record<string, string> = { birthday: 'Aniversário', followup: 'Pós-procedimento', reminder: 'Lembrete' };

function Messages() {
  const auto = useList<{ templates: any[]; followupRules: any[] }>('/automation');
  const procs = useList<any[]>('/procedures');
  const [adding, setAdding] = useState<'modelo' | 'regra' | null>(null);
  const toast = useToast();
  const t = auto.data?.templates ?? [];
  return (
    <>
      <PageHead title="Mensagens" hint="Automáticas, por WhatsApp. Só recebem pacientes que autorizaram.">
        <button className="ghost sm" onClick={() => setAdding('regra')}>Nova regra</button>
        <button className="primary sm" onClick={() => setAdding('modelo')}><Icon name="plus" size={16} />Novo modelo</button>
      </PageHead>
      <section className="card list-card">
        <h2 className="sec">Modelos</h2>
        <Loading error={auto.error} ready={!!auto.data} />
        {auto.data && t.length === 0 && <Empty icon="mail" title="Nenhum modelo" text="Crie a mensagem de aniversário ou de pós-procedimento. Use {{nome}} para o primeiro nome."><button className="primary sm" onClick={() => setAdding('modelo')}>Novo modelo</button></Empty>}
        <ul className="rows">{t.map((m) => (
          <li key={m.id} className="stack"><span className="pill ok">{KIND[m.kind] ?? m.kind}</span><div className="msg-body">{m.body}</div></li>
        ))}</ul>
      </section>
      <section className="card list-card">
        <h2 className="sec">Regras pós-procedimento</h2>
        {auto.data && !auto.data.followupRules.length && <p className="muted pad">Nenhuma regra. Uma regra envia um modelo alguns dias após o atendimento.</p>}
        <ul className="rows">{auto.data?.followupRules.map((r) => (
          <li key={r.id}><div className="row-btn static"><span className="q-ico"><Icon name="calendar" size={20} /></span><span className="grow"><b>{r.days_after} dia(s) depois</b><span className="muted">{procs.data?.find((p) => p.id === r.procedure_id)?.name ?? 'qualquer procedimento'}</span></span></div></li>
        ))}</ul>
        <p className="muted pad">As mensagens entram na fila e saem pelo WhatsApp; sem a conexão configurada, ficam como falhas na fila.</p>
      </section>
      {adding === 'modelo' && (
        <Sheet title="Novo modelo de mensagem" onClose={() => setAdding(null)}>
          <p className="muted">Use {'{{nome}}'} para o primeiro nome do paciente.</p>
          <AddForm label="Salvar modelo" onSubmit={async (v) => { await api('/automation/templates', { method: 'POST', json: v }); auto.reload(); setAdding(null); toast('Modelo salvo'); }} fields={[
            { name: 'kind', label: 'Tipo', type: 'select', required: true, options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
            { name: 'body', label: 'Mensagem', type: 'textarea', required: true },
          ]} />
        </Sheet>
      )}
      {adding === 'regra' && (
        <Sheet title="Nova regra pós-procedimento" onClose={() => setAdding(null)}>
          <AddForm label="Salvar regra" onSubmit={async (v) => { await api('/automation/followup-rules', { method: 'POST', json: v }); auto.reload(); setAdding(null); toast('Regra salva'); }} fields={[
            { name: 'procedureId', label: 'Procedimento (vazio = todos)', type: 'select', options: procs.data?.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'daysAfter', label: 'Dias após o atendimento', type: 'number', def: '1', required: true },
            { name: 'templateId', label: 'Modelo', type: 'select', required: true, options: t.filter((m) => m.kind === 'followup').map((m) => ({ value: m.id, label: m.body.slice(0, 40) })) },
          ]} />
        </Sheet>
      )}
    </>
  );
}
