# Tasks for João (só você pode fazer)

- [ ] O banco local antigo (`backend/.pglite-data`) não sobe mais (PGlite aborta, `postmaster.pid` órfão). Não apaguei por segurança. Se quiser usá-lo de novo: pare os `npm run dev` abertos, apague `backend/.pglite-data/postmaster.pid` (ou a pasta inteira para recriar o demo). Testes desta rodada usaram um banco demo novo em pasta temporária.
- [ ] Ver o efeito vidro ao vivo: seu Windows está com "efeitos de transparência" desligado, então o app mostra a versão opaca (de propósito). Ligue em Configurações > Personalização > Cores para ver o vidro.
- [ ] Decidir se corrige fuso horário nas telas de criar/reagendar e no WhatsApp (`Cadastros.tsx` ymd/hhmm, `WhatsApp.tsx` clock): usam o relógio do aparelho, não o de São Paulo. Só aparece se o aparelho estiver em outro fuso.
- [ ] Revisar as mudanças e decidir se faz commit/PR (nada foi commitado nem publicado; regra: nunca deploy).
