import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Sheet, useInstall } from './ui';

type Item = { id: string; icon: IconName; label: string };

// Barra de navegação flutuante (celular). No centro, o "+" abre as ações rápidas.
export function BottomNav({ view, isManager, go, onQuick, onMenu }: { view: string; isManager: boolean; go: (v: any) => void; onQuick: () => void; onMenu: () => void }) {
  const left: Item[] = [{ id: 'inicio', icon: 'home', label: 'Início' }, { id: 'agenda', icon: 'calendar', label: 'Agenda' }];
  const right: Item[] = isManager
    ? [{ id: 'financeiro', icon: 'chart', label: 'Financeiro' }, { id: 'sara', icon: 'spark', label: 'Julia' }]
    : [{ id: 'pacientes', icon: 'users', label: 'Pacientes' }, { id: 'menu', icon: 'menu', label: 'Menu' }];
  const btn = (i: Item) => (
    <button key={i.id} className="bn-item" aria-current={view === i.id ? 'page' : undefined} onClick={() => (i.id === 'menu' ? onMenu() : go(i.id))}>
      <span><Icon name={i.icon} size={22} /></span><i>{i.label}</i>
    </button>
  );
  return (
    <nav className="bottom-nav" aria-label="Navegação principal">
      {left.map(btn)}
      <button className="bn-plus" aria-label="Ações rápidas" onClick={onQuick}><Icon name="plus" size={26} /></button>
      {right.map(btn)}
    </nav>
  );
}

export type QuickAction = { icon: IconName; title: string; hint: string; run: () => void };

export function QuickSheet({ actions, onClose }: { actions: QuickAction[]; onClose: () => void }) {
  return (
    <Sheet title="O que você quer fazer?" onClose={onClose}>
      <ul className="quick-list">{actions.map((a) => (
        <li key={a.title}>
          <button onClick={() => { onClose(); a.run(); }}>
            <span className="q-ico"><Icon name={a.icon} size={22} /></span>
            <span className="grow"><b>{a.title}</b><span className="muted">{a.hint}</span></span>
            <Icon name="back" size={18} />
          </button>
        </li>
      ))}</ul>
    </Sheet>
  );
}

// Abertura do app (uma vez por sessão): marca da clínica sobre o verde.
export function Splash() {
  const [show, setShow] = useState(() => { try { return sessionStorage.getItem('clinica.splash') !== '1'; } catch { return false; } });
  useEffect(() => {
    if (!show) return;
    try { sessionStorage.setItem('clinica.splash', '1'); } catch { /* storage bloqueado */ }
    const t = setTimeout(() => setShow(false), 1100);
    return () => clearTimeout(t);
  }, [show]);
  if (!show) return null;
  return (
    <div className="splash" aria-hidden="true">
      <img className="splash-logo" src="/neri-logo.png" alt="" />
      <span>Gestão da clínica na palma da mão</span>
    </div>
  );
}

// "Instalar app" na barra superior: só aparece quando o navegador permite instalar (ou no iPhone, com o passo a passo) e o app ainda não está instalado.
export function InstallPill() {
  const { installed, canPrompt, ios, install } = useInstall();
  const [help, setHelp] = useState(false);
  if (installed || !(canPrompt || ios)) return null;
  return (
    <>
      <button className="install-pill" aria-label="Instalar aplicativo no celular" onClick={() => (canPrompt ? install() : setHelp(true))}>
        <Icon name="download" size={18} /><span>Instalar app</span>
      </button>
      {help && (
        <Sheet title="Instalar no iPhone" onClose={() => setHelp(false)}>
          <ol className="steps">
            <li>Abra este site no <b>Safari</b>.</li>
            <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima).</li>
            <li>Escolha <b>Adicionar à Tela de Início</b>.</li>
          </ol>
        </Sheet>
      )}
    </>
  );
}
