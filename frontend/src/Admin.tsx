import { useState } from 'react';
import { api, brl } from './api';
import { AddForm, Cadastros } from './Cadastros';
import { BanksPanel } from './Finance';
import { useLoad } from './hooks';
import { Icon, type IconName } from './Icon';
import { MfaCard, PrivacyCard } from './Privacidade';
import { AssistantCard, GoogleCard, HoursCard, PaymentsCard, Team, WhatsAppCard, type Me } from './Settings';
import { Empty, ListSkeleton, ROLE_LABEL, useRole, useToast } from './ui';

// Painel Administrador: a configuração de cada parte do app num só lugar. Menu grande à esquerda (na horizontal em tela estreita), um cartão de resumo por área
// e, em cada aba, as mesmas telas de configuração que já existem (nada duplicado): o que muda aqui muda nas telas de uso, e o inverso.
type Tab = 'geral' | 'equipe' | 'agenda' | 'procedimentos' | 'estoque' | 'financeiro' | 'mensagens' | 'integracoes' | 'seguranca' | 'sistema';
const TABS: { id: Tab; label: string; hint: string; icon: IconName; owner?: boolean }[] = [
  { id: 'geral', label: 'Visão geral', hint: 'Resumo de tudo', icon: 'chart' },
  { id: 'equipe', label: 'Equipe e acessos', hint: 'Usuários e permissões', icon: 'users', owner: true },
  { id: 'agenda', label: 'Agenda e horários', hint: 'Dias e horas de atendimento', icon: 'calendar' },
  { id: 'procedimentos', label: 'Procedimentos', hint: 'Catálogo e preços', icon: 'syringe' },
  { id: 'estoque', label: 'Estoque e produtos', hint: 'Itens, mínimos e custos', icon: 'box' },
  { id: 'financeiro', label: 'Financeiro', hint: 'Bancos e categorias', icon: 'bank' },
  { id: 'mensagens', label: 'Mensagens', hint: 'Modelos e avisos', icon: 'mail' },
  { id: 'integracoes', label: 'Integrações', hint: 'Pix, WhatsApp e Google', icon: 'spark', owner: true },
  { id: 'seguranca', label: 'Segurança e LGPD', hint: 'Acesso e privacidade', icon: 'alert' },
  { id: 'sistema', label: 'Sistema', hint: 'Estado e histórico', icon: 'pulse', owner: true },
];

type Tile = { icon: IconName; label: string; value: string; caption: string; badge?: string; warn?: boolean; tab: Tab };

function TileCard({ t, open }: { t: Tile; open: (tab: Tab) => void }) {
  return (
    <div className="hs">
      <button type="button" className="hs-link" onClick={() => open(t.tab)} aria-label={`${t.label}: ${t.value}. Abrir configuração`} />
      <span className="hs-top" aria-hidden="true">
        <span className="hs-ico"><Icon name={t.icon} size={18} /></span>
        {t.badge && <span className={`hs-badge${t.warn ? ' warn' : ''}`}>{t.badge}</span>}
      </span>
      <span className="hs-label" aria-hidden="true">{t.label}</span>
      <strong aria-hidden="true">{t.value}</strong>
      <span className="hs-foot"><small>{t.caption}</small><span className="hs-arrow" aria-hidden="true"><Icon name="arrow" size={16} /></span></span>
    </div>
  );
}

