import { useState, type FormEvent } from 'react';
import { ApiError, api, brl } from './api';
import { useLoad } from './hooks';

type Opt = { value: string; label: string };
type Field = { name: string; label: string; type?: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'textarea' | 'datetime-local';
  options?: Opt[]; required?: boolean; def?: string | boolean; step?: string };
type Values = Record<string, string | boolean>;

const useList = useLoad;

const errText = (e: unknown) =>
  e instanceof ApiError && e.status === 403 ? 'Sem permissão para esta ação.'
  : e instanceof ApiError && e.message === 'validation' ? 'Confira os campos preenchidos.'
  : e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível salvar. Tente novamente.';

function AddForm({ fields, label, onSubmit }: { fields: Field[]; label: string; onSubmit: (v: Record<string, unknown>) => Promise<void> }) {
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
            <input type={f.type ?? 'text'} step={f.step} inputMode={f.type === 'number' ? 'decimal' : undefined} value={String(v[f.name])}
              required={f.required} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          )}
        </label>
      ))}
      {err && <p role="alert" className="err">{err}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Salvando…' : label}</button>
    </form>
  );
}

const Loading = ({ error, ready }: { error: string; ready: boolean }) =>
  error ? <p role="alert" className="err">{error}</p> : !ready ? <p className="muted">Carregando…</p> : null;

// ---------- Agendar (usado na aba Hoje) ----------
export function NewAppointment({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const patients = useList<any[]>('/patients');
  const procs = useList<any[]>('/procedures');
  if (!open) return <button className="primary sm" onClick={() => setOpen(true)}>+ Agendar</button>;

  const fields: Field[] = [
    { name: 'patientId', label: 'Paciente', type: 'select', required: true, options: patients.data?.map((p) => ({ value: p.id, label: p.full_name })) },
    { name: 'procedureId', label: 'Procedimento', type: 'select', options: procs.data?.map((p) => ({ value: p.id, label: `${p.name} — ${brl(Number(p.default_price))}` })) },
    { name: 'start', label: 'Início', type: 'datetime-local', required: true },
  ];
  return (
    <div className="inline-form">
      <AddForm fields={fields} label="Agendar" onSubmit={async (v) => {
        const proc = procs.data?.find((p) => p.id === v.procedureId);
        const start = new Date(String(v.start));
        const end = new Date(start.getTime() + (proc?.duration_min ?? 60) * 60_000);
        await api('/appointments', { method: 'POST', json: { patientId: v.patientId, procedureId: v.procedureId, startsAt: start.toISOString(), endsAt: end.toISOString() } });
        setOpen(false); onCreated();
      }} />
      <button className="ghost sm" onClick={() => setOpen(false)}>Cancelar</button>
    </div>
  );
}

// ---------- Aba Cadastros ----------
export type Section = 'pacientes' | 'procedimentos' | 'estoque' | 'mensagens';
export function Cadastros({ section }: { section: Section }) {
  return (
    <>
      {section === 'pacientes' && <Patients />}
      {section === 'procedimentos' && <Procedures />}
      {section === 'estoque' && <Products />}
      {section === 'mensagens' && <Messages />}
    </>
  );
}

function Patients() {
  const l = useList<any[]>('/patients');
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <PatientDetail id={open} onClose={() => setOpen(null)} />;
  return (
    <>
      <section className="card"><h2>Novo paciente</h2>
        <AddForm label="Salvar paciente" onSubmit={async (v) => { await api('/patients', { method: 'POST', json: v }); l.reload(); }} fields={[
          { name: 'fullName', label: 'Nome completo', required: true },
          { name: 'birthDate', label: 'Nascimento', type: 'date' },
          { name: 'phone', label: 'Telefone (com DDD)' },
          { name: 'cpf', label: 'CPF (opcional)' },
          { name: 'marketingConsent', label: 'Autoriza receber mensagens (aniversário, pós-procedimento)', type: 'checkbox' },
        ]} />
      </section>
      <section className="card"><h2>Pacientes</h2>
        <Loading error={l.error} ready={!!l.data} />
        <ul className="rows">{l.data?.map((p) => (
          <li key={p.id}><div><button className="link" onClick={() => setOpen(p.id)}>{p.full_name}</button><div className="muted">{p.phone ?? 'sem telefone'}</div></div>
            {p.birth_date && <span className="muted">{new Date(`${p.birth_date}T12:00`).toLocaleDateString('pt-BR')}</span>}</li>
        ))}</ul>
      </section>
    </>
  );
}

const fmtCpf = (d: string) => d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

// Ficha clínica: CPF em claro e prontuário. A API só entrega a perfis clínicos e registra cada acesso.
function PatientDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const p = useLoad<any>(`/patients/${id}`);
  const recs = useLoad<any[]>(`/patients/${id}/records`);
  const denied = p.error === 'forbidden' || recs.error === 'forbidden';
  return (
    <>
      <button className="ghost sm" onClick={onClose}>← Pacientes</button>
      {denied ? <section className="card"><p className="muted">Seu perfil não tem acesso à ficha clínica.</p></section> : (
        <>
          <Loading error={p.error} ready={!!p.data} />
          {p.data && (
            <section className="card">
              <h2>{p.data.full_name}</h2>
              <dl className="facts">
                <dt>CPF</dt><dd>{p.data.cpf ? fmtCpf(p.data.cpf) : '—'}</dd>
                <dt>Telefone</dt><dd>{p.data.phone ?? '—'}</dd>
                <dt>Nascimento</dt><dd>{p.data.birth_date ? new Date(`${p.data.birth_date}T12:00`).toLocaleDateString('pt-BR') : '—'}</dd>
              </dl>
              <p className="muted" style={{ marginTop: 10 }}>Dados sensíveis: cada acesso a esta ficha é registrado.</p>
            </section>
          )}
          <section className="card"><h2>Novo registro clínico</h2>
            <AddForm label="Salvar registro" onSubmit={async (v) => { await api(`/patients/${id}/records`, { method: 'POST', json: v }); recs.reload(); }} fields={[
              { name: 'allergies', label: 'Alergias', type: 'textarea' },
              { name: 'evolution', label: 'Evolução / observações', type: 'textarea' },
            ]} />
          </section>
          <section className="card"><h2>Histórico</h2>
            <Loading error={recs.error} ready={!!recs.data} />
            {recs.data?.length === 0 && <p className="muted">Nenhum registro ainda.</p>}
            <ul className="rows">{recs.data?.map((r) => (
              <li key={r.id} className="stack">
                <div className="muted">{new Date(r.createdAt).toLocaleString('pt-BR')} · {r.author ?? '—'}</div>
                {r.allergies && <div><b>Alergias:</b> {r.allergies}</div>}
                {r.evolution && <div className="pre">{r.evolution}</div>}
              </li>
            ))}</ul>
          </section>
        </>
      )}
    </>
  );
}

