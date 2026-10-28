import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { useLoad } from './hooks';
import { Sheet, useRole, useToast } from './ui';

// Regra de retorno por procedimento. O intervalo é SEMPRE definido pela doutora; nenhuma IA decide isso.
const DEFAULT_TEXT = 'Olá, {{nome}}! Já está na época de avaliar o seu retorno do procedimento {{procedimento}}. Que tal escolher um horário a partir de {{data}}? Estamos à disposição.';

type Rule = { configured: boolean; targetDays?: number; windowMinDays?: number; windowMaxDays?: number; messageText?: string; active?: boolean };

const errMsg = (e: unknown) =>
  e instanceof ApiError && e.status === 403 ? 'Sem permissão para alterar a regra.'
  : e instanceof ApiError && e.status < 500 ? e.message
  : 'Não foi possível salvar. Tente novamente.';

export function RegraRetornoSheet({ procedure, onClose }: { procedure: { id: string; name: string }; onClose: () => void }) {
  const { isManager } = useRole(); // owner e manager editam; professional apenas vê
  const toast = useToast();
  const rule = useLoad<Rule>(`/procedures/${procedure.id}/return-rule`);
  const [target, setTarget] = useState(''); const [min, setMin] = useState(''); const [max, setMax] = useState('');
  const [text, setText] = useState(DEFAULT_TEXT); const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  useEffect(() => {
    const r = rule.data; if (!r) return;
    if (r.configured) {
      setTarget(String(r.targetDays)); setMin(String(r.windowMinDays)); setMax(String(r.windowMaxDays));
      setText(r.messageText ?? DEFAULT_TEXT); setActive(!!r.active);
    }
  }, [rule.data]);

  async function save(e: FormEvent) {
    e.preventDefault(); setErr('');
    const t = Number(target), a = Number(min), b = Number(max);
    if (![t, a, b].every((n) => Number.isInteger(n) && n > 0)) return setErr('Informe os prazos em dias, com números inteiros maiores que zero.');
    if (a > t || t > b) return setErr('A janela precisa respeitar: mínimo ≤ intervalo-alvo ≤ máximo.');
    setBusy(true);
    try {
      await api(`/procedures/${procedure.id}/return-rule`, { method: 'PUT', json: { targetDays: t, windowMinDays: a, windowMaxDays: b, messageText: text.trim(), active } });
      toast('Regra de retorno salva'); onClose();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  }

  const ro = !isManager;
  return (
    <Sheet title={`Retorno: ${procedure.name}`} onClose={onClose}>
      {rule.error && <p role="alert" className="err">{rule.error}</p>}
      {!rule.data && !rule.error && <p className="muted">Carregando…</p>}
      {rule.data && (
        <form className="form" onSubmit={save}>
          <p className="muted">Quem define o prazo de retorno é a doutora. O sistema só aplica a regra: nada é decidido automaticamente e nenhuma mensagem é enviada sozinha.</p>
          {ro && <p className="muted" role="note">Somente proprietário(a) e gerente podem alterar esta regra.</p>}
          <label>Intervalo-alvo (dias após o atendimento)
            <input type="number" inputMode="numeric" min={1} step={1} required disabled={ro} value={target} placeholder="ex.: 105" onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label>Janela: a partir de (dias)
            <input type="number" inputMode="numeric" min={1} step={1} required disabled={ro} value={min} placeholder="ex.: 90" onChange={(e) => setMin(e.target.value)} />
          </label>
          <label>Janela: até (dias)
            <input type="number" inputMode="numeric" min={1} step={1} required disabled={ro} value={max} placeholder="ex.: 120" onChange={(e) => setMax(e.target.value)} />
          </label>
          <label>Texto-base da mensagem
            <textarea rows={5} minLength={5} maxLength={600} required disabled={ro} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="rr-help" />
          </label>
          <p id="rr-help" className="muted">
            Variáveis: <b>{'{{nome}}'}</b> (primeiro nome do paciente), <b>{'{{procedimento}}'}</b> e <b>{'{{data}}'}</b> (data sugerida do retorno).
            Não use termos que prometam resultado ou garantia (ex.: &quot;garantido&quot;, &quot;100%&quot;, &quot;antes e depois&quot;): o sistema recusa.
            {' '}{text.length}/600
          </p>
          {!ro && <button type="button" className="ghost sm" style={{ minHeight: 44 }} onClick={() => setText(DEFAULT_TEXT)}>Usar o texto padrão sugerido</button>}
          <label className="check"><input type="checkbox" disabled={ro} checked={active} onChange={(e) => setActive(e.target.checked)} />Regra ativa (gera sugestões de retorno ao concluir atendimentos)</label>
          {err && <p role="alert" className="err">{err}</p>}
          {!ro && <button className="primary" style={{ minHeight: 48 }} disabled={busy}>{busy ? 'Salvando…' : 'Salvar regra'}</button>}
        </form>
      )}
    </Sheet>
  );
}
