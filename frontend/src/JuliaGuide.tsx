import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { Icon } from './Icon';
import Mascote, { type Mood } from './Mascote';

// Julia como guia dentro do app: fica no canto, explica cada tela na primeira visita, avisa o que há para fazer
// e responde dúvidas sobre a tela atual (usa a mesma Julia do chat, via /sara/chat).
export type Nudge = { key: string; text: string; action?: { label: string; run: () => void } };
type Tip = { label: string; title: string; text: string; ask: string[] };

const TIPS: Record<string, Tip> = {
  inicio: { label: 'Início', title: 'Seu dia em um olhar', text: 'Aqui estão os atendimentos de hoje, o que precisa de atenção e os números do mês. Toque em um atendimento para registrar ou reagendar.',
    ask: ['O que significam os avisos de atenção?', 'Como registro um atendimento concluído?'] },
  agenda: { label: 'Agenda', title: 'Agenda', text: 'Veja o dia e toque em um horário livre para agendar. Em um atendimento aberto você reagenda, inicia e conclui. Não deixo marcar dois pacientes no mesmo horário.',
    ask: ['Como agendar um paciente?', 'Como remarcar um atendimento?'] },
  financeiro: { label: 'Financeiro', title: 'Financeiro', text: 'Resumo, contas a receber e a pagar, bancos e DRE. Lance as contas e marque como pagas para o saldo e o fluxo de caixa ficarem certos.',
    ask: ['Como lanço uma conta a receber?', 'O que é o DRE?'] },
  estoque: { label: 'Estoque e reposição', title: 'Estoque e reposição', text: 'Produtos abaixo do mínimo aparecem para repor. Registre entradas com lote e validade: é o que permite a rastreabilidade nos atendimentos.',
    ask: ['Como registro a entrada de um produto?', 'Para que serve o lote?'] },
  produtos: { label: 'Produtos', title: 'Produtos', text: 'Cadastre os produtos, o estoque mínimo e o custo. O custo ajuda a calcular a margem de cada procedimento.',
    ask: ['Como cadastro um produto novo?', 'Como defino o estoque mínimo?'] },
  pacientes: { label: 'Pacientes', title: 'Pacientes', text: 'Cadastre e busque pacientes. Na ficha ficam o prontuário, as autorizações de contato e os comprovantes dos produtos aplicados.',
    ask: ['Como cadastro um paciente?', 'Para que servem as autorizações?'] },
  procedimentos: { label: 'Procedimentos', title: 'Procedimentos', text: 'O catálogo da clínica: nome, preço e duração. A duração define o tamanho do horário na agenda. Aqui também ficam as regras de retorno.',
    ask: ['Como cadastro um procedimento?', 'Como funcionam as regras de retorno?'] },
  mensagens: { label: 'Mensagens', title: 'Mensagens automáticas', text: 'Mensagens de retorno e aniversário por WhatsApp. Só vão para quem autorizou o contato, e você controla o que fica ligado.',
    ask: ['Como funcionam as mensagens automáticas?', 'Quem recebe essas mensagens?'] },
  whatsapp: { label: 'WhatsApp', title: 'WhatsApp da clínica', text: 'As conversas dos clientes chegam aqui. Responda direto: quando você responde, eu paro de atender aquela conversa. Em dia corrido, ligue o botão da Julia para eu ajudar.',
    ask: ['Quando a Julia responde sozinha?', 'Como devolvo uma conversa para a Julia?'] },
  config: { label: 'Configurações', title: 'Configurações', text: 'Dados da clínica, horário de atendimento, equipe e integrações. O horário de atendimento define a agenda e quando a Julia atende sozinha no WhatsApp.',
    ask: ['Como mudo o horário de atendimento?', 'Como adiciono alguém da equipe?'] },
};

const seenKey = (u: string) => `neri.tips.${u}`;
const readSeen = (u: string): string[] => { try { return JSON.parse(localStorage.getItem(seenKey(u)) ?? '[]'); } catch { return []; } };
const markSeen = (u: string, v: string) => { try { localStorage.setItem(seenKey(u), JSON.stringify([...new Set([...readSeen(u), v])])); } catch { /* sem armazenamento: a dica volta */ } };
const NUDGE_EVERY = 30 * 60_000;
const nudgedAt = (k: string) => { try { return Number(sessionStorage.getItem(`neri.nudge.${k}`) ?? 0); } catch { return 0; } };
const markNudged = (k: string) => { try { sessionStorage.setItem(`neri.nudge.${k}`, String(Date.now())); } catch { /* ignora */ } };

type Bubble = { kind: 'tip' | 'nudge'; title: string; text: string; ask?: string[]; action?: Nudge['action']; nudgeKey?: string };
type Msg = { role: 'user' | 'julia'; text: string };

