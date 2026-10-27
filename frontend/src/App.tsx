import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLoad } from './hooks';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, brl, getToken, monthLabel, setToken, thisMonth } from './api';

import { Cadastros, NewAppointment } from './Cadastros';

type Tab = 'hoje' | 'financeiro' | 'estoque' | 'cadastros' | 'sara';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'hoje', label: 'Hoje', icon: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z' },
  { id: 'financeiro', label: 'Financeiro', icon: 'M4 20V10h4v10zm6 0V4h4v16zm6 0v-7h4v7z' },
  { id: 'estoque', label: 'Estoque', icon: 'M3 7l9-4 9 4v10l-9 4-9-4zm9 4v9m0-9L3 7m9 4l9-4' },
  { id: 'cadastros', label: 'Cadastros', icon: 'M4 6h16M4 12h16M4 18h10' },
  { id: 'sara', label: 'Sara', icon: 'M4 5h16v11H9l-5 4z' },
];


export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState<Tab>('hoje');
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <div className="shell">
      <header className="top">
        <h1>Clínica</h1>
        <button className="ghost" onClick={() => { setToken(null); setAuthed(false); }}>Sair</button>
      </header>
      <main>
        {tab === 'hoje' && <Today />}
        {tab === 'financeiro' && <Finance />}
        {tab === 'estoque' && <Stock />}
        {tab === 'cadastros' && <Cadastros />}
        {tab === 'sara' && <Sara />}
      </main>
      <nav className="tabs" aria-label="Seções">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id} onClick={() => setTab(t.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { const r = await api<{ token: string }>('/auth/login', { method: 'POST', json: { email, password } }); setToken(r.token); onDone(); }
    catch (err) { setError(err instanceof Error && err.message === 'invalid credentials' ? 'E-mail ou senha incorretos.' : 'Não foi possível entrar. Tente novamente.'); }
    finally { setBusy(false); }
  }
  return (
    <form className="login" onSubmit={submit}>
      <h1>Clínica</h1>
      <p className="muted">Gestão na palma da mão.</p>
      <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {error && <p role="alert" className="err">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
    </form>
  );
}

const Status = ({ error, loading }: { error: string; loading: boolean }) =>
  error ? <p role="alert" className="err">{error}</p> : loading ? <p className="muted">Carregando…</p> : null;

// ---------- Hoje ----------
function Today() {
  const dash = useLoad<any>('/dashboard');
  const sum = useLoad<any>(`/finance/summary?month=${thisMonth()}`);
  const recv = useLoad<any[]>('/finance/receivables');
  const alerts = useLoad<any[]>('/alerts');
  const [busyId, setBusyId] = useState('');

  async function complete(id: string) {
    setBusyId(id);
    try { await api(`/appointments/${id}/complete`, { method: 'POST', json: {} }); dash.reload(); sum.reload(); recv.reload(); }
    finally { setBusyId(''); }
  }
  const d = dash.data, s = sum.data;
  const toReceive = (recv.data ?? []).reduce((a, t) => a + Number(t.amount), 0);
  const max = Math.max(1, ...(d?.topProcedures ?? []).map((p: any) => p.total));

  return (
    <>
      <Status error={dash.error || sum.error} loading={!d || !s} />
      {d && s && (
        <>
          <section className="kpis">
            <div className="kpi hero"><span>Receita do mês</span><strong>{brl(s.income)}</strong><small>Saldo {brl(s.balance)}</small></div>
            <div className="kpi"><span>Ticket médio</span><strong>{brl(s.averageTicket)}</strong></div>
            <div className="kpi"><span>A receber</span><strong>{brl(toReceive)}</strong></div>
          </section>

          {(alerts.data ?? []).length > 0 && (
            <section className="card warn">
              <h2>Atenção</h2>
              <ul className="rows">
                {alerts.data!.map((a) => (
                  <li key={a.id}><span>Repor <b>{a.payload.product}</b></span><span className="muted">tem {a.payload.quantity} · comprar {a.payload.buy}</span></li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <div className="between"><h2>Agenda de hoje</h2><NewAppointment onCreated={dash.reload} /></div>
            {d.today.length === 0 ? <p className="muted">Nenhum atendimento hoje.</p> : (
              <ul className="rows">
                {d.today.map((a: any) => (
                  <li key={a.id}>
                    <div>
                      <b>{new Date(a.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>{' '}{a.patient}
                      <div className="muted">{a.procedure ?? 'Sem procedimento'}</div>
                    </div>
                    {a.status === 'done' ? <span className="pill ok">Concluído</span>
                      : <button className="primary sm" disabled={busyId === a.id} onClick={() => complete(a.id)}>Concluir</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Faturamento — 6 meses</h2>
            <div className="chart" role="img" aria-label="Gráfico de barras do faturamento mensal">
              <ResponsiveContainer width="100%" height={190}>
                <BarChart data={d.revenueByMonth.map((r: any) => ({ ...r, m: monthLabel(r.month) }))} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--line)" />
                  <XAxis dataKey="m" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                  <Tooltip cursor={{ fill: 'var(--line)', opacity: 0.4 }} formatter={(v: number) => [brl(v), 'Receita']}
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }} />
                  <Bar dataKey="revenue" fill="var(--accent)" radius={[6, 6, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="card">
            <h2>Procedimentos mais realizados</h2>
            <ul className="bars">
              {d.topProcedures.map((p: any) => (
                <li key={p.name}>
                  <div className="lbl"><span>{p.name}</span><b>{p.total}</b></div>
                  <div className="track"><div style={{ width: `${(p.total / max) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          </section>
          <GoogleCard />
        </>
      )}
    </>
  );
}

function GoogleCard() {
  const st = useLoad<{ connected: boolean }>('/google/status');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('');
    try { await fn(); } catch { setMsg('Não foi possível concluir. Tente novamente.'); } finally { setBusy(false); }
  };
  if (!st.data) return null;
  return (
    <section className="card">
      <h2>Google Agenda</h2>
      {st.data.connected ? (
        <>
          <p className="muted">Conectado. Agendamentos e alterações são sincronizados a cada 5 minutos.</p>
          <div className="actions">
            <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('/google/sync', { method: 'POST', json: {} }); setMsg('Sincronizado.'); })}>Sincronizar agora</button>
            <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('/google', { method: 'DELETE' }); st.reload(); })}>Desconectar</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Veja a agenda da clínica também no Google Agenda do seu celular.</p>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<{ url: string }>('/google/connect', { method: 'POST', json: {} }); location.href = r.url; })}>Conectar Google Agenda</button>
          </div>
        </>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}
    </section>
  );
}

// ---------- Financeiro ----------
function Finance() {
  const [month, setMonth] = useState(thisMonth());
  const sum = useLoad<any>(`/finance/summary?month=${month}`);
  const dre = useLoad<any>(`/finance/dre?month=${month}`);
  const pay = useLoad<any[]>('/finance/payables');
  const recv = useLoad<any[]>('/finance/receivables');

  async function settle(id: string) {
    await api(`/finance/transactions/${id}/pay`, { method: 'POST', json: {} });
    pay.reload(); recv.reload(); sum.reload();
  }
  const s = sum.data, r = dre.data;
  const line = (label: string, v: number, strong = false) => (
    <tr className={strong ? 'strong' : ''}><td>{label}</td><td className={v < 0 ? 'neg' : ''}>{brl(v)}</td></tr>
  );
  const list = (title: string, items: any[] | null, cta: string) => (
    <section className="card">
      <h2>{title}</h2>
      {!items?.length ? <p className="muted">Nada pendente.</p> : (
        <ul className="rows">
          {items.map((t) => (
            <li key={t.id}>
              <div>{t.description}<div className="muted">vence {new Date(`${t.due_date}T12:00`).toLocaleDateString('pt-BR')}</div></div>
              <div className="right"><b>{brl(Number(t.amount))}</b><button className="ghost sm" onClick={() => settle(t.id)}>{cta}</button></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <div className="toolbar">
        <label>Mês<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>
      <Status error={sum.error || dre.error} loading={!s || !r} />
      {s && r && (
        <>
          <section className="kpis">
            <div className="kpi"><span>Receitas</span><strong>{brl(s.income)}</strong></div>
            <div className="kpi"><span>Despesas</span><strong>{brl(s.expense)}</strong></div>
            <div className="kpi hero"><span>Saldo</span><strong className={s.balance < 0 ? 'neg' : ''}>{brl(s.balance)}</strong><small>Ticket médio {brl(s.averageTicket)}</small></div>
          </section>
          <section className="card">
            <h2>DRE</h2>
            <table className="dre"><tbody>
              {line('Receita bruta', r.receitaBruta)}
              {line('(−) Deduções', -r.deducoes)}
              {line('Receita líquida', r.receitaLiquida, true)}
              {line('(−) Custos variáveis', -r.custosVariaveis)}
              {line('Lucro bruto', r.lucroBruto, true)}
              {line('(−) Despesas operacionais', -r.despesasOperacionais)}
              {line('Resultado operacional', r.resultadoOperacional, true)}
              {line('(−) Despesas financeiras', -r.despesasFinanceiras)}
              {line('(−) Impostos sobre o lucro', -r.impostosLucro)}
              {line('Lucro líquido', r.lucroLiquido, true)}
            </tbody></table>
          </section>
        </>
      )}
      {list('A receber', recv.data, 'Receber')}
      {list('A pagar', pay.data, 'Pagar')}
    </>
  );
}

// ---------- Estoque ----------
function Stock() {
  const restock = useLoad<any[]>('/stock/restock');
  const protocols = useLoad<any[]>('/protocols');
  return (
    <>
      <section className="card">
        <h2>O que repor</h2>
        <Status error={restock.error} loading={!restock.data} />
        {restock.data && (restock.data.length === 0 ? <p className="muted">Estoque em dia.</p> : (
          <ul className="rows">
            {restock.data.map((p) => (
              <li key={p.name}>
                <div>{p.name}<div className="muted">atual {p.quantity} · mínimo {p.min_quantity}</div></div>
                <span className="pill warn">comprar {p.qty_to_buy}</span>
              </li>
            ))}
          </ul>
        ))}
      </section>
      <section className="card">
        <h2>Protocolos</h2>
        <Status error={protocols.error} loading={!protocols.data} />
        {protocols.data?.map((p) => (
          <details key={p.id}>
            <summary>{p.name}</summary>
            <p>{p.instructions}</p>
            <ul className="muted">{p.items.map((i: any) => <li key={i.product}>{i.quantity} × {i.product}</li>)}</ul>
          </details>
        ))}
      </section>
    </>
  );
}

// ---------- Sara ----------
type Msg = { role: 'user' | 'sara'; text: string };
const SUGGESTIONS = ['Faturamento e nº de pacientes dos últimos 6 meses', 'Quais produtos preciso repor?', 'Como aumentar meu ticket médio?'];

function Sara() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const convo = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setMsgs((m) => [...m, { role: 'user', text: message }]); setText(''); setBusy(true);
    try {
      const r = await api<{ conversationId: string; reply: string }>('/sara/chat', { method: 'POST', json: { message, conversationId: convo.current } });
      convo.current = r.conversationId;
      setMsgs((m) => [...m, { role: 'sara', text: r.reply }]);
    } catch { setMsgs((m) => [...m, { role: 'sara', text: 'Não consegui responder agora. Tente novamente em instantes.' }]); }
    finally { setBusy(false); }
  }

  return (
    <div className="chat">
      <div className="log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="intro">
            <h2>Oi, eu sou a Sara.</h2>
            <p className="muted">Pergunte sobre faturamento, pacientes, estoque ou finanças da clínica.</p>
            {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
        {busy && <div className="bubble sara muted">Sara está consultando os dados…</div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pergunte à Sara…" maxLength={2000} aria-label="Mensagem para a Sara" />
        <button className="primary" disabled={busy || !text.trim()}>Enviar</button>
      </form>
    </div>
  );
}
