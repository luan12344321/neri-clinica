import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

// ---------- Aviso rápido (toast) ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const push = useCallback((m: string) => {
    setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(''), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">{msg && <div className="toast"><Icon name="check" size={18} />{msg}</div>}</div>
    </ToastCtx.Provider>
  );
}

// ---------- Janela de formulário (sobe de baixo no celular, centralizada no desktop) ----------
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
    return () => { removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="sheet-wrap">
      <div className="scrim" onClick={onClose} />
      <section ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" aria-label="Fechar" onClick={onClose}><Icon name="close" /></button></header>
        {children}
      </section>
    </div>
  );
}

// ---------- Cabeçalho de página com ação principal ----------
export const PageHead = ({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) => (
  <div className="page-head">
    <div><h2>{title}</h2>{hint && <p className="muted">{hint}</p>}</div>
    <div className="page-actions">{children}</div>
  </div>
);

// ---------- Carregamento e estado vazio ----------
export const ListSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="skel-list" aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => <div key={i} className="skel-row"><i /><div><b /><b /></div></div>)}
  </div>
);

export const Empty = ({ icon, title, text, children }: { icon: IconName; title: string; text?: string; children?: ReactNode }) => (
  <div className="empty"><span><Icon name={icon} size={26} /></span><b>{title}</b>{text && <p className="muted">{text}</p>}{children}</div>
);

// ---------- Avatar com iniciais e cor estável por nome ----------
export function Avatar({ name, size = 42 }: { name: string; size?: number }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 6 + 1;
  return <span className="av" style={{ width: size, height: size, background: `var(--c${hue})`, fontSize: size * 0.36 }} aria-hidden="true">{ini}</span>;
}

// ---------- Perfil do usuário logado ----------
export type Role = 'owner' | 'manager' | 'professional' | 'reception';
export const ROLE_LABEL: Record<Role, string> = { owner: 'Proprietário(a)', manager: 'Gerente', professional: 'Profissional', reception: 'Recepção' };
type RoleInfo = { role: Role | null; isManager: boolean; isOwner: boolean };
const RoleCtx = createContext<RoleInfo>({ role: null, isManager: false, isOwner: false });
export const useRole = () => useContext(RoleCtx);
export const RoleProvider = ({ role, children }: { role: Role | null; children: ReactNode }) => (
  <RoleCtx.Provider value={{ role, isManager: role === 'owner' || role === 'manager', isOwner: role === 'owner' }}>{children}</RoleCtx.Provider>
);

// ---------- Instalação como aplicativo (PWA) ----------
// O navegador dispara beforeinstallprompt uma vez, cedo; guardamos o evento fora do React para não perdê-lo.
let deferred: any = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  addEventListener('appinstalled', () => { deferred = null; notify(); });
}
const standalone = () => typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);

export function useInstall() {
  const canPrompt = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => !!deferred);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed = standalone();
  const install = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; notify(); };
  return { installed, canPrompt, ios, install };
}

// ---------- Ocultar valores (olhinho) ----------
const HIDE_KEY = 'clinica.hideValues';
let hidden = (() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } })();
const hideSubs = new Set<() => void>();
export function useHideValues() {
  const value = useSyncExternalStore((cb) => { hideSubs.add(cb); return () => hideSubs.delete(cb); }, () => hidden);
  const toggle = () => { hidden = !hidden; try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0'); } catch { /* storage bloqueado */ } hideSubs.forEach((f) => f()); };
  return { hidden: value, toggle };
}
export const mask = (text: string, hide: boolean) => (hide ? 'R$ ••••••' : text);
export const EyeToggle = ({ className = '' }: { className?: string }) => {
  const { hidden, toggle } = useHideValues();
  return <button className={`eye ${className}`} aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} aria-pressed={hidden} onClick={toggle}><Icon name={hidden ? 'eyeoff' : 'eye'} size={20} /></button>;
};

// ---------- Abas em pílula ----------
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="seg2" role="tablist">
      {options.map((o) => <button key={o.id} role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

// Última barreira: se uma tela falhar ao desenhar, mostra um aviso com "Recarregar" em vez de deixar a tela em branco.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash" role="alert">
        <b>Algo deu errado nesta tela.</b>
        <p className="muted">Seus dados estão salvos. Toque para recarregar.</p>
        <button className="primary" onClick={() => location.reload()}>Recarregar</button>
      </div>
    );
  }
}
