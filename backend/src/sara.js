import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { q } from './db.js';
import { getRevenueByMonth, getTopProcedures, getFinanceSummary, getRestock, getInsights, buildDre } from './queries.js';

let defaultClient; // criado sob demanda (lê ANTHROPIC_API_KEY)
const MODEL = process.env.SARA_MODEL ?? 'claude-sonnet-5-5';

const SYSTEM = `Você é Sara, assistente interna de gestão de uma clínica médica/estética.
Fale em português do Brasil, de forma objetiva. Use SEMPRE as ferramentas para obter números; nunca invente dados.
Formate valores em R$. Se faltar dado, diga isso. Você só lê dados e não executa ações.`;

// Ferramentas fixas e somente-leitura: a IA NÃO escreve SQL. clinic_id vem do token, nunca do modelo.
const TOOLS = [
  { name: 'revenue_by_month', description: 'Faturamento e nº de pacientes atendidos por mês.',
    input_schema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['months'] },
    run: (c, i) => getRevenueByMonth(c, i.months) },
  { name: 'top_procedures', description: 'Procedimentos mais realizados nos últimos N meses.',
    input_schema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['months'] },
    run: (c, i) => getTopProcedures(c, i.months) },
  { name: 'finance_summary', description: 'Receitas, despesas, saldo e ticket médio de um mês (YYYY-MM).',
    input_schema: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } }, required: ['month'] },
    run: (c, i) => getFinanceSummary(c, `${i.month}-01`) },
  { name: 'dre', description: 'DRE do mês (YYYY-MM).',
    input_schema: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } }, required: ['month'] },
    run: (c, i) => buildDre(c, `${i.month}-01`) },
  { name: 'restock', description: 'Produtos abaixo do estoque mínimo e quanto repor.',
    input_schema: { type: 'object', properties: {} }, run: (c) => getRestock(c) },
  { name: 'business_insights', description: 'Sugestões automáticas (ticket médio, margem, inadimplência).',
    input_schema: { type: 'object', properties: {} }, run: (c) => getInsights(c) },
];
const toolDefs = TOOLS.map(({ run, ...def }) => def);

export async function askSara({ clinicId, userId, message, conversationId = randomUUID(), client = (defaultClient ??= new Anthropic()) }) {
  const history = await q(
    `SELECT role, content FROM (SELECT id, role, content FROM sara_messages
       WHERE conversation_id=$1 AND clinic_id=$2 ORDER BY id DESC LIMIT 20) t ORDER BY id`, [conversationId, clinicId]);
  const messages = [...history, { role: 'user', content: message }];
  const save = (role, content, usage) => q(
    `INSERT INTO sara_messages (clinic_id,user_id,conversation_id,role,content,tokens_in,tokens_out)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [clinicId, userId, conversationId, role, JSON.stringify(content), usage?.input_tokens ?? null, usage?.output_tokens ?? null]);
  await save('user', message);

  // Funções serverless têm tempo máximo por requisição: a Sara para de consultar antes de estourá-lo.
  const deadline = Date.now() + Number(process.env.SARA_BUDGET_MS ?? 40_000);
  for (let step = 0; step < 6 && Date.now() < deadline; step++) {   // limite de iterações e de tempo
    const res = await client.messages.create({
      model: MODEL, max_tokens: 1500, system: SYSTEM, tools: toolDefs, messages },
      { timeout: Math.max(1000, deadline - Date.now()) });
    messages.push({ role: 'assistant', content: res.content });
    await save('assistant', res.content, res.usage);

    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { conversationId, reply: text };
    }
    const results = [];
    for (const b of res.content.filter((x) => x.type === 'tool_use')) {
      let out, isError = false;
      try { out = await TOOLS.find((t) => t.name === b.name).run(clinicId, b.input); }
      catch (e) { out = { error: e.message }; isError = true; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), is_error: isError });
    }
    messages.push({ role: 'user', content: results });
    await save('user', results);
  }
  return { conversationId, reply: 'Não consegui concluir a consulta a tempo. Tente uma pergunta mais específica.' };
}
