const KEY = 'clinica.token';
export const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* storage bloqueado */ }
};

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && path !== '/auth/login') { setToken(null); location.reload(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Erro inesperado');
  return data as T;
}

export const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const monthLabel = (ym: string) =>
  new Date(`${ym}-15`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
export const thisMonth = () => new Date().toISOString().slice(0, 7);

// Os últimos `n` meses (YYYY-MM) até `end`, do mais antigo ao mais recente.
export const lastMonths = (n: number, end = thisMonth()) => {
  const [y, m] = end.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y!, m! - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
};