function Procedures() {
  const l = useList<any[]>('/procedures');
  return (
    <>
      <section className="card"><h2>Novo procedimento</h2>
        <AddForm label="Salvar procedimento" onSubmit={async (v) => { await api('/procedures', { method: 'POST', json: v }); l.reload(); }} fields={[
          { name: 'name', label: 'Nome', required: true },
          { name: 'defaultPrice', label: 'Preço (R$)', type: 'number', step: '0.01', required: true },
          { name: 'durationMin', label: 'Duração (min)', type: 'number', def: '60' },
        ]} />
      </section>
      <section className="card"><h2>Procedimentos</h2>
        <Loading error={l.error} ready={!!l.data} />
        <ul className="rows">{l.data?.map((p) => (
          <li key={p.id}><div>{p.name}<div className="muted">{p.duration_min} min</div></div><b>{brl(Number(p.default_price))}</b></li>
        ))}</ul>
      </section>
    </>
  );
}

function StockRow({ p, onDone }: { p: any; onDone: () => void }) {
  const [qty, setQty] = useState('');
  const [err, setErr] = useState('');
  async function move(sign: 1 | -1, reason: 'purchase' | 'loss') {
    const n = Number(qty);
    if (!n || n <= 0) return;
    setErr('');
    try { await api(`/products/${p.id}/movements`, { method: 'POST', json: { delta: sign * n, reason } }); setQty(''); onDone(); }
    catch (e) { setErr(e instanceof ApiError && e.status === 409 ? 'Estoque insuficiente.' : errText(e)); }
  }
  const low = Number(p.quantity) <= Number(p.min_quantity);
  return (
    <li className="stack">
      <div className="between">
        <div>{p.name}<div className="muted">mín. {Number(p.min_quantity)} · alvo {Number(p.target_quantity)} {p.unit}</div></div>
        <span className={`pill ${low ? 'warn' : 'ok'}`}>{Number(p.quantity)} {p.unit}</span>
      </div>
      <div className="adjust">
        <input type="number" min="0" step="any" inputMode="decimal" placeholder="Qtd." aria-label={`Quantidade de ${p.name}`} value={qty} onChange={(e) => setQty(e.target.value)} />
        <button className="ghost sm" onClick={() => move(1, 'purchase')}>Entrada</button>
        <button className="ghost sm" onClick={() => move(-1, 'loss')}>Perda</button>
      </div>
      {err && <p role="alert" className="err">{err}</p>}
    </li>
  );
}

