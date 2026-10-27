import crypto from 'node:crypto';

// Criptografia de campos sensíveis em repouso: AES-256-GCM.
// `aad` (dados autenticados adicionais) amarra o texto cifrado à sua origem, p.ex. "patients.cpf:<id>":
// copiar o valor cifrado de uma linha para outra faz a decifragem falhar, em vez de revelar o dado.
// O prefixo de versão permite trocar de chave/algoritmo no futuro sem perder o que já foi gravado.
const VERSION = 'v1';

const key = () => {
  const k = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 64 caracteres hex (32 bytes)');
  return k;
};

export function encrypt(text, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${VERSION}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function decrypt(payload, aad) {
  const [version, b64] = String(payload).split(':');
  if (version !== VERSION || !b64) throw new Error('formato de campo criptografado desconhecido');
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// Índice cego: permite achar/deduplicar por igualdade sem guardar o valor em claro (HMAC, não reversível).
export const blindIndex = (domain, value) =>
  crypto.createHmac('sha256', key()).update(`${domain}:${value}`).digest('hex');

// CPF: devolve só os dígitos se for válido (tamanho + dígitos verificadores), senão null.
export function normalizeCpf(input) {
  const d = String(input).replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  const dv = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]) ? d : null;
}
