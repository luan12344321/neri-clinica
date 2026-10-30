import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Mascote, { type Mood } from './Mascote';
import { Icon } from './Icon';
import './status.css';

// Páginas de erro e avisos do sistema, sempre com a Julia explicando o que houve e o que fazer em seguida.
export type StatusKind = 'notfound' | 'forbidden' | 'crash' | 'update' | 'unavailable' | 'offline';

const COPY: Record<StatusKind, { mood: Mood; title: string; text: string; code?: string }> = {
  notfound: { mood: 'think', code: '404', title: 'Não encontrei esta página',
    text: 'O endereço pode ter sido digitado errado ou a tela mudou de lugar. Nada do que você salvou foi afetado.' },
  forbidden: { mood: 'think', code: '403', title: 'Esta área é restrita',
    text: 'Seu perfil não tem acesso a esta tela. Se precisar dela, peça ao proprietário para ajustar seu acesso em Configurações → Equipe.' },
  crash: { mood: 'sad', code: '500', title: 'Algo deu errado nesta tela',
    text: 'O problema já foi registrado para a equipe técnica. O que você salvou antes continua guardado.' },
  update: { mood: 'wave', title: 'Saiu uma versão nova do sistema',
    text: 'Esta tela foi atualizada enquanto o app estava aberto. Recarregue para continuar com a versão nova.' },
  unavailable: { mood: 'sad', code: '503', title: 'O servidor não está respondendo',
    text: 'Pode ser uma manutenção ou uma instabilidade passageira. Seus dados estão guardados; tente de novo em alguns minutos.' },
  offline: { mood: 'sad', title: 'Você está sem internet',
    text: 'Confira o Wi-Fi ou os dados móveis. Assim que a conexão voltar, tente de novo.' },
};

// Falha ao baixar um pedaço do app (deploy novo enquanto a aba estava aberta): não é bug, é versão velha.
export const isStaleChunk = (e: unknown) => /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(String((e as Error)?.message ?? e));

export const goHome = () => { history.replaceState(null, '', '#/inicio'); dispatchEvent(new HashChangeEvent('hashchange')); };

export function StatusPage({ kind, onRetry, children }: { kind: StatusKind; onRetry?: () => void; children?: ReactNode }) {
  const c = COPY[kind];
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, [kind]); // leitor de tela anuncia o título ao trocar de tela
  const reload = () => location.reload();
  return (
    <section className="status-page" aria-labelledby="status-title">
      <Mascote mood={c.mood} size={148} label="Julia, a assistente" />
      <h2 id="status-title" ref={title} tabIndex={-1}>{c.title}</h2>
      <p>{c.text}</p>
      <div className="status-actions">
        {kind === 'notfound' && <><button className="primary" onClick={goHome}>Ir para o Início</button>{history.length > 1 && <button className="ghost" onClick={() => history.back()}>Voltar</button>}</>}
        {kind === 'forbidden' && <button className="primary" onClick={goHome}>Ir para o Início</button>}
        {(kind === 'crash' || kind === 'update') && <button className="primary" onClick={reload}>Recarregar</button>}
        {(kind === 'unavailable' || kind === 'offline') && <button className="primary" onClick={onRetry ?? reload}>Tentar de novo</button>}
        {children}
      </div>
      {c.code && <p className="status-code">Código do erro: {c.code}</p>}
    </section>
  );
}

// ---------- Conexão ----------
const onNet = (cb: () => void) => { addEventListener('online', cb); addEventListener('offline', cb); return () => { removeEventListener('online', cb); removeEventListener('offline', cb); }; };
export const useOnline = () => useSyncExternalStore(onNet, () => navigator.onLine);

// ---------- Nova versão (service worker) ----------
let applyUpdate: (() => void) | null = null;
const updSubs = new Set<() => void>();
export const offerUpdate = (apply: () => void) => { applyUpdate = apply; updSubs.forEach((f) => f()); };
const useUpdate = () => useSyncExternalStore((cb) => { updSubs.add(cb); return () => updSubs.delete(cb); }, () => applyUpdate);

// Avisos que valem para o app inteiro: sem internet, conexão de volta e versão nova disponível.
// A versão nova não recarrega sozinha: recarregar no meio de um cadastro apagaria o que foi digitado.
export function SystemBanners() {
  const online = useOnline();
  const update = useUpdate();
  const [later, setLater] = useState(false);
  const [back, setBack] = useState(false);
  const was = useRef(online);
  useEffect(() => {
    if (online && !was.current) { setBack(true); const t = setTimeout(() => setBack(false), 3500); was.current = online; return () => clearTimeout(t); }
    was.current = online;
  }, [online]);
  return (
    <div className="sys-banners" role="status" aria-live="polite">
      {!online && <div className="sys-banner"><Icon name="alert" size={18} /><span>Sem internet. O que já está aberto continua visível, mas nada será salvo até a conexão voltar.</span></div>}
      {online && back && <div className="sys-banner ok"><Icon name="check" size={18} /><span>Conexão de volta.</span></div>}
      {update && !later && (
        <div className="sys-banner">
          <span>Versão nova do sistema disponível.</span>
          <button className="sys-btn" onClick={update}>Atualizar</button>
          <button className="sys-btn quiet" onClick={() => setLater(true)}>Depois</button>
        </div>
      )}
    </div>
  );
}

// Aviso na tela de entrada quando a sessão expirou (o servidor recusou o acesso e o app voltou para o login).
const EXPIRED = 'clinica.expired';
export const markExpired = () => { try { sessionStorage.setItem(EXPIRED, '1'); } catch { /* storage bloqueado */ } };
export function SessionExpiredNote() {
  const [show] = useState(() => { try { const v = sessionStorage.getItem(EXPIRED) === '1'; sessionStorage.removeItem(EXPIRED); return v; } catch { return false; } });
  if (!show) return null;
  return (
    <div className="expired-note" role="status">
      <Mascote variant="head" mood="think" size={44} label="Julia" />
      <p><b>Sua sessão expirou.</b> Por segurança, entre de novo para continuar de onde parou.</p>
    </div>
  );
}