export function AdminPanel({ me }: { me: Me | null }) {
  const { isOwner } = useRole();
  const tabs = TABS.filter((t) => isOwner || !t.owner);
  const [tab, setTab] = useState<Tab>('geral');
  const first = me?.name?.split(/\s+/)[0];
  const shortcuts: { icon: IconName; label: string; tab: Tab; owner?: boolean }[] = [
    { icon: 'users', label: 'Novo usuário', tab: 'equipe', owner: true },
    { icon: 'syringe', label: 'Novo procedimento', tab: 'procedimentos' },
    { icon: 'box', label: 'Novo produto', tab: 'estoque' },
    { icon: 'bank', label: 'Nova conta bancária', tab: 'financeiro' },
    { icon: 'mail', label: 'Novo modelo de mensagem', tab: 'mensagens' },
  ];
  return (
    <div className="admin">
      <header className="home-hello">
        <div>
          <h2>Painel administrador</h2>
          <p className="muted">{me?.clinic ?? 'Sua clínica'}{first ? ` · ${first}` : ''} · {me ? ROLE_LABEL[me.role] : ''}</p>
        </div>
        <div className="home-quick" role="group" aria-label="Atalhos de cadastro">
          {shortcuts.filter((s) => isOwner || !s.owner).map((s) => (
            <button key={s.label} type="button" onClick={() => setTab(s.tab)}><Icon name={s.icon} size={18} />{s.label}</button>
          ))}
        </div>
      </header>
      <div className="admin-layout">
      <nav className="admin-nav" role="tablist" aria-label="Áreas do painel" aria-orientation="vertical">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            <span className="admin-nav-ico" aria-hidden="true"><Icon name={t.icon} size={20} /></span>
            <span className="admin-nav-txt"><b>{t.label}</b><small>{t.hint}</small></span>
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {tab === 'geral' && <Overview open={setTab} />}
        {tab === 'equipe' && isOwner && <><Team /><Permissions /></>}
        {tab === 'agenda' && <div className="dash settings"><HoursCard /><section className="card"><h2>Profissionais na agenda</h2>
          <p className="muted">Quem atende aparece ao agendar. Para incluir ou tirar alguém, use <b>Equipe e acessos</b>: cada usuário com perfil Profissional, Gerente ou Proprietário pode ser escolhido na agenda.</p>
          {isOwner && <div className="actions"><button className="ghost" onClick={() => setTab('equipe')}>Abrir equipe e acessos</button></div>}</section></div>}
        {tab === 'procedimentos' && <Cadastros section="procedimentos" />}
        {tab === 'estoque' && <Cadastros section="estoque" />}
        {tab === 'financeiro' && <><BanksPanel /><Categories /></>}
        {tab === 'mensagens' && <Cadastros section="mensagens" />}
        {tab === 'integracoes' && isOwner && <div className="dash settings"><PaymentsCard /><WhatsAppCard /><AssistantCard /><GoogleCard /></div>}
        {tab === 'seguranca' && <div className="dash settings"><MfaCard /><PrivacyCard /></div>}
        {tab === 'sistema' && isOwner && <System me={me} />}
      </div>
      </div>
    </div>
  );
}

// ---------- Visão geral: um cartão por área, com o estado atual da configuração ----------
function Overview({ open }: { open: (t: Tab) => void }) {
  const { isOwner } = useRole();
  const team = useLoad<{ revoked: boolean }[]>(isOwner ? '/team' : null);
  const procs = useLoad<unknown[]>('/procedures');
  const prods = useLoad<{ quantity: string; min_quantity: string }[]>('/products');
  const banks = useLoad<{ active: boolean; balance: number }[]>('/banks');
  const auto = useLoad<{ templates: unknown[] }>('/automation');
  const hours = useLoad<{ isDefault: boolean }>('/clinic/hours');
  const mfa = useLoad<{ enabled: boolean }>('/me/mfa');
  const pay = useLoad<{ asaas: { configured: boolean } }>(isOwner ? '/integrations' : null);
  const wa = useLoad<{ enabled: boolean }>(isOwner ? '/integrations/whatsapp' : null);
  const goo = useLoad<{ connected: boolean }>(isOwner ? '/google/status' : null);
  const cats = useLoad<unknown[]>('/categories');
  const dash = (v: unknown, fn: () => Tile['value']) => (v ? fn() : '…');

  const low = (prods.data ?? []).filter((p) => Number(p.quantity) <= Number(p.min_quantity)).length;
  const activeBanks = (banks.data ?? []).filter((b) => b.active);
  const connected = [pay.data?.asaas.configured, wa.data?.enabled, goo.data?.connected].filter(Boolean).length;
  const tiles: Tile[] = [
    ...(isOwner ? [{ icon: 'users' as IconName, label: 'Equipe e acessos', tab: 'equipe' as Tab,
      value: dash(team.data, () => `${team.data!.filter((u) => !u.revoked).length} ativos`), caption: 'Usuários, perfis e senhas' }] : []),
    { icon: 'calendar', label: 'Agenda e horários', tab: 'agenda', value: dash(hours.data, () => (hours.data!.isDefault ? 'Padrão' : 'Personalizado')), caption: 'Dias e horas de atendimento' },
    { icon: 'syringe', label: 'Procedimentos', tab: 'procedimentos', value: dash(procs.data, () => String(procs.data!.length)), caption: 'Catálogo, preços e retornos' },
    { icon: 'box', label: 'Estoque e produtos', tab: 'estoque', value: dash(prods.data, () => String(prods.data!.length)), caption: 'Mínimos, custos e reposição',
      ...(low ? { badge: `${low} abaixo do mínimo`, warn: true } : {}) },
    { icon: 'bank', label: 'Financeiro', tab: 'financeiro', value: dash(banks.data, () => `${activeBanks.length} conta(s)`),
      caption: banks.data ? `Saldo ${brl(activeBanks.reduce((a, b) => a + b.balance, 0))} · ${cats.data?.length ?? 0} categorias` : 'Contas e categorias' },
    { icon: 'mail', label: 'Mensagens', tab: 'mensagens', value: dash(auto.data, () => `${auto.data!.templates.length} modelo(s)`), caption: 'Modelos e avisos da agenda' },
    ...(isOwner ? [{ icon: 'spark' as IconName, label: 'Integrações', tab: 'integracoes' as Tab,
      value: dash(pay.data && wa.data && goo.data, () => `${connected} de 3`), caption: 'Pix, WhatsApp e Google Agenda',
      ...(pay.data && connected < 3 ? { badge: 'Incompleto' } : {}) }] : []),
    { icon: 'alert', label: 'Segurança e LGPD', tab: 'seguranca', value: dash(mfa.data, () => (mfa.data!.enabled ? '2FA ligado' : '2FA desligado')), caption: 'Verificação em duas etapas e privacidade',
      ...(mfa.data && !mfa.data.enabled ? { badge: 'Recomendado ligar', warn: true } : {}) },
    ...(isOwner ? [{ icon: 'pulse' as IconName, label: 'Sistema', tab: 'sistema' as Tab, value: 'Online', caption: 'Estado e histórico de atividades' }] : []),
  ];
  return (
    <>
      <div className="home-stats admin-tiles">{tiles.map((t) => <TileCard key={t.label} t={t} open={open} />)}</div>
      <p className="muted">Toque em um cartão para configurar. As alterações valem para todo o sistema e aparecem nas telas da recepção conforme o perfil de cada pessoa.</p>
    </>
  );
}

