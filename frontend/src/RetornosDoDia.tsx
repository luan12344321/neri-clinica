import { useState } from 'react';
import { ApiError, api, brl } from './api';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { AgendarRetornoButton } from './AgendarRetorno';
import { ConsentimentoSheet } from './Consentimento';
import { Empty, ListSkeleton, Sheet, mask, useToast } from './ui';

// "Retornos do dia": a secretária chama pelo WhatsApp (envio MANUAL, o app só abre a conversa com o texto pronto)
// e registra o resultado com um toque. Nenhuma mensagem sai sozinha.
type Item = {
  id: string; patient: { id: string; name: string }; procedure: { id: string; name: string }; windowEnd: string;
  state: string; urgency: 'high' | 'medium' | 'low'; daysLate: number; message: string; consent: boolean; phone: string | null;
};
type Result = 'scheduled' | 'declined' | 'no_response' | 'remind_later';

const TZ = 'America/Sao_Paulo';
const ymd = (plusDays = 0) => new Date(Date.now() + plusDays * 864e5).toLocaleDateString('sv-SE', { timeZone: TZ });
const URGENCY: Record<Item['urgency'], { label: string; cls: string }> = {
  high: { label: 'Vencido', cls: 'pill warn' }, medium: { label: 'Fecha em breve', cls: 'pill hi' }, low: { label: 'Na janela', cls: 'pill' },
};
const RESULTS: { id: Exclude<Result, 'remind_later'>; label: string }[] = [
  { id: 'scheduled', label: 'Agendou' }, { id: 'declined', label: 'Recusou' }, { id: 'no_response', label: 'Sem resposta' },
];
const touch = { minHeight: 44, minWidth: 44 } as const;

