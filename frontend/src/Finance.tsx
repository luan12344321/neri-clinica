import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Cell, Pie, PieChart, ResponsiveContainer, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError, api, brl, dayISO, monthLabel, thisMonth } from './api';
import { AddForm, errText, type Field } from './Cadastros';
import { useLoad } from './hooks';
import PainelCiclo from './PainelCiclo';
import { Icon, type IconName } from './Icon';
import { ConfirmButton, Empty, EyeToggle, ListSkeleton, PageHead, Segmented, Sheet, mask, useHideValues, useToast } from './ui';

export type FinTab = 'resumo' | 'contas' | 'bancos' | 'dre';
export type Bank = {
  id: string; name: string; institution: string; kind: 'checking' | 'savings' | 'payment' | 'cash'; last4: string | null;
  isDefault: boolean; active: boolean; balance: number; openingBalance: number; pixKeyType: string | null; pixKeyMasked: string | null;
};
type Tx = { id: string; description: string; amount: string; due_date: string };
type Recent = { id: string; type: 'income' | 'expense'; description: string; amount: number; status: 'pending' | 'paid'; due_date: string; paid_at: string | null; category: string | null; bank: string | null };

const KIND: Record<Bank['kind'], string> = { checking: 'Conta corrente', savings: 'Poupança', payment: 'Conta de pagamento', cash: 'Caixa (dinheiro)' };
const INSTITUTIONS = ['Nubank', 'Itaú', 'Bradesco', 'Banco do Brasil', 'Caixa', 'Santander', 'Inter', 'C6 Bank', 'Sicoob', 'Sicredi', 'Mercado Pago', 'PagBank', 'Stone', 'Cora', 'Dinheiro', 'Outro'];
const PIX_TYPES = [{ value: 'cpf', label: 'CPF' }, { value: 'cnpj', label: 'CNPJ' }, { value: 'email', label: 'E-mail' }, { value: 'phone', label: 'Celular' }, { value: 'random', label: 'Chave aleatória' }];
const dateBR = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00`).toLocaleDateString('pt-BR');

const Status = ({ error, loading }: { error: string; loading: boolean }) =>
  error ? <p role="alert" className="err">{error}</p> : loading ? <ListSkeleton rows={3} /> : null;

// ---------- Últimas movimentações (usada também no Início) ----------
export function RecentTransactions({ limit = 6, reloadKey, onSeeAll }: { limit?: number; reloadKey?: number; onSeeAll?: () => void }) {
  const l = useLoad<Recent[]>(`/finance/transactions?limit=${limit}&k=${reloadKey ?? 0}`);
  const { hidden } = useHideValues();
  return (
    <section className="card list-card">
      <div className="between pad-h"><h2>Últimas movimentações</h2>{onSeeAll && <button className="link" onClick={onSeeAll}>Ver tudo</button>}</div>
      <Status error={l.error} loading={!l.data} />
      {l.data?.length === 0 && <Empty icon="wallet" title="Nada por aqui ainda" text="Os recebimentos e pagamentos aparecem aqui." />}
      <ul className="rows">{l.data?.map((t) => (
        <li key={t.id}>
          <div className="row-btn static">
            <span className={`q-ico ${t.type === 'expense' ? 'out' : ''}`}><Icon name={t.type === 'income' ? 'receive' : 'pay'} size={20} /></span>
            <span className="grow"><b>{t.description}</b><span className="muted">{[t.category, t.bank].filter(Boolean).join(' · ') || (t.paid_at ? dateBR(t.paid_at) : `vence ${dateBR(t.due_date)}`)}</span></span>
            <span className="tx-right">
              <b className={t.type === 'expense' ? 'neg' : 'pos'}>{mask(`${t.type === 'expense' ? '−' : '+'} ${brl(t.amount)}`, hidden)}</b>
              <span className={`pill ${t.status === 'paid' ? 'ok' : 'warn'}`}>{t.status === 'paid' ? (t.type === 'income' ? 'Recebido' : 'Pago') : 'Pendente'}</span>
            </span>
          </div>
        </li>
      ))}</ul>
    </section>
  );
}

// ---------- Tela Financeiro ----------
export function Finance({ initialTab = 'resumo', onTab }: { initialTab?: FinTab; onTab?: (t: FinTab) => void }) {
  const [tab, setTabState] = useState<FinTab>(initialTab);
  const setTab = (t: FinTab) => { setTabState(t); onTab?.(t); };
  const [month, setMonth] = useState(thisMonth());
  const [bump, setBump] = useState(0);
  const sum = useLoad<any>(`/finance/summary?month=${month}`);
  const dre = useLoad<any>(`/finance/dre?month=${month}`);
  const pay = useLoad<Tx[]>('/finance/payables');
  const recv = useLoad<Tx[]>('/finance/receivables');
  const flow = useLoad<{ month: string; income: number; expense: number }[]>('/finance/cashflow');
  const banks = useLoad<Bank[]>('/banks');
  const refresh = () => { pay.reload(); recv.reload(); sum.reload(); flow.reload(); banks.reload(); setBump((b) => b + 1); };

  return (
    <div className="fin-page">
      <Segmented value={tab} onChange={setTab} options={[{ id: 'resumo', label: 'Resumo' }, { id: 'contas', label: 'Contas' }, { id: 'bancos', label: 'Bancos' }, { id: 'dre', label: 'DRE' }]} />
      {tab !== 'bancos' && tab !== 'contas' && (
        <div className="toolbar"><label>Mês<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label></div>
      )}
      {tab === 'resumo' && <Summary sum={sum} flow={flow} banks={banks.data} recv={recv.data} pay={pay.data} bump={bump} goTab={setTab} />}
      {tab === 'resumo' && <PainelCiclo />}
      {tab === 'contas' && <Accounts recv={recv.data} pay={pay.data} banks={banks.data ?? []} onChanged={refresh} goBanks={() => setTab('bancos')} error={recv.error || pay.error} />}
      {tab === 'bancos' && <Banks banks={banks} onChanged={refresh} />}
      {tab === 'dre' && <Dre dre={dre} />}
    </div>
  );
}

// ---------- Resumo ----------
function Summary({ sum, flow, banks, recv, pay, bump, goTab }: { sum: ReturnType<typeof useLoad<any>>; flow: ReturnType<typeof useLoad<{ month: string; income: number; expense: number }[]>>;
  banks: Bank[] | null; recv: Tx[] | null; pay: Tx[] | null; bump: number; goTab: (t: FinTab) => void }) {
  const { hidden } = useHideValues();
  const s = sum.data;
  const total = (items: Tx[] | null) => (items ?? []).reduce((a, t) => a + Number(t.amount), 0);
  const overdue = (recv ?? []).filter((t) => String(t.due_date).slice(0, 10) < dayISO());
  const active = (banks ?? []).filter((b) => b.active);
  const quick = (icon: IconName, label: string, hint: string, value: number, tone = '') => (
    <li><span className={`q-ico ${tone}`}><Icon name={icon} size={20} /></span><div><b>{label}</b><div className="muted">{hint}</div></div><strong className={tone === 'bad' ? 'neg' : ''}>{mask(brl(value), hidden)}</strong></li>
  );
  return (
    <>
      <Status error={sum.error} loading={!s} />
      {s && (
        <>
          <section className="fin-cards">
            <div className="fin"><span><Icon name="receive" size={16} />Receitas</span><strong>{mask(brl(s.income), hidden)}</strong></div>
            <div className="fin"><span><Icon name="pay" size={16} />Despesas</span><strong>{mask(brl(s.expense), hidden)}</strong></div>
            <div className="fin result"><span><Icon name="wallet" size={16} />Resultado do mês<EyeToggle className="on-dark" /></span><strong className={s.balance < 0 ? 'neg' : ''}>{mask(brl(s.balance), hidden)}</strong><small>Ticket médio {mask(brl(s.averageTicket), hidden)}</small></div>
          </section>
          {active.length > 0 && (
            <section className="card balance-strip">
              <span className="q-ico"><Icon name="bank" size={20} /></span>
              <div className="grow"><b>Saldo em contas</b><span className="muted">{active.length} conta(s)</span></div>
              <strong>{mask(brl(active.reduce((a, b) => a + b.balance, 0)), hidden)}</strong>
              <button className="link" onClick={() => goTab('bancos')}>Ver</button>
            </section>
          )}
          <section className="card">
            <h2>Resumo rápido</h2>
            <ul className="quick">
              {quick('receive', 'Contas a receber', `${recv?.length ?? 0} pendente(s)`, total(recv))}
              {quick('pay', 'Contas a pagar', `${pay?.length ?? 0} pendente(s)`, total(pay))}
              {quick('alert', 'Inadimplência', `${overdue.length} vencido(s)`, total(overdue), overdue.length ? 'bad' : '')}
            </ul>
          </section>
          <section className="card">
            <div className="between"><h2>Fluxo de caixa</h2><span className="muted">últimos 6 meses · pagos e recebidos</span></div>
            <Status error={flow.error} loading={!flow.data} />
            {flow.data && (
              <>
                <div className="chart" role="img" aria-label="Gráfico de barras com entradas e saídas de caixa por mês">
                  <ResponsiveContainer width="100%" height={210}>
                    <BarChart data={flow.data.map((f) => ({ ...f, m: monthLabel(f.month) }))} margin={{ top: 8, right: 8, left: -14, bottom: 0 }} barGap={4}>
                      <CartesianGrid vertical={false} stroke="var(--line)" />
                      <XAxis dataKey="m" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                      <YAxis tickLine={false} axisLine={false} width={52} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v)} />
                      <Tooltip cursor={{ fill: 'var(--line)', opacity: 0.4 }} formatter={(v: number, n: string) => [hidden ? '••••' : brl(v), n === 'income' ? 'Entradas' : 'Saídas']}
                        contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--ink)' }} />
                      <Bar dataKey="income" fill="var(--c1)" radius={[8, 8, 8, 8]} maxBarSize={22} />
                      <Bar dataKey="expense" fill="var(--out)" radius={[8, 8, 8, 8]} maxBarSize={22} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="legend inline">
                  <li><i style={{ background: 'var(--c1)' }} /><span>Entradas</span><b>{mask(brl(flow.data.reduce((a, f) => a + f.income, 0)), hidden)}</b></li>
                  <li><i style={{ background: 'var(--out)' }} /><span>Saídas</span><b>{mask(brl(flow.data.reduce((a, f) => a + f.expense, 0)), hidden)}</b></li>
                </ul>
              </>
            )}
          </section>
          <RecentTransactions reloadKey={bump} onSeeAll={() => goTab('contas')} />
        </>
      )}
    </>
  );
}

// ---------- Contas a receber e a pagar ----------
function Accounts({ recv, pay, banks, onChanged, goBanks, error }: { recv: Tx[] | null; pay: Tx[] | null; banks: Bank[]; onChanged: () => void; goBanks: () => void; error: string }) {
  const [settle, setSettle] = useState<{ tx: Tx; kind: 'in' | 'out' } | null>(null);
  const [pix, setPix] = useState<Tx | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const { hidden } = useHideValues();
  const today = dayISO();
  const list = (title: string, items: Tx[] | null, kind: 'in' | 'out') => (
    <section className="card">
      <h2>{title}</h2>
      {!items ? (error ? null : <ListSkeleton rows={2} />) : items.length === 0 ? <Empty icon="check" title="Nada pendente" /> : (
        <ul className="rows">
          {items.map((t) => {
            const late = String(t.due_date).slice(0, 10) < today;
            return (
              <li key={t.id} className="stack">
                <div className="between">
                  <div><b>{t.description}</b><div className="muted">vence {dateBR(t.due_date)} {late && <span className="pill warn">vencida</span>}</div></div>
                  <b className="amount">{mask(brl(Number(t.amount)), hidden)}</b>
                </div>
                <div className="actions">
                  {kind === 'in' && <button className="ghost sm" onClick={() => setPix(t)}><Icon name="qr" size={16} />Cobrar por Pix</button>}
                  <button className="primary sm" onClick={() => setSettle({ tx: t, kind })}>{kind === 'in' ? 'Receber' : 'Pagar'}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
  return (
    <>
      <PageHead title="Contas" hint="O que entra e o que sai"><button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Nova conta</button></PageHead>
      {error && <p role="alert" className="err">{error}</p>}
      {list('A receber', recv, 'in')}
      {list('A pagar', pay, 'out')}
      {settle && <SettleSheet tx={settle.tx} kind={settle.kind} banks={banks} goBanks={goBanks} onClose={() => setSettle(null)}
        onDone={() => { setSettle(null); onChanged(); toast(settle.kind === 'in' ? 'Recebimento registrado' : 'Pagamento registrado'); }} />}
      {pix && <PixSheet tx={pix} onClose={() => setPix(null)} onPaid={() => { onChanged(); toast('Pagamento recebido'); }} goBanks={() => { setPix(null); goBanks(); }} />}
      {adding && <NewTransaction onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChanged(); toast('Conta cadastrada'); }} />}
    </>
  );
}

function SettleSheet({ tx, kind, banks, onClose, onDone, goBanks }: { tx: Tx; kind: 'in' | 'out'; banks: Bank[]; onClose: () => void; onDone: () => void; goBanks: () => void }) {
  const active = banks.filter((b) => b.active);
  const [bank, setBank] = useState(active.find((b) => b.isDefault)?.id ?? active[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await api(`/finance/transactions/${tx.id}/pay`, { method: 'POST', json: bank ? { bankAccountId: bank } : {} }); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Sheet title={kind === 'in' ? 'Confirmar recebimento' : 'Confirmar pagamento'} onClose={onClose}>
      <div className="settle-head"><b>{tx.description}</b><strong>{brl(Number(tx.amount))}</strong></div>
      {active.length === 0 ? (
        <p className="muted">Você ainda não cadastrou uma conta bancária. Cadastre para acompanhar o saldo de cada conta, ou confirme sem escolher conta.</p>
      ) : (
        <label className="form-label">{kind === 'in' ? 'Em qual conta o dinheiro caiu?' : 'De qual conta saiu?'}
          <select value={bank} onChange={(e) => setBank(e.target.value)}>
            {active.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.institution}</option>)}
          </select>
        </label>
      )}
      {err && <p role="alert" className="err">{err}</p>}
      <button className="primary" disabled={busy} onClick={go}>{busy ? 'Salvando…' : kind === 'in' ? 'Confirmar recebimento' : 'Confirmar pagamento'}</button>
      {active.length === 0 && <button className="link" onClick={() => { onClose(); goBanks(); }}>Cadastrar conta bancária</button>}
    </Sheet>
  );
}

// ---------- Cobrança por Pix ----------
// Com o Asaas configurado, cria uma cobrança que se confirma sozinha (a tela detecta o pagamento).
// Sem ele, ou se o paciente não tem CPF, usa o Pix estático: copia e cola sem confirmação automática.
type PixData = { payload: string; amount: number; provider: 'asaas' | 'static'; bank?: string; keyMasked?: string };

function PixSheet({ tx, onClose, onPaid, goBanks }: { tx: Tx; onClose: () => void; onPaid: () => void; goBanks: () => void }) {
  const [data, setData] = useState<PixData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'paid' | 'nokey' | 'error'>('loading');
  const [problem, setProblem] = useState('');
  const [copied, setCopied] = useState(false);

  const loadStatic = () => {
    setState('loading'); setProblem('');
    api<{ payload?: string; amount: number; bank: string; keyMasked: string; available?: false }>(`/finance/transactions/${tx.id}/pix`)
      .then((r) => { if (r?.payload) { setData({ ...r, payload: r.payload, provider: 'static' }); setState('ready'); } else setState(r?.available === false ? 'nokey' : 'error'); })
      .catch(() => setState('error'));
  };
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const i = await api<{ asaas: { configured: boolean } }>('/integrations');
        if (!i?.asaas?.configured) return loadStatic();
        const r = await api<{ payload?: string; amount: number }>(`/finance/transactions/${tx.id}/charge`, { method: 'POST', json: {} });
        if (off) return;
        if (!r?.payload) return setState('error');
        setData({ payload: r.payload, amount: r.amount, provider: 'asaas' }); setState('ready');
      } catch (e) {
        if (off) return;
        if (e instanceof ApiError && e.status === 409 && (e.message === 'patient cpf required' || e.message === 'no patient')) {
          setProblem(e.message === 'no patient'
            ? 'Esta conta não está ligada a um paciente, então não dá para cobrar com confirmação automática.'
            : 'Cadastre o CPF do paciente para cobrar com confirmação automática (o Asaas exige o CPF de quem paga).');
          setState('nokey');
        } else if (e instanceof ApiError && e.status === 502) { setProblem(`O Asaas recusou a cobrança${e.detail ? `: ${e.detail}` : '.'}`); setState('error'); }
        else setState('error');
      }
    })();
    return () => { off = true; };
  }, [tx.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enquanto a cobrança do Asaas está aberta, confere a cada 5 s se o pagamento já foi confirmado.
  useEffect(() => {
    if (state !== 'ready' || data?.provider !== 'asaas') return;
    const id = setInterval(() => {
      api<{ status: string }>(`/finance/transactions/${tx.id}/status`).then((s) => {
        if (s?.status === 'paid') { setState('paid'); onPaid(); setTimeout(onClose, 2200); }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [state, data?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const svg = data ? (() => { const q = qrcode(0, 'M'); q.addData(data.payload); q.make(); return q.createSvgTag({ cellSize: 5, margin: 0, scalable: true }); })() : '';
  async function copy() {
    try { await navigator.clipboard.writeText(data!.payload); setCopied(true); setTimeout(() => setCopied(false), 2200); } catch { /* sem permissão de área de transferência */ }
  }
  async function share() {
    const text = `Pix para pagamento: ${brl(Number(tx.amount))}\nCopia e cola:\n${data!.payload}`;
    if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelado */ } }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  return (
    <Sheet title="Cobrar por Pix" onClose={onClose}>
      <div className="settle-head"><b>{tx.description}</b><strong>{brl(Number(tx.amount))}</strong></div>
      {state === 'loading' && <ListSkeleton rows={2} />}
      {state === 'paid' && <div className="paid-ok" role="status"><span><Icon name="check" size={30} /></span><b>Pagamento recebido!</b><p className="muted">A conta foi baixada automaticamente.</p></div>}
      {state === 'nokey' && (
        <>
          <p className="muted">{problem || 'Nenhuma conta da clínica tem chave Pix cadastrada. Em Bancos, abra a conta que recebe os pagamentos e informe a chave Pix; depois volte aqui para gerar o código.'}</p>
          {problem ? <button className="primary" onClick={loadStatic}>Usar Pix estático (sem confirmação automática)</button> : <button className="primary" onClick={goBanks}>Ir para Bancos</button>}
        </>
      )}
      {state === 'error' && (
        <>
          <p role="alert" className="err">{problem || 'Não foi possível gerar o Pix agora. Tente novamente.'}</p>
          <button className="ghost" onClick={loadStatic}>Usar Pix estático</button>
        </>
      )}
      {state === 'ready' && data && (
        <>
          <span className={`pill ${data.provider === 'asaas' ? 'ok' : 'warn'} center-pill`}>{data.provider === 'asaas' ? 'Confirmação automática' : 'Pix estático'}</span>
          <div className="qr" role="img" aria-label="QR Code do Pix" dangerouslySetInnerHTML={{ __html: svg }} />
          {data.provider === 'static' && <p className="muted center">Destino: {data.bank} · chave {data.keyMasked}</p>}
          <textarea className="pix-code" readOnly rows={4} value={data.payload} aria-label="Pix copia e cola" onFocus={(e) => e.currentTarget.select()} />
          <div className="actions">
            <button className="primary" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} />{copied ? 'Copiado' : 'Copiar código'}</button>
            <button className="ghost" onClick={share}><Icon name="share" size={18} />Enviar</button>
          </div>
          {data.provider === 'asaas'
            ? <p className="muted note-box ok-box">Assim que o paciente pagar, esta conta é baixada sozinha. Você pode fechar esta janela: a baixa acontece mesmo assim.</p>
            : <p className="muted note-box">Este Pix é estático: o sistema não detecta o pagamento sozinho. Quando o dinheiro cair na conta, toque em <b>Receber</b> para dar baixa.</p>}
        </>
      )}
    </Sheet>
  );
}

function NewTransaction({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const cats = useLoad<{ id: string; name: string; kind: 'income' | 'expense' }[]>('/categories');
  const fields: Field[] = [
    { name: 'categoryId', label: 'Categoria', type: 'select', required: true, options: cats.data?.map((c) => ({ value: c.id, label: `${c.kind === 'income' ? 'Receita' : 'Despesa'} · ${c.name}` })) },
    { name: 'description', label: 'Descrição', required: true },
    { name: 'amount', label: 'Valor (R$)', type: 'number', step: '0.01', required: true },
    { name: 'dueDate', label: 'Vencimento', type: 'date', def: dayISO(), required: true },
  ];
  return (
    <Sheet title="Nova conta" onClose={onClose}>
      <AddForm label="Cadastrar" fields={fields} onSubmit={async (v) => {
        const kind = cats.data?.find((c) => c.id === v.categoryId)?.kind;
        await api('/finance/transactions', { method: 'POST', json: { type: kind, categoryId: v.categoryId, description: v.description, amount: v.amount, competenceDate: v.dueDate, dueDate: v.dueDate } });
        onDone();
      }} />
    </Sheet>
  );
}

// ---------- Bancos ----------
function Banks({ banks, onChanged }: { banks: ReturnType<typeof useLoad<Bank[]>>; onChanged: () => void }) {
  const integ = useLoad<{ asaas: { configured: boolean; sandbox: boolean } }>('/integrations');
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Bank | null>(null);
  const toast = useToast();
  const { hidden } = useHideValues();
  const list = banks.data ?? [];
  const active = list.filter((b) => b.active);
  const total = active.reduce((a, b) => a + b.balance, 0);
  return (
    <>
      <PageHead title="Bancos" hint="Onde o dinheiro cai"><button className="primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Adicionar banco</button></PageHead>
      <Status error={banks.error} loading={!banks.data} />
      {banks.data && (
        <section className="hero-card bank-total">
          <div className="hero-main"><span>Saldo total em contas <EyeToggle className="on-dark inline" /></span><strong>{mask(brl(total), hidden)}</strong><span className="delta flat">{active.length} conta(s) ativa(s)</span></div>
        </section>
      )}
      {banks.data && list.length === 0 && (
        <section className="card"><Empty icon="bank" title="Nenhuma conta cadastrada" text="Cadastre os bancos onde a clínica recebe. Ao dar baixa em um recebimento, você escolhe em qual conta o dinheiro caiu e o saldo de cada uma é acompanhado.">
          <button className="primary sm" onClick={() => setAdding(true)}>Adicionar banco</button></Empty></section>
      )}
      <ul className="bank-list">{list.map((b) => (
        <li key={b.id}>
          <button className={`bank-card ${b.active ? '' : 'off'}`} onClick={() => setEdit(b)}>
            <span className="bank-logo" aria-hidden="true">{b.institution.slice(0, 2).toUpperCase()}</span>
            <span className="grow"><b>{b.name}</b><span className="muted">{b.institution} · {KIND[b.kind]}{b.last4 ? ` · final ${b.last4}` : ''}</span>
              <span className="bank-pills">{b.isDefault && <span className="pill ok">Padrão</span>}{b.pixKeyMasked && <span className="pill">Pix {b.pixKeyMasked}</span>}{!b.active && <span className="pill warn">Arquivada</span>}</span></span>
            <strong>{mask(brl(b.balance), hidden)}</strong>
          </button>
        </li>
      ))}</ul>
      <HowItWorks auto={integ.data?.asaas ?? null} />
      {adding && <BankSheet onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); onChanged(); toast(m); }} />}
      {edit && <BankSheet bank={edit} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); onChanged(); toast(m); }} />}
    </>
  );
}

function BankSheet({ bank, onClose, onDone }: { bank?: Bank; onClose: () => void; onDone: (msg: string) => void }) {
  const [err, setErr] = useState('');
  const act = async (json: object, msg: string) => { setErr(''); try { await api(`/banks/${bank!.id}`, { method: 'PATCH', json }); onDone(msg); } catch (e) { setErr(errText(e)); } };
  const fields: Field[] = [
    { name: 'name', label: 'Apelido da conta (ex.: Nubank PJ)', def: bank?.name, required: true },
    { name: 'institution', label: 'Banco', type: 'select', def: bank?.institution ?? '', required: true, options: INSTITUTIONS.map((i) => ({ value: i, label: i })) },
    { name: 'kind', label: 'Tipo', type: 'select', def: bank?.kind ?? 'checking', required: true, options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
    { name: 'last4', label: 'Final da conta (4 últimos dígitos, opcional)', def: bank?.last4 ?? '' },
    { name: 'pixKeyType', label: bank?.pixKeyMasked ? 'Trocar chave Pix: tipo' : 'Tipo da chave Pix (para cobrar por Pix)', type: 'select', options: PIX_TYPES },
    { name: 'pixKey', label: bank?.pixKeyMasked ? `Nova chave Pix (atual: ${bank.pixKeyMasked})` : 'Chave Pix' },
    ...(bank ? [] : [{ name: 'openingBalance', label: 'Saldo atual da conta (R$)', type: 'number' as const, step: '0.01', def: '0' }]),
    { name: 'isDefault', label: 'Usar como conta padrão para recebimentos', type: 'checkbox', def: bank?.isDefault ?? false },
  ];
  return (
    <Sheet title={bank ? bank.name : 'Adicionar banco'} onClose={onClose}>
      {!bank && <p className="muted">Não pedimos senha nem número completo da conta: só o que é preciso para acompanhar saldos e gerar cobranças por Pix.</p>}
      <AddForm label={bank ? 'Salvar alterações' : 'Adicionar'} fields={fields}
        onSubmit={async (v) => {
          if (bank) { await api(`/banks/${bank.id}`, { method: 'PATCH', json: v }); onDone('Conta atualizada'); }
          else { await api('/banks', { method: 'POST', json: v }); onDone('Banco adicionado'); }
        }} />
      {bank && (
        <div className="danger-zone">
          {bank.pixKeyMasked && <ConfirmButton label="Remover chave Pix" confirm="Confirmar remoção" onConfirm={() => act({ pixKey: '' }, 'Chave Pix removida')}
            text={`Sem chave, esta conta não gera cobranças por Pix até você cadastrar outra (atual: ${bank.pixKeyMasked}).`} />}
          {bank.active
            ? <ConfirmButton label="Arquivar conta" confirm="Confirmar arquivamento" onConfirm={() => act({ active: false }, 'Conta arquivada')}
                text="A conta deixa de receber cobranças e vai para o fim da lista. O histórico de lançamentos é mantido e você pode reativá-la depois." />
            : <button className="ghost" onClick={() => act({ active: true }, 'Conta reativada')}>Reativar conta</button>}
          {err && <p role="alert" className="err">{err}</p>}
        </div>
      )}
    </Sheet>
  );
}

// Como os pagamentos entram hoje e o que vem depois (honesto sobre o que é manual).
function HowItWorks({ auto }: { auto: { configured: boolean; sandbox: boolean } | null }) {
  const rows: { icon: IconName; title: string; text: string; state: string; ok?: boolean }[] = [
    { icon: 'qr', title: 'Pix copia e cola e QR Code', text: 'Gere a cobrança em Contas → Cobrar por Pix e envie ao paciente. Cai direto na sua conta, sem taxa de intermediário.', state: 'Disponível', ok: true },
    { icon: 'wallet', title: 'Cartão, dinheiro e transferência', text: 'Dê baixa em Receber escolhendo a conta onde o valor entrou (maquininha, caixa ou banco).', state: 'Registro manual', ok: true },
    auto?.configured
      ? { icon: 'bank', title: 'Confirmação automática (Asaas)', text: 'Cobrar por Pix cria a cobrança no Asaas: quando o paciente paga, a conta é baixada sozinha e a tarifa é lançada. O dinheiro cai na conta digital do Asaas (aparece acima).', state: auto.sandbox ? 'Ativa · modo teste' : 'Ativa', ok: true }
      : { icon: 'bank', title: 'Confirmação automática (Asaas)', text: 'Cobra por Pix e dá a baixa sozinho quando o paciente paga. Falta conectar a conta do Asaas: o proprietário faz isso em Configurações → Pagamentos.', state: 'Não conectado' },
  ];
  return (
    <section className="card">
      <h2>Como os pagamentos chegam</h2>
      <ul className="rows how">{rows.map((r) => (
        <li key={r.title}><div className="row-btn static"><span className="q-ico"><Icon name={r.icon} size={20} /></span>
          <span className="grow"><b>{r.title}</b><span className="muted wrap">{r.text}</span></span><span className={`pill ${r.ok ? 'ok' : ''}`}>{r.state}</span></div></li>
      ))}</ul>
    </section>
  );
}

// ---------- DRE ----------
function Dre({ dre }: { dre: ReturnType<typeof useLoad<any>> }) {
  const { hidden } = useHideValues();
  const r = dre.data;
  const line = (label: string, v: number, strong = false) => (
    <tr className={strong ? 'strong' : ''}><td>{label}</td><td className={v < 0 ? 'neg' : ''}>{mask(brl(v || 0), hidden)}</td>{/* -0 virava "-R$ 0,00" */}</tr>
  );
  const parts = r ? [
    { name: 'Deduções', value: r.deducoes }, { name: 'Custos variáveis', value: r.custosVariaveis }, { name: 'Despesas operacionais', value: r.despesasOperacionais },
    { name: 'Despesas financeiras', value: r.despesasFinanceiras }, { name: 'Impostos sobre o lucro', value: r.impostosLucro }].filter((p) => p.value > 0) : [];
  const sum = parts.reduce((a, p) => a + p.value, 0);
  return (
    <>
      <Status error={dre.error} loading={!r} />
      {r && (
        <>
          <section className="card">
            <h2>Para onde vai o dinheiro</h2>
            {sum === 0 ? <Empty icon="chart" title="Sem despesas no mês" text="Quando houver custos e despesas, a divisão aparece aqui." /> : (
              <div className="donut-row">
                <div className="donut" role="img" aria-label="Divisão das despesas por grupo">
                  <ResponsiveContainer width="100%" height={168}>
                    <PieChart><Pie data={parts} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="100%" cornerRadius={8} paddingAngle={parts.length > 1 ? 4 : 0} stroke="none" isAnimationActive={false}>
                      {parts.map((p, i) => <Cell key={p.name} fill={`var(--c${(i % 6) + 1})`} />)}</Pie></PieChart>
                  </ResponsiveContainer>
                  <div className="donut-total"><strong>{mask(brl(sum), hidden).replace(/R\$\s/, '')}</strong><span>em saídas</span></div>
                </div>
                <ul className="legend">{parts.map((p, i) => (
                  <li key={p.name}><i style={{ background: `var(--c${(i % 6) + 1})` }} /><span>{p.name}</span><b>{Math.round((p.value / sum) * 100)}%</b></li>
                ))}</ul>
              </div>
            )}
          </section>
          <section className="card">
            <h2>DRE</h2>
            <table className="dre"><tbody>
              {line('Receita bruta', r.receitaBruta)}
              {line('(−) Deduções', -r.deducoes)}
              {line('Receita líquida', r.receitaLiquida, true)}
              {line('(−) Custos variáveis', -r.custosVariaveis)}
              {line('Lucro bruto', r.lucroBruto, true)}
              {line('(−) Despesas operacionais', -r.despesasOperacionais)}
              {line('Resultado operacional', r.resultadoOperacional, true)}
              {line('(−) Despesas financeiras', -r.despesasFinanceiras)}
              {line('(−) Impostos sobre o lucro', -r.impostosLucro)}
              {line('Lucro líquido', r.lucroLiquido, true)}
            </tbody></table>
          </section>
        </>
      )}
    </>
  );
}
