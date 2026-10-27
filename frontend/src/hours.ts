import { useLoad } from './hooks';

// Horário de atendimento da clínica, por dia da semana (0 = domingo … 6 = sábado), em faixas "HH:MM".
export type Hours = Record<string, [string, string][]>;

const WORK: [string, string][] = [['08:00', '11:00'], ['13:00', '18:00']];
export const DEFAULT_HOURS: Hours = { 0: [], 1: WORK, 2: WORK, 3: WORK, 4: WORK, 5: WORK, 6: [] };

const pad = (n: number) => String(n).padStart(2, '0');
export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
export const fromMin = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// Enquanto carrega, usa o padrão, para a tela nunca ficar sem horários.
export function useHours() {
  const l = useLoad<{ hours: Hours; isDefault: boolean }>('/clinic/hours');
  return { hours: l.data?.hours ?? DEFAULT_HOURS, loaded: !!l.data, isDefault: l.data?.isDefault ?? true, reload: l.reload };
}

export const dayIntervals = (h: Hours, d: Date): [number, number][] => (h[String(d.getDay())] ?? []).map(([s, e]) => [toMin(s), toMin(e)]);
export const slotsOf = (iv: [number, number][]) => iv.flatMap(([s, e]) => Array.from({ length: Math.max(0, (e - s) / 30) }, (_, i) => fromMin(s + i * 30)));
