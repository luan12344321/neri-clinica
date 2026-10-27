import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    api<T>(path).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}
