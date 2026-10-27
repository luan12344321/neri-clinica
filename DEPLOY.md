# Deploy no Netlify

## O que roda onde

| Peça | Onde | Como |
|---|---|---|
| App (PWA React) | CDN do Netlify | `frontend/dist`, gerado no build |
| API | Netlify Function | `netlify/functions/api.mjs` atende `/api/*` e executa o mesmo Fastify de `backend/src/app.js` |
| Rotinas (aniversário, pós-procedimento, estoque, DRE, envio, Google Agenda) | Função agendada | `netlify/functions/jobs.mjs`, a cada 5 min (UTC) |
| Banco | **Fora do Netlify** | Postgres em Neon ou Supabase (plano gratuito basta para começar) |

O Netlify não mantém servidor ligado, por isso o `node-cron` do `server.js` não é usado lá: o `tick()` de `backend/src/jobs.js` roda tudo de forma idempotente e decide sozinho o que está na hora (aniversário só depois das 9h de São Paulo, DRE do mês anterior a partir do dia 1 às 6h, e assim por diante).

## Passo a passo

### 1. Banco de dados
1. Crie um projeto no [Neon](https://neon.tech) (ou Supabase), região mais próxima do Netlify (ex.: `us-east`).
2. Copie a string de conexão **pooled** (no Neon, o host tem `-pooler`) com `?sslmode=require`.
3. No seu computador, em `backend/`, copie `.env.example` para `.env` e preencha `DATABASE_URL`, `JWT_SECRET` e `ENCRYPTION_KEY` (os comandos para gerar estão no próprio arquivo).
4. Crie as tabelas e o primeiro usuário:
   ```powershell
   cd backend
   npm install
   npm run db:schema
   $env:OWNER_PASSWORD = 'uma-senha-forte-com-10+-caracteres'
   npm run clinic:create -- "Nome da Clínica" dono@email.com "Nome do Dono"
   ```
   `db:schema` recusa rodar se o banco já tiver tabelas (não sobrescreve nada). **Não** use `db:init` em produção: ele carrega dados de demonstração e uma senha conhecida.

### 2. Site no Netlify
1. Suba o projeto para um repositório Git (GitHub, GitLab ou Bitbucket). O `.gitignore` já exclui `.env` e `node_modules`.
2. Em Netlify: **Add new site → Import an existing project** e escolha o repositório. Build, pasta publicada e funções vêm do `netlify.toml`; não preencha nada.
3. Em **Site configuration → Environment variables**, crie as variáveis abaixo. Marque as secretas como *Contains secret values*.

| Variável | Valor |
|---|---|
| `DATABASE_URL` | string pooled do passo 1 |
| `JWT_SECRET` | o mesmo do passo 1 (ou um novo; trocar derruba os logins ativos) |
| `ENCRYPTION_KEY` | **a mesma** do passo 1. Se for trocada depois, CPF e prontuários já gravados deixam de abrir |
| `ANTHROPIC_API_KEY` | chave da Sara |
| `PG_POOL_MAX` | `3` |
| `SARA_BUDGET_MS` | `40000` (veja "Limites") |
| `APP_URL` | `https://SEU-SITE.netlify.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | só se for usar Google Agenda |
| `GOOGLE_REDIRECT_URI` | `https://SEU-SITE.netlify.app/api/google/callback` (cadastre o mesmo no Google Cloud) |

4. **Deploy.** Depois do primeiro deploy, confira:
   - `https://SEU-SITE.netlify.app/api/health` responde `{"ok":true}`;
   - o login funciona com o e-mail e a senha do passo 1;
   - em **Functions** aparecem `api` e `jobs`; `jobs` mostra o agendamento. Use **Run now** para testar, e veja o log: deve listar `birthday`, `followup`, `stock`, `outbox`… como `ok`.

Por linha de comando (opcional): `npx netlify-cli login`, `npx netlify-cli link`, `npx netlify-cli deploy --build --prod`.

## Antes de usar com pacientes reais

- **Guarde a `ENCRYPTION_KEY` em dois lugares** (por exemplo, gerenciador de senhas e cofre da empresa), fora do Netlify. Sem ela, os dados cifrados são irrecuperáveis.
- **Backups:** confirme no provedor do banco que há backup automático e quanto tempo ele retém. Teste uma restauração antes de depender dela.
- **Contas e termos:** LGPD exige base legal, política de privacidade e contrato com os operadores (Netlify, Neon/Supabase, Anthropic, Google). A Sara consulta apenas agregados (faturamento, procedimentos, estoque) e não envia nomes de pacientes ao modelo, mas confirme isso com quem responde juridicamente pela clínica.
- **WhatsApp:** o envio ainda é um stub (`sendWhatsApp` em `backend/src/jobs.js`). As mensagens ficam na fila e são marcadas como enviadas **sem sair de fato**. Não ligue a automação para pacientes antes de integrar um provedor real.

## Limites do Netlify que afetam o app

- **Cron em UTC e só no deploy publicado.** Deploy Preview e branch deploy não rodam o `jobs`. Limite de 30 s por execução.
- **Frequência do cron.** A documentação não fixa um mínimo e há relatos de planos com piso de 1 hora. Se o deploy recusar `*/5 * * * *`, troque `schedule` em `netlify/functions/jobs.mjs` por `@hourly`: tudo continua funcionando, só com mais atraso no envio e na sincronização do Google. O botão "Sincronizar agora" do app independe disso.
- **Tempo da API.** A documentação atual lista 60 s para funções síncronas; discussões da comunidade citam 10 s (até 26 s sob pedido) conforme o plano. Se a Sara estourar o tempo, reduza `SARA_BUDGET_MS` para `8000`.
- **Conexões com o banco.** Cada invocação concorrente abre as suas. Por isso `PG_POOL_MAX=3` e a string *pooled*. Em picos, o provedor do banco é o gargalo, não o Netlify.
- **Partida a frio.** A primeira requisição depois de um período parado leva mais tempo (empacotamento de ~3 MB + conexão ao banco).
- **Banco do Netlify:** o Netlify DB (Neon) exige plano por créditos e já mudou de nome de variável; por isso o guia usa `DATABASE_URL` com Neon/Supabase diretamente.

## Segurança já configurada

- Cabeçalhos no `netlify.toml`: CSP restritiva, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- API e app na mesma origem (`/api`): CORS desligado por padrão.
- Limite de 300 requisições/min por IP na borda do Netlify e bloqueio de login no banco (5 falhas em 15 min por usuário e IP).
- Segredos só em variáveis de ambiente; o `.env` nunca vai para o Git.

## Reverter

O Netlify guarda cada deploy: em **Deploys** escolha um anterior e **Publish deploy**. Isso reverte o código, **não o banco**: alterações de schema são manuais (`db/schema.sql` ainda não tem sistema de migrações).
