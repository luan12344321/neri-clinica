import { useEffect, useState } from 'react';
import { LegalLinks } from './Legal';
import { ApiError, api } from './api';
import { AddForm, errText, type Field } from './Cadastros';
import { useLoad } from './hooks';
import { DEFAULT_HOURS, fromMin, toMin, useHours, type Hours } from './hours';
import { Icon } from './Icon';
import { seenText, usePresence } from './Presence';
import { Avatar, Empty, ListSkeleton, PageHead, ROLE_LABEL, Sheet, useInstall, useRole, useToast, type Role } from './ui';

export type Me = { name: string; email: string; role: Role; clinic: string; termsAccepted?: boolean };
type Member = { id: string; name: string; email: string; role: Role; revoked: boolean };

const ROLE_HINT: Record<Exclude<Role, 'owner'>, string> = {
  manager: 'Tudo, menos gerenciar a equipe: financeiro, estoque, cadastros, mensagens e a Julia.',
  professional: 'Agenda, pacientes e prontuário. Não vê o financeiro.',
  reception: 'Agenda, cadastro de pacientes, estoque e reposição (entradas, perdas e novos produtos) e a Julia. Sem acesso a financeiro, custos, mensagens, CPF, prontuário e equipe.',
};
const ROLE_OPTIONS = (Object.keys(ROLE_HINT) as (keyof typeof ROLE_HINT)[]).map((value) => ({ value, label: ROLE_LABEL[value] }));

export function Settings({ me }: { me: Me | null }) {
  const { isOwner, isManager } = useRole();
  return (
    <div className="dash settings">
      <div className="span-all"><PageHead title="Configurações" hint={me?.clinic} /></div>
      <Account me={me} />
      {isManager && <HoursCard />}
      <InstallCard />
      {isOwner && <Team />}
      {isOwner && <AssistantCard />}
      {isOwner && <PaymentsCard />}
      {isOwner && <WhatsAppCard />}
      <LegalLinks className="span-all" />
      <footer className="credit span-all"><span>Desenvolvido por</span><img src="/neri-logo.png" alt="NERI Design & Web" /></footer>
    </div>
  );
}

function Account({ me }: { me: Me | null }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  if (!me) return <section className="card"><ListSkeleton rows={1} /></section>;
  return (
    <section className="card">
      <h2>Minha conta</h2>
      <div className="row-btn static">
        <Avatar name={me.name} size={48} />
        <span className="grow"><b>{me.name}</b><span className="muted">{me.email}</span></span>
        <span className="pill ok">{ROLE_LABEL[me.role]}</span>
      </div>
      <div className="actions"><button className="ghost" onClick={() => setOpen(true)}>Alterar senha</button></div>
      {open && (
        <Sheet title="Alterar senha" onClose={() => setOpen(false)}>
          <AddForm label="Salvar nova senha" fields={[
            { name: 'current', label: 'Senha atual', type: 'password', required: true },
            { name: 'next', label: 'Nova senha (mínimo 10 caracteres)', type: 'password', required: true },
          ]} onSubmit={async (v) => { await api('/me/password', { method: 'POST', json: v }); setOpen(false); toast('Senha alterada'); }} />
        </Sheet>
      )}
    </section>
  );
}

function InstallCard() {
  const { installed, canPrompt, ios, install } = useInstall();
  return (
    <section className="card install">
      <h2>Aplicativo no celular</h2>
      {installed ? <p className="muted"><Icon name="check" size={16} /> Já instalado neste aparelho.</p> : canPrompt ? (
        <>
          <p className="muted">Instale para abrir direto da tela inicial, em tela cheia, como um aplicativo.</p>
          <div className="actions"><button className="primary" onClick={install}><Icon name="download" size={18} />Instalar aplicativo</button></div>
        </>
      ) : ios ? (
        <ol className="steps">
          <li>Abra este site no <b>Safari</b>.</li>
          <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima).</li>
          <li>Escolha <b>Adicionar à Tela de Início</b>.</li>
        </ol>
      ) : (
        <p className="muted">No Chrome do celular: toque nos três pontinhos <b>⋮</b> e depois em <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b>). No computador, use o ícone de instalar na barra de endereço.</p>
      )}
    </section>
  );
}

