import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ApiError, api, brl } from './api';
import { AgendarRetornoButton } from './AgendarRetorno';
import { ComprovanteButton } from './Comprovante';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { Sheet, useRole, useToast } from './ui';

// Folha "Concluir atendimento": a doutora confere os produtos (sugestão do protocolo já preenchida),
// o lote vem pelo FEFO, e um toque em "Confirmar e dar baixa" fecha o atendimento e baixa o estoque.
// Nada é baixado sem esse toque: o protocolo é só sugestão.

type Lot = { id: string; code: string; expiresAt: string; units: number; expired: boolean; blocked: boolean };
type Product = { id: string; name: string; unit: string; device_type: string; units_per_package: number; lots: Lot[] };
type Ctx = {
  appointment: { id: string; status: string };
  patient: { id: string; name: string };
  procedure: { id: string; name: string } | null;
  suggestions: { productId: string; product: string; units: number }[];
  products: Product[];
  returnRule: { targetDays: number } | null;
};
type Line = { key: number; productId: string; lotId: string | null; units: number; photo: string | null; raw?: string }; // raw: texto digitado ("1," enquanto digita 1,5)
type Result = {
  applications: { id: string; product: { name: string }; lot: { code: string } | null; units: number; cost?: number | null }[];
  totalCost?: number; missingCost?: boolean; margin?: { value: number; pct: number | null };
  returnSuggested: { id: string; suggested_date?: string } | null;
  traceability: { id: string } | null;
};

const MAX_PHOTO_BYTES = 380 * 1024; // abaixo do limite de 400 KB do servidor
const fmtDate = (d: string) => d.slice(0, 10).split('-').reverse().join('/');
const fmtUnits = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const stepOf = (p?: Product) => (p && p.units_per_package > 1 ? 1 : 0.5);
const ERR: Record<string, string> = {
  lot_expired: 'Este lote está vencido e não pode ser usado. Escolha outro lote.',
  insufficient_stock: 'O lote não tem saldo suficiente. Reduza as unidades ou escolha outro lote.',
  'not completable': 'Este atendimento já foi concluído ou cancelado.',
  photo_too_large: 'A foto da etiqueta ficou grande demais. Tire outra.',
  invalid_photo: 'A foto da etiqueta não é válida. Tire outra.',
  product_not_found: 'Produto não encontrado.', lot_not_found: 'Lote não encontrado.',
};

// Reduz a foto no aparelho (máx. ~1280 px, JPEG 0,7) antes de enviar.
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('img')); i.src = url; });
    for (const [max, quality] of [[1280, 0.7], [1024, 0.55], [800, 0.45]] as const) {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
      const out = cv.toDataURL('image/jpeg', quality);
      if (out.length * 0.75 <= MAX_PHOTO_BYTES) return out;
    }
    throw new Error('big');
  } finally { URL.revokeObjectURL(url); }
}

