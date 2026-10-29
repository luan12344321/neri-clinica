import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

// O servidor responde com códigos em inglês ("Rate limit exceeded...", "internal error"); a tela mostra o motivo em português.
// 'forbidden' segue como código: telas checam esse valor para explicar a falta de permissão.
const loadErr = (e: unknown) =>
  !(e instanceof ApiError) ? 'Sem conexão com o servidor. Confira a internet e tente de novo.'
  : e.status === 403 ? e.message
  : e.status === 429 ? 'Muitas consultas seguidas. Aguarde alguns segundos e abra a tela de novo.'
  : e.status >= 500 ? 'O servidor não respondeu. Tente de novo em instantes.'
  : 'Não foi possível carregar estas informações.';

// `path` nulo = não carrega. `every` (ms) recarrega periodicamente enquanto a aba está visível.
export function useLoad<T>(path: string | null, every?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (path === null) return;
    api<T>(path).then((d) => { setData(d); setError(''); }).catch((e) => setError(loadErr(e)));
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
