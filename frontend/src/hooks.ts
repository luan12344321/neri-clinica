import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

// O servidor responde com códigos em inglês ("Rate limit exceeded...", "internal error"); a tela mostra o motivo em português.
// 'forbidden' segue como código: telas checam esse valor para explicar a falta de permissão.
const loadErr = (e: unknown) =>
  !(e instanceof ApiError) ? (navigator.onLine ? 'Sem conexão com o servidor. Tente de novo em instantes.' : 'Você está sem internet. Confira a conexão e tente de novo.')
  : e.status === 403 ? e.message
  : e.status === 429 ? 'Muitas consultas seguidas. Aguarde alguns segundos e abra a tela de novo.'
  : e.status === 404 || e.status === 410 ? 'Este item não existe mais. Ele pode ter sido removido por outra pessoa da equipe.'
  : e.status >= 500 ?'O servidor não respondeu. Tente de novo em instantes.'
  : 'Não foi possível carregar estas informações.';

// `path` nulo = não carrega. `every` (ms) recarrega periodicamente enquanto a aba está visível.
export function useLoad<T>(path: string | null, every?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const current = useRef(path);
  current.current = path;
  const reload = useCallback(() => {
    if (path === null) return;
    // resposta de um caminho antigo (ex.: semana anterior da Agenda, clicada rápido) chega depois e é descartada
    api<T>(path).then((d) => { if (current.current === path) { setData(d); setError(''); } })
      .catch((e) => { if (current.current === path) setError(loadErr(e)); });
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!every || path === null) return;
    const tick = () => { if (document.visibilityState === 'visible') reload(); };
    const id = setInterval(tick, every);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [every, path, reload]);
  return { data, error, reload };
}
