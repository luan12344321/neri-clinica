import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLoad } from './hooks';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { api, brl, getToken, monthLabel, setToken, thisMonth } from './api';
import { Icon, type IconName } from './Icon';
import { Cadastros, NewAppointment, type Section } from './Cadastros';

type View = 'inicio' | 'financeiro' | 'estoque' | 'sara' | 'pacientes' | 'procedimentos' | 'produtos' | 'mensagens';
type Me = { name: string; role: string; clinic: string };

const NAV: { group: string; items: { id: View; label: string; icon: IconName }[] }[] = [
  { group: 'Principal', items: [
    { id: 'inicio', label: 'Início', icon: 'home' },
    { id: 'sara', label: 'Sara, assistente', icon: 'spark' },
  ] },
  { group: 'Gestão', items: [
    { id: 'financeiro', label: 'Financeiro', icon: 'chart' },
    { id: 'estoque', label: 'Estoque e reposição', icon: 'box' },
    { id: 'produtos', label: 'Produtos', icon: 'tag' },
  ] },
  { group: 'Cadastros', items: [
    { id: 'pacientes', label: 'Pacientes', icon: 'users' },
    { id: 'procedimentos', label: 'Procedimentos', icon: 'syringe' },
  ] },
  { group: 'Comunicação', items: [{ id: 'mensagens', label: 'Mensagens', icon: 'mail' }] },
];
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<View, string>;
const TITLE_OVERRIDE: Partial<Record<View, string>> = { inicio: 'Início', sara: 'Sara' };

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
const pct = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => { setToken(null); setAuthed(false); }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<View>('inicio');
  const [open, setOpen] = useState(false);
  const me = useLoad<Me>('/me');
  const alerts = useLoad<any[]>('/alerts');
  const menuBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuBtn.current?.focus(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  const go = (v: View) => { setView(v); setOpen(false); scrollTo({ top: 0 }); };
  const nAlerts = alerts.data?.length ?? 0;

  return (
    <div className={`shell${view === 'sara' ? ' on-sara' : ''}`}>
      <header className="top">
        <button ref={menuBtn} className="icon-btn" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></button>
        <h1>{TITLE_OVERRIDE[view] ?? TITLES[view]}</h1>
        <div className="top-actions">
          <button className="icon-btn" aria-label={nAlerts ? `${nAlerts} alertas de estoque` : 'Sem alertas'} onClick={() => go('estoque')}>
            <Icon name="bell" />{nAlerts > 0 && <span className="dot">{nAlerts}</span>}
          </button>
          <span className="avatar" aria-label={me.data?.name ?? 'Usuário'}>{initials(me.data?.name)}</span>
        </div>
      </header>

      <main>
        {view === 'inicio' && <Today name={me.data?.name} alerts={alerts.data ?? []} />}
        {view === 'financeiro' && <Finance />}
        {view === 'estoque' && <Stock />}
        {view === 'sara' && <Sara name={me.data?.name} />}
        {(view === 'pacientes' || view === 'procedimentos' || view === 'mensagens') && <Cadastros section={view} />}
        {view === 'produtos' && <Cadastros section={'estoque' satisfies Section} />}
      </main>

      {view !== 'sara' && (
        <button className="fab" aria-label="Falar com a Sara" onClick={() => go('sara')}><Icon name="spark" size={26} /></button>
      )}

      {open && (
        <div className="drawer-wrap">
          <div className="scrim" onClick={() => setOpen(false)} />
          <nav className="drawer" role="dialog" aria-modal="true" aria-label="Menu principal">
            <div className="drawer-head">
              <div><strong>Clínica</strong><span>{me.data?.clinic ?? 'Gestão'}</span></div>
              <button className="icon-btn on-dark" aria-label="Fechar menu" onClick={() => { setOpen(false); menuBtn.current?.focus(); }}><Icon name="close" /></button>
            </div>
            {NAV.map((g) => (
              <div key={g.group} className="nav-group">
                <p>{g.group}</p>
                {g.items.map((i) => (
                  <button key={i.id} aria-current={view === i.id ? 'page' : undefined} onClick={() => go(i.id)}>
                    <Icon name={i.icon} size={20} />{i.label}
                  </button>
                ))}
              </div>
            ))}
            <div className="drawer-foot">
              <span className="avatar sm">{initials(me.data?.name)}</span>
              <div><b>{me.data?.name ?? ''}</b></div>
              <button className="out" onClick={onLogout}><Icon name="out" size={18} />Sair</button>
            </div>
          </nav>
        </div>
      )}
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
      <span className="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 5v14M5 12h14" /></svg></span>
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

const Delta = ({ value }: { value: number | null }) =>
  value === null ? null : <span className={`delta${value < 0 ? ' down' : ''}`}>{value < 0 ? '▼' : '▲'} {pct(Math.abs(value))}% <i>vs mês anterior</i></span>;

// ---------- Início ----------
function Today({ name, alerts }: { name?: string; alerts: any[] }) {
  const dash = useLoad<any>('/dashboard');
  const sum = useLoad<any>(`/finance/summary?month=${thisMonth()}`);
  const recv = useLoad<any[]>('/finance/receivables');
  const [busyId, setBusyId] = useState('');

  async function complete(id: string) {
    setBusyId(id);
    try { await api(`/appointments/${id}/complete`, { method: 'POST', json: {} }); dash.reload(); sum.reload(); recv.reload(); }
    finally { setBusyId(''); }
  }
  const d = dash.data, s = sum.data;
  const toReceive = (recv.data ?? []).reduce((a, t) => a + Number(t.amount), 0);
  const series = (d?.revenueByMonth ?? []).map((r: any) => ({ ...r, m: monthLabel(r.month) }));
  const cur = series.find((r: any) => r.month === thisMonth());
  const prev = cur ? series[series.indexOf(cur) - 1] : undefined;
  const delta = cur && prev?.revenue ? ((cur.revenue - prev.revenue) / prev.revenue) * 100 : null;
  const procTotal = (d?.topProcedures ?? []).reduce((a: number, p: any) => a + p.total, 0);
  const first = name?.split(/\s+/)[0];
  const doneToday = d ? d.today.filter((a: any) => a.status === 'done').length : 0;

  return (
    <>
      <section className="hello">
        <h2>{greeting()}{first ? `, ${first}` : ''}</h2>
        <p className="muted">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </section>
      <Status error={dash.error || sum.error} loading={!d || !s} />
      {d && s && (
        <>
          <section className="hero-card">
            <span>Faturamento do mês</span>
            <strong>{brl(s.income)}</strong>
            {delta === null ? <span className="delta flat">Sem mês anterior para comparar</span> : <Delta value={delta} />}
            <div className="spark" aria-hidden="true">
              <ResponsiveContainer width="100%" height={64}>
                <AreaChart data={series} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <defs><linearGradient id="g-hero" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: 'var(--yellow)', stopOpacity: 0.35 }} /><stop offset="100%" style={{ stopColor: 'var(--yellow)', stopOpacity: 0 }} />
                  </linearGradient></defs>
                  <Area type="monotone" dataKey="revenue" stroke="var(--yellow)" strokeWidth={2} fill="url(#g-hero)" isAnimationActive={false} dot={series.length < 2 ? { r: 4, fill: 'var(--yellow)' } : false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="kpis">
            <div className="kpi"><Icon name="calendar" size={18} /><span>Atendimentos hoje</span><strong>{d.today.length}</strong><small>{doneToday} concluído(s)</small></div>
            <div className="kpi"><Icon name="syringe" size={18} /><span>Procedimentos no mês</span><strong>{s.proceduresDone}</strong></div>
            <div className="kpi"><Icon name="wallet" size={18} /><span>Ticket médio</span><strong>{brl(s.averageTicket)}</strong></div>
            <div className="kpi"><Icon name="receive" size={18} /><span>A receber</span><strong>{brl(toReceive)}</strong></div>
          </section>

          {alerts.length > 0 && (
            <section className="card warn">
              <h2>Atenção</h2>
              <ul className="rows">
                {alerts.map((a) => (
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
            <div className="between"><h2>Faturamento mensal</h2><Delta value={delta} /></div>
            <div className="chart" role="img" aria-label="Gráfico de área do faturamento dos últimos meses">
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={series} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                  <defs><linearGradient id="g-rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.28 }} /><stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
                  </linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="var(--line)" />
                  <XAxis dataKey="m" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} width={44} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                  <Tooltip formatter={(v: number) => [brl(v), 'Receita']}
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }} />
                  <Area type="monotone" dataKey="revenue" stroke="var(--accent)" strokeWidth={2.5} fill="url(#g-rev)" dot={series.length < 2 ? { r: 5, fill: 'var(--accent)' } : false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="card">
            <h2>Procedimentos mais realizados</h2>
            {procTotal === 0 ? <p className="muted">Sem atendimentos concluídos no período.</p> : (
              <div className="donut-row">
                <div className="donut" role="img" aria-label="Proporção dos procedimentos realizados">
                  <ResponsiveContainer width="100%" height={168}>
                    <PieChart>
                      <Pie data={d.topProcedures} dataKey="total" nameKey="name" innerRadius="68%" outerRadius="100%" paddingAngle={2} stroke="none" isAnimationActive={false}>
                        {d.topProcedures.map((p: any, i: number) => <Cell key={p.name} fill={`var(--c${(i % 6) + 1})`} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="donut-total"><strong>{procTotal}</strong><span>realizados</span></div>
                </div>
                <ul className="legend">
                  {d.topProcedures.map((p: any, i: number) => (
                    <li key={p.name}><i style={{ background: `var(--c${(i % 6) + 1})` }} /><span>{p.name}</span><b>{pct((p.total / procTotal) * 100)}%</b></li>
                  ))}
                </ul>
              </div>
            )}
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
  const total = (items: any[] | null) => (items ?? []).reduce((a, t) => a + Number(t.amount), 0);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = (recv.data ?? []).filter((t) => String(t.due_date).slice(0, 10) < today);
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
              <div>{t.description}<div className="muted">vence {new Date(`${String(t.due_date).slice(0, 10)}T12:00`).toLocaleDateString('pt-BR')}</div></div>
              <div className="right"><b>{brl(Number(t.amount))}</b><button className="ghost sm" onClick={() => settle(t.id)}>{cta}</button></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const quick = (icon: IconName, label: string, hint: string, value: number, tone = '') => (
    <li><span className={`q-ico ${tone}`}><Icon name={icon} size={20} /></span><div><b>{label}</b><div className="muted">{hint}</div></div><strong className={tone === 'bad' ? 'neg' : ''}>{brl(value)}</strong></li>
  );

  return (
    <>
      <div className="toolbar">
        <label>Mês<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
      </div>
      <Status error={sum.error || dre.error} loading={!s || !r} />
      {s && r && (
        <>
          <section className="fin-cards">
            <div className="fin"><span><Icon name="receive" size={16} />Receitas</span><strong>{brl(s.income)}</strong></div>
            <div className="fin"><span><Icon name="pay" size={16} />Despesas</span><strong>{brl(s.expense)}</strong></div>
            <div className="fin result"><span><Icon name="wallet" size={16} />Resultado do mês</span><strong className={s.balance < 0 ? 'neg' : ''}>{brl(s.balance)}</strong><small>Ticket médio {brl(s.averageTicket)}</small></div>
          </section>
          <section className="card">
            <h2>Resumo rápido</h2>
            <ul className="quick">
              {quick('receive', 'Contas a receber', `${recv.data?.length ?? 0} pendente(s)`, total(recv.data))}
              {quick('pay', 'Contas a pagar', `${pay.data?.length ?? 0} pendente(s)`, total(pay.data))}
              {quick('alert', 'Inadimplência', `${overdue.length} vencido(s)`, total(overdue), overdue.length ? 'bad' : '')}
            </ul>
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
const SUGGESTIONS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'chart', title: 'Faturamento', text: 'Faturamento e nº de pacientes dos últimos 6 meses' },
  { icon: 'box', title: 'Estoque', text: 'Quais produtos preciso repor?' },
  { icon: 'pulse', title: 'Ticket médio', text: 'Como aumentar meu ticket médio?' },
];

function Sara({ name }: { name?: string }) {
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
            <span className="sara-avatar"><Icon name="spark" size={34} /></span>
            <h2>Olá{name ? `, ${name.split(/\s+/)[0]}` : ''}</h2>
            <p className="muted">Eu sou a Sara. Pergunte sobre faturamento, pacientes, estoque ou finanças da clínica.</p>
            <div className="sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="sugg-card" onClick={() => send(s.text)}>
                  <Icon name={s.icon} size={22} /><b>{s.title}</b><span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
        {busy && <div className="bubble sara muted">Sara está consultando os dados…</div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pergunte à Sara…" maxLength={2000} aria-label="Mensagem para a Sara" />
        <button className="send" aria-label="Enviar" disabled={busy || !text.trim()}><Icon name="send" size={20} /></button>
      </form>
    </div>
  );
}
