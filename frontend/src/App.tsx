import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLoad } from './hooks';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ApiError, api, brl, getToken, lastMonths, monthLabel, setToken, thisMonth } from './api';
import { Icon, type IconName } from './Icon';
import { AppointmentSheet, Cadastros, NewAppointment, RescheduleSheet, type Focus, type Section } from './Cadastros';
import { ApptSheet, DayTimeline, ageOf } from './Timeline';
import { Avatar, Empty, ErrorBoundary, EyeToggle, ListSkeleton, RoleProvider, ToastProvider, mask, useHideValues, useRole } from './ui';
import { Settings, type Me } from './Settings';
import { PresenceButton } from './Presence';
import { Finance, RecentTransactions, type Bank, type FinTab } from './Finance';
import { BottomNav, InstallPill, QuickSheet, Splash, type QuickAction } from './Chrome';

type View = 'inicio' | 'agenda' | 'financeiro' | 'estoque' | 'sara' | 'pacientes' | 'procedimentos' | 'produtos' | 'mensagens' | 'config';

const NAV: { group: string; items: { id: View; label: string; icon: IconName; mgr?: boolean }[] }[] = [
  { group: 'Principal', items: [
    { id: 'inicio', label: 'Início', icon: 'home' },
    { id: 'agenda', label: 'Agenda', icon: 'calendar' },
    { id: 'sara', label: 'Julia, assistente', icon: 'spark', mgr: true },
  ] },
  { group: 'Gestão', items: [
    { id: 'financeiro', label: 'Financeiro', icon: 'chart', mgr: true },
    { id: 'estoque', label: 'Estoque e reposição', icon: 'box' },
    { id: 'produtos', label: 'Produtos', icon: 'tag', mgr: true },
  ] },
  { group: 'Cadastros', items: [
    { id: 'pacientes', label: 'Pacientes', icon: 'users' },
    { id: 'procedimentos', label: 'Procedimentos', icon: 'syringe' },
  ] },
  { group: 'Comunicação', items: [{ id: 'mensagens', label: 'Mensagens', icon: 'mail', mgr: true }] },
  { group: 'Conta', items: [{ id: 'config', label: 'Configurações', icon: 'gear' }] },
];
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<View, string>;
const TITLE_OVERRIDE: Partial<Record<View, string>> = { inicio: 'Início', sara: 'Julia' };

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
const pct = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <ErrorBoundary><Splash /><Login onDone={() => setAuthed(true)} /></ErrorBoundary>;
  return <ErrorBoundary><ToastProvider><Splash /><Shell onLogout={() => { setToken(null); setAuthed(false); }} /></ToastProvider></ErrorBoundary>;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const me = useLoad<Me>('/me');
  return <RoleProvider role={me.data?.role ?? null}><ShellInner onLogout={onLogout} me={me.data} /></RoleProvider>;
}

