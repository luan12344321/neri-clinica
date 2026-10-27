import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// `path` nulo = não carrega. `every` (ms) recarrega periodicamente enquanto a aba está visível.
export function useLoad<T>(path: string | null, every?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (path === null) return;
    api<T>(path).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
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