// ---------- Permissões por perfil (o que o servidor realmente aplica) ----------
const ROLES = ['owner', 'manager', 'professional', 'reception'] as const;
const MATRIX: [string, ...boolean[]][] = [
  ['Ver agenda, agendar, remarcar e cancelar', true, true, true, true],
  ['Cadastrar paciente e corrigir contato', true, true, true, true],
  ['Ficha clínica, CPF e prontuário', true, true, true, false],
  ['Concluir atendimento com baixa de estoque e lote', true, true, true, false],
  ['Concluir atendimento sem baixa ("fechar rápido")', true, true, true, true],
  ['Movimentar estoque (entrada, perda)', true, true, true, true],
  ['Ver e editar o custo dos produtos', true, true, false, false],
  ['Editar procedimentos e preços', true, true, false, false],
  ['Financeiro: contas, bancos e DRE', true, true, false, false],
  ['Mensagens: modelos e avisos', true, true, false, false],
  ['WhatsApp: conversas', true, true, false, true],
  ['Verificação em duas etapas e privacidade (LGPD)', true, true, false, false],
  ['Anonimizar paciente e ver histórico de atividades', true, false, false, false],
  ['Equipe e acessos, integrações', true, false, false, false],
];
function Permissions() {
  return (
    <section className="card">
      <h2>Quem pode o quê</h2>
      <p className="muted">Estas permissões são aplicadas pelo servidor: esconder um botão não basta, o acesso é recusado mesmo por fora da tela.</p>
      <div className="table-wrap"><table className="matrix">
        <thead><tr><th scope="col">Ação</th>{ROLES.map((r) => <th key={r} scope="col">{ROLE_LABEL[r]}</th>)}</tr></thead>
        <tbody>{MATRIX.map(([label, ...ok]) => (
          <tr key={label}><th scope="row">{label}</th>{ok.map((v, i) => <td key={ROLES[i]} className={v ? 'yes' : 'no'}><span className="sr-only">{v ? 'Pode' : 'Não pode'}</span><span aria-hidden="true">{v ? '✓' : '—'}</span></td>)}</tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

// ---------- Categorias financeiras ----------
const DRE_GROUP: Record<string, string> = {
  receita_bruta: 'Receita bruta', deducoes: 'Deduções', custos_variaveis: 'Custos variáveis', despesas_operacionais: 'Despesas operacionais',
  despesas_financeiras: 'Despesas financeiras', impostos_lucro: 'Impostos sobre o lucro',
};
function Categories() {
  const l = useLoad<{ id: string; name: string; kind: 'income' | 'expense'; dre_group: string }[]>('/categories');
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  return (
    <section className="card">
      <div className="between"><h2>Categorias financeiras</h2><button className="primary sm" onClick={() => setAdding((v) => !v)}><Icon name="plus" size={16} />Nova categoria</button></div>
      <p className="muted">Organizam as contas e definem onde cada valor aparece no DRE.</p>
      {adding && (
        <AddForm label="Salvar categoria" onSubmit={async (v) => { await api('/categories', { method: 'POST', json: v }); l.reload(); setAdding(false); toast('Categoria criada'); }} fields={[
          { name: 'name', label: 'Nome', required: true },
          { name: 'kind', label: 'Tipo', type: 'select', required: true, options: [{ value: 'income', label: 'Receita' }, { value: 'expense', label: 'Despesa' }] },
          { name: 'dreGroup', label: 'Grupo no DRE', type: 'select', required: true, options: Object.entries(DRE_GROUP).map(([value, label]) => ({ value, label })) },
        ]} />
      )}
      {l.error && <p role="alert" className="err">{l.error}</p>}
      {!l.data && !l.error && <ListSkeleton rows={2} />}
      <ul className="rows">{l.data?.map((c) => (
        <li key={c.id}><div className="row-btn static"><span className="grow"><b>{c.name}</b><span className="muted">{DRE_GROUP[c.dre_group] ?? c.dre_group}</span></span>
          <span className={`pill ${c.kind === 'income' ? 'ok' : 'warn'}`}>{c.kind === 'income' ? 'Receita' : 'Despesa'}</span></div></li>
      ))}</ul>
    </section>
  );
}

// ---------- Sistema: estado e histórico de atividades ----------
const ACTION: Record<string, string> = {
  'auth.login': 'Entrou no sistema', 'patient.create': 'Cadastrou um paciente', 'patient.read': 'Abriu a ficha de um paciente', 'team.create': 'Criou um usuário',
  'team.update': 'Alterou um usuário', 'team.revoke': 'Removeu o acesso de um usuário', 'team.password_reset': 'Redefiniu a senha de um usuário',
  'finance.mark_paid': 'Deu baixa em uma conta', 'finance.update': 'Corrigiu uma conta', 'finance.cancel': 'Cancelou uma conta',
  'procedure.update': 'Alterou um procedimento', 'stock.product_create': 'Cadastrou um produto', 'stock.product_update': 'Alterou um produto', 'stock.movement': 'Movimentou o estoque',
  'appointment.complete_quick': 'Fechou um atendimento (sem baixa de estoque)', 'appointment.complete_confirmed': 'Concluiu um atendimento (com baixa de estoque)',
  'application.create': 'Registrou o uso de um produto', 'lgpd.export': 'Exportou os dados de um titular (LGPD)', 'lgpd.hold_set': 'Bloqueou a anonimização de um paciente',
};
const actionLabel = (a: string) => ACTION[a] ?? (a.startsWith('patient.update') ? 'Corrigiu dados de um paciente' : a);
function System({ me }: { me: Me | null }) {
  const health = useLoad<{ ok: boolean }>('/health');
  const log = useLoad<{ id: string; created_at: string; action: string; user_name: string | null }[]>('/audit');
  return (
    <>
      <section className="card">
        <h2>Estado do sistema</h2>
        <ul className="rows">
          <li><div className="row-btn static"><span className="grow"><b>Servidor</b><span className="muted">Resposta da API agora</span></span>
            <span className={`pill ${health.data?.ok ? 'ok' : 'warn'}`}>{health.data ? (health.data.ok ? 'Online' : 'Com problema') : health.error ? 'Sem resposta' : '…'}</span></div></li>
          <li><div className="row-btn static"><span className="grow"><b>Clínica</b><span className="muted">Fuso: America/Sao_Paulo</span></span><b>{me?.clinic ?? '—'}</b></div></li>
        </ul>
      </section>
      <section className="card">
        <h2>Histórico de atividades</h2>
        <p className="muted">Os 40 registros mais recentes: quem fez o quê. Só o proprietário vê.</p>
        {log.error && <p role="alert" className="err">{log.error === 'forbidden' ? 'Seu perfil não tem acesso ao histórico.' : log.error}</p>}
        {!log.data && !log.error && <ListSkeleton rows={3} />}
        {log.data?.length === 0 && <Empty icon="list" title="Nada registrado ainda" />}
        <ul className="rows">{log.data?.slice(0, 40).map((a) => (
          <li key={a.id}><div className="row-btn static"><span className="grow"><b>{actionLabel(a.action)}</b><span className="muted">{a.user_name ?? 'Sistema'}</span></span>
            <span className="muted">{new Date(a.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div></li>
        ))}</ul>
      </section>
    </>
  );
}