function Team() {
  const list = useLoad<Member[]>('/team');
  const presence = usePresence(true);
  const seen = (id: string) => presence.data?.find((p) => p.id === id);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Member | null>(null);
  const toast = useToast();
  const fields: Field[] = [
    { name: 'name', label: 'Nome', required: true },
    { name: 'email', label: 'E-mail (será o login)', type: 'email', required: true },
    { name: 'role', label: 'Perfil', type: 'select', required: true, options: ROLE_OPTIONS },
    { name: 'password', label: 'Senha inicial (mínimo 10 caracteres)', type: 'password', required: true },
  ];
  return (
    <section className="card list-card span-all">
      <div className="between pad-h">
        <div><h2>Equipe</h2><p className="muted">Quem pode entrar no sistema e o que cada perfil enxerga.</p></div>
        <button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Novo usuário</button>
      </div>
      {!list.data && !list.error && <ListSkeleton rows={2} />}
      {list.error && <p role="alert" className="err">{list.error}</p>}
      {list.data && list.data.length <= 1 && <Empty icon="users" title="Só você por aqui" text="Cadastre um funcionário com e-mail e senha para ele acessar também." />}
      <ul className="rows">{list.data?.map((m) => (
        <li key={m.id}>
          {m.role === 'owner' ? (
            <div className="row-btn static"><Avatar name={m.name} /><span className="grow"><b>{m.name}</b><span className="muted">{m.email}</span></span><span className="pill ok">{ROLE_LABEL.owner}</span></div>
          ) : (
            <button className="row-btn" onClick={() => setEdit(m)}>
              <span className="av-wrap"><Avatar name={m.name} />{seen(m.id)?.online && <i className="on-dot" />}</span>
              <span className="grow"><b>{m.name}</b><span className="muted">{m.email}</span>{seen(m.id) && !m.revoked && <span className={`seen ${seen(m.id)!.online ? 'on' : ''}`}>{seenText(seen(m.id)!)}</span>}</span>
              {m.revoked ? <span className="pill warn">Sem acesso</span> : <span className="pill">{ROLE_LABEL[m.role]}</span>}
            </button>
          )}
        </li>
      ))}</ul>
      <p className="muted pad">{Object.entries(ROLE_HINT).map(([r, h]) => `${ROLE_LABEL[r as Role]}: ${h}`).join(' ')}</p>
      {adding && (
        <Sheet title="Novo usuário" onClose={() => setAdding(false)}>
          <AddForm label="Cadastrar" fields={fields} onSubmit={async (v) => { await api('/team', { method: 'POST', json: v }); list.reload(); setAdding(false); toast('Usuário cadastrado'); }} />
        </Sheet>
      )}
      {edit && <EditMember m={edit} onClose={() => setEdit(null)} onDone={(msg) => { list.reload(); setEdit(null); toast(msg); }} />}
    </section>
  );
}

