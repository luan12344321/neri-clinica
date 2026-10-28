// Cliente mínimo da API do Gemini (generateContent) via fetch: sem SDK, a chave só existe no servidor (GEMINI_API_KEY).
export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const BASE = process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(status, message) { super(message); this.name = 'GeminiError'; this.status = status; }
}
export class BudgetError extends Error {
  constructor(scope) { super(`orçamento mensal de IA esgotado (${scope})`); this.name = 'BudgetError'; this.scope = scope; }
}

// req: { system, tools: [{name, description, parameters?}], contents: [{role, parts}], maxOutputTokens? }
// devolve { parts, usage: { input, output } } com as partes da resposta do modelo, sem alterá-las (inclui functionCall).
export async function generate({ system, tools, contents, maxOutputTokens = 2048 }, { timeout = 30_000 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError(0, 'GEMINI_API_KEY não configurada');
  const body = {
    contents,
    generationConfig: { maxOutputTokens },
    ...(system && { systemInstruction: { parts: [{ text: system }] } }),
    ...(tools?.length && { tools: [{ functionDeclarations: tools }] }),
  };
  const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new GeminiError(res.status, `Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const u = json.usageMetadata ?? {};
  const input = u.promptTokenCount ?? 0;
  return {
    parts: json.candidates?.[0]?.content?.parts ?? [], // vazio quando o conteúdo é bloqueado pelos filtros do provedor
    usage: { input, output: Math.max(0, (u.totalTokenCount ?? input) - input) }, // saída inclui tokens de raciocínio (também cobrados)
  };
}
