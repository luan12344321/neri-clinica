import { useState } from 'react';
import { ApiError, api } from './api';
import { AddForm, errText, type Field } from './Cadastros';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { seenText, usePresence } from './Presence';
import { Avatar, Empty, ListSkeleton, PageHead, ROLE_LABEL, Sheet, useInstall, useRole, useToast, type Role } from './ui';

export type Me = { name: string; email: string; role: Role; clinic: string };
type Member = { id: string; name: string; email: string; role: Role; revoked: boolean };

const ROLE_HINT: Record<Exclude<Role, 'owner'>, string> = {
  manager: 'Tudo, menos gerenciar a equipe: financeiro, estoque, cadastros, mensagens e a Julia.',
  professional: 'Agenda, pacientes e prontuário. Não vê o financeiro.',
  reception: 'Agenda e cadastro de pacientes. Não vê financeiro nem prontuário.',
};
const ROLE_OPTIONS = (Object.keys(ROLE_HINT) as (keyof typeof ROLE_HINT)[]).map((value) => ({ value, label: ROLE_LABEL[value] }));

export function Settings({ me }: { me: Me | null }) {
  const { isOwner } = useRole();
  return (
    <div className="dash settings">
      <div className="span-all"><PageHead title="Configurações" hint={me?.clinic} /></div>
      <Account me={me} />
      <InstallCard />
      {isOwner && <Team />}
      {isOwner && <AssistantCard />}
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
      <p className="muted">Confira se a Julia está conectada à inteligência artificial. Use depois de adicionar créditos na conta da Anthropic.</p>
      <div className="actions"><button className="ghost" disabled={state === 'busy'} onClick={test}>{state === 'busy' ? 'Testando…' : 'Testar conexão'}</button></div>
      {state === 'ok' && <p className="ok-text" role="status"><Icon name="check" size={16} /> Tudo certo: a Julia está respondendo.</p>}
      {state === 'down' && <p role="alert" className="err">Sem conexão com a IA. Verifique se a conta da Anthropic tem crédito e se a chave (ANTHROPIC_API_KEY) está correta no Netlify.</p>}
      {state === 'error' && <p role="alert" className="err">Não foi possível testar agora. Tente novamente em instantes.</p>}
    </section>
  );
}