export default function JuliaGuide({ view, userKey, nudges }: { view: string; userKey: string; nudges: Nudge[] }) {
  const tip = TIPS[view];
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [talking, setTalking] = useState(false);
  const [failed, setFailed] = useState(false);
  const convo = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const showing = useRef(false);
  showing.current = !!bubble || open;

  // Falar um pouco quando aparece um balão.
  const say = useCallback((b: Bubble, ms: number) => {
    setBubble(b); setTalking(true);
    const t1 = setTimeout(() => setTalking(false), 2600);
    const t2 = setTimeout(() => setBubble((cur) => (cur === b ? null : cur)), ms);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // 1) Primeira visita a cada tela: explica o que dá para fazer ali.
  useEffect(() => {
    setBubble(null);
    if (!tip || readSeen(userKey).includes(view)) return;
    const t = setTimeout(() => { markSeen(userKey, view); say({ kind: 'tip', title: tip.title, text: tip.text, ask: tip.ask }, 30_000); }, 700);
    return () => clearTimeout(t);
  }, [view, userKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2) Avisos do que há para fazer (estoque, mensagens…): um por vez, sem repetir por 30 min e sem atrapalhar.
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 120_000); return () => clearInterval(id); }, []);
  const nudgeSig = nudges.map((n) => n.key + n.text).join('|');
  useEffect(() => {
    const n = nudges.find((x) => Date.now() - nudgedAt(x.key) > NUDGE_EVERY);
    if (!n) return;
    const t = setTimeout(() => {
      if (showing.current) return;
      markNudged(n.key);
      say({ kind: 'nudge', title: 'Tem coisa para fazer', text: n.text, action: n.action, nudgeKey: n.key }, 20_000);
    }, 6_000);
    return () => clearTimeout(t);
  }, [nudgeSig, view, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, open]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open && !bubble) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setBubble(null); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, bubble]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setOpen(true); setBubble(null); setText(''); setFailed(false);
    setMsgs((m) => [...m, { role: 'user', text: q }]); setBusy(true);
    try {
      const r = await api<{ conversationId: string; reply: string }>('/sara/chat', {
        method: 'POST', json: { message: `[O usuário está na tela "${tip?.label ?? view}" do aplicativo e pede ajuda para usá-la] ${q}`, conversationId: convo.current } });
      convo.current = r.conversationId;
      setMsgs((m) => [...m, { role: 'julia', text: r.reply }]);
      setTalking(true); setTimeout(() => setTalking(false), 3000);
    } catch (e) {
      const s = e instanceof ApiError ? e.status : 0;
      setFailed(true);
      setMsgs((m) => [...m, { role: 'julia', text: s === 429 ? 'Atingi o limite de uso por agora. Tente de novo daqui a pouco.' : s === 504 ? 'Demorei demais para responder. Tente uma pergunta mais curta.' : s === 503 ? 'Estou indisponível no momento. Avise o administrador da clínica.' : 'Não consegui responder agora.' }]);
    } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };

  const mood: Mood = busy ? 'think' : failed && open ? 'sad' : talking ? 'talk' : 'idle';
  return (
    <div className={`julia-guide v-${view}${open ? ' open' : ''}`}>
      {open && (
        <section className="jg-panel" role="dialog" aria-label="Ajuda da Julia">
          <header>
            <div><b>Julia</b><span className="muted">Ajuda: {tip?.label ?? view}</span></div>
            <button className="icon-btn" aria-label="Fechar ajuda" onClick={() => setOpen(false)}><Icon name="close" size={20} /></button>
          </header>
          <div className="jg-log" aria-live="polite">
            {!msgs.length && <p className="muted">{tip?.text ?? 'Como posso ajudar?'}</p>}
            {msgs.map((m, i) => <div key={i} className={`bubble ${m.role === 'user' ? 'user' : 'sara'}`}>{m.text}</div>)}
            {busy && <div className="bubble sara muted">Pensando…</div>}
            <div ref={end} />
          </div>
          {!msgs.length && tip && (
            <div className="jg-chips">{tip.ask.map((q) => <button key={q} className="chip" onClick={() => ask(q)}>{q}</button>)}</div>
          )}
          <form className="jg-form" onSubmit={submit}>
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Como faço…?" aria-label="Pergunte à Julia" />
            <button className="primary" disabled={busy || !text.trim()} aria-label="Enviar"><Icon name="send" size={18} /></button>
          </form>
        </section>
      )}

      {!open && bubble && (
        <div className="jg-bubble" role="status">
          <button className="jg-x" aria-label="Fechar dica" onClick={() => setBubble(null)}><Icon name="close" size={16} /></button>
          <b>{bubble.title}</b>
          <p>{bubble.text}</p>
          <div className="jg-actions">
            {bubble.action && <button className="primary sm" onClick={() => { bubble.action!.run(); setBubble(null); }}>{bubble.action.label}</button>}
            <button className="ghost sm" onClick={() => { setOpen(true); setBubble(null); }}>Perguntar</button>
          </div>
        </div>
      )}

      <button className="jg-btn" aria-label={open ? 'Fechar ajuda da Julia' : 'Abrir ajuda da Julia'} aria-expanded={open}
        onClick={() => { setBubble(null); setOpen((o) => !o); }}>
        <Mascote variant="full" size={104} mood={mood} label="" />
        <span className="jg-q" aria-hidden="true">?</span>
      </button>
    </div>
  );
}
