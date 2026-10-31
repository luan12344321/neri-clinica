# Procedimentos de produção — Neri Clínica

Documento operacional. Nada aqui é executado automaticamente: cada passo em produção exige decisão e autorização do dono.
Ele não afirma conformidade legal; onde a lei ou a profissão define prazos e obrigações, a decisão é da clínica com assessoria jurídica.

## 1. Ordem segura do primeiro deploy desta versão

1. **Backup completo do banco** (seção 2) e conferência de que a `ENCRYPTION_KEY` de produção está guardada em local separado do banco.
2. **Migração do esquema.** É só de ADIÇÕES e idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE/INDEX IF NOT EXISTS`):
   - `sara_messages.client_msg_id` + índices, `users.totp_*`, tabela `mfa_recovery_codes`, `patients.legal_hold_*`/`anonymized_at`, `clinics.retention_years`.
   - O próprio app aplica os passos na primeira requisição de cada instância (`backend/src/schema.js`, padrão já usado antes). Para não depender disso, rode antes, numa janela calma, o bloco final de `db/schema.sql` (a seção “Rodada final”) com `psql`. Nenhuma linha existente é alterada ou apagada.
3. Faça o deploy. **Todas as sessões abertas caem** (o token novo carrega uma marca da senha): avise a equipe.
4. Confira `GET /health?deep=1` e entre com o dono.
5. Só então: selagem do histórico da Julia (seção 3) e ativação do MFA (seção 4).

Reversão: o código antigo ignora as colunas novas; não é preciso desfazer a migração. Para voltar o banco ao estado anterior use o backup.

## 2. Backup e restauração

- **Neon (produção):** use a retenção/“restore” por ponto no tempo do próprio Neon e, além disso, um `pg_dump` lógico antes de mudanças grandes:
  `pg_dump --format=custom --no-owner "$DATABASE_URL" -f neri-AAAA-MM-DD.dump`
- **Restauração:** nunca por cima da produção. Restaure num banco/branch novo e separado:
  `createdb neri_restore && pg_restore --no-owner -d neri_restore neri-AAAA-MM-DD.dump`
  Depois aponte um ambiente de teste para ele e confira: contagem de linhas por tabela, login do dono, abrir um prontuário de teste (prova que a `ENCRYPTION_KEY` bate) e `UPDATE audit_log ...` falhando (trilha imutável).
- **A chave `ENCRYPTION_KEY` faz parte do backup.** Sem ela, CPF, prontuário, chaves Pix, tokens e segredos MFA dos backups ficam ilegíveis. Guarde-a em cofre, separada do dump.
- **Ensaio feito nesta rodada:** backup e restauração em banco isolado (PGlite, dados fictícios): mesmas 30 tabelas e linhas, dado cifrado abre com a mesma chave e não abre com outra, auditoria continua imutável, colunas novas presentes. **`pg_dump`/`pg_restore` reais contra Neon NÃO foram executados** (ferramenta ausente neste ambiente): faça este ensaio uma vez antes do go-live.

## 3. Cifrar o histórico antigo da Julia (S-03)

Script: `backend/scripts/seal-sara-history.js`. Cifra com AES-256-GCM as conversas gravadas em claro antes da cifragem e reduz resultados de ferramentas antigos a `{ok}`/`{error}` (o que podia ter CPF/prontuário some). Idempotente; verifica cada valor (decifra de volta e compara) antes de gravar; só grava se a linha não mudou; nunca regrava linha ilegível.

```
# 1) backup (seção 2)  2) simulação: não grava nada
node --env-file=.env scripts/seal-sara-history.js
# 3) conferir a saída: "Antes" mostra quantas linhas em claro (plaintext) e quantas ilegíveis (unreadable)
#    unreadable > 0 = ENCRYPTION_KEY diferente da usada na gravação: o script ABORTA sem gravar
# 4) aplicar
node --env-file=.env scripts/seal-sara-history.js --apply
# 5) a saída "Depois" deve mostrar plaintext: 0 e unreadable: 0 (senão o código de saída é 1)
```
Restauração: o passo de volta é o backup do passo 1 (o redutor de resultados de ferramenta é intencionalmente sem volta).
Testado em banco isolado (`backend/test/sara.test.js`): simulação não grava, `--apply` cifra e confere, segunda execução não altera, chave errada aborta com código 1.

## 4. Verificação em duas etapas (TOTP) — dono e gerente

- **Opt-in:** nada muda para quem não ativar, então ninguém fica trancado para fora no deploy. Recomenda-se que dono e gerentes ativem logo após o deploy.
- **Ativar:** Configurações → Verificação em duas etapas → Ativar. Pede a senha, mostra QR Code (aplicativo autenticador), exige um código de 6 dígitos para ligar e mostra **10 códigos de recuperação uma única vez** (guardar em local seguro, fora do celular).
- **Login:** senha → código de 6 dígitos (ou um código de recuperação, uso único). 5 erros em 15 minutos travam a conta por 15 minutos (vale para qualquer IP) e todo erro/uso fica na auditoria. Um código TOTP não vale duas vezes.
- **Segredo:** cifrado no banco (AES-256-GCM, preso ao usuário); nunca devolvido depois da ativação; fora do `/team` e da exportação da clínica. Códigos de recuperação só existem como HMAC.
- **Perdeu o celular, tem códigos de recuperação:** entra com um deles e gera novos em Configurações.
- **Perdeu o celular e os códigos (gerente):** o dono abre Configurações → Equipe → a pessoa → “Redefinir verificação em duas etapas”.
- **Perdeu tudo (dono):** quem tem acesso ao servidor roda, após confirmar a identidade por outro canal:
  `node --env-file=.env scripts/mfa-reset.js dono@clinica.com` (simula) e depois `... --apply`. Fica registrado como `mfa.reset_by_operator`.
- **Limites conhecidos (revisão hostil desta rodada):**
  - A ativação é voluntária; nada obriga o MFA. Torná-lo obrigatório exige período de adesão.
  - A trava de 5 tentativas é por usuário (qualquer IP) e é atômica no banco. Consequência: quem **sabe a senha** do dono consegue mantê-lo travado repetindo tentativas de código a cada 15 min. Saída: trocar a senha e/ou o script `mfa-reset.js`; monitore `auth.mfa_failed` na auditoria.
  - Ativar o MFA **não encerra sessões já abertas** (até 12 h). Para encerrá-las, troque a senha. O token provisório do login vale 5 min e não é de uso único (cada uso exige um código válido).
  - Dois donos na mesma clínica não conseguem redefinir o MFA um do outro pela tela (só pelo script).
  - Troca/conferência de senha em `/me/mfa/*` tem só o limite em memória por instância (5/min), sem trava no banco.

## 5. LGPD — o que o sistema faz e o que depende de decisão

Implementado (Configurações → Privacidade e dados pessoais; dono e gerente, salvo indicação):
- **Exportação do titular** (JSON: cadastro com CPF, consultas, aplicações, financeiro ligado, retornos, autorizações, mensagens, prontuário, WhatsApp, trilha de acesso). Auditada.
- **Correção** de nome, nascimento, telefone, e-mail e observações (ficha do paciente → Corrigir dados). Prontuário não é editado (registro clínico): corrige-se com novo registro. Auditada (só os nomes dos campos).
- **Retenção legal (dono):** marca o titular; enquanto houver, não pode ser anonimizado nem entra na lista de revisão.
- **Prazo de guarda:** a clínica informa os anos; o sistema **lista** quem passou do prazo para revisão humana. **Nunca apaga nada sozinho.** Sem prazo informado, não sugere nada.
- **Anonimização (dono; limites):** não altera o número de telefone usado como identificador do contato no WhatsApp (só o texto e o nome); casa o celular com e sem o 9º dígito, mas um contato guardado com outro número não é encontrado. O reenvio ao Google Agenda é aguardado e a resposta informa quantos eventos falharam (editar na agenda). Julia e agendamento não enxergam o anonimizado; uma marcação feita no mesmo instante da anonimização pode escapar da checagem de consultas futuras.
- **Anonimização (dono):** exige digitar o nome exato e confirmar; bloqueada por retenção legal e por consultas futuras. Remove nome, CPF, telefone, e-mail, nascimento, observações; revoga autorizações; cancela mensagens pendentes e limpa o texto das enviadas; encerra retornos; limpa mensagens e nome do contato no WhatsApp; reenvia ao Google Agenda os eventos (agora com nome anonimizado). **Mantém:** prontuário (conteúdo), lançamentos financeiros, rastreabilidade de lotes e a trilha de auditoria.
- **Trilha de acesso por titular (dono)** e auditoria de toda ação acima.

Decisões que NÃO são técnicas (precisam da clínica e de assessoria jurídica/CFM) — o sistema não inventa respostas:
1. **Prazo de guarda do prontuário e dos demais dados** e o que fazer ao final dele (hoje: só lista para revisão).
2. **Se e quando o conteúdo do prontuário pode ser apagado** (a anonimização não o toca; o texto pode conter o nome do paciente).
3. **Anonimização × obrigação fiscal/contábil** dos lançamentos financeiros.
4. **Backups:** quanto tempo guardam dados de quem já foi anonimizado e como tratar pedidos de exclusão neles.
5. **Terceiros** que já receberam dados (Google Agenda, WhatsApp/Meta, Asaas, Gemini): contratos, bases legais e como atender pedidos neles.
6. **Encarregado (DPO)**, canal de atendimento ao titular, prazos de resposta e atualização dos Termos/Política (`frontend/src/Legal.tsx`).
7. **Conversas internas com a Julia** (cifradas): política de retenção própria.

Não há, neste repositório, evidência suficiente para afirmar conformidade com a LGPD; os itens acima são mecanismos técnicos de apoio.

## 6. Julia — conversa guardada

- A tela reabre a conversa mais recente da própria pessoa (últimas 12 h) após recarregar (`GET /sara/history`). Só texto; cifrado no banco; só do usuário e da clínica dele.
- Reenvio da mesma mensagem (`messageId`) devolve a resposta já dada sem gastar IA; duas mensagens ao mesmo tempo na mesma conversa: a segunda recebe 409 `conversation_busy`.
- **Limites conhecidos:** o controle de “mensagem em andamento” é por instância (memória); entre instâncias a proteção é o índice único `client_msg_id`. Repetir um envio que falhou no meio com o MESMO `messageId` devolve 409 (a tela gera um id novo a cada envio, então isso não ocorre pela interface). Duas mensagens em instâncias diferentes na mesma conversa podem se intercalar.
- **Migração em várias instâncias ao mesmo tempo:** `CREATE ... IF NOT EXISTS` concorrente pode falhar uma vez e se refaz na requisição seguinte. Por isso a seção 1 manda aplicar o bloco de `db/schema.sql` antes do deploy; sem isso, o primeiro minuto pós-deploy pode ter logins com erro 500 transitório.
