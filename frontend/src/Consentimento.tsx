import { useState } from 'react';
import { ApiError, api } from './api';
import { useLoad } from './hooks';
import { Sheet, useToast } from './ui';

// Autorização de contato por finalidade (LGPD). Cada alteração cria um NOVO registro no histórico; o último vale.
// "Retorno" é uma autorização própria: não vem de aniversário nem de marketing.
type Purpose = 'return' | 'birthday' | 'marketing';
type Entry = { granted: boolean; recordedAt: string } | null;
type Consents = Record<Purpose, Entry>;

const PURPOSES: { id: Purpose; label: string; hint: string }[] = [
  { id: 'return', label: 'Lembrete de retorno', hint: 'Convite para avaliação de retorno, enviado por uma pessoa da equipe.' },
  { id: 'birthday', label: 'Mensagem de aniversário', hint: 'Parabéns no dia do aniversário.' },
  { id: 'marketing', label: 'Novidades e campanhas', hint: 'Comunicados da clínica.' },
];

const fmt = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function ConsentimentoPaciente({ patientId, onChange }: { patientId: string; onChange?: () => void }) {
  const { data, error, reload } = useLoad<Consents>(`/patients/${patientId}/consents`);
  const toast = useToast();
  const [busy, setBusy] = useState<Purpose | ''>('');

  async function flip(purpose: Purpose, granted: boolean) {
    setBusy(purpose);
    try {
      await api(`/patients/${patientId}/consents`, { method: 'PUT', json: { purpose, granted } });
      toast(granted ? 'Autorização registrada.' : 'Autorização retirada.');
      reload(); onChange?.();
    } catch (e) {
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível salvar. Tente de novo.');
    } finally { setBusy(''); }
  }

  if (error) return <p className="err" role="alert">Não foi possível carregar as autorizações.</p>;
  if (!data) return <p className="muted" role="status">Carregando autorizações…</p>;
  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Autorização de contato</h3>
      <p className="muted" style={{ marginBottom: 8 }}>Cada mudança é guardada no histórico, com data.</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {PURPOSES.map((p) => {
          const e = data[p.id];
          const on = e?.granted === true;
          return (
            <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 56, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <b id={`cons-${p.id}-${patientId}`}>{p.label}</b>
                <span className="muted" style={{ display: 'block' }}>{p.hint}</span>
                <span className="muted" style={{ display: 'block' }}>{e ? `${on ? 'Autorizado' : 'Não autorizado'} em ${fmt(e.recordedAt)}` : 'Sem registro'}</span>
              </div>
              <button
                role="switch" aria-checked={on} aria-labelledby={`cons-${p.id}-${patientId}`} disabled={busy === p.id}
                onClick={() => flip(p.id, !on)}
                style={{ minWidth: 56, minHeight: 44, padding: '0 6px', border: 0, background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
              >
                <span aria-hidden="true" style={{ width: 48, height: 28, borderRadius: 99, background: on ? 'var(--accent)' : 'var(--line)', position: 'relative', transition: 'background .15s' }}>
                  <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 22, height: 22, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Folha pronta para abrir direto da fila de retornos ("Registrar autorização").
export function ConsentimentoSheet({ patientId, patientName, onClose, onDone }: { patientId: string; patientName: string; onClose: () => void; onDone?: () => void }) {
  return (
    <Sheet title={`Autorização de ${patientName.split(/\s+/)[0]}`} onClose={() => { onDone?.(); onClose(); }}>
      <ConsentimentoPaciente patientId={patientId} onChange={onDone} />
    </Sheet>
  );
}
