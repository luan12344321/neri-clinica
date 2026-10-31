import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { SystemBanners, offerUpdate } from './StatusPage';
import './styles.css';

// Versão nova: aplica sozinha assim que for seguro. Não é seguro com uma janela aberta ou texto digitado num campo,
// porque recarregar apagaria o cadastro em andamento: nesse caso mostra o aviso "Atualizar" e aplica quando a tela ficar livre.
const safeToReload = () => !document.querySelector('[role="dialog"]')
  && ![...document.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=radio]):not([type=date]):not([type=month]):not([type=time]):not([type=range]), textarea')].some((el) => el.value);
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => {
    if (safeToReload()) return void updateSW(true);
    offerUpdate(() => updateSW(true));
    const wait = setInterval(() => { if (safeToReload()) { clearInterval(wait); void updateSW(true); } }, 5_000);
  },
  // procura versão nova a cada 5 minutos e sempre que o app volta para a frente
  onRegisteredSW: (_url, r) => {
    if (!r) return;
    const check = () => r.update().catch(() => {});
    setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  },
});
createRoot(document.getElementById('root')!).render(<><App /><SystemBanners /></>);
