import { useState } from 'react';
import { getToken } from './api';
import { useLoad } from './hooks';

// Baixa o PDF com fetch autenticado (Authorization no cabeçalho): sem link público e sem token na URL.
// O blob fica só na memória do navegador e a URL temporária é revogada logo depois do download.
async function baixar(documentId: string) {
  const token = getToken();
  const res = await fetch(`/api/traceability/${encodeURIComponent(documentId)}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'Seu perfil não pode ver este comprovante.' : 'Não foi possível baixar o comprovante.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'comprovante-rastreabilidade.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BTN: React.CSSProperties = {
  minHeight: 44, minWidth: 44, padding: '0 16px', borderRadius: 10, border: '1px solid #2f5d46',
  background: '#2f5d46', color: '#fff', fontWeight: 600, cursor: 'pointer',
};

export function ComprovanteButton({ documentId }: { documentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await baixar(documentId); } catch (e: any) { setError(e.message || 'Erro ao baixar o comprovante.'); }
    setBusy(false);
  };
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" style={{ ...BTN, opacity: busy ? 0.7 : 1 }} onClick={go} disabled={busy} aria-busy={busy}>
        {busy ? 'Baixando…' : 'Comprovante (PDF)'}
      </button>
      {error && <span role="alert" style={{ color: '#a4472f', fontSize: 13 }}>{error}</span>}
    </span>
  );
}

export function ComprovantesDoPaciente({ patientId }: { patientId: string }) {
  const docs = useLoad<{ id: string; created_at: string }[]>(`/patients/${patientId}/traceability`);
  if (docs.error || !docs.data || docs.data.length === 0) return null; // sem comprovantes: nada a mostrar
  return (
    <section className="card">
      <h3 style={{ margin: '0 0 8px' }}>Comprovantes de rastreabilidade</h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {docs.data.map((d) => (
          <li key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 }}>
            <span className="muted">{new Date(d.created_at).toLocaleString('pt-BR')}</span>
            <ComprovanteButton documentId={d.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}
