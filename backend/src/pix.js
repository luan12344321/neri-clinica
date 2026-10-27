import { normalizeCpf } from './crypto.js';

// Pix "copia e cola" (BR Code, padrão EMV do Banco Central), estático e com valor. Não precisa de provedor, mas
// também não avisa quando o pagamento cai: quem confirma é a clínica (ou, no futuro, um provedor via webhook).

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), em hexadecimal maiúsculo de 4 dígitos.
export function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;
// Nome e cidade: sem acento, maiúsculas e só caracteres seguros; limites do padrão (25 e 15).
const clean = (s, max) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, max) || 'NA';

export function pixPayload({ key, name, city = 'BRASIL', amount, txid = '***' }) {
  const account = field('00', 'br.gov.bcb.pix') + field('01', key);
  const body = field('00', '01') + field('01', amount ? '12' : '11') + field('26', account) + field('52', '0000') + field('53', '986')
    + (amount ? field('54', Number(amount).toFixed(2)) : '') + field('58', 'BR') + field('59', clean(name, 25)) + field('60', clean(city, 15))
    + field('62', field('05', String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) + '6304';
  return body + crc16(body);
}

// Valida e padroniza a chave Pix pelo tipo; devolve null se inválida.
export function normalizePixKey(type, raw) {
  const v = String(raw).trim();
  const digits = v.replace(/\D/g, '');
  switch (type) {
    case 'cpf': return normalizeCpf(v);
    case 'cnpj': return digits.length === 14 && !/^(\d)\1{13}$/.test(digits) ? digits : null;
    case 'phone': {
      const d = digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits}`;
      return d.length === 12 || d.length === 13 ? `+${d}` : null;
    }
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 77 ? v.toLowerCase() : null;
    case 'random': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
    default: return null;
  }
}

// Mostra só o começo e o fim da chave (telas e listagens nunca devolvem a chave inteira).
export const maskKey = (v) => (v.length <= 6 ? '•'.repeat(v.length) : `${v.slice(0, 2)}•••${v.slice(-3)}`);