export function RetornosDoDia() {
  const { data, error, reload } = useLoad<{ items: Item[] }>('/returns/queue?scope=today');
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [consentFor, setConsentFor] = useState<Item | null>(null);
  const [remindFor, setRemindFor] = useState<Item | null>(null);
  const [remindOn, setRemindOn] = useState(ymd(7));

  async function register(it: Item, result: Result, date?: string) {
    setBusy(it.id);
    try {
      await api(`/returns/${it.id}/result`, { method: 'POST', json: { result, ...(date ? { remindOn: date } : {}) } });
      toast('Resultado registrado.');
      setRemindFor(null); reload();
    } catch (e) {
      toast(e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível registrar. Tente de novo.');
      if (e instanceof ApiError && e.status === 409) reload();
    } finally { setBusy(''); }
  }

  const items = data?.items ?? [];
  return (
    <section className="card" id="retornos-do-dia" aria-labelledby="retornos-dia-h" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 id="retornos-dia-h" className="grow" style={{ margin: 0 }}>Retornos do dia</h2>
        {data && items.length > 0 && <span className="badge" aria-label={`${items.length} retornos`}>{items.length}</span>}
      </div>
      {error && !data && (
        <div role="alert">
          <p className="err">Não foi possível carregar os retornos.</p>
          <button className="ghost" style={touch} onClick={reload}>Tentar de novo</button>
        </div>
      )}
      {!data && !error && <div role="status" aria-label="Carregando retornos"><ListSkeleton rows={2} /></div>}
      {data && items.length === 0 && <Empty icon="check" title="Nenhum retorno para hoje" text="Quando um paciente entrar na janela de retorno, ele aparece aqui." />}
      {items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
          {items.map((it) => {
            const u = URGENCY[it.urgency];
            const disabled = busy === it.id;
            return (
              <li key={it.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{it.patient.name}</b>
                    <span className="muted" style={{ display: 'block' }}>{it.procedure.name}</span>
                  </div>
                  <span className={u.cls}>{u.label}</span>
                  {it.daysLate > 0 && <span className="pill warn">{it.daysLate} {it.daysLate === 1 ? 'dia' : 'dias'} de atraso</span>}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {it.consent && it.phone ? (
                    <a className="primary sm" style={{ ...touch, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 14px', borderRadius: 10, textDecoration: 'none', background: 'var(--accent)', color: 'var(--accent-ink)' }}
                      href={`https://wa.me/${it.phone}?text=${encodeURIComponent(it.message)}`} target="_blank" rel="noopener noreferrer"
                      aria-label={`Chamar ${it.patient.name} no WhatsApp (abre em nova aba)`}>
                      <Icon name="send" size={16} />Chamar no WhatsApp
                    </a>
                  ) : (
                    <>
                      <span className="muted">Sem autorização de contato</span>
                      <button className="ghost sm" style={touch} onClick={() => setConsentFor(it)} aria-label={`Registrar autorização de ${it.patient.name}`}>Registrar autorização</button>
                    </>
                  )}
                  <AgendarRetornoButton returnId={it.id} patientName={it.patient.name} onDone={reload} />
                </div>

                <div role="group" aria-label={`Resultado do contato com ${it.patient.name}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {RESULTS.map((r) => (
                    <button key={r.id} className="ghost sm" style={touch} disabled={disabled} onClick={() => register(it, r.id)}>{r.label}</button>
                  ))}
                  <button className="ghost sm" style={touch} disabled={disabled} onClick={() => { setRemindOn(ymd(7)); setRemindFor(it); }}>Lembrar depois</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {consentFor && <ConsentimentoSheet patientId={consentFor.patient.id} patientName={consentFor.patient.name} onClose={() => setConsentFor(null)} onDone={reload} />}
      {remindFor && (
        <Sheet title="Lembrar depois" onClose={() => setRemindFor(null)}>
          <p className="muted">Quando o retorno de {remindFor.patient.name.split(/\s+/)[0]} volta para a fila?</p>
          <label style={{ display: 'grid', gap: 4, margin: '12px 0' }}>Data do lembrete
            <input type="date" value={remindOn} min={ymd(1)} max={ymd(180)} onChange={(e) => setRemindOn(e.target.value)} style={{ minHeight: 44 }} />
          </label>
          <button className="primary" style={touch} disabled={busy === remindFor.id || !remindOn} onClick={() => register(remindFor, 'remind_later', remindOn)}>Salvar lembrete</button>
        </Sheet>
      )}
    </section>
  );
}

// "Precisa de atenção" agrupada por urgência, com o responsável em um selo e as próximas ações como botões.
export type AttItem = {
  id: string; kind: string; urgency: 'high' | 'medium' | 'low'; owner: 'doctor' | 'secretary' | 'manager'; title: string; detail: string;
  count: number; amount?: number; nextActions: { kind: string; label: string }[];
};
const OWNER: Record<AttItem['owner'], string> = { doctor: 'Doutora', secretary: 'Secretária', manager: 'Gerente' };
const GROUP: Record<AttItem['urgency'], string> = { high: 'Urgente', medium: 'Para hoje', low: 'Quando der' };

export function AtencaoLista({ items, hidden, onAction }: { items: AttItem[]; hidden: boolean; onAction: (kind: string, item: AttItem) => void }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {(['high', 'medium', 'low'] as const).map((u) => {
        const group = items.filter((i) => i.urgency === u);
        if (!group.length) return null;
        return (
          <div key={u} role="group" aria-label={GROUP[u]}>
            <h3 style={{ margin: '0 0 6px', fontSize: 13, textTransform: 'uppercase', letterSpacing: '.04em', color: u === 'high' ? 'var(--warn)' : 'var(--muted)' }}>{GROUP[u]}</h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {group.map((it) => (
                <li key={it.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 10, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <b className="grow" style={{ minWidth: 0 }}>{it.title}</b>
                    <span className={u === 'high' ? 'pill warn' : 'pill'}>{OWNER[it.owner]}</span>
                  </div>
                  {(it.detail || it.amount !== undefined) && (
                    <span className="muted wrap">{it.detail}{it.amount !== undefined ? ` ${mask(brl(it.amount), hidden)}` : ''}</span>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {it.nextActions.map((a) => (
                      <button key={a.kind} className="ghost sm" style={touch} onClick={() => onAction(a.kind, it)}>{a.label}</button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