function Products() {
  const l = useList<any[]>('/products');
  return (
    <>
      <section className="card"><h2>Novo produto</h2>
        <AddForm label="Salvar produto" onSubmit={async (v) => { await api('/products', { method: 'POST', json: v }); l.reload(); }} fields={[
          { name: 'name', label: 'Nome', required: true },
          { name: 'unit', label: 'Unidade', def: 'un' },
          { name: 'minQuantity', label: 'Estoque mínimo (avisar abaixo disso)', type: 'number', step: 'any', required: true },
          { name: 'targetQuantity', label: 'Estoque alvo (quanto ter após repor)', type: 'number', step: 'any', required: true },
          { name: 'unitCost', label: 'Custo unitário (R$)', type: 'number', step: '0.01' },
        ]} />
      </section>
      <section className="card"><h2>Produtos</h2>
        <Loading error={l.error} ready={!!l.data} />
        <ul className="rows">{l.data?.map((p) => <StockRow key={p.id} p={p} onDone={l.reload} />)}</ul>
      </section>
    </>
  );
}

const KIND: Record<string, string> = { birthday: 'Aniversário', followup: 'Pós-procedimento', reminder: 'Lembrete' };

function Messages() {
  const auto = useList<{ templates: any[]; followupRules: any[] }>('/automation');
  const procs = useList<any[]>('/procedures');
  const t = auto.data?.templates ?? [];
  return (
    <>
      <section className="card"><h2>Novo modelo de mensagem</h2>
        <p className="muted">Use {'{{nome}}'} para o primeiro nome do paciente. Só recebem mensagens pacientes que autorizaram.</p>
        <AddForm label="Salvar modelo" onSubmit={async (v) => { await api('/automation/templates', { method: 'POST', json: v }); auto.reload(); }} fields={[
          { name: 'kind', label: 'Tipo', type: 'select', required: true, options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
          { name: 'body', label: 'Mensagem', type: 'textarea', required: true },
        ]} />
      </section>
      <section className="card"><h2>Modelos</h2>
        <Loading error={auto.error} ready={!!auto.data} />
        <ul className="rows">{t.map((m) => <li key={m.id}><div><b>{KIND[m.kind] ?? m.kind}</b><div className="muted">{m.body}</div></div></li>)}</ul>
        <p className="muted" style={{ marginTop: 12 }}>As mensagens entram na fila e saem pelo WhatsApp; sem a conexão configurada, ficam como falhas na fila.</p>
      </section>
      <section className="card"><h2>Nova regra pós-procedimento</h2>
        <AddForm label="Salvar regra" onSubmit={async (v) => { await api('/automation/followup-rules', { method: 'POST', json: v }); auto.reload(); }} fields={[
          { name: 'procedureId', label: 'Procedimento (vazio = todos)', type: 'select', options: procs.data?.map((p) => ({ value: p.id, label: p.name })) },
          { name: 'daysAfter', label: 'Dias após o atendimento', type: 'number', def: '1', required: true },
          { name: 'templateId', label: 'Modelo', type: 'select', required: true, options: t.filter((m) => m.kind === 'followup').map((m) => ({ value: m.id, label: m.body.slice(0, 40) })) },
        ]} />
        <ul className="rows" style={{ marginTop: 12 }}>{auto.data?.followupRules.map((r) => (
          <li key={r.id}><span>{r.days_after} dia(s) após {procs.data?.find((p) => p.id === r.procedure_id)?.name ?? 'qualquer procedimento'}</span></li>
        ))}</ul>
      </section>
    </>
  );
}
