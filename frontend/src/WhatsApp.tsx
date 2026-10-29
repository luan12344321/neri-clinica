import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import Mascote from './Mascote';
import { Avatar, Empty, ListSkeleton, useToast } from './ui';

export type Conversation = { contact: string; name: string | null; patient: string | null; human: boolean; reason: string | null;
  last_body: string; last_direction: 'in' | 'out'; last_at: string; unread: number };
type Msg = { id: number; direction: 'in' | 'out'; body: string; created_at: string; staff: boolean };

export const BASE = '/integrations/whatsapp/conversations';
const phoneLabel = (d: string) => (d.startsWith('55') && d.length >= 12 ? `+55 (${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}` : `+${d}`);
const title = (c: Conversation) => c.patient ?? c.name ?? phoneLabel(c.contact);
const clock = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function stamp(iso: string) {
  const d = new Date(iso), today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(iso);
  const yest = new Date(today.getTime() - 864e5);
  if (d.toDateString() === yest.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
const dayLabel = (iso: string) => {
  const d = new Date(iso), t = stamp(iso);
  return t.includes(':') ? 'Hoje' : t === 'Ontem' ? t : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
};

// Caixa de entrada do WhatsApp da clínica: a equipe vê as conversas, responde e, ao responder, a Julia fica pausada naquele contato.
export default function WhatsApp({ list }: { list: { data: Conversation[] | null; error: string; reload: () => void } }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);

  const total = useMemo(() => (list.data ?? []).reduce((n, c) => n + c.unread, 0), [list.data]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase(), digits = t.replace(/\D/g, '');
    return (list.data ?? []).filter((c) => (!onlyUnread || c.unread > 0)
      && (!t || title(c).toLowerCase().includes(t) || (digits && c.contact.includes(digits))));
  }, [list.data, q, onlyUnread]);
  const active = list.data?.find((c) => c.contact === current) ?? null;

  return (
    <div className={`wa${active ? ' has-chat' : ''}`}>
      <section className="wa-list" aria-label="Conversas">
        <JuliaSwitch />
        <div className="wa-tools">
          <label className="wa-search">
            <Icon name="search" size={18} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome ou telefone" aria-label="Buscar conversa" />
          </label>
          <button className={`chip${onlyUnread ? ' on' : ''}`} aria-pressed={onlyUnread} onClick={() => setOnlyUnread((v) => !v)}>
            Não lidas{total > 0 ? ` (${total})` : ''}
          </button>
        </div>
        <div className="wa-scroll">
          {!list.data && !list.error && <ListSkeleton rows={5} />}
          {list.error && !list.data && <p role="alert" className="err">Não foi possível carregar as conversas.</p>}
          {list.data && !shown.length && (
            <Empty icon="mail" title={list.data.length ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}
              text={list.data.length ? undefined : 'Quando um cliente escrever para o WhatsApp da clínica, a conversa aparece aqui.'} />
          )}
          {shown.map((c) => (
            <button key={c.contact} className="wa-row" aria-current={c.contact === current ? 'true' : undefined} onClick={() => setCurrent(c.contact)}>
              <Avatar name={title(c)} size={46} />
              <span className="wa-row-main">
                <span className="wa-row-top"><b>{title(c)}</b><time dateTime={c.last_at}>{stamp(c.last_at)}</time></span>
                <span className="wa-row-bottom">
                  <span className="wa-preview">{c.last_direction === 'out' ? 'Você: ' : ''}{c.last_body}</span>
                  {c.unread > 0 && <span className="wa-badge" aria-label={`${c.unread} não lidas`}>{c.unread}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="wa-chat" aria-label="Conversa aberta">
        {active
          ? <Thread key={active.contact} conv={active} onBack={() => setCurrent(null)} onChanged={list.reload} />
          : <div className="wa-blank"><Empty icon="mail" title="Escolha uma conversa" text="As mensagens dos clientes aparecem aqui. Ao responder, a Julia para de atender essa conversa." /></div>}
      </section>
    </div>
  );
}

// Fora do expediente a Julia atende sozinha (travado). No expediente a recepção liga para ajudar só hoje; desliga a qualquer hora.
function JuliaSwitch() {
  const st = useLoad<{ open: boolean; help: boolean; active: boolean }>('/integrations/whatsapp/julia', 60_000);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!st.data) return null;
  const { open, help } = st.data;
  async function flip() {
    setBusy(true);
    try { await api('/integrations/whatsapp/julia', { method: 'PUT', json: { help: !help } }); st.reload(); toast(help ? 'Julia desligada. Só a recepção responde.' : 'Julia ajudando no atendimento hoje.'); }
    catch { toast('Não foi possível mudar. Tente de novo.'); }
    finally { setBusy(false); }
  }
  const on = !open || help;
  return (
    <div className={`wa-julia${on ? ' on' : ''}`}>
      <span className="wa-julia-ico"><Mascote variant="head" size={34} mood={on ? 'happy' : 'idle'} label="" /></span>
      <div className="wa-julia-text">
        <b>{!open ? 'Julia atendendo' : help ? 'Julia ajudando hoje' : 'Julia desligada'}</b>
        <span className="muted">{!open ? 'Fora do expediente ela responde todas as mensagens.' : help ? 'Responde os contatos que você não assumir. Desliga sozinha à meia-noite.' : 'Só a recepção responde. Ligue em dia corrido.'}</span>
      </div>
      <button role="switch" aria-checked={on} aria-label="Julia no WhatsApp" className="switch" disabled={!open || busy} onClick={flip}><span /></button>
    </div>
  );
}

function Thread({ conv, onBack, onChanged }: { conv: Conversation; onBack: () => void; onChanged: () => void }) {
  const toast = useToast();
  const msgs = useLoad<Msg[]>(`${BASE}/${conv.contact}/messages`, 8_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const count = msgs.data?.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);
  useEffect(() => { if (count) onChanged(); }, [count]); // eslint-disable-line react-hooks/exhaustive-deps -- a abertura marca como lida: atualiza a lista

  const lastIn = [...(msgs.data ?? [])].reverse().find((m) => m.direction === 'in');
  const expired = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() > 24 * 3600_000;

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    try { await api(`${BASE}/${conv.contact}/messages`, { method: 'POST', json: { text: body } }); setText(''); msgs.reload(); onChanged(); }
    catch (x) { setErr(x instanceof ApiError && x.status < 500 && x.detail ? x.detail : 'Não foi possível enviar. Tente de novo.'); }
    finally { setBusy(false); }
  }
  async function giveBack() {
    try { await api(`/integrations/whatsapp/contacts/${conv.contact}/resume`, { method: 'POST', json: {} }); toast('A Julia voltou a atender esta conversa.'); onChanged(); }
    catch { toast('Não foi possível devolver para a Julia.'); }
  }

  let lastDay = '';
  return (
    <div className="wa-thread">
      <header className="wa-head">
        <button className="icon-btn wa-back" aria-label="Voltar para as conversas" onClick={onBack}><Icon name="back" /></button>
        <Avatar name={title(conv)} size={42} />
        <div className="wa-head-main">
          <b>{title(conv)}</b>
          <span className="muted">{phoneLabel(conv.contact)} · {conv.human ? 'Equipe atendendo' : 'Julia atendendo'}</span>
        </div>
        {conv.human && <button className="ghost" onClick={giveBack}>Devolver para a Julia</button>}
      </header>

      <div className="wa-log" role="log" aria-live="polite">
        {!msgs.data && !msgs.error && <ListSkeleton rows={3} />}
        {msgs.error && !msgs.data && <p role="alert" className="err">Não foi possível carregar a conversa.</p>}
        {msgs.data?.map((m) => {
          const day = dayLabel(m.created_at), showDay = day !== lastDay; lastDay = day;
          return (
            <div key={m.id} className="wa-msg-wrap">
              {showDay && <p className="wa-day"><span>{day}</span></p>}
              <div className={`wa-msg ${m.direction === 'in' ? 'in' : 'out'}`}>
                {m.direction === 'out' && <small className="wa-who">{m.staff ? 'Equipe' : 'Julia'}</small>}
                <span>{m.body}</span>
                <time dateTime={m.created_at}>{clock(m.created_at)}</time>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      {expired
        ? <p className="wa-note">Passaram mais de 24h desde a última mensagem do cliente. O WhatsApp só permite responder dentro desse prazo.</p>
        : (
          <form className="wa-compose" onSubmit={send}>
            {err && <p role="alert" className="err">{err}</p>}
            <div className="wa-compose-row">
              <textarea value={text} rows={1} maxLength={2000} placeholder="Digite uma mensagem" aria-label="Mensagem"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
              <button className="primary wa-send" disabled={busy || !text.trim()} aria-label="Enviar"><Icon name="send" size={20} /></button>
            </div>
            {!conv.human && <p className="muted wa-hint">Ao enviar, a Julia para de responder esta conversa por 12 horas.</p>}
          </form>
        )}
    </div>
  );
}
