import { useEffect, useState } from 'react';
import { ApiError, api } from './api';

// Versão dos termos. Mudou o texto de forma relevante? Suba a versão aqui e em backend/src/app.js (TERMS_VERSION):
// todos os usuários precisam aceitar de novo no próximo acesso.
export const TERMS_VERSION = '2026-10';
const PROVIDER = 'NERI Design & Web';

type Doc = { title: string; updated: string; sections: { h: string; p: string[] }[] };

const TERMS: Doc = {
  title: 'Termos de Uso',
  updated: 'outubro de 2026',
  sections: [
    { h: '1. O que é o NERI Clínica', p: [
      `O NERI Clínica é um sistema de gestão para clínicas de estética e procedimentos injetáveis (agenda, pacientes, prontuário, estoque, financeiro, retornos e assistente Julia), oferecido por ${PROVIDER} ("Fornecedora") à clínica contratante ("Clínica").` ] },
    { h: '2. Quem pode usar', p: [
      'O acesso é pessoal e intransferível. O proprietário da Clínica cadastra a equipe e define o perfil de cada pessoa (proprietário, gerente, profissional ou recepção). A Clínica responde pelo uso feito com as credenciais da sua equipe e deve manter senhas fortes e sigilosas.' ] },
    { h: '3. Responsabilidade clínica e profissional', p: [
      'O sistema organiza informações e sugere rotinas (por exemplo, intervalos de retorno e baixa de estoque). Ele não faz diagnóstico, não indica conduta e não substitui o julgamento do profissional de saúde. As decisões clínicas, o preenchimento do prontuário, a escolha dos produtos, lotes e doses são sempre do profissional responsável.',
      'A Clínica é responsável por cumprir as normas aplicáveis à sua atividade (conselhos profissionais, Anvisa e vigilância sanitária), inclusive quanto a rastreabilidade de produtos e guarda de documentos.' ] },
    { h: '4. A assistente Julia (inteligência artificial)', p: [
      'A Julia usa um modelo de inteligência artificial de terceiros para responder perguntas e executar tarefas dentro das permissões do usuário. Ela pode errar. Confira as informações importantes e confirme antes de agendar, remarcar ou cancelar.',
      'A Julia não deve ser usada para diagnóstico ou conduta clínica. Cada consulta ao prontuário feita pela Julia é registrada.' ] },
    { h: '5. WhatsApp e contato com pacientes', p: [
      'A Clínica é responsável por obter e registrar a autorização do paciente para cada finalidade de contato (retorno, aniversário, marketing) e por respeitar o pedido de quem deixar de querer receber mensagens. O sistema registra as autorizações e só mostra o contato quando há autorização, mas a decisão de enviar é da Clínica.',
      'O uso do WhatsApp Business depende das regras da Meta, incluindo a verificação do negócio e o número dedicado.' ] },
    { h: '6. Dados da Clínica e dos pacientes', p: [
      'Os dados cadastrados pertencem à Clínica. Para a Lei Geral de Proteção de Dados (LGPD), a Clínica é a controladora e a Fornecedora atua como operadora, tratando os dados somente para prestar o serviço. Veja a Política de Privacidade.' ] },
    { h: '7. Disponibilidade e backup', p: [
      'A Fornecedora busca manter o serviço disponível, mas não garante funcionamento ininterrupto. Pode haver manutenção, falhas de provedores de internet, hospedagem, banco de dados ou serviços de terceiros. Recomenda-se que a Clínica mantenha cópias de dados essenciais, como exportações e documentos.' ] },
    { h: '8. Uso proibido', p: [
      'É proibido tentar acessar dados de outras clínicas, burlar permissões, sobrecarregar o serviço, copiar o sistema ou usá-lo para fins ilícitos.' ] },
    { h: '9. Preço, vigência e cancelamento', p: [
      'Valores, prazos, forma de pagamento e cancelamento seguem o contrato ou a proposta comercial firmada com a Clínica. Ao fim do contrato, a Clínica pode solicitar a exportação dos seus dados antes da exclusão, conforme a Política de Privacidade.' ] },
    { h: '10. Alterações e contato', p: [
      `Estes termos podem ser atualizados. Mudanças relevantes pedem novo aceite no acesso seguinte. Dúvidas: fale com o suporte da ${PROVIDER} pelo canal informado no seu contrato.` ] },
  ],
};

