import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { SystemBanners, offerUpdate } from './StatusPage';
import './styles.css';

// Versão nova: avisa e espera o "Atualizar" (recarregar sozinho apagaria um cadastro em andamento). Procura versão nova a cada hora.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => offerUpdate(() => updateSW(true)),
  onRegisteredSW: (_url, r) => { if (r) setInterval(() => r.update().catch(() => {}), 60 * 60_000); },
});
createRoot(document.getElementById('root')!).render(<><App /><SystemBanners /></>);