function EditMember({ m, onClose, onDone }: { m: Member; onClose: () => void; onDone: (msg: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  async function revoke() {
    try { await api(`/team/${m.id}`, { method: 'DELETE' }); onDone('Acesso removido'); } catch (e) { setErr(errText(e)); }
  }
  return (
    <Sheet title={m.name} onClose={onClose}>
      {m.revoked && <p className="muted">Este usuário está sem acesso. Defina uma nova senha abaixo para reativá-lo.</p>}
      <AddForm label="Salvar alterações" fields={[
        { name: 'name', label: 'Nome', def: m.name, required: true },
        { name: 'role', label: 'Perfil', type: 'select', def: m.role, options: ROLE_OPTIONS },
        { name: 'password', label: m.revoked ? 'Nova senha (mínimo 10 caracteres)' : 'Redefinir senha (deixe em branco para manter)', type: 'password', required: m.revoked },
      ]} onSubmit={async (v) => { await api(`/team/${m.id}`, { method: 'PATCH', json: v }); onDone(m.revoked && v.password ? 'Acesso reativado' : 'Alterações salvas'); }} />
      {!m.revoked && (
        <div className="danger-zone">
          {!confirm ? <button className="ghost danger" onClick={() => setConfirm(true)}>Remover acesso</button> : (
            <>
              <p className="muted">{m.name} deixa de entrar no sistema agora. O histórico é mantido e você pode reativar depois redefinindo a senha.</p>
              <div className="actions"><button className="ghost danger" onClick={revoke}>Confirmar remoção</button><button className="ghost" onClick={() => setConfirm(false)}>Cancelar</button></div>
            </>
          )}
          {err && <p role="alert" className="err">{err}</p>}
        </div>
      )}
    </Sheet>
  );
}

function AssistantCard() {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'down' | 'error'>('idle');
  async function test() {
    setState('busy');
    try { await api('/sara/test', { method: 'POST', json: {} }); setState('ok'); }
    catch (e) { setState(e instanceof ApiError && e.status === 503 ? 'down' : 'error'); }
  }
  return (
    <section className="card">
      <h2>Assistente Julia</h2>
      <p className="muted">Confira se a Julia está conectada à inteligência artificial. Ela usa a API do Google Gemini (plano pago, com limite mensal de uso).</p>
      <div className="actions"><button className="ghost" disabled={state === 'busy'} onClick={test}>{state === 'busy' ? 'Testando…' : 'Testar conexão'}</button></div>
      {state === 'ok' && <p className="ok-text" role="status"><Icon name="check" size={16} /> Tudo certo: a Julia está respondendo.</p>}
      {state === 'down' && <p role="alert" className="err">Sem conexão com a IA. Verifique se a cobrança do Google Gemini está ativa e se a chave (GEMINI_API_KEY) está correta na Vercel.</p>}
      {state === 'error' && <p role="alert" className="err">Não foi possível testar agora. Tente novamente em instantes.</p>}
    </section>
  );
}

// Conexão com o Asaas (confirmação automática de Pix). As chaves ficam nas variáveis do Netlify, nunca nesta tela.
function PaymentsCard() {
  const integ = useLoad<{ asaas: { configured: boolean; sandbox: boolean } }>('/integrations');
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle');
  const [detail, setDetail] = useState('');
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/api/webhooks/asaas`;
  const a = integ.data?.asaas;
  async function test() {
    setState('busy'); setDetail('');
    try { await api('/integrations/asaas/test', { method: 'POST', json: {} }); setState('ok'); }
    catch (e) { setState('fail'); setDetail(e instanceof ApiError && e.detail ? e.detail : ''); }
  }
  async function copy() { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sem permissão */ } }
  return (
    <section className="card">
      <div className="between"><h2>Pagamentos (Asaas)</h2>{a && <span className={`pill ${a.configured ? 'ok' : 'warn'}`}>{a.configured ? (a.sandbox ? 'Conectado · modo teste' : 'Conectado') : 'Não conectado'}</span>}</div>
      <p className="muted">Cobra por Pix e dá a baixa sozinho quando o paciente paga. O dinheiro cai na conta digital do Asaas.</p>
      {a && !a.configured && (
        <ol className="steps">
          <li>Crie a conta no Asaas e gere uma <b>chave de API</b> (comece pelo ambiente de teste).</li>
          <li>No Netlify, cadastre <b>ASAAS_API_KEY</b>, <b>ASAAS_WEBHOOK_TOKEN</b> (um segredo seu, de 32 a 255 caracteres) e <b>ASAAS_ENV</b> (<code>sandbox</code> ou <code>production</code>) e faça um novo deploy.</li>
          <li>No Asaas, em Integrações → Webhooks, cadastre o endereço abaixo, o mesmo segredo e os eventos de cobrança.</li>
        </ol>
      )}
      <label className="form-label">Endereço do webhook (cole no Asaas)
        <span className="pw"><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /><button type="button" aria-label="Copiar endereço" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={20} /></button></span>
      </label>
      {a?.configured && <div className="actions"><button className="ghost" disabled={state === 'busy'} onClick={test}>{state === 'busy' ? 'Testando…' : 'Testar conexão'}</button></div>}
      {state === 'ok' && <p className="ok-text" role="status"><Icon name="check" size={16} /> Conexão com o Asaas funcionando.</p>}
      {state === 'fail' && <p role="alert" className="err">Não foi possível conectar ao Asaas{detail ? `: ${detail}` : '. Confira a chave de API e o ambiente (teste ou produção).'}</p>}
    </section>
  );
}

// ---------- WhatsApp: a Julia atende os clientes ----------
type WaConfig = { enabled: boolean; number: string; phoneId: string; tokenSet: boolean; secretSet: boolean; verifyToken: string | null };
type WaWaiting = { contact: string; name: string | null; reason: string | null; last_message: string | null };
const maskPhone = (p: string) => (p.length > 4 ? `…${p.slice(-4)}` : p);

function WhatsAppCard() {
  const cfg = useLoad<WaConfig>('/integrations/whatsapp');
  const waiting = useLoad<WaWaiting[]>('/integrations/whatsapp/waiting', 30000);
  const toast = useToast();
  const [form, setForm] = useState({ number: '', phoneId: '', token: '', appSecret: '', enabled: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; detail: string }>({ state: 'idle', detail: '' });
  const [copied, setCopied] = useState('');
  const url = `${location.origin}/api/webhooks/whatsapp`;
  const c = cfg.data;
  useEffect(() => { if (c) setForm((f) => ({ ...f, number: c.number, phoneId: c.phoneId, enabled: c.enabled })); }, [c]);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api('/integrations/whatsapp', { method: 'PUT', json: { number: form.number, phoneId: form.phoneId, enabled: form.enabled,
        ...(form.token ? { token: form.token } : {}), ...(form.appSecret ? { appSecret: form.appSecret } : {}) } });
      setForm((f) => ({ ...f, token: '', appSecret: '' }));
      cfg.reload(); toast('WhatsApp salvo');
    } catch (e2) { setErr(e2 instanceof ApiError && e2.detail ? e2.detail : e2 instanceof ApiError && e2.status === 400 ? 'Confira o número (com DDD) e o Phone Number ID.' : 'Não foi possível salvar agora.'); }
    finally { setBusy(false); }
  }
  async function runTest() {
    setTest({ state: 'busy', detail: '' });
    try { const r = await api<{ number: string | null }>('/integrations/whatsapp/test', { method: 'POST', json: {} }); setTest({ state: 'ok', detail: r.number ?? '' }); }
    catch (e2) { setTest({ state: 'fail', detail: e2 instanceof ApiError && e2.detail ? e2.detail : '' }); }
  }
  async function copy(key: string, text: string) { try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 2000); } catch { /* sem permissão */ } }
  async function resume(contact: string) { try { await api(`/integrations/whatsapp/contacts/${contact}/resume`, { method: 'POST', json: {} }); waiting.reload(); toast('A Julia voltou a atender'); } catch { toast('Não foi possível agora'); } }
  const configured = !!c?.tokenSet && !!c?.secretSet && !!c?.phoneId;
  return (
    <section className="card span-all">
      <div className="between"><h2>WhatsApp da clínica</h2>{c && <span className={`pill ${c.enabled ? 'ok' : 'warn'}`}>{c.enabled ? 'Julia atendendo' : 'Desligado'}</span>}</div>
      <p className="muted">Cadastre o número que os clientes vão usar. A Julia responde as mensagens a qualquer hora, tira dúvidas, agenda, remarca e cancela consultas, e chama a equipe quando o assunto é com vocês.</p>
      {!configured && (
        <ol className="steps">
          <li>Na Meta (WhatsApp Business Platform), crie o app e registre um número que <b>não esteja em uso</b> no WhatsApp comum.</li>
          <li>Copie o <b>Phone Number ID</b>, gere um <b>token de acesso permanente</b> e pegue o <b>segredo do app</b> (App Secret). Cole nos campos abaixo e salve.</li>
          <li>Na Meta, em Webhooks, cadastre o endereço e o token de verificação mostrados aqui e assine o campo <b>messages</b>.</li>
        </ol>
      )}
      <form onSubmit={save} className="form">
        <label className="form-label">Número do WhatsApp (com DDD) <input inputMode="tel" required value={form.number} onChange={(e) => set('number', e.target.value)} placeholder="+55 11 90000-0000" /></label>
        <label className="form-label">Phone Number ID (da Meta) <input inputMode="numeric" required value={form.phoneId} onChange={(e) => set('phoneId', e.target.value)} autoComplete="off" /></label>
        <label className="form-label">Token de acesso {c?.tokenSet && <small>(salvo; preencha só para trocar)</small>}
          <input type="password" value={form.token} onChange={(e) => set('token', e.target.value)} autoComplete="new-password" placeholder={c?.tokenSet ? '••••••••••••' : ''} /></label>
        <label className="form-label">Segredo do app (App Secret) {c?.secretSet && <small>(salvo; preencha só para trocar)</small>}
          <input type="password" value={form.appSecret} onChange={(e) => set('appSecret', e.target.value)} autoComplete="new-password" placeholder={c?.secretSet ? '••••••••••••' : ''} /></label>
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Ligar o atendimento da Julia neste número</label>
        {err && <p role="alert" className="err">{err}</p>}
        <div className="actions">
          <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
          {configured && <button type="button" className="ghost" disabled={test.state === 'busy'} onClick={runTest}>{test.state === 'busy' ? 'Testando…' : 'Testar conexão'}</button>}
        </div>
      </form>
      {test.state === 'ok' && <p className="ok-text" role="status"><Icon name="check" size={16} /> Conectado à Meta{test.detail ? ` · ${test.detail}` : ''}.</p>}
      {test.state === 'fail' && <p role="alert" className="err">Não foi possível conectar{test.detail ? `: ${test.detail}` : '. Confira o Phone Number ID e o token.'}</p>}
      {c?.verifyToken && (
        <div className="form" style={{ marginTop: 16 }}>
          <label className="form-label">Endereço do webhook (cole na Meta)
            <span className="pw"><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} /><button type="button" aria-label="Copiar endereço" onClick={() => copy('url', url)}><Icon name={copied === 'url' ? 'check' : 'copy'} size={20} /></button></span>
          </label>
          <label className="form-label">Token de verificação (cole na Meta)
            <span className="pw"><input readOnly value={c.verifyToken} onFocus={(e) => e.currentTarget.select()} /><button type="button" aria-label="Copiar token" onClick={() => copy('tok', c.verifyToken!)}><Icon name={copied === 'tok' ? 'check' : 'copy'} size={20} /></button></span>
          </label>
        </div>
      )}
      {!!waiting.data?.length && (
        <div style={{ marginTop: 20 }}>
          <h3>Conversas esperando a equipe</h3>
          <p className="muted">A Julia ficou quieta nestas conversas. Responda pelo WhatsApp e, quando terminar, devolva para ela.</p>
          <ul className="rows">
            {waiting.data.map((w) => (
              <li key={w.contact} className="between">
                <span><b>{w.name || maskPhone(w.contact)}</b> <small className="muted">{w.reason}</small><br /><small className="muted">{w.last_message}</small></span>
                <button className="ghost" onClick={() => resume(w.contact)}>Devolver para a Julia</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- Horário de atendimento da clínica ----------
const DAYS: [number, string][] = [[1, 'Segunda-feira'], [2, 'Terça-feira'], [3, 'Quarta-feira'], [4, 'Quinta-feira'], [5, 'Sexta-feira'], [6, 'Sábado'], [0, 'Domingo']];
const TIMES = Array.from({ length: 48 }, (_, i) => fromMin(i * 30));
const validDay = (f: [string, string][]) => f.every(([s, e], i) => toMin(e) > toMin(s) && (i === 0 || toMin(s) >= toMin(f[i - 1]![1])));
const clone = (h: Hours): Hours => JSON.parse(JSON.stringify(h));

function HoursCard() {
  const { hours, loaded, isDefault, reload } = useHours();
  const [draft, setDraft] = useState<Hours | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toast = useToast();
  useEffect(() => { if (loaded && !draft) setDraft(clone(hours)); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return <section className="card"><h2>Horário de atendimento</h2><ListSkeleton rows={2} /></section>;

  const set = (d: number, f: [string, string][]) => setDraft({ ...draft, [d]: f });
  const dirty = JSON.stringify(draft) !== JSON.stringify(hours);
  const badDay = DAYS.find(([d]) => !validDay(draft[d] ?? []));
  async function save() {
    setBusy(true); setErr('');
    try { await api('/clinic/hours', { method: 'PUT', json: { hours: draft } }); reload(); toast('Horário de atendimento salvo'); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <section className="card hours">
      <div className="between"><h2>Horário de atendimento</h2>{isDefault && <span className="pill">Padrão</span>}</div>
      <p className="muted">A agenda só oferece estes horários. Cada dia aceita até 3 faixas (ex.: manhã e tarde).</p>
      <ul className="hours-list">
        {DAYS.map(([d, label]) => {
          const faixas = draft[d] ?? [];
          const open = faixas.length > 0;
          return (
            <li key={d} className={!validDay(faixas) ? 'bad' : ''}>
              <label className="day-switch">
                <input type="checkbox" checked={open} onChange={(e) => set(d, e.target.checked ? [['08:00', '11:00'], ['13:00', '18:00']] : [])} />
                <b title={label}>{label.slice(0, 3)}</b>{!open && <span className="muted">fechado</span>}
              </label>
              {open && (
                <div className="faixas">
                  {faixas.map(([s, e], i) => (
                    <div key={i} className="faixa">
                      <select aria-label={`${label}: início da faixa ${i + 1}`} value={s} onChange={(ev) => set(d, faixas.map((f, j) => (j === i ? [ev.target.value, f[1]] : f)) as [string, string][])}>{TIMES.map((x) => <option key={x}>{x}</option>)}</select>
                      <span aria-hidden="true">–</span>
                      <select aria-label={`${label}: fim da faixa ${i + 1}`} value={e} onChange={(ev) => set(d, faixas.map((f, j) => (j === i ? [f[0], ev.target.value] : f)) as [string, string][])}>{TIMES.map((x) => <option key={x}>{x}</option>)}</select>
                      <button className="icon-btn" aria-label={`Remover faixa ${i + 1} de ${label}`} onClick={() => set(d, faixas.filter((_, j) => j !== i))}><Icon name="close" size={18} /></button>
                    </div>
                  ))}
                  {faixas.length < 3 && <button className="icon-btn add" aria-label={`Adicionar faixa em ${label}`} title="Adicionar faixa" onClick={() => set(d, [...faixas, ['14:00', '18:00']])}><Icon name="plus" size={16} /></button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {badDay && <p role="alert" className="err">Confira {badDay[1].toLowerCase()}: o fim precisa ser depois do início e as faixas não podem se sobrepor.</p>}
      {err && <p role="alert" className="err">{err}</p>}
      <div className="actions">
        <button className="primary" disabled={busy || !dirty || !!badDay} onClick={save}>{busy ? 'Salvando…' : 'Salvar horário'}</button>
        <button className="ghost" onClick={() => { const seg = JSON.stringify(draft[1] ?? []); setDraft({ ...draft, 2: JSON.parse(seg), 3: JSON.parse(seg), 4: JSON.parse(seg), 5: JSON.parse(seg) }); }}>Copiar segunda para terça a sexta</button>
        <button className="ghost" onClick={() => setDraft(clone(DEFAULT_HOURS))}>Restaurar padrão</button>
      </div>
    </section>
  );
}
