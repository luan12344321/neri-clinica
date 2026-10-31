import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, api, getToken } from './api';
import { AddForm, errText } from './Cadastros';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { ConfirmButton, Empty, ListSkeleton, Sheet, useRole, useToast } from './ui';

// ---------- Verificação em duas etapas (dono e gerente) ----------
type MfaState = { enabled: boolean; pending: boolean; recoveryCodesLeft: number };

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  async function copy() { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* sem permissão */ } }
  function save() {
    const url = URL.createObjectURL(new Blob([`Códigos de recuperação (cada um vale uma vez)\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = 'codigos-de-recuperacao.txt'; a.click(); URL.revokeObjectURL(url);
  }
  return (
    <>
      <p className="muted"><b>Guarde estes 10 códigos agora.</b> Eles só aparecem esta vez. Se você perder o celular, cada código entra uma vez no lugar do código do aplicativo.</p>
      <ul className="recovery-codes" aria-label="Códigos de recuperação">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="actions">
        <button className="ghost" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} />{copied ? 'Copiado' : 'Copiar'}</button>
        <button className="ghost" onClick={save}>Baixar arquivo</button>
        <button className="primary" onClick={onClose}>Já guardei os códigos</button>
      </div>
    </>
  );
}

export function MfaCard() {
  const s = useLoad<MfaState>('/me/mfa');
  const [mode, setMode] = useState<null | 'on' | 'off' | 'codes'>(null);
  const done = () => { setMode(null); s.reload(); };
  return (
    <section className="card">
      <h2>Verificação em duas etapas</h2>
      {!s.data ? (s.error ? <p role="alert" className="err">{s.error}</p> : <ListSkeleton rows={1} />) : (
        <>
          <p className="muted">
            {s.data.enabled
              ? `Ligada. Além da senha, o login pede um código do aplicativo autenticador. Códigos de recuperação restantes: ${s.data.recoveryCodesLeft}.`
              : 'Desligada. Recomendado para quem acessa financeiro e prontuários: além da senha, o login pede um código de 6 dígitos de um aplicativo autenticador no celular.'}
          </p>
          <div className="actions">
            {!s.data.enabled && <button className="primary" onClick={() => setMode('on')}>Ativar</button>}
            {s.data.enabled && <button className="ghost" onClick={() => setMode('codes')}>Gerar novos códigos de recuperação</button>}
            {s.data.enabled && <button className="ghost danger" onClick={() => setMode('off')}>Desativar</button>}
          </div>
        </>
      )}
      {mode === 'on' && <Enroll onClose={done} />}
      {mode === 'off' && (
        <Sheet title="Desativar verificação em duas etapas" onClose={() => setMode(null)}>
          <AddForm label="Desativar" fields={[
            { name: 'password', label: 'Sua senha', type: 'password', required: true },
            { name: 'code', label: 'Código do aplicativo (6 dígitos) ou de recuperação', required: true },
          ]} onSubmit={async (v) => { await api('/me/mfa/disable', { method: 'POST', json: v }); done(); }} />
        </Sheet>
      )}
      {mode === 'codes' && <NewCodes onClose={done} />}
    </section>
  );
}

function NewCodes({ onClose }: { onClose: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <Sheet title="Novos códigos de recuperação" onClose={() => (codes ? undefined : onClose())}>
      {codes ? <RecoveryCodes codes={codes} onClose={onClose} /> : (
        <>
          <p className="muted">Os códigos antigos deixam de valer.</p>
          <AddForm label="Gerar códigos" fields={[
            { name: 'password', label: 'Sua senha', type: 'password', required: true },
            { name: 'code', label: 'Código do aplicativo (6 dígitos)', required: true },
          ]} onSubmit={async (v) => { const r = await api<{ recoveryCodes: string[] }>('/me/mfa/recovery-codes', { method: 'POST', json: v }); setCodes(r.recoveryCodes); }} />
        </>
      )}
    </Sheet>
  );
}

function Enroll({ onClose }: { onClose: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const svg = setup ? (() => { const q = qrcode(0, 'M'); q.addData(setup.otpauthUrl); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); })() : '';
  return (
    // com os códigos na tela a janela não fecha sozinha: fechar sem guardá-los trancaria a pessoa fora se perder o celular
    <Sheet title="Ativar verificação em duas etapas" onClose={() => (codes ? undefined : onClose())}>
      {codes ? <RecoveryCodes codes={codes} onClose={onClose} /> : !setup ? (
        <>
          <p className="muted">Você vai precisar de um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).</p>
          <AddForm label="Continuar" fields={[{ name: 'password', label: 'Sua senha', type: 'password', required: true }]}
            onSubmit={async (v) => setSetup(await api('/me/mfa/setup', { method: 'POST', json: v }))} />
        </>
      ) : (
        <>
          <p className="muted">1. No aplicativo, escaneie o QR Code. 2. Digite o código de 6 dígitos que ele mostrar.</p>
          <div className="qr" role="img" aria-label="QR Code para o aplicativo autenticador" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="muted center">Sem câmera? Digite esta chave no aplicativo: <code>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
          <AddForm label="Ativar" fields={[{ name: 'code', label: 'Código de 6 dígitos', numeric: true, required: true }]}
            onSubmit={async (v) => { const r = await api<{ recoveryCodes: string[] }>('/me/mfa/enable', { method: 'POST', json: { code: String(v.code).replace(/\D/g, '') } }); setCodes(r.recoveryCodes); }} />
        </>
      )}
    </Sheet>
  );
}

// Dono: tirar a verificação de um gerente que perdeu o celular e os códigos.
export function ResetMfaButton({ memberId, onDone }: { memberId: string; onDone: (msg: string) => void }) {
  const [err, setErr] = useState('');
  return (
    <div>
      <ConfirmButton label="Redefinir verificação em duas etapas" confirm="Confirmar redefinição"
        text="Desliga a verificação em duas etapas desta pessoa (por exemplo, se ela perdeu o celular e os códigos). Ela entra só com a senha e pode ativar de novo."
        onConfirm={async () => { try { await api(`/team/${memberId}/mfa/reset`, { method: 'POST', json: {} }); onDone('Verificação redefinida'); } catch (e) { setErr(errText(e)); } }} />
      {err && <p role="alert" className="err">{err}</p>}
    </div>
  );
}

// ---------- Privacidade e dados pessoais (LGPD) ----------
type Row = { id: string; full_name: string };
type Retention = { retentionYears: number | null; decisionPending: boolean; candidates: { id: string; fullName: string; lastActivity: string }[] };

async function download(path: string, name: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? 'Erro inesperado');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function PrivacyCard() {
  const { isOwner } = useRole();
  const ret = useLoad<Retention>('/lgpd/retention');
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(term.trim()), 250); return () => clearTimeout(t); }, [term]);
  const found = useLoad<Row[]>(q.length >= 2 ? `/patients?search=${encodeURIComponent(q)}` : null);
  const [sel, setSel] = useState<Row | null>(null);
  const [years, setYears] = useState(false);
  const toast = useToast();
  return (
    <section className="card span-all">
      <h2>Privacidade e dados pessoais (LGPD)</h2>
      <p className="muted">Atenda pedidos do titular: baixar uma cópia dos dados, corrigir (na ficha do paciente), bloquear por obrigação legal e anonimizar. Cada ação fica registrada. Esta tela não substitui a orientação de um advogado.</p>
      <label className="search"><Icon name="search" size={18} /><input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar titular pelo nome (mín. 2 letras)" aria-label="Buscar titular" /></label>
      {q.length >= 2 && found.data?.length === 0 && <Empty icon="search" title="Nenhum paciente encontrado" text="Pacientes já anonimizados não aparecem na busca." />}
      <ul className="rows people">{found.data?.map((p) => (
        <li key={p.id}><button className="row-btn" onClick={() => setSel(p)}><span className="grow"><b>{p.full_name}</b></span><Icon name="arrow" size={18} /></button></li>
      ))}</ul>
      <h3>Prazo de guarda</h3>
      {!ret.data ? <ListSkeleton rows={1} /> : (
        <>
          <p className="muted">
            {ret.data.decisionPending
              ? 'Prazo não definido. Quanto tempo guardar prontuários e dados é decisão da clínica, com orientação jurídica; o sistema não assume nenhum prazo e nunca apaga nada sozinho.'
              : `Prazo definido: ${ret.data.retentionYears} ano(s) sem atividade. ${ret.data.candidates.length ? `${ret.data.candidates.length} paciente(s) passaram do prazo e aguardam sua revisão (nada foi apagado).` : 'Nenhum paciente passou do prazo.'}`}
          </p>
          {isOwner && <div className="actions"><button className="ghost" onClick={() => setYears(true)}>{ret.data.decisionPending ? 'Definir prazo' : 'Alterar prazo'}</button></div>}
          {ret.data.candidates.length > 0 && (
            <ul className="rows people">{ret.data.candidates.slice(0, 20).map((c) => (
              <li key={c.id}><button className="row-btn" onClick={() => setSel({ id: c.id, full_name: c.fullName })}><span className="grow"><b>{c.fullName}</b><span className="muted">última atividade em {new Date(c.lastActivity).toLocaleDateString('pt-BR')}</span></span></button></li>
            ))}</ul>
          )}
        </>
      )}
      {years && (
        <Sheet title="Prazo de guarda" onClose={() => setYears(false)}>
          <p className="muted">Informe só o prazo que sua assessoria jurídica indicou. Deixe em branco para voltar a “não definido”.</p>
          <AddForm label="Salvar" fields={[{ name: 'years', label: 'Anos sem atividade', numeric: true, def: ret.data?.retentionYears?.toString() ?? '' }]}
            onSubmit={async (v) => {
              const n = v.years == null ? '' : String(v.years).trim();
              await api('/lgpd/retention', { method: 'PUT', json: { retentionYears: n === '' ? null : Number(n) } });
              setYears(false); ret.reload(); toast('Prazo salvo');
            }} />
        </Sheet>
      )}
      {sel && <Titular row={sel} onClose={() => setSel(null)} onChanged={() => { ret.reload(); }} />}
    </section>
  );
}

function Titular({ row, onClose, onChanged }: { row: Row; onClose: () => void; onChanged: () => void }) {
  const { isOwner } = useRole();
  const st = useLoad<{ legalHold: { since: string; reason: string } | null; anonymizedAt: string | null }>(`/lgpd/patients/${row.id}`);
  const [view, setView] = useState<null | 'hold' | 'anon' | 'log'>(null);
  const [err, setErr] = useState('');
  const toast = useToast();
  async function run(fn: () => Promise<unknown>, ok: string) { setErr(''); try { await fn(); toast(ok); st.reload(); onChanged(); } catch (e) { setErr(errText(e)); } }
  return (
    <Sheet title={row.full_name} onClose={onClose}>
      {!st.data ? <ListSkeleton rows={2} /> : (
        <>
          {st.data.anonymizedAt && <p className="pill warn">Anonimizado em {new Date(st.data.anonymizedAt).toLocaleDateString('pt-BR')}</p>}
          {st.data.legalHold && <p className="pill warn">Retenção legal: {st.data.legalHold.reason}</p>}
          <div className="actions stack">
            <button className="ghost" onClick={() => run(() => download(`/lgpd/patients/${row.id}/export`, `titular-${row.id}.json`), 'Arquivo baixado')}>Baixar cópia dos dados (JSON)</button>
            {isOwner && <button className="ghost" onClick={() => setView('log')}>Ver quem acessou os dados</button>}
            {isOwner && !st.data.anonymizedAt && (st.data.legalHold
              ? <ConfirmButton label="Remover retenção legal" confirm="Confirmar remoção" text="Sem o bloqueio, este titular pode ser anonimizado." onConfirm={() => run(() => api(`/lgpd/patients/${row.id}/hold`, { method: 'DELETE' }), 'Bloqueio removido')} />
              : <button className="ghost" onClick={() => setView('hold')}>Marcar retenção legal</button>)}
            {isOwner && !st.data.anonymizedAt && !st.data.legalHold && <button className="ghost danger" onClick={() => setView('anon')}>Anonimizar titular…</button>}
          </div>
          {err && <p role="alert" className="err">{err}</p>}
        </>
      )}
      {view === 'hold' && (
        <Sheet title="Retenção legal" onClose={() => setView(null)}>
          <p className="muted">Enquanto houver retenção legal (ex.: processo, fiscalização), este titular não pode ser anonimizado.</p>
          <AddForm label="Marcar retenção" fields={[{ name: 'reason', label: 'Motivo (mín. 5 caracteres)', required: true }]}
            onSubmit={async (v) => { await api(`/lgpd/patients/${row.id}/hold`, { method: 'PUT', json: v }); setView(null); st.reload(); toast('Retenção marcada'); }} />
        </Sheet>
      )}
      {view === 'anon' && (
        <Sheet title="Anonimizar titular" onClose={() => setView(null)}>
          <p className="muted"><b>Não dá para desfazer.</b> Somem: nome, CPF, telefone, e-mail, nascimento, observações, autorizações de contato e mensagens pendentes. <b>Ficam</b>, por obrigação de guarda: prontuário, lançamentos financeiros, rastreabilidade de lotes e a trilha de auditoria. Cópias de segurança, comprovantes em PDF já emitidos e dados já enviados a terceiros (Google, WhatsApp, Asaas) não são alterados. Confirme com sua assessoria jurídica antes.</p>
          <AddForm label="Anonimizar definitivamente" fields={[
            { name: 'confirmName', label: `Digite o nome exato: ${row.full_name}`, required: true },
            { name: 'acknowledge', label: 'Entendi que não dá para desfazer e que o prontuário continua guardado', type: 'checkbox', required: true },
          ]} onSubmit={async (v) => {
            await api(`/lgpd/patients/${row.id}/anonymize`, { method: 'POST', json: { confirmName: v.confirmName, acknowledge: v.acknowledge === true ? true : undefined } });
            setView(null); st.reload(); onChanged(); toast('Titular anonimizado');
          }} />
        </Sheet>
      )}
      {view === 'log' && <AccessLog id={row.id} onClose={() => setView(null)} />}
    </Sheet>
  );
}

function AccessLog({ id, onClose }: { id: string; onClose: () => void }) {
  const l = useLoad<{ action: string; createdAt: string; userName: string | null; ip: string | null }[]>(`/lgpd/patients/${id}/access-log`);
  return (
    <Sheet title="Quem acessou os dados" onClose={onClose}>
      {!l.data ? (l.error ? <p role="alert" className="err">{l.error}</p> : <ListSkeleton rows={3} />) : l.data.length === 0 ? <Empty icon="check" title="Nenhum acesso registrado" /> : (
        <ul className="rows">{l.data.map((r, i) => (
          <li key={i} className="row-btn static"><span className="grow"><b>{r.action}</b><span className="muted">{r.userName ?? 'sistema'} · {new Date(r.createdAt).toLocaleString('pt-BR')}</span></span></li>
        ))}</ul>
      )}
    </Sheet>
  );
}