const PRIVACY: Doc = {
  title: 'Política de Privacidade',
  updated: 'outubro de 2026',
  sections: [
    { h: '1. Quem é quem', p: [
      `A Clínica contratante é a controladora dos dados dos seus pacientes e da sua equipe. A ${PROVIDER} é operadora: trata esses dados apenas para fornecer o sistema, seguindo as instruções da Clínica.` ] },
    { h: '2. Quais dados são tratados', p: [
      'Equipe: nome, e-mail, perfil de acesso, senha (guardada apenas em formato protegido, nunca em texto) e registros de uso, como horário de acesso e ações importantes.',
      'Pacientes: nome, telefone, data de nascimento, CPF, histórico de atendimentos, procedimentos, produtos e lotes aplicados, fotos de etiquetas de produtos, registros de prontuário (incluindo alergias e evolução), autorizações de contato e dados financeiros relacionados.',
      'Dados de saúde são dados pessoais sensíveis e recebem cuidado reforçado.' ] },
    { h: '3. Para que usamos', p: [
      'Para agendar e registrar atendimentos, controlar estoque e rastreabilidade, gerar cobranças e relatórios financeiros, sugerir e acompanhar retornos, enviar mensagens autorizadas e permitir que a equipe consulte informações pela Julia dentro das suas permissões.' ] },
    { h: '4. Segurança', p: [
      'CPF, prontuário, comprovantes de rastreabilidade, fotos de etiquetas e credenciais de integrações são cifrados no banco de dados. Cada clínica enxerga apenas os seus dados. O acesso depende de login e do perfil do usuário, e ações sensíveis ficam registradas em histórico de auditoria. A comunicação usa conexão segura (HTTPS).' ] },
    { h: '5. Com quem os dados podem ser compartilhados', p: [
      'Somente com os serviços necessários ao funcionamento, quando a Clínica os ativa ou quando fazem parte da infraestrutura: hospedagem (Vercel), banco de dados (Neon), inteligência artificial da Julia (Google Gemini), WhatsApp (Meta), cobrança Pix (Asaas) e Google Agenda (Google). Esses serviços podem processar dados fora do Brasil, com salvaguardas previstas na LGPD.',
      'Quando a Julia responde uma pergunta, o trecho necessário da conversa e dos dados consultados é enviado ao serviço de inteligência artificial. Não vendemos dados.' ] },
    { h: '6. Por quanto tempo guardamos', p: [
      'Os dados ficam armazenados enquanto durar o contrato e pelo período que a Clínica precisar para cumprir obrigações legais e regulatórias, como a guarda de prontuário. Após o encerramento, a Clínica pode pedir a exportação e a exclusão, ressalvadas as obrigações de guarda. Conversas do WhatsApp com a Julia e registros técnicos têm retenção definida pela Clínica junto à Fornecedora.' ] },
    { h: '7. Direitos do titular', p: [
      'Pacientes e usuários podem pedir confirmação do tratamento, acesso, correção, anonimização, portabilidade, informação sobre compartilhamento e a revogação de autorizações (como receber mensagens). O pedido deve ser feito à Clínica, que é a controladora; a Fornecedora apoia o atendimento.' ] },
    { h: '8. Incidentes', p: [
      'Em caso de incidente de segurança que possa causar risco relevante, a Fornecedora avisa a Clínica para que sejam tomadas as providências previstas na LGPD.' ] },
    { h: '9. Contato', p: [
      `Dúvidas sobre privacidade: fale com a Clínica ou com o suporte da ${PROVIDER} pelo canal informado no contrato.` ] },
  ],
};

export type LegalKind = 'termos' | 'privacidade';
export const legalFromHash = (h: string): LegalKind | null => (h === '#/termos' ? 'termos' : h === '#/privacidade' ? 'privacidade' : null);

export function LegalPage({ kind }: { kind: LegalKind }) {
  const doc = kind === 'termos' ? TERMS : PRIVACY;
  const other = kind === 'termos' ? { href: '#/privacidade', label: 'Política de Privacidade' } : { href: '#/termos', label: 'Termos de Uso' };
  return (
    <main className="legal" aria-labelledby="legal-title">
      <a className="back" href="#/" onClick={(e) => { e.preventDefault(); history.pushState(null, '', location.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); }}>← Voltar</a>
      <h1 id="legal-title">{doc.title}</h1>
      <p className="muted">NERI Clínica · atualizado em {doc.updated} · versão {TERMS_VERSION}</p>
      {doc.sections.map((s) => (
        <section key={s.h}><h2>{s.h}</h2>{s.p.map((t) => <p key={t}>{t}</p>)}</section>
      ))}
      <p><a href={other.href}>{other.label}</a></p>
    </main>
  );
}

export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <p className={`legal-links ${className}`}>
      <a href="#/termos">Termos de Uso</a><span aria-hidden="true"> · </span><a href="#/privacidade">Política de Privacidade</a>
    </p>
  );
}

// Aceite obrigatório no primeiro acesso (e quando a versão muda). Fica gravado com data e versão.
export function TermsGate({ onAccepted }: { onAccepted: () => void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { document.body.classList.add('modal-open'); return () => document.body.classList.remove('modal-open'); }, []);
  async function accept() {
    setBusy(true); setErr('');
    try { await api('/me/terms', { method: 'POST', json: { version: TERMS_VERSION } }); onAccepted(); }
    catch (e) { setErr(e instanceof ApiError && e.status < 500 ? e.message : 'Não foi possível registrar o aceite. Tente novamente.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-title">
      <div className="card">
        <h2 id="terms-title">Antes de continuar</h2>
        <p>Para usar o NERI Clínica, leia e aceite os documentos abaixo. Eles explicam como o sistema funciona e como os dados dos pacientes são protegidos.</p>
        <p className="legal-links"><a href="#/termos">Termos de Uso</a><span aria-hidden="true"> · </span><a href="#/privacidade">Política de Privacidade</a></p>
        <label className="terms-check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Li e aceito os Termos de Uso e a Política de Privacidade.</span>
        </label>
        {err && <p role="alert" className="err">{err}</p>}
        <button className="primary" disabled={!ok || busy} onClick={accept}>{busy ? 'Salvando…' : 'Aceitar e continuar'}</button>
      </div>
    </div>
  );
}