const S: Record<string, CSSProperties> = {
  stack: { display: 'grid', gap: 12 },
  line: { border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'grid', gap: 10, background: 'var(--card)' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sel: { minHeight: 44, width: '100%', padding: '0 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit' },
  stepper: { display: 'flex', alignItems: 'center', gap: 8 },
  step: { minHeight: 44, minWidth: 44, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--bg)', fontSize: 22, fontWeight: 600, lineHeight: 1 },
  num: { minHeight: 44, width: 84, textAlign: 'center', fontSize: 18, fontWeight: 600, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)' },
  search: { minHeight: 44, width: '100%', padding: '0 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit' },
  pick: { minHeight: 44, width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  summary: { background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 12, padding: '10px 12px', fontSize: 14 },
  foot: { position: 'sticky', bottom: 0, background: 'var(--card)', paddingTop: 8, paddingBottom: 'calc(8px + env(safe-area-inset-bottom))', display: 'grid', gap: 8 },
  warn: { color: 'var(--warn)', fontSize: 13, margin: 0 },
};

export function ConcluirAtendimento({ appointmentId, onClose, onDone }: { appointmentId: string; onClose: () => void; onDone?: () => void }) {
  const { isManager } = useRole();
  const toast = useToast();
  const ctx = useLoad<Ctx>(`/appointments/${appointmentId}/conclusion-context`);
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [photoErr, setPhotoErr] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const seq = useRef(0);
  const seeded = useRef(false);
  // Sheet refoca o primeiro campo sempre que onClose muda de identidade: mantemos uma função estável.
  const latest = useRef({ onClose, onDone, result });
  latest.current = { onClose, onDone, result };
  const close = useCallback(() => { const l = latest.current; if (l.result) l.onDone?.(); l.onClose(); }, []);

  const byId = useMemo(() => new Map((ctx.data?.products ?? []).map((p) => [p.id, p])), [ctx.data]);
  // FEFO: o servidor já devolve os lotes ordenados (validade mais próxima primeiro, vencidos no fim e bloqueados).
  const fefo = (p: Product | undefined, units: number) => {
    const ok = (p?.lots ?? []).filter((l) => !l.blocked);
    return (ok.find((l) => l.units >= units) ?? ok[0])?.id ?? null;
  };

  useEffect(() => {
    if (!ctx.data || seeded.current) return;
    seeded.current = true;
    setLines(ctx.data.suggestions.filter((s) => byId.has(s.productId)).map((s) => ({
      key: ++seq.current, productId: s.productId, units: s.units, photo: null, lotId: fefo(byId.get(s.productId), s.units),
    })));
  }, [ctx.data, byId]);

  const patch = (key: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const add = (p: Product) => {
    const units = stepOf(p);
    setLines((ls) => [...ls, { key: ++seq.current, productId: p.id, units, photo: null, lotId: fefo(p, units) }]);
    setSearch('');
  };
  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (ctx.data?.products ?? []).filter((p) => !s || p.name.toLowerCase().includes(s)).slice(0, 6);
  }, [ctx.data, search]);

  async function onPhoto(key: number, f?: File) {
    if (!f) return;
    setPhotoErr('');
    try { patch(key, { photo: await shrink(f) }); } catch { setPhotoErr('Não foi possível usar essa foto. Tente outra.'); }
  }

  // sem unidades, ou mais unidades do que o lote escolhido tem (o servidor recusaria com insufficient_stock)
  const invalid = lines.some((l) => !(l.units > 0) || l.units > (byId.get(l.productId)?.lots.find((x) => x.id === l.lotId)?.units ?? Infinity));
  async function confirm() {
    if (busy || invalid) return;
    setBusy(true); setErr('');
    try {
      const r = await api<Result>(`/appointments/${appointmentId}/conclude`, {
        method: 'POST',
        json: { confirmed: true, applications: lines.map((l) => ({ productId: l.productId, ...(l.lotId ? { lotId: l.lotId } : {}), units: l.units, ...(l.photo ? { labelPhoto: l.photo } : {}) })) },
      });
      setResult(r);
      toast('Atendimento concluído');
    } catch (e) {
      const m = e instanceof ApiError ? e.message : '';
      setErr(ERR[m] ?? (e instanceof ApiError && e.status === 413 ? ERR.photo_too_large! : 'Não foi possível concluir. Nada foi baixado. Tente novamente.'));
    } finally { setBusy(false); }
  }

  const title = 'Concluir atendimento';
  if (ctx.error) return <Sheet title={title} onClose={close}><p role="alert" className="err">{ctx.error === 'forbidden' ? 'Seu perfil não pode concluir atendimentos.' : 'Não foi possível carregar o atendimento.'}</p><button className="ghost" style={{ minHeight: 44 }} onClick={ctx.reload}>Tentar de novo</button></Sheet>;
  if (!ctx.data) return <Sheet title={title} onClose={close}><p className="muted" role="status">Carregando…</p></Sheet>;
  const c = ctx.data;

  if (result) {
    return (
      <Sheet title="Atendimento concluído" onClose={close}>
        <div style={S.stack}>
          <p className="muted"><b>{c.patient.name}</b>{c.procedure ? ` · ${c.procedure.name}` : ''}</p>
          {result.applications.length === 0 ? <p className="muted">Nenhum produto foi baixado do estoque.</p> : (
            <section className="card" aria-label="O que foi baixado">
              <h2>O que foi baixado</h2>
              <ul className="rows">
                {result.applications.map((a) => (
                  <li key={a.id}>
                    <span><b>{a.product.name}</b><br /><span className="muted">{a.lot ? `Lote ${a.lot.code}` : 'Sem lote informado'}</span></span>
                    <span style={{ textAlign: 'right' }}><b>{fmtUnits(a.units)} un</b>{a.cost != null && <><br /><span className="muted">{brl(a.cost)}</span></>}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {isManager && result.totalCost !== undefined && result.margin && (
            <section className="card" aria-label="Custo e margem">
              <ul className="rows">
                <li><span>Custo dos produtos</span><b>{brl(result.totalCost)}</b></li>
                <li><span>Margem bruta</span><b>{brl(result.margin.value)}{result.margin.pct != null ? ` · ${fmtUnits(result.margin.pct)}%` : ''}</b></li>
              </ul>
              {result.missingCost && <p style={S.warn}>Algum produto está sem custo cadastrado: o custo real pode ser maior.</p>}
            </section>
          )}
          {result.returnSuggested && (
            <section className="card" aria-label="Retorno sugerido">
              <div className="between" style={{ gap: 12 }}>
                <span><b>Retorno sugerido</b>{result.returnSuggested.suggested_date && <><br /><span className="muted">por volta de {fmtDate(result.returnSuggested.suggested_date)}</span></>}</span>
                <AgendarRetornoButton returnId={result.returnSuggested.id} patientName={c.patient.name} />
              </div>
            </section>
          )}
          {result.traceability && <div><ComprovanteButton documentId={result.traceability.id} /></div>}
          <button className="primary" style={{ minHeight: 48 }} onClick={close}>Fechar</button>
        </div>
      </Sheet>
    );
  }

  const baixa = lines.map((l) => ({ l, p: byId.get(l.productId) })).filter((x) => x.p);
  return (
    <Sheet title={title} onClose={close}>
      <div style={S.stack}>
        <p className="muted"><b>{c.patient.name}</b>{c.procedure ? ` · ${c.procedure.name}` : ' · Sem procedimento'}</p>
        {c.suggestions.length > 0 && <p className="muted">Já preenchido com o protocolo do procedimento. Confira e ajuste, nada é baixado antes de confirmar.</p>}

        {lines.length === 0 && <p className="muted" role="status">Nenhum produto adicionado. Adicione abaixo ou conclua sem baixa de estoque.</p>}
        {baixa.map(({ l, p }) => {
          const lot = p!.lots.find((x) => x.id === l.lotId);
          const over = lot ? l.units > lot.units : false;
          const step = stepOf(p);
          return (
            <section key={l.key} style={S.line} aria-label={p!.name}>
              <div style={S.head}>
                <b>{p!.name}</b>
                <button type="button" className="ghost sm" style={{ minHeight: 44, minWidth: 44 }} aria-label={`Remover ${p!.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Icon name="close" size={16} /></button>
              </div>
              <label className="muted" htmlFor={`lot-${l.key}`}>Lote (validade mais próxima primeiro)</label>
              <select id={`lot-${l.key}`} style={S.sel} value={l.lotId ?? ''} onChange={(e) => patch(l.key, { lotId: e.target.value || null })}>
                {p!.lots.map((x) => <option key={x.id} value={x.id} disabled={x.blocked}>{x.code} · vence {fmtDate(x.expiresAt)} · {fmtUnits(x.units)} un{x.blocked ? ' · VENCIDO' : ''}</option>)}
                <option value="">Sem lote informado</option>
              </select>
              {!l.lotId && <p style={S.warn}>Sem lote: a baixa será só no produto e a rastreabilidade fica incompleta.</p>}
              <div style={S.stepper}>
                <button type="button" style={S.step} aria-label={`Diminuir unidades de ${p!.name}`} onClick={() => patch(l.key, { raw: undefined, units: Math.max(step, Math.round((l.units - step) * 100) / 100) })}>−</button>
                <input style={S.num} inputMode="decimal" aria-label={`Unidades de ${p!.name}`} value={l.raw ?? (Number.isFinite(l.units) ? String(l.units).replace('.', ',') : '')}
                  onChange={(e) => { const raw = e.target.value; const v = parseFloat(raw.replace(',', '.')); patch(l.key, { raw, units: Number.isFinite(v) ? v : 0 }); }} />
                <button type="button" style={S.step} aria-label={`Aumentar unidades de ${p!.name}`} onClick={() => patch(l.key, { raw: undefined, units: Math.round((l.units + step) * 100) / 100 })}>+</button>
                <span className="muted">unidades</span>
              </div>
              {over && <p style={S.warn} role="alert">O lote tem só {fmtUnits(lot!.units)} un. Reduza ou escolha outro lote.</p>}
              <div style={S.stepper}>
                <input id={`ph-${l.key}`} type="file" accept="image/*" capture="environment" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
                  onChange={(e) => { void onPhoto(l.key, e.target.files?.[0]); e.target.value = ''; }} />
                <label htmlFor={`ph-${l.key}`} className="ghost" tabIndex={-1} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, cursor: 'pointer' }}>
                  {l.photo ? 'Trocar foto da etiqueta' : 'Fotografar etiqueta'}
                </label>
                {l.photo && <><span className="pill ok">Foto anexada</span><button type="button" className="ghost sm" style={{ minHeight: 44 }} onClick={() => patch(l.key, { photo: null })}>Remover foto</button></>}
              </div>
            </section>
          );
        })}
        {photoErr && <p role="alert" className="err">{photoErr}</p>}

        <div style={S.stack}>
          <label className="muted" htmlFor="prod-search">Adicionar produto</label>
          <input id="prod-search" type="search" style={S.search} placeholder="Buscar produto" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          {matches.length === 0 ? <p className="muted">Nenhum produto encontrado.</p> : (
            <ul className="rows" style={{ display: 'grid', gap: 6 }}>
              {matches.map((p) => {
                const free = p.lots.filter((x) => !x.blocked).length;
                return <li key={p.id} style={{ border: 0, padding: 0 }}>
                  <button type="button" style={S.pick} onClick={() => add(p)} aria-label={`Adicionar ${p.name}`}>
                    <span>{p.name}</span><span className="muted">{p.lots.length === 0 ? 'sem lote' : free === 0 ? 'lotes vencidos' : `${free} lote${free > 1 ? 's' : ''}`} · +</span>
                  </button>
                </li>;
              })}
            </ul>
          )}
        </div>

        <div style={S.foot}>
          {baixa.length > 0 && <div style={S.summary} aria-live="polite">Será baixado: {baixa.map(({ l, p }) => `${fmtUnits(l.units)} un de ${p!.name}`).join(' · ')}</div>}
          {err && <p role="alert" className="err" style={{ margin: 0 }}>{err}</p>}
          <button className="primary" style={{ minHeight: 52, fontSize: 17 }} disabled={busy || invalid} aria-busy={busy} onClick={confirm}>
            {busy ? 'Concluindo…' : baixa.length > 0 ? 'Confirmar e dar baixa' : 'Concluir sem baixa de produtos'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
