// Cliente mínimo da API v3 do Asaas (https://docs.asaas.com). Credenciais só por variável de ambiente:
//   ASAAS_API_KEY        chave de API (sandbox: começa com $aact_hmlg_; produção: $aact_prod_)
//   ASAAS_WEBHOOK_TOKEN  segredo (32 a 255 caracteres) que o Asaas envia no cabeçalho asaas-access-token
//   ASAAS_ENV            'production' para valer de verdade; qualquer outro valor usa o sandbox (padrão, mais seguro)
export class AsaasError extends Error {
  constructor(status, detail) { super(`Asaas ${status}: ${detail}`); this.status = status; this.detail = detail; }
}

export const asaasConfigured = () => !!process.env.ASAAS_API_KEY && !!process.env.ASAAS_WEBHOOK_TOKEN;
export const asaasSandbox = () => process.env.ASAAS_ENV !== 'production';
const base = () => (asaasSandbox() ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3');

async function call(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { access_token: process.env.ASAAS_API_KEY, 'User-Agent': 'neri-clinica/1.0', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000), // o Netlify limita a duração da função
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AsaasError(res.status, data.errors?.[0]?.description ?? `HTTP ${res.status}`);
  return data;
}

export const asaas = {
  balance: () => call('GET', '/finance/balance'),
  // externalReference = id do paciente no nosso sistema (um UUID, nada pessoal)
  findCustomer: async (ref) => (await call('GET', `/customers?externalReference=${encodeURIComponent(ref)}&limit=1`)).data?.[0] ?? null,
  createCustomer: (b) => call('POST', '/customers', b),
  createPayment: (b) => call('POST', '/payments', b),
  getPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
  pixQrCode: (id) => call('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`),
  deletePayment: (id) => call('DELETE', `/payments/${encodeURIComponent(id)}`),
};
