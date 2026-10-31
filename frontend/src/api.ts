import { markExpired } from './StatusPage';

const KEY = 'clinica.token';
export const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* storage bloqueado */ }
};

export class ApiError extends Error { constructor(public status: number, msg: string, public detail?: string) { super(msg); } }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // Content-Type só com corpo: o servidor recusa (400) DELETE sem corpo marcado como JSON
    headers: { ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(getToken()? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/mfa') { markExpired(); setToken(null); location.reload(); } // a tela de entrada explica que a sessão expirou
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Erro inesperado', data.detail);
  return data as T;
}

export const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const monthLabel = (ym: string) =>
  new Date(`${ym}-15`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
// Dia de São Paulo (AAAA-MM-DD), não UTC: depois das 21h o UTC já seria amanhã (e no último dia, o mês seguinte).
export const dayISO = (plusDays = 0) => new Date(Date.now() + plusDays * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
export const thisMonth = () => dayISO().slice(0, 7);
