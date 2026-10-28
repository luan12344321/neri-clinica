// Teste de conexão real com o Gemini. Uso (a chave vem do ambiente, nunca de argumento):
//   node --env-file=.env scripts/gemini-check.js
// Faz 3 passos pequenos: (1) o modelo existe para esta chave, (2) uma chamada simples, (3) uma chamada com declaração de
// ferramenta e o retorno do resultado dela. Imprime só OK/FALHA e erros sanitizados; não toca em banco, login ou permissões.
import { generate, MODEL } from '../src/gemini.js';

const BASE = process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta';
const key = process.env.GEMINI_API_KEY;

// Nenhuma mensagem sai sem passar por aqui: remove a chave (e qualquer coisa com cara de chave do Google) e limita o tamanho.
const safe = (msg) => {
  let s = String(msg ?? '');
  if (key) s = s.split(key).join('[chave]');
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[chave]').replace(/\s+/g, ' ').slice(0, 220);
};
const fail = (step, e) => { console.log(`FALHA  ${step}: ${e?.status ? `HTTP ${e.status} · ` : ''}${safe(e?.message)}`); process.exitCode = 1; };
const ok = (step, extra = '') => console.log(`OK     ${step}${extra ? ` · ${extra}` : ''}`);

console.log(`Modelo: ${MODEL}`);
if (!key) { console.log('FALHA  GEMINI_API_KEY ausente neste ambiente (nada foi enviado)'); process.exit(1); }

// 1) o modelo está disponível para esta chave?
try {
  const res = await fetch(`${BASE}/models/${MODEL}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(res.status === 404 ? 'modelo não encontrado para esta chave' : (await res.text())), { status: res.status });
  const m = await res.json();
  const can = m.supportedGenerationMethods ?? [];
  if (can.length && !can.includes('generateContent')) throw new Error('o modelo não aceita generateContent');
  ok('modelo disponível');
} catch (e) { fail('modelo', e); process.exit(1); }

// 2) chamada simples
try {
  const r = await generate({ contents: [{ role: 'user', parts: [{ text: 'Responda somente com a palavra: ok' }] }] }, { timeout: 30_000 });
  const text = r.parts.filter((p) => p.text).map((p) => p.text).join('').trim();
  if (!text) throw new Error('resposta sem texto');
  ok('chamada simples', `${text.length} caracteres · tokens entrada ${r.usage.input} / saída ${r.usage.output}`);
} catch (e) { fail('chamada simples', e); }

// 3) ferramenta: o modelo pede a função, devolvemos o resultado e ele conclui com texto
try {
  const tools = [{ name: 'horarios_livres', description: 'Lista os horários livres de um dia.',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'] } }];
  const contents = [{ role: 'user', parts: [{ text: 'Quais horários livres existem em 2030-03-18? Use a ferramenta.' }] }];
  const a = await generate({ tools, contents }, { timeout: 30_000 });
  const call = a.parts.find((p) => p.functionCall)?.functionCall;
  if (call?.name !== 'horarios_livres') throw new Error('o modelo não chamou a ferramenta declarada');
  contents.push({ role: 'model', parts: a.parts }, { role: 'user', parts: [{ functionResponse: { name: call.name, response: { result: { slots: ['08:00', '08:30'] } } } }] });
  const b = await generate({ tools, contents }, { timeout: 30_000 });
  if (!b.parts.some((p) => p.text)) throw new Error('sem texto final depois do resultado da ferramenta');
  ok('chamada com ferramenta', `tokens entrada ${a.usage.input + b.usage.input} / saída ${a.usage.output + b.usage.output}`);
} catch (e) { fail('chamada com ferramenta', e); }

console.log(process.exitCode ? 'RESULTADO: com falhas' : 'RESULTADO: tudo certo');
