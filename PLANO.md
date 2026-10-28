# PLANO: Ciclo do Procedimento (Neri Clínica)

Origem: `Prompt_Orquestracao_Neri_Clínica.md`. Fase 0 (reconhecimento) concluída em 28/10/2026. Nada foi implementado ainda. Trabalho só na branch `dev`.

## 1. Stack e convenções (o que já existe)
- **Backend:** Fastify 5 (ESM, JS), `pg` direto (sem ORM), zod 4, node:test + PGlite nos testes. Hoje 158 testes.
- **Banco:** Postgres (Neon). **Sem sistema de migração:** `db/schema.sql` (instalação nova) + passos aditivos e idempotentes em `backend/src/schema.js` (`ensureSchema`).
- **Front:** React 18 + Vite + PWA, arquivos grandes (`App.tsx` 628 linhas, `Cadastros.tsx`, `Timeline.tsx`, `Settings.tsx`). Padrões: `useLoad`, `Sheet` (agora via portal), `AddForm`, classes `card`, `rows`, `pill`.
- **Deploy:** Vercel (função `api/index.mjs` + estático); cron diário em `/api/cron/tick` (plano Hobby: 1x/dia).
- **Perfis:** `owner`, `manager`, `professional`, `reception`. Não existe perfil "doutora": doutora/gestora = `owner` (ou `professional` para o clínico); secretária = `reception`.
- **Segurança já pronta:** `clinic_id` em toda consulta, auditoria (`audit_log`), AES-256-GCM com AAD (`crypto.js`) para CPF e prontuário, permissões por perfil no backend e testes de matriz.

## 2. Entidades existentes e o que falta
| Pedido | Hoje | Plano |
|---|---|---|
| Produto | `products` (nome, unidade, qtd, mínimo, alvo, custo, validade) | **Estender** (categoria, fabricante, tipo de dispositivo, unidades por embalagem). Não criar tabela nova. |
| Lote | não existe (`expires_at` no produto) | **Nova** `product_lots`; `stock_movements` ganha `lot_id`. |
| Regra de procedimento | `followup_rules` (dias após, texto) | **Nova** `procedure_return_rules` (alvo, janela mín/máx, texto, ativo). |
| Aplicação | não existe | **Nova** `applications` (atendimento, paciente, produto, lote, unidades, custo calculado, foto cifrada opcional). |
| Retorno | não existe | **Nova** `returns` (estados do prompt) com índice `(data_sugerida, estado)`. |
| Consentimento | `patients.marketing_consent` (um só) | **Nova** `contact_consents` por finalidade; `marketing_consent` continua valendo para aniversário. |
| Concluir atendimento | `POST /appointments/:id/complete` | **Reescrever o fluxo** (ver conflito 1). |
| Prontuário | `medical_records` (cifrado) | Guardar o comprovante (PDF cifrado) e o registro de uso de IA. |
| Precisa de atenção | lista em `Today` (`App.tsx`) | Reorganizar por urgência, responsável e próxima ação. |

## 3. Conflitos com o que existe (decidir antes de construir)
1. **Baixa silenciosa de estoque:** hoje `complete` baixa o estoque pelo protocolo sem ninguém confirmar. Isso contradiz "nenhuma baixa sem confirmação". Proposta: o protocolo vira só sugestão pré-preenchida; a baixa acontece na confirmação da doutora.
2. **Envio automático:** a automação atual (`followup_rules` + job `followup` + `outbox`) já **enfileira e envia WhatsApp sozinha**. O prompt proíbe envio automático de retorno. Proposta: desligar o job `followup` quando o Retorno existir (aniversário não muda).
3. **Consentimento único:** retorno não pode herdar `marketing_consent`. Proposta: consentimento próprio para a finalidade "retorno", registrado explicitamente.
4. **Sem migração formal:** "migração reversível" vira passos aditivos em `schema.js` + um arquivo de reversão documentado (nada destrutivo).
5. **Perfil "doutora":** custo e margem só para `owner`/`manager`. Se a doutora for cadastrada como `professional`, ela não verá margem. Confirmar.

## 4. Decisões técnicas
- **PDF:** sem biblioteca hoje. Usar `pdfkit` (JS puro, roda na Vercel). Cópia guardada **cifrada** no banco e baixada só por rota autenticada, **sem link público**.
- **Foto da etiqueta:** a Vercel não tem disco. Reduzir a imagem no celular e guardar cifrada no banco (limite ~400 KB).
- **Frasco fracionado:** lote em unidades; custo por unidade = custo da embalagem ÷ unidades por embalagem.
- **Transação única:** aplicação + baixa + retorno sugerido + auditoria; falhou, nada grava.
- **Retorno:** regra definida pela doutora; nenhuma IA decide intervalo, diagnóstico ou conduta. Mensagem-base sem promessa de resultado.
- **Fila da secretária:** botão `wa.me` abre o WhatsApp com texto pronto (envio manual); o servidor só entrega o telefone se houver consentimento.
- **Job diário:** nova tarefa dentro do `tick` existente (Vercel Hobby: 1x/dia).
- **Julia:** não gera diagnóstico nem conduta; uso de IA sobre prontuário já vai para a auditoria e passará a aparecer no prontuário.

## 5. Ordem de execução e agents
1. `modelo-dados` (sozinho): `schema.sql`, `schema.js`, tipos, auditoria, testes de integridade.
2. Em paralelo: `fluxo-concluir-atendimento` (Timeline/`complete`), `rastreabilidade-anvisa` (PDF), `retorno-inteligente` (regras e sugestão).
3. Em paralelo: `fila-secretaria` e `painel-doutora`.
4. `qa-seguranca-conformidade`: testes, permissões, LGPD, acessibilidade.
5. Integração, build, testes e resumo.
**Risco:** vários agents mexem nos mesmos arquivos (`schema.js`, `sara.js`, `App.tsx`). Mitigação: contratos fechados antes (nomes de tabelas, rotas e tipos) e cada agent só altera os arquivos do seu escopo.

## 6. Fora do MVP
Envio automático por API oficial, IA redigindo mensagens, lista de espera, churn, Julia executando tarefas, mais gráficos, chatbot genérico, campanhas.

## 7. Não verificado
As normas citadas no prompt (CFM 2.336, CFM 2.454/2026, exigências da ANVISA para preenchedores) e as metas de resultado **não foram verificadas por mim**. Precisam de validação jurídica/regulatória e piloto real.
