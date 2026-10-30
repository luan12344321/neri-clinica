import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLoad } from './hooks';
import { ApiError, api, brl, getToken, setToken } from './api';
import { Icon, type IconName } from './Icon';
import { AppointmentSheet, Cadastros, NewAppointment, RescheduleSheet, errText, type Focus, type Section } from './Cadastros';
import { ApptSheet, DayTimeline, ageOf, clock, isLate } from './Timeline';
import { ConcluirAtendimento } from './Atendimento';
import { AtencaoLista, RetornosDoDia, type AttItem } from './RetornosDoDia';
import { useHours } from './hours';
import { LegalLinks, LegalPage, TermsGate, legalFromHash } from './Legal';
import { Avatar, Empty, ErrorBoundary, EyeToggle, ListSkeleton, RoleProvider, ToastProvider, mask, useHideValues, useRole, useToast } from './ui';
import type { Me } from './Settings';
import { PresenceButton } from './Presence';
import type { FinTab } from './Finance';
import { SessionExpiredNote, StatusPage } from './StatusPage';
import Mascote, { type Mood } from './Mascote';
import JuliaGuide, { type Nudge } from './JuliaGuide';
import WhatsApp, { BASE as WA_BASE, type Conversation } from './WhatsApp';
import { BottomNav, InstallPill, QuickSheet, Splash, type QuickAction } from './Chrome';

// Telas pesadas (gráficos do Financeiro, Configurações, Agenda completa) baixam só quando abertas; o service worker guarda para as próximas visitas.
const AgendaView = lazy(() => import('./AgendaView').then((m) => ({ default: m.AgendaView })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));
const Finance = lazy(() => import('./Finance').then((m) => ({ default: m.Finance })));

type View = 'inicio' | 'agenda' | 'financeiro' | 'estoque' | 'sara' | 'pacientes' | 'procedimentos' | 'produtos' | 'mensagens' | 'whatsapp' | 'config';

