// Cifra o histórico da Julia gravado em claro antes da cifragem (pode conter resumo de prontuário e CPF).
// Uso (procedimento completo em backend/docs/PROCEDIMENTOS.md):
//   node --env-file=.env scripts/seal-sara-history.js            -> só confere e conta (não grava nada)
//   node --env-file=.env scripts/seal-sara-history.js --apply    -> cifra o que está em claro
// Precisa da mesma ENCRYPTION_KEY da produção. Faça backup do banco antes do --apply. Pode rodar mais de uma vez.
// Linhas que têm cara de cifradas mas não decifram (chave errada, dado corrompido) nunca são regravadas: aparecem como "ilegíveis".
import { fileURLToPath } from 'node:url';
import { sealLegacyHistory, verifySealedHistory } from '../src/sara.js';

// Devolve o código de saída (0 = ok). `log` existe para o teste capturar a saída.
export async function main(argv = [], log = console.log) {
  const apply = argv.includes('--apply');
  try {
    const before = await verifySealedHistory();
    log('Antes:', before);
    if (before.unreadable) throw new Error(`${before.unreadable} linhas ilegíveis: confira se a ENCRYPTION_KEY é a da produção. Nada foi gravado.`);
    const r = await sealLegacyHistory({ dryRun: !apply });
    log(apply ? 'Cifrado:' : 'Simulação (nada gravado):', r);
    if (!apply) { log('Para gravar, rode de novo com --apply (depois do backup).'); return 0; }
    const after = await verifySealedHistory();
    log('Depois:', after);
    if (after.plaintext || after.unreadable || r.failed) throw new Error('Verificação final falhou: rode de novo e investigue antes de seguir.');
    return 0;
  } catch (e) { log(e.message); return 1; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('../src/db.js');
  process.exitCode = await main(process.argv.slice(2));
  await pool.end();
}
