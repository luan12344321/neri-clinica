import { useEffect, useState } from 'react';
import { ApiError, api, dayISO } from './api';
import { Icon } from './Icon';
import { Sheet, useToast } from './ui';

// Botão "Agendar agora" de um retorno sugerido: escolhe o dia, vê os horários livres e confirma.

export function AgendarRetornoButton({ returnId, patientName, onDone }: { returnId: string; patientName: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="primary sm" style={{ minHeight: 44 }} onClick={() => setOpen(true)} aria-label={`Agendar retorno de ${patientName}`}>
        <Icon name="calendar" size={16} />Agendar agora
      </button>
      {open && <AgendarSheet returnId={returnId} patientName={patientName} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />}
    </>
  );
}

function AgendarSheet({ returnId, patientName, onClose, onDone }: { returnId: string; patientName: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(dayISO());
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setSlots(null); setSlot(''); setLoadErr('');
    api<{ slots: string[] }>(`/returns/${returnId}/slots?date=${date}`)
      .then((r) => live && setSlots(r.slots))
      .catch((e) => live && setLoadErr(e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível carregar os horários.'));
    return () => { live = false; };
  }, [returnId, date]);

  async function confirm() {
    setBusy(true); setErr('');
    try {
      await api(`/returns/${returnId}/schedule`, { method: 'POST', json: { startsAt: new Date(`${date}T${slot}:00-03:00`).toISOString() } });
      toast(`Retorno de ${patientName} agendado`); onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível agendar. Tente novamente.');
    } finally { setBusy(false); }
  }

  return (
    <Sheet title={`Agendar retorno: ${patientName}`} onClose={onClose}>
      <div className="form">
        <label>Dia
          <input type="date" min={dayISO()} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <div role="group" aria-label="Horários livres" aria-busy={slots === null && !loadErr}>
          {loadErr && <p role="alert" className="err">{loadErr}</p>}
          {slots === null && !loadErr && <p className="muted">Carregando horários…</p>}
          {slots?.length === 0 && <p className="muted">Nenhum horário livre neste dia. Escolha outra data.</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {slots?.map((s) => (
              <button key={s} type="button" aria-pressed={slot === s} onClick={() => setSlot(s)}
                className={slot === s ? 'primary' : 'ghost'} style={{ minHeight: 44, minWidth: 72 }}>{s}</button>
            ))}
          </div>
        </div>
        {err && <p role="alert" className="err">{err}</p>}
        <button className="primary" style={{ minHeight: 48 }} disabled={!slot || busy} onClick={confirm}>
          {busy ? 'Agendando…' : slot ? `Confirmar ${slot}` : 'Escolha um horário'}
        </button>
      </div>
    </Sheet>
  );
}