const NAV: { group: string; items: { id: View; label: string; icon: IconName; mgr?: boolean; front?: boolean }[] }[] = [
  { group: 'Principal', items: [
    { id: 'inicio', label: 'Início', icon: 'home' },
    { id: 'agenda', label: 'Agenda', icon: 'calendar' },
    { id: 'sara', label: 'Julia, assistente', icon: 'spark' },
  ] },
  { group: 'Gestão', items: [
    { id: 'financeiro', label: 'Financeiro', icon: 'chart', mgr: true },
    { id: 'estoque', label: 'Estoque e reposição', icon: 'box' },
    { id: 'produtos', label: 'Produtos', icon: 'tag' },
  ] },
  { group: 'Cadastros', items: [
    { id: 'pacientes', label: 'Pacientes', icon: 'users' },
    { id: 'procedimentos', label: 'Procedimentos', icon: 'syringe' },
  ] },
  { group: 'Comunicação', items: [{ id: 'mensagens', label: 'Mensagens', icon: 'mail', mgr: true }] },
  { group: 'Conta', items: [{ id: 'config', label: 'Configurações', icon: 'gear' }] },
  { group: 'Atendimento', items: [{ id: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp', front: true }] },
];
const NAV_ITEMS = NAV.flatMap((g) => g.items);
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<View, string>;
const TITLE_OVERRIDE: Partial<Record<View, string>> = { inicio: 'Início', sara: 'Julia' };
// A tela aberta fica no endereço (#/agenda...): o "voltar" do navegador/celular troca de tela e recarregar não perde o lugar.
const viewFromHash = (h: string) => { const id = h.replace(/^#\//, ''); return NAV_ITEMS.some((i) => i.id === id) ? (id as View) : null; };
const isLost = (h: string) => !!h.replace(/^#\/?/, '') && !viewFromHash(h);

const completeErr = (e: unknown) => e instanceof ApiError && e.status === 409
  ? 'Este atendimento não pode mais ser concluído (já foi concluído, cancelado ou marcado como falta).' : errText(e);
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => { const f = () => setHash(window.location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const legal = legalFromHash(hash);
  if (legal) return <ErrorBoundary><LegalPage kind={legal} /></ErrorBoundary>;
  if (!authed) return <ErrorBoundary><Splash /><Login onDone={() => setAuthed(true)} /></ErrorBoundary>;
  return <ErrorBoundary><ToastProvider><Splash /><Shell onLogout={() => { setToken(null); setAuthed(false); }} /></ToastProvider></ErrorBoundary>;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const me = useLoad<Me>('/me');
  if (me.data && me.data.termsAccepted === false) return <TermsGate onAccepted={me.reload} />;
  // sem o perfil o app não sabe o que mostrar: explica a queda (internet ou servidor) em vez de abrir telas vazias
  if (!me.data && me.error) return <main><StatusPage kind={navigator.onLine ? 'unavailable' : 'offline'} onRetry={me.reload} /></main>;
  return <RoleProvider role={me.data?.role ?? null}><ShellInner onLogout={onLogout} me={me.data} /></RoleProvider>;
}

function ShellInner({ onLogout, me }: { onLogout: () => void; me: Me | null }) {
  const { isManager, isOwner, role } = useRole();
  const hasWa = role === 'owner' || role === 'manager' || role === 'reception'; // caixa do WhatsApp: quem atende o público
  const [view, setView] = useState<View>(() => viewFromHash(location.hash) ?? 'inicio');
  const [open, setOpen] = useState(false);
  // endereço que não é tela nenhuma (#/xyz): mostra a página 404 com a Julia em vez de pular calado para o Início
  const [lost, setLost] = useState(() => isLost(location.hash));
  useEffect(() => {
    if (lost) return;
    const h = `#/${view}`;
    if (!location.hash) history.replaceState(null, '', h);
    else if (location.hash !== h) location.hash = h;
  }, [view, lost]);
  useEffect(() => {
    const f = () => { const v = viewFromHash(location.hash); setLost(isLost(location.hash)); if (v) { setView(v); setOpen(false); scrollTo({ top: 0 }); } };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  // Quem não é dono/gerente nunca vê uma tela restrita (ex.: Financeiro), mesmo que o perfil mude com o app aberto.
  // Enquanto o perfil carrega, a tela restrita não é montada (nada de pedir dados que o servidor recusaria);
  // com o perfil, a página 403 explica o motivo e leva ao Início substituindo a entrada do histórico (o "voltar" não fica preso).
  const it = NAV_ITEMS.find((i) => i.id === view);
  const blocked = !!((it?.mgr && !isManager) || (it?.front && !hasWa));
  const wa = useLoad<Conversation[]>(hasWa ? WA_BASE : null, view === 'whatsapp' ? 15_000 : 60_000);
  const waUnread = (wa.data ?? []).reduce((n, c) => n + c.unread, 0);
  // Estoque atual (não o aviso gravado pela rotina): some assim que o produto é reposto.
  const restock = useLoad<any[]>('/stock/restock');
  const attn = useLoad<{ items: AttItem[] }>('/attention', 120_000); // alimenta os avisos da Julia no canto
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
  const go = (v: View, tab?: FinTab) => { if (tab) setFinTab(tab); setAutoPatient(false); setFocus(null); setLost(false); setView(v); setOpen(false); scrollTo({ top: 0 }); };
  const quickActions: QuickAction[] = [
    { icon: 'calendar', title: 'Agendar atendimento', hint: 'Escolha o dia e o horário', run: () => setBooking(true) },
    { icon: 'users', title: 'Cadastrar paciente', hint: 'Novo cadastro', run: () => { go('pacientes'); setAutoPatient(true); } },
    ...(isManager ? [
      { icon: 'receive' as const, title: 'Nova conta a receber ou pagar', hint: 'Lançar no financeiro', run: () => go('financeiro', 'contas') },
      { icon: 'bank' as const, title: 'Adicionar banco', hint: 'Onde o dinheiro cai', run: () => go('financeiro', 'bancos') },
    ] : []),
  ];
  // abre a ficha do paciente (e, se vier, o atendimento) — usado pelo Início e pela Agenda
  const openPatient = (patientId: string, appt: any | null) => { go('pacientes'); setFocus({ id: patientId, appt: appt ? { id: appt.id, label: `${appt.procedure ?? 'Atendimento'} · ${clock(new Date(appt.starts_at))}` } : undefined }); };
  const nAlerts = restock.data?.length ?? 0;
  const toSection = (id: string) => { go('inicio'); setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 500); };
  const ATT_NUDGE: Record<string, { label: string; run: () => void } | undefined> = {
    late_appointments: { label: 'Ver no Início', run: () => toSection('agenda-hoje') },
    returns_overdue: { label: 'Ver retornos', run: () => toSection('retornos-do-dia') },
    returns_closing: { label: 'Ver retornos', run: () => toSection('retornos-do-dia') },
    returns_window: { label: 'Ver retornos', run: () => toSection('retornos-do-dia') },
    payables_overdue: { label: 'Ver contas', run: () => go('financeiro', 'contas') },
    receivables_overdue: { label: 'Ver contas', run: () => go('financeiro', 'contas') },
    lots_expired: { label: 'Ver lotes', run: () => go('estoque') },
    lots_expiring: { label: 'Ver lotes', run: () => go('estoque') },
  };
  const URGENCY = { high: 0, medium: 1, low: 2 };
  const stockRows: { name: string; quantity: number; min_quantity: number }[] = (restock.data ?? []).map((p) => ({ name: p.name, quantity: Number(p.quantity), min_quantity: Number(p.min_quantity) }));
  const outOf = stockRows.filter((p) => p.quantity <= 0), lowOf = stockRows.filter((p) => p.quantity > 0);
  const names = (l: { name: string }[]) => l.slice(0, 3).map((p) => p.name).join(', ') + (l.length > 3 ? ` e mais ${l.length - 3}` : '');
  const goStock = { label: 'Ver estoque', run: () => go('estoque') };
  const OWNER_LABEL = { doctor: 'Doutora', secretary: 'Secretária', manager: 'Gerente' } as const;
  const attItems = attn.data?.items ?? [];
  const context = [
    attItems.length ? `Avisos em "Precisa de atenção": ${attItems.slice(0, 6).map((i) => `${i.title}${i.detail ? ` (${i.detail})` : ''}, responsável: ${OWNER_LABEL[i.owner]}`).join('; ')}.` : '',
    outOf.length ? `Sem estoque: ${names(outOf)}.` : '',
    lowOf.length ? `No mínimo ou abaixo: ${lowOf.slice(0, 4).map((p) => `${p.name} (${p.quantity} de ${p.min_quantity})`).join(', ')}.` : '',
    waUnread ? `${waUnread} mensagem(ns) de clientes não lidas no WhatsApp.` : '',
  ].filter(Boolean).join(' ').slice(0, 1200);
  const suggest = [
    ...(view === 'estoque' || view === 'produtos' ? (stockRows.length ? ['Quais produtos preciso comprar primeiro?', 'Quanto devo repor de cada produto?'] : []) : []),
    ...(view === 'financeiro' ? attItems.filter((i) => i.kind.endsWith('_overdue') && i.kind !== 'returns_overdue').slice(0, 1).map((i) => `O que significa: ${i.title}?`) : []),
    ...(view === 'agenda' || view === 'inicio' ? attItems.filter((i) => i.kind === 'late_appointments').slice(0, 1).map(() => 'Quais atendimentos estão sem conclusão e o que faço?') : []),
    ...(view === 'inicio' ? attItems.filter((i) => i.kind.startsWith('returns_')).slice(0, 1).map(() => 'Quais pacientes precisam de retorno?') : []),
    ...(view === 'inicio' && attItems.length ? ['Explique meus avisos de atenção e quem cuida de cada um.'] : []),
  ];
  const nudges: Nudge[] = [
    ...(outOf.length ? [{ key: 'stock_out', views: ['estoque', 'produtos'], text: `Sem estoque: ${names(outOf)}. Precisa comprar.`, action: goStock }] : []),
    ...(lowOf.length ? [{ key: 'stock_low', views: ['estoque', 'produtos'], text: `Estoque no mínimo: ${names(lowOf)}. Hora de repor.`, action: goStock }] : []),
    ...[...(attn.data?.items ?? [])].filter((i) => ATT_NUDGE[i.kind]).sort((a, b) => URGENCY[a.urgency] - URGENCY[b.urgency]).slice(0, 4)
      .map((i) => ({ key: i.kind, text: `${i.title}${i.detail ? `: ${i.detail}` : ''}. Responsável: ${OWNER_LABEL[i.owner]}.`, views: i.kind.startsWith('returns_') || i.kind === 'late_appointments' ? ['inicio', 'agenda'] : i.kind.endsWith('_overdue') ? ['financeiro'] : undefined, action: ATT_NUDGE[i.kind] })),
    ...(waUnread ? [{ key: 'wa', text: `${waUnread} mensagem(ns) de clientes no WhatsApp para ler e responder.`, action: { label: 'Abrir WhatsApp', run: () => go('whatsapp') } }] : []),
  ];

  return (
    <div className={`shell${view === 'sara' || view === 'whatsapp' ? ' on-sara' : ''}`}>
      <header className="top">
        <button ref={menuBtn} className="icon-btn menu-btn" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></button>
        <h1>{lost ? 'Não encontrada' : TITLE_OVERRIDE[view] ?? TITLES[view]}</h1>
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
        {lost ? <StatusPage kind="notfound" /> : blocked ? (role ? <StatusPage kind="forbidden" /> : <ListSkeleton rows={3} />) : <ErrorBoundary key={view}><Suspense fallback={<ListSkeleton rows={4} />}>
        {view === 'inicio' && <Today key={fresh} name={me?.name} restock={restock.data ?? []} go={go} money={isManager} onBook={() => setBooking(true)} onPatient={() => { go('pacientes'); setAutoPatient(true); }}
          onStart={openPatient} />}
        {view === 'config' && <Settings me={me} />}
        {view === 'agenda' && <Agenda key={fresh} onStart={openPatient} />}
        {view === 'financeiro' && <Finance initialTab={finTab} onTab={setFinTab} />}
        {view === 'estoque' && <Stock go={go} />}
        {view === 'sara' && <Julia name={me?.name} />}
        {view === 'whatsapp' && hasWa && <WhatsApp list={wa} />}
        {(view === 'pacientes' || view === 'procedimentos' || view === 'mensagens') && <Cadastros section={view} autoOpen={autoPatient} focus={focus} onFinish={() => { go('inicio'); setFresh((n) => n + 1); }} />}
        {view === 'produtos' && <Cadastros section={'estoque' satisfies Section} />}
        </Suspense></ErrorBoundary>}
      </main>

      {view !== 'sara' && view !== 'whatsapp' && <BottomNav view={lost ? '' : view} isManager={isManager} go={go} onQuick={() => setQuick(true)} onMenu={() => setOpen(true)} />}
      {me && view !== 'sara' && !lost && !(role && blocked) && <JuliaGuide view={view} userKey={me.email} nudges={nudges} context={context} suggest={suggest} />}
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
            {NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.mgr || isManager) && (!i.front || hasWa)) })).filter((g) => g.items.length).map((g) => (
              <div key={g.group} className="nav-group">
                <p>{g.group}</p>
                {g.items.map((i) => (
                  <button key={i.id} aria-current={!lost && view === i.id ? 'page' : undefined} onClick={() => go(i.id)}>
                    <Icon name={i.icon} size={20} />{i.label}{i.id === 'whatsapp' && waUnread > 0 && <span className="nav-badge" aria-label={`${waUnread} não lidas`}>{waUnread}</span>}
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
    catch (err) {
      setError(!(err instanceof ApiError) ? (navigator.onLine ? 'O servidor não respondeu. Tente de novo em instantes.' : 'Você está sem internet. Confira a conexão e tente de novo.')
        : err.status === 429 ? 'Muitas tentativas seguidas. Por segurança, aguarde alguns minutos antes de tentar de novo.'
        : err.message === 'invalid credentials' ? 'E-mail ou senha incorretos.' : 'Não foi possível entrar. Tente novamente.');
    }
    finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <aside className="login-brand" aria-hidden="true"><img className="brand-logo" src="/neri-logo.png" alt="" /><h2>Gestão da clínica na palma da mão</h2><p>Agenda, financeiro, estoque e a Julia, sua assistente, em um só lugar.</p></aside>
    <form className="login" aria-label="Entrar" onSubmit={submit}>
      <span className="logo" aria-hidden="true"><img src="/neri-n.png" alt="" /></span>
      <h1>Clínica</h1>
      <SessionExpiredNote />
      <p className="muted">Gestão na palma da mão.</p>
      <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Senha<span className="pw"><input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button type="button" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'} onClick={() => setShow((s) => !s)}><Icon name={show ? 'eyeoff' : 'eye'} size={20} /></button></span></label>
      {error && <p role="alert" className="err">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="login-hint">Esqueceu a senha? Peça ao proprietário para redefinir em Configurações → Equipe.</p>
      <LegalLinks />
    </form>
    </div>
  );
}

const Status = ({ error, loading }: { error: string; loading: boolean }) =>
  error ? <p role="alert" className="err">{error}</p> : loading ? <ListSkeleton rows={3} /> : null;

// ---------- Início ----------
type Todo = { icon: IconName; text: string; hint?: string; tone?: 'bad'; run: () => void };
type Stat = { icon: IconName; label: string; value: string; caption: string; dest: string; run: () => void; badge?: string; warn?: boolean; primary?: boolean; eye?: boolean };

// O "meu dia" numa tela só: resumo clicável, próximo paciente, agenda do dia e o que pede atenção.
// No computador cabe sem rolar a página; a agenda e a coluna de pendências rolam por dentro.
function Today({ name, restock, go, money, onBook, onPatient, onStart }: {
  name?: string; restock: any[]; go: (v: View, tab?: FinTab) => void; money: boolean; onBook: () => void; onPatient: () => void;
  onStart: (patientId: string, appt: any | null) => void;
}) {
  const dash = useLoad<any>('/dashboard');
  const att = useLoad<{ items: AttItem[] }>('/attention');
  const { isClinical } = useRole();
  const { hours } = useHours();
  const [busyId, setBusyId] = useState('');
  const [moving, setMoving] = useState<any | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const [concluding, setConcluding] = useState('');
  const [flash, setFlash] = useState(false);
  const { hidden } = useHideValues();
  const toast = useToast();
  const tlRef = useRef<HTMLDivElement>(null);
  const reload = () => { dash.reload(); att.reload(); };

  async function complete(id: string) {
    if (isClinical) { setOpen(null); setConcluding(id); return; } // owner/gerente/profissional: folha com baixa de estoque confirmada
    setBusyId(id);
    try { await api(`/appointments/${id}/complete`, { method: 'POST', json: {} }); setOpen(null); reload(); }
    catch (e) { toast(completeErr(e)); }
    finally { setBusyId(''); }
  }
  const d = dash.data;
  const now = Date.now();
  const timeOf = (a: any) => clock(new Date(a.starts_at));
  const today: any[] = d?.today ?? [];
  const pending = today.filter((a) => a.status !== 'done' && a.status !== 'canceled');
  const doneToday = today.filter((a) => a.status === 'done').length;
  const ended = (a: any) => new Date(a.ends_at ?? a.starts_at).getTime() < now;
  const next = pending.find((a) => !ended(a)) ?? null;
  const late = pending.filter(ended);
  const patientsToday = new Set(today.map((a) => a.patient_id)).size;
  const birthdays: { id: string; full_name: string }[] = d?.birthdays ?? [];
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  const goAgenda = () => jump('agenda-hoje');
  const focusAttn = () => {
    const el = document.getElementById('pendencias');
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); el?.focus({ preventScroll: true });
    setFlash(true); setTimeout(() => setFlash(false), 1200);
  };
  // Ações da lista "Precisa de atenção". "Encaminhar" não tem tela própria: leva à agenda do dia.
  const onAttnAction = (kind: string) => {
    const ref = (att.data?.items as any[] | undefined)?.find((i) => i.kind === 'late_appointments')?.refs?.[0] ?? late[0]; // inclui dias anteriores
    if (kind === 'register') { if (ref) complete(ref.id); else goAgenda(); }
    else if (kind === 'reschedule') { if (ref) setMoving(ref); else goAgenda(); }
    else if (kind === 'check_status' || kind === 'forward') goAgenda();
    else if (kind === 'open_returns') jump('retornos-do-dia');
    else if (kind === 'open_payables' || kind === 'open_receivables') go('financeiro', 'contas');
    else if (kind === 'open_lots' || kind === 'open_restock') go('estoque');
    else if (kind === 'open_birthdays') go('pacientes');
  };

  // Reserva para quando /attention ainda não respondeu ou falhou: só o que o Início já sabe sozinho.
  const todo: Todo[] = [
    ...(late.length ? [{ icon: 'alert' as IconName, tone: 'bad' as const, text: `${late.length} atendimento(s) passaram do horário sem ser concluídos`, hint: late.map((a) => `${timeOf(a)} ${a.patient}`).join(' · '), run: goAgenda }] : []),
    ...(restock.length ? [{ icon: 'box' as IconName, text: `${restock.length} produto(s) para repor`, hint: restock.map((p) => p.name).slice(0, 3).join(', '), run: () => go('estoque') }] : []),
    ...(birthdays.length ? [{ icon: 'users' as IconName, text: `Aniversário hoje: ${birthdays.map((p) => p.full_name).slice(0, 3).join(', ')}${birthdays.length > 3 ? ` e mais ${birthdays.length - 3}` : ''}`, hint: 'A mensagem automática sai às 9h se a paciente autorizou', run: () => go('pacientes') }] : []),
  ];
  const nAtt = att.data ? att.data.items.length : todo.length;
  const urgent = att.data?.items.filter((i) => i.urgency === 'high').length ?? 0;
  const first = name?.split(/\s+/)[0];

  const stats: Stat[] = [
    { icon: 'users', label: 'Pacientes hoje', value: String(patientsToday), caption: `${today.length} na agenda hoje`, dest: 'Abrir pacientes', run: () => go('pacientes'),
      ...(next ? { badge: `Próx. ${timeOf(next)}` } : {}) },
    { icon: 'check', label: 'Concluídos hoje', value: `${doneToday} de ${today.length}`, caption: `${pending.length} por fazer`, dest: 'Abrir agenda', run: () => go('agenda'),
      ...(late.length ? { badge: `${late.length} ${late.length === 1 ? 'atrasado' : 'atrasados'}`, warn: true } : {}) },
    { icon: 'alert', label: 'Pendências', value: String(nAtt), caption: nAtt ? 'Ver a lista' : 'Tudo em dia', dest: 'Ir para a lista de pendências', run: focusAttn, primary: !money,
      ...(urgent ? { badge: `${urgent} ${urgent === 1 ? 'urgente' : 'urgentes'}`, warn: true } : {}) },
    ...(money ? [{ icon: 'wallet' as IconName, label: 'Faturamento do dia', value: mask(brl(d?.todayRevenue ?? 0), hidden), caption: 'Recebido hoje', dest: 'Abrir resumo financeiro', run: () => go('financeiro', 'resumo'), primary: true, eye: true }] : []),
  ];
  const quick: { icon: IconName; label: string; run: () => void }[] = [
    { icon: 'calendar', label: 'Novo agendamento', run: onBook },
    { icon: 'users', label: 'Novo paciente', run: onPatient },
    money ? { icon: 'receive', label: 'Registrar recebimento', run: () => go('financeiro', 'contas') } : { icon: 'box', label: 'Ver estoque', run: () => go('estoque') },
  ];
  const nextAge = next ? ageOf(next.birth_date) : null;

  // a agenda rola por dentro: abre já mostrando o "agora"
  useEffect(() => {
    const sc = tlRef.current?.firstElementChild as HTMLElement | null;
    const mark = sc?.querySelector<HTMLElement>('.tl-now');
    if (sc && mark && sc.scrollHeight > sc.clientHeight) sc.scrollTop += mark.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
  }, [d]);

  return (
    <div className="home">
      <header className="home-hello">
        <div>
          <h2>{greeting()}{first ? `, ${first}` : ''}</h2>
          <p className="muted">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="home-quick" role="group" aria-label="Ações rápidas">
          {quick.map((q) => <button key={q.label} type="button" onClick={q.run}><Icon name={q.icon} size={18} />{q.label}</button>)}
        </div>
      </header>

      {!d ? <Status error={dash.error} loading={!d} /> : (
        <div className="home-grid">
          <div className="home-main">
            <section className={`home-stats n${stats.length}`} aria-label="Resumo do dia">
              {stats.map((k) => (
                <div key={k.label} className={`hs${k.primary ? ' primary' : ''}`}>
                  <button type="button" className="hs-link" onClick={k.run} aria-label={`${k.label}: ${k.value}. ${k.dest}`} />
                  <span className="hs-top" aria-hidden="true">
                    <span className="hs-ico"><Icon name={k.icon} size={18} /></span>
                    {k.badge && <span className={`hs-badge${k.warn ? ' warn' : ''}`}>{k.badge}</span>}
                  </span>
                  <span className="hs-label" aria-hidden="true">{k.label}</span>
                  <strong aria-hidden="true">{k.value}</strong>
                  <span className="hs-foot">
                    <small aria-hidden="true">{k.caption}</small>
                    {k.eye && <EyeToggle className="inline small" />}
                    <span className="hs-arrow" aria-hidden="true"><Icon name="arrow" size={16} /></span>
                  </span>
                </div>
              ))}
            </section>

            <section className="card home-next" aria-labelledby="next-h">
              <div className="home-head"><h2 id="next-h">Próximo paciente</h2>{next && <span className="next-time"><Icon name="calendar" size={16} />{timeOf(next)}</span>}</div>
              {next ? (
                <>
                  <div className="next-main">
                    <Avatar name={next.patient} size={48} />
                    <div className="grow">
                      <b>{next.patient}</b>
                      <span className="muted">{[nextAge !== null ? `${nextAge} anos` : null, next.procedure ?? 'Sem procedimento'].filter(Boolean).join(' · ')}</span>
                    </div>
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
                  {isClinical && <button className="link small home-next-link" onClick={() => setMoving(next)}>Reagendar este atendimento</button>}
                </>
              ) : <p className="muted">{today.length === 0 ? 'Nenhum paciente para hoje.' : late.length ? 'Os atendimentos restantes de hoje já passaram do horário.' : 'Todos os atendimentos de hoje foram concluídos.'}</p>}
            </section>
          </div>

          <div className="home-tl" ref={tlRef}>
            <DayTimeline appts={today} hours={hours} onOpen={setOpen} onBook={onBook} onSeeAll={() => go('agenda')} />
          </div>

          <aside className="home-side" aria-label="Pendências e retornos">
            <section className={`card home-attn${flash ? ' flash' : ''}`} id="pendencias" tabIndex={-1} aria-labelledby="attn-h">
              <div className="attn-head"><h2 id="attn-h">Precisa de atenção</h2>{nAtt > 0 && <span className="badge" aria-label={`${nAtt} pendência(s)`}>{nAtt}</span>}</div>
              {att.data ? (
                att.data.items.length === 0
                  ? <p className="muted">Tudo em dia. Nada pendente por enquanto.</p>
                  : <AtencaoLista items={att.data.items} hidden={hidden} onAction={onAttnAction} />
              ) : todo.length > 0 ? (
                <ul className="todo">{todo.map((t) => (
                  <li key={t.text}>
                    <button onClick={t.run}>
                      <span className={`q-ico ${t.tone === 'bad' ? 'bad' : ''}`}><Icon name={t.icon} size={20} /></span>
                      <span className="grow"><b>{t.text}</b>{t.hint && <span className="muted wrap">{t.hint}</span>}</span>
                      <Icon name="arrow" size={18} />
                    </button>
                  </li>
                ))}</ul>
              ) : att.error ? <p className="muted">Não foi possível carregar as pendências agora.</p> : <ListSkeleton rows={2} />}
            </section>
            <RetornosDoDia />
          </aside>
        </div>
      )}
      {open && <ApptSheet appt={open} clinical={isClinical} busy={busyId === open.id} onClose={() => setOpen(null)}
        onStart={() => { const a = open; setOpen(null); onStart(a.patient_id, a); }} onChart={() => { const a = open; setOpen(null); onStart(a.patient_id, null); }}
        onComplete={() => complete(open.id)} onMove={() => { setMoving(open); setOpen(null); }} />}
      {concluding && <ConcluirAtendimento appointmentId={concluding} onClose={() => setConcluding('')} onDone={reload} />}
      {moving && <RescheduleSheet appt={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />}
    </div>
  );
}

// ---------- Agenda ---------- (calendário em AgendaView.tsx)
const Agenda = ({ onStart }: { onStart: (patientId: string, appt: any | null) => void }) => <AgendaView onStart={onStart} completeErr={completeErr} />;

// ---------- Estoque ----------
function Stock({ go }: { go: (v: View, tab?: FinTab) => void }) {
  const { isManager } = useRole();
  const restock = useLoad<any[]>('/stock/restock');
  const protocols = useLoad<any[]>('/protocols');
  return (
    <div className="dash">
      <section className="card">
        <div className="between"><h2>O que repor</h2><button className="link" onClick={() => go('produtos')}>Registrar entrada</button></div>
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
const SUGGESTIONS: { icon: IconName; title: string; text: string; mgr?: boolean }[] = [
  { icon: 'chart', title: 'Faturamento', text: 'Faturamento e nº de pacientes dos últimos 6 meses', mgr: true },
  { icon: 'box', title: 'Estoque', text: 'Quais produtos preciso repor?' },
  { icon: 'pulse', title: 'Ticket médio', text: 'Como aumentar meu ticket médio?', mgr: true },
  { icon: 'calendar', title: 'Horários livres', text: 'Quais horários livres tenho amanhã?' },
];

function Julia({ name }: { name?: string }) {
  const { isManager } = useRole();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [spoke, setSpoke] = useState<Mood | null>(null); // reação depois da resposta (fala ou tristeza em erro)
  const convo = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const mood: Mood = busy ? 'think' : spoke ?? 'idle';
  useEffect(() => { if (!spoke) return; const id = setTimeout(() => setSpoke(null), spoke === 'talk' ? 3200 : 3000); return () => clearTimeout(id); }, [spoke]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setMsgs((m) => [...m, { role: 'user', text: message }]); setText(''); setBusy(true);
    try {
      const r = await api<{ conversationId: string; reply: string }>('/sara/chat', { method: 'POST', json: { message, conversationId: convo.current } });
      convo.current = r.conversationId;
      setMsgs((m) => [...m, { role: 'sara', text: r.reply }]); setSpoke('talk');
    } catch (e) {
      const s = e instanceof ApiError ? e.status : 0;
      const text = s === 503 ? 'A Julia está indisponível no momento. Avise o administrador da clínica.'
        : s === 504 ? 'A Julia demorou demais para responder. Tente uma pergunta mais curta.'
        : s === 429 ? 'Limite de uso da Julia atingido (por minuto ou do mês). Aguarde um pouco ou avise o administrador.'
        : s === 403 ? 'Seu perfil não tem acesso à Julia.' : 'Não consegui responder agora.';
      setMsgs((m) => [...m, { role: 'sara', text, retry: s === 403 ? undefined : message }]); setSpoke('sad');
    }
    finally { setBusy(false); }
  }

  return (
    <div className={`chat${msgs.length ? ' has-dock' : ''}`}>
      {msgs.length > 0 && (
        <div className="julia-dock">
          <Mascote variant="half" size={84} mood={mood} />
          <div><b>Julia</b><span className="muted">{busy ? 'Pensando…' : spoke === 'talk' ? 'Respondendo' : spoke === 'sad' ? 'Não deu certo' : 'Pronta para ajudar'}</span></div>
        </div>
      )}
      <div className="log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="intro">
            <div className="julia-hero"><Mascote size={190} mood={mood} greet /></div>
            <h2>Olá{name ? `, ${name.split(/\s+/)[0]}` : ''}</h2>
            <p className="muted">Eu sou a Julia. Pergunte sobre faturamento, pacientes, estoque ou finanças da clínica.</p>
            <div className="sugg">
              {SUGGESTIONS.filter((s) => !s.mgr || isManager).map((s) => (
                <button key={s.title} className="sugg-card" onClick={() => send(s.text)}>
                  <Icon name={s.icon} size={22} /><b>{s.title}</b><span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          const b = (
            <div key={i} className={`bubble ${m.role}`}>{m.text}
              {m.retry && <button className="ghost sm retry" disabled={busy} onClick={() => { setMsgs((x) => x.slice(0, i - 1)); send(m.retry!); }}>Tentar novamente</button>}
            </div>
          );
          return m.role === 'user' ? b : (
            <div key={i} className="julia-row"><span className="julia-avatar" aria-hidden="true"><Mascote variant="head" size={34} /></span>{b}</div>
          );
        })}
        {busy && <div className="julia-row"><span className="julia-avatar" aria-hidden="true"><Mascote variant="head" size={34} mood="think" /></span><div className="bubble sara muted">Julia está consultando os dados…</div></div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pergunte à Julia…" maxLength={2000} aria-label="Mensagem para a Julia" />
        <button className="send" aria-label="Enviar" disabled={busy || !text.trim()}><Icon name="send" size={20} /></button>
      </form>
    </div>
  );
}