function ShellInner({ onLogout, me }: { onLogout: () => void; me: Me | null }) {
  const { isManager, isOwner } = useRole();
  const [view, setView] = useState<View>('inicio');
  const [open, setOpen] = useState(false);
  // Estoque atual (não o aviso gravado pela rotina): some assim que o produto é reposto.
  const restock = useLoad<any[]>('/stock/restock');
  const menuBtn = useRef<HTMLButtonElement>(null);

  // Sinal de vida: avisa o servidor que este usuário está com o app aberto (alimenta o painel "Equipe" do proprietário).
  useEffect(() => {
    const ping = () => { if (document.visibilityState === 'visible') api('/presence/ping', { method: 'POST', json: {} }).catch(() => {}); };
    ping();
    const id = setInterval(ping, 45_000);
    document.addEventListener('visibilitychange', ping);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', ping); };
  }, []);
  useEffect(() => { restock.reload(); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuBtn.current?.focus(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  const [finTab, setFinTab] = useState<FinTab>('resumo');
  const [autoPatient, setAutoPatient] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null); // paciente (e atendimento) aberto a partir do Início
  const [quick, setQuick] = useState(false);
  const [booking, setBooking] = useState(false);
  const [fresh, setFresh] = useState(0); // muda quando algo é criado, para as telas recarregarem
  const go = (v: View, tab?: FinTab) => { if (tab) setFinTab(tab); setAutoPatient(false); setFocus(null); setView(v); setOpen(false); scrollTo({ top: 0 }); };
  const quickActions: QuickAction[] = [
    { icon: 'calendar', title: 'Agendar atendimento', hint: 'Escolha o dia e o horário', run: () => setBooking(true) },
    { icon: 'users', title: 'Cadastrar paciente', hint: 'Novo cadastro', run: () => { go('pacientes'); setAutoPatient(true); } },
    ...(isManager ? [
      { icon: 'receive' as const, title: 'Nova conta a receber ou pagar', hint: 'Lançar no financeiro', run: () => go('financeiro', 'contas') },
      { icon: 'bank' as const, title: 'Adicionar banco', hint: 'Onde o dinheiro cai', run: () => go('financeiro', 'bancos') },
    ] : []),
  ];
  const nAlerts = restock.data?.length ?? 0;

  return (
    <div className={`shell${view === 'sara' ? ' on-sara' : ''}`}>
      <header className="top">
        <button ref={menuBtn} className="icon-btn menu-btn" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></button>
        <h1>{TITLE_OVERRIDE[view] ?? TITLES[view]}</h1>
        <div className="top-actions">
          <InstallPill />
          {isOwner && <PresenceButton />}
          <button className="icon-btn" aria-label={nAlerts ? `${nAlerts} alertas de estoque` : 'Sem alertas'} onClick={() => go('estoque')}>
            <Icon name="bell" />{nAlerts > 0 && <span className="dot">{nAlerts}</span>}
          </button>
          <button className="avatar" aria-label="Configurações da conta" onClick={() => go('config')}>{initials(me?.name)}</button>
        </div>
      </header>

      <main>
        {view === 'inicio' && <Today key={fresh} name={me?.name} restock={restock.data ?? []} go={go} money={isManager} onBook={() => setBooking(true)} onPatient={() => { go('pacientes'); setAutoPatient(true); }}
          onStart={(patientId, appt) => { go('pacientes'); setFocus({ id: patientId, appt: appt ? { id: appt.id, label: `${appt.procedure ?? 'Atendimento'} · ${new Date(appt.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` } : undefined }); }} />}
        {view === 'config' && <Settings me={me} />}
        {view === 'agenda' && <Agenda key={fresh} />}
        {view === 'financeiro' && <Finance initialTab={finTab} onTab={setFinTab} />}
        {view === 'estoque' && <Stock go={go} />}
        {view === 'sara' && <Julia name={me?.name} />}
        {(view === 'pacientes' || view === 'procedimentos' || view === 'mensagens') && <Cadastros section={view} autoOpen={autoPatient} focus={focus} onFinish={() => { go('inicio'); setFresh((n) => n + 1); }} />}
        {view === 'produtos' && <Cadastros section={'estoque' satisfies Section} />}
      </main>

      {view !== 'sara' && <BottomNav view={view} isManager={isManager} go={go} onQuick={() => setQuick(true)} onMenu={() => setOpen(true)} />}
      {quick && <QuickSheet actions={quickActions} onClose={() => setQuick(false)} />}
      {booking && <AppointmentSheet onClose={() => setBooking(false)} onCreated={() => { setBooking(false); setFresh((n) => n + 1); }} />}

      {/* Celular: gaveta que abre sobre o conteúdo. Desktop (CSS): barra lateral fixa, sempre visível. */}
      <div className={`drawer-wrap${open ? ' open' : ''}`}>
          <div className="scrim" onClick={() => setOpen(false)} />
          <nav className="drawer" role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label="Menu principal">
            <div className="drawer-head">
              <div className="drawer-title"><img src="/neri-n.png" alt="" /><div><strong>Clínica</strong><span>{me?.clinic ?? 'Gestão'}</span></div></div>
              <button className="icon-btn on-dark close-btn" aria-label="Fechar menu" onClick={() => { setOpen(false); menuBtn.current?.focus(); }}><Icon name="close" /></button>
            </div>
            {NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.mgr || isManager) })).filter((g) => g.items.length).map((g) => (
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
              <span className="avatar sm">{initials(me?.name)}</span>
              <div><b>{me?.name ?? ''}</b></div>
              <button className="out" onClick={onLogout}><Icon name="out" size={18} />Sair</button>
            </div>
          </nav>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { const r = await api<{ token: string }>('/auth/login', { method: 'POST', json: { email, password } }); setToken(r.token); onDone(); }
    catch (err) { setError(err instanceof Error && err.message === 'invalid credentials' ? 'E-mail ou senha incorretos.' : 'Não foi possível entrar. Tente novamente.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <aside className="login-brand" aria-hidden="true"><img className="brand-logo" src="/neri-logo.png" alt="" /><h2>Gestão da clínica na palma da mão</h2><p>Agenda, financeiro, estoque e a Julia, sua assistente, em um só lugar.</p></aside>
    <form className="login" aria-label="Entrar" onSubmit={submit}>
      <span className="logo" aria-hidden="true"><img src="/neri-n.png" alt="" /></span>
      <h1>Clínica</h1>
      <p className="muted">Gestão na palma da mão.</p>
      <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Senha<span className="pw"><input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button type="button" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'} onClick={() => setShow((s) => !s)}><Icon name={show ? 'eyeoff' : 'eye'} size={20} /></button></span></label>
      {error && <p role="alert" className="err">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="login-hint">Esqueceu a senha? Peça ao proprietário para redefinir em Configurações → Equipe.</p>
    </form>
    </div>
  );
}

const Status = ({ error, loading }: { error: string; loading: boolean }) =>
  error ? <p role="alert" className="err">{error}</p> : loading ? <ListSkeleton rows={3} /> : null;

const Delta = ({ value }: { value: number | null }) =>
  value === null ? null : <span className={`delta${value < 0 ? ' down' : ''}`}>{value < 0 ? '▼' : '▲'} {pct(Math.abs(value))}% <i>vs mês anterior</i></span>;

// ---------- Início ----------
const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type Todo = { icon: IconName; text: string; hint?: string; tone?: 'bad'; run: () => void };

// O "meu dia": indicadores, quem é o próximo paciente, a agenda em linha do tempo e o que pede atenção. Dinheiro vem depois.
function Today({ name, restock, go, money, onBook, onPatient, onStart }: {
  name?: string; restock: any[]; go: (v: View, tab?: FinTab) => void; money: boolean; onBook: () => void; onPatient: () => void;
  onStart: (patientId: string, appt: any | null) => void;
}) {
  const dash = useLoad<any>('/dashboard');
  const sum = useLoad<any>(money ? `/finance/summary?month=${thisMonth()}` : null);
  const recv = useLoad<any[]>(money ? '/finance/receivables' : null);
  const pay = useLoad<any[]>(money ? '/finance/payables' : null);
  const banks = useLoad<Bank[]>(money ? '/banks' : null);
  const { isClinical } = useRole();
  const [busyId, setBusyId] = useState('');
  const [bump, setBump] = useState(0);
  const [moving, setMoving] = useState<any | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const { hidden } = useHideValues();

  async function complete(id: string) {
    setBusyId(id);
    try { await api(`/appointments/${id}/complete`, { method: 'POST', json: {} }); setOpen(null); dash.reload(); sum.reload(); recv.reload(); banks.reload(); setBump((b) => b + 1); }
    finally { setBusyId(''); }
  }
  const d = dash.data, s = sum.data;
  const now = Date.now();
  const timeOf = (a: any) => new Date(a.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today: any[] = d?.today ?? [];
  const pending = today.filter((a) => a.status !== 'done' && a.status !== 'canceled');
  const doneToday = today.length - pending.length;
  const ended = (a: any) => new Date(a.ends_at ?? a.starts_at).getTime() < now;
  const next = pending.find((a) => !ended(a)) ?? null;
  const late = pending.filter(ended);
  const patientsToday = new Set(today.map((a) => a.patient_id)).size;
  const todayStr = localYmd();
  const sumOf = (items: any[]) => items.reduce((acc, t) => acc + Number(t.amount), 0);
  const dueRecv = (recv.data ?? []).filter((t) => String(t.due_date).slice(0, 10) <= todayStr);
  const duePay = (pay.data ?? []).filter((t) => String(t.due_date).slice(0, 10) <= todayStr);
  const birthdays: { id: string; full_name: string }[] = d?.birthdays ?? [];
  const goAgenda = () => document.getElementById('agenda-hoje')?.scrollIntoView({ behavior: 'smooth' });

  const todo: Todo[] = [
    ...(late.length ? [{ icon: 'alert' as IconName, tone: 'bad' as const, text: `${late.length} atendimento(s) passaram do horário sem ser concluídos`, hint: late.map((a) => `${timeOf(a)} ${a.patient}`).join(' · '), run: goAgenda }] : []),
    ...(dueRecv.length ? [{ icon: 'receive' as IconName, text: `${dueRecv.length} conta(s) a receber vencendo hoje ou vencida(s)`, hint: mask(brl(sumOf(dueRecv)), hidden), run: () => go('financeiro', 'contas') }] : []),
    ...(duePay.length ? [{ icon: 'pay' as IconName, text: `${duePay.length} conta(s) a pagar vencendo hoje ou vencida(s)`, hint: mask(brl(sumOf(duePay)), hidden), run: () => go('financeiro', 'contas') }] : []),
    ...(restock.length ? [{ icon: 'box' as IconName, text: `${restock.length} produto(s) para repor`, hint: restock.map((p) => p.name).slice(0, 3).join(', '), run: () => go('estoque') }] : []),
    ...(birthdays.length ? [{ icon: 'users' as IconName, text: `Aniversário hoje: ${birthdays.map((p) => p.full_name).slice(0, 3).join(', ')}${birthdays.length > 3 ? ` e mais ${birthdays.length - 3}` : ''}`, hint: 'A mensagem automática sai às 9h se a paciente autorizou', run: () => go('pacientes') }] : []),
  ];

  // Dinheiro (só dono e gerente), mais abaixo
  const toReceive = sumOf(recv.data ?? []);
  const activeBanks = (banks.data ?? []).filter((b) => b.active);
  const balance = activeBanks.reduce((a, b) => a + b.balance, 0);
  const byMonth = Object.fromEntries((d?.revenueByMonth ?? []).map((r: any) => [r.month, r.revenue]));
  const series = lastMonths(6).map((month) => ({ month, m: monthLabel(month), revenue: byMonth[month] ?? 0 }));
  const cur = series[series.length - 1]!, prev = series[series.length - 2]!;
  const delta = prev.revenue ? ((cur.revenue - prev.revenue) / prev.revenue) * 100 : null;
  const procTotal = (d?.topProcedures ?? []).reduce((a: number, p: any) => a + p.total, 0);
  const first = name?.split(/\s+/)[0];
  const tip = !money || todo.some((t) => t.icon === 'receive') ? null
    : delta !== null && delta !== 0
      ? { icon: 'pulse' as IconName, text: `Faturamento ${pct(Math.abs(delta))}% ${delta > 0 ? 'acima' : 'abaixo'} do mês anterior.`, cta: 'Ver resumo', run: () => go('financeiro', 'resumo') }
      : null;

  const kpis: { icon: IconName; label: string; value: string; hot?: boolean; eye?: boolean }[] = [
    { icon: 'users', label: 'Pacientes hoje', value: String(patientsToday) },
    { icon: 'check', label: 'Atendimentos concluídos', value: `${doneToday} de ${today.length}` },
    { icon: 'alert', label: 'Pendências', value: String(todo.length), hot: todo.length > 0 },
    ...(money ? [{ icon: 'wallet' as IconName, label: 'Faturamento do dia', value: mask(brl(d?.todayRevenue ?? 0), hidden), eye: true }] : []),
  ];
  const quick: { icon: IconName; label: string; run: () => void }[] = [
    { icon: 'calendar', label: 'Novo agendamento', run: onBook },
    { icon: 'users', label: 'Novo paciente', run: onPatient },
    money ? { icon: 'receive', label: 'Registrar recebimento', run: () => go('financeiro', 'contas') } : { icon: 'box', label: 'Ver estoque', run: () => go('estoque') },
  ];
  const nextAge = next ? ageOf(next.birth_date) : null;

  return (
    <div className="dash">
      <section className="hello span-all">
        <h2>{greeting()}{first ? `, ${first}` : ''}</h2>
        <p className="muted">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </section>
      <div className="span-all"><Status error={dash.error || sum.error} loading={!d || (money && !s)} /></div>
      {d && (!money || s) && (
        <>
          <section className={`top-kpis n${kpis.length} span-all`} aria-label="Resumo do dia">
            {kpis.map((k) => (
              <div key={k.label} className={`tk${k.hot ? ' hot' : ''}`}>
                <span className="tk-ico"><Icon name={k.icon} size={18} /></span>
                <strong>{k.value}</strong>
                <span className="tk-label">{k.label}{k.eye && <EyeToggle className="inline small" />}</span>
              </div>
            ))}
          </section>

          <div className="day-grid span-all">
            <section className="next-card g-next">
              <span className="next-label">Próximo paciente</span>
              {next ? (
                <>
                  <div className="next-main">
                    <Avatar name={next.patient} size={64} />
                    <div className="grow">
                      <b>{next.patient}</b>
                      <span>{[nextAge !== null ? `${nextAge} anos` : null, next.procedure ?? 'Sem procedimento'].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className="next-time"><Icon name="calendar" size={16} />{timeOf(next)}</span>
                  </div>
                  <div className="next-actions">
                    {isClinical ? (
                      <>
                        <button className="primary" onClick={() => onStart(next.patient_id, next)}>Iniciar atendimento</button>
                        <button className="ghost" onClick={() => onStart(next.patient_id, null)}>Ver prontuário</button>
                      </>
                    ) : (
                      <>
                        <button className="primary" disabled={busyId === next.id} onClick={() => complete(next.id)}>Concluir</button>
                        <button className="ghost" onClick={() => setMoving(next)}>Reagendar</button>
                      </>
                    )}
                  </div>
                  {isClinical && <button className="next-link" onClick={() => setMoving(next)}>Reagendar este atendimento</button>}
                </>
              ) : <p className="next-empty">{today.length === 0 ? 'Nenhum paciente para hoje.' : late.length ? 'Os atendimentos restantes de hoje já passaram do horário.' : 'Todos os atendimentos de hoje foram concluídos.'}</p>}
            </section>

            <aside className="g-side">
            {todo.length > 0 ? (
              <section className="card attn g-attn" id="pendencias">
                <div className="attn-head"><h2>Precisa de atenção</h2><span className="badge" aria-label={`${todo.length} pendência(s)`}>{todo.length}</span></div>
                <ul className="todo">{todo.map((t) => (
                  <li key={t.text}>
                    <button onClick={t.run}>
                      <span className={`q-ico ${t.tone === 'bad' ? 'bad' : ''}`}><Icon name={t.icon} size={20} /></span>
                      <span className="grow"><b>{t.text}</b>{t.hint && <span className="muted wrap">{t.hint}</span>}</span>
                      <Icon name="back" size={18} />
                    </button>
                  </li>
                ))}</ul>
              </section>
            ) : (
              <section className="card attn ok g-attn" id="pendencias">
                <span className="q-ico"><Icon name="check" size={20} /></span>
                <div className="grow"><b>Tudo em dia</b><span className="muted">Nada pendente por enquanto.</span></div>
              </section>
            )}

            <section className="card quick-card g-quick" aria-label="Ações rápidas">
              <h2>Ações rápidas</h2>
              <div className="qgrid">
                {quick.map((q) => <button key={q.label} onClick={q.run}><span><Icon name={q.icon} size={22} /></span><b>{q.label}</b></button>)}
              </div>
            </section>
            </aside>

            <DayTimeline appts={today} onOpen={setOpen} onBook={onBook} onSeeAll={() => go('agenda')} />

          </div>

          {money && s && (
            <section className="hero-card span-all">
              <div className="hero-main">
                <span>Faturamento do mês<EyeToggle className="on-dark inline" /></span>
                <strong>{mask(brl(s.income), hidden)}</strong>
                {delta === null ? <span className="delta flat">Primeiro mês</span> : <Delta value={delta} />}
                {activeBanks.length > 0 && <button className="hero-balance" onClick={() => go('financeiro', 'bancos')}><Icon name="bank" size={16} />Saldo em contas <b>{mask(brl(balance), hidden)}</b></button>}
              </div>
              <div className="spark" aria-hidden="true">
                <ResponsiveContainer width="100%" height={56}>
                  <AreaChart data={series} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <defs><linearGradient id="g-hero" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style={{ stopColor: 'var(--yellow)', stopOpacity: 0.35 }} /><stop offset="100%" style={{ stopColor: 'var(--yellow)', stopOpacity: 0 }} />
                    </linearGradient></defs>
                    <Area type="monotone" dataKey="revenue" stroke="var(--yellow)" strokeWidth={2} fill="url(#g-hero)" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {money && s && (
            <section className="kpis span-all">
              <button className="kpi" onClick={() => go('financeiro')}><Icon name="syringe" size={18} /><span>Procedimentos no mês</span><strong>{s.proceduresDone}</strong></button>
              <button className="kpi" onClick={() => go('financeiro')}><Icon name="wallet" size={18} /><span>Ticket médio</span><strong>{mask(brl(s.averageTicket), hidden)}</strong></button>
              <button className="kpi" onClick={() => go('financeiro', 'contas')}><Icon name="receive" size={18} /><span>A receber</span><strong>{mask(brl(toReceive), hidden)}</strong><small>{recv.data?.length ?? 0} pendente(s) de pagamento</small></button>
            </section>
          )}

          {tip && (
            <section className="card tip span-all">
              <span className="q-ico"><Icon name={tip.icon} size={20} /></span>
              <div className="grow"><b>{tip.text}</b></div>
              <button className="link" onClick={tip.run}>{tip.cta}</button>
            </section>
          )}

          {money && <RecentTransactions limit={5} reloadKey={bump} onSeeAll={() => go('financeiro', 'contas')} />}

          {money && (
            <section className="card">
              <div className="between"><h2>Faturamento mensal</h2><Delta value={delta} /></div>
              <div className="chart" role="img" aria-label="Gráfico de área do faturamento dos últimos 6 meses">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={series} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                    <defs><linearGradient id="g-rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.28 }} /><stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
                    </linearGradient></defs>
                    <CartesianGrid vertical={false} stroke="var(--line)" />
                    <XAxis dataKey="m" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                    <YAxis tickLine={false} axisLine={false} width={44} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
                    <Tooltip formatter={(v: number) => [hidden ? '••••' : brl(v), 'Receita']}
                      contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }} />
                    <Area type="monotone" dataKey="revenue" stroke="var(--accent)" strokeWidth={2.5} fill="url(#g-rev)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <section className="card">
            <h2>Procedimentos mais realizados</h2>
            {procTotal === 0 ? <p className="muted">Sem atendimentos concluídos no período.</p> : (
              <div className="donut-row">
                <div className="donut" role="img" aria-label="Proporção dos procedimentos realizados">
                  <ResponsiveContainer width="100%" height={168}>
                    <PieChart>
                      <Pie data={d.topProcedures} dataKey="total" nameKey="name" innerRadius="68%" outerRadius="100%" paddingAngle={d.topProcedures.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
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
      {open && <ApptSheet appt={open} clinical={isClinical} busy={busyId === open.id} onClose={() => setOpen(null)}
        onStart={() => { const a = open; setOpen(null); onStart(a.patient_id, a); }} onChart={() => { const a = open; setOpen(null); onStart(a.patient_id, null); }}
        onComplete={() => complete(open.id)} onMove={() => { setMoving(open); setOpen(null); }} />}
      {moving && <RescheduleSheet appt={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); dash.reload(); }} />}
    </div>
  );
}

// ---------- Agenda ----------
function Agenda() {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
  const ap = useLoad<any[]>(`/appointments?from=${from}&to=${to}`);
  const days = new Map<string, any[]>();
  for (const a of ap.data ?? []) {
    const k = new Date(a.starts_at).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    days.set(k, [...(days.get(k) ?? []), a]);
  }
  const STATUS: Record<string, string> = { scheduled: 'Agendado', confirmed: 'Confirmado', done: 'Concluído', canceled: 'Cancelado', no_show: 'Faltou' };
  return (
    <>
      <div className="between"><p className="muted">Próximos 7 dias</p><NewAppointment onCreated={ap.reload} /></div>
      <Status error={ap.error} loading={!ap.data} />
      {ap.data && days.size === 0 && <section className="card"><Empty icon="calendar" title="Agenda livre" text="Nenhum atendimento nos próximos 7 dias." /></section>}
      {[...days].map(([day, items]) => (
        <section key={day} className="card">
          <h2 className="cap">{day}</h2>
          <ul className="rows">
            {items.map((a) => (
              <li key={a.id}>
                <div>
                  <b>{new Date(a.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>{' '}{a.patient}
                  <div className="muted">{a.procedure ?? 'Sem procedimento'}</div>
                </div>
                <span className={`pill ${a.status === 'done' ? 'ok' : a.status === 'canceled' || a.status === 'no_show' ? 'warn' : ''}`}>{STATUS[a.status] ?? a.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
            <button className="ghost" disabled={busy} onClick={() => run(async () => { await api('/google/sync', { method: 'POST', json: {} }); setMsg(`Sincronizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`); })}>Sincronizar agora</button>
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

// ---------- Estoque ----------
function Stock({ go }: { go: (v: View, tab?: FinTab) => void }) {
  const { isManager } = useRole();
  const restock = useLoad<any[]>('/stock/restock');
  const protocols = useLoad<any[]>('/protocols');
  return (
    <div className="dash">
      <section className="card">
        <div className="between"><h2>O que repor</h2>{isManager && <button className="link" onClick={() => go('produtos')}>Registrar entrada</button>}</div>
        <Status error={restock.error} loading={!restock.data} />
        {restock.data && (restock.data.length === 0 ? <Empty icon="check" title="Estoque em dia" text="Nenhum produto está no mínimo ou abaixo." /> : (
          <ul className="rows">
            {restock.data.map((p) => {
              const fill = Math.min(100, (Number(p.quantity) / Math.max(Number(p.min_quantity), 1)) * 100);
              return (
                <li key={p.name} className="stack">
                  <div className="between">
                    <div><b>{p.name}</b><div className="muted">atual {p.quantity} · mínimo {p.min_quantity}</div></div>
                    <span className="pill warn">comprar {p.qty_to_buy}</span>
                  </div>
                  <div className="meter low" role="img" aria-label={`${p.quantity} de ${p.min_quantity} (mínimo)`}><div style={{ width: `${fill}%` }} /></div>
                </li>
              );
            })}
          </ul>
        ))}
      </section>
      <section className="card">
        <h2>Protocolos</h2>
        <Status error={protocols.error} loading={!protocols.data} />
        {protocols.data?.length === 0 && <Empty icon="syringe" title="Nenhum protocolo" text="Um protocolo define quais produtos cada procedimento consome e baixa o estoque sozinho." />}
        {protocols.data?.map((p) => (
          <details key={p.id}>
            <summary>{p.name}</summary>
            <p>{p.instructions}</p>
            <ul className="muted">{p.items.map((i: any) => <li key={i.product}>{i.quantity} × {i.product}</li>)}</ul>
          </details>
        ))}
      </section>
    </div>
  );
}

// ---------- Julia ----------
type Msg = { role: 'user' | 'sara'; text: string; retry?: string };
const SUGGESTIONS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'chart', title: 'Faturamento', text: 'Faturamento e nº de pacientes dos últimos 6 meses' },
  { icon: 'box', title: 'Estoque', text: 'Quais produtos preciso repor?' },
  { icon: 'pulse', title: 'Ticket médio', text: 'Como aumentar meu ticket médio?' },
];

function Julia({ name }: { name?: string }) {
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
    } catch (e) {
      const s = e instanceof ApiError ? e.status : 0;
      const text = s === 503 ? 'A Julia está indisponível no momento. Avise o administrador da clínica.'
        : s === 504 ? 'A Julia demorou demais para responder. Tente uma pergunta mais curta.'
        : s === 429 ? 'Muitas perguntas em sequência. Aguarde um minuto e tente de novo.'
        : s === 403 ? 'Seu perfil não tem acesso à Julia.' : 'Não consegui responder agora.';
      setMsgs((m) => [...m, { role: 'sara', text, retry: s === 403 ? undefined : message }]);
    }
    finally { setBusy(false); }
  }

  return (
    <div className="chat">
      <div className="log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="intro">
            <span className="sara-avatar"><Icon name="spark" size={34} /></span>
            <h2>Olá{name ? `, ${name.split(/\s+/)[0]}` : ''}</h2>
            <p className="muted">Eu sou a Julia. Pergunte sobre faturamento, pacientes, estoque ou finanças da clínica.</p>
            <div className="sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="sugg-card" onClick={() => send(s.text)}>
                  <Icon name={s.icon} size={22} /><b>{s.title}</b><span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.text}
            {m.retry && <button className="ghost sm retry" disabled={busy} onClick={() => { setMsgs((x) => x.slice(0, i - 1)); send(m.retry!); }}>Tentar novamente</button>}
          </div>
        ))}
        {busy && <div className="bubble sara muted">Julia está consultando os dados…</div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pergunte à Julia…" maxLength={2000} aria-label="Mensagem para a Julia" />
        <button className="send" aria-label="Enviar" disabled={busy || !text.trim()}><Icon name="send" size={20} /></button>
      </form>
    </div>
  );
}
