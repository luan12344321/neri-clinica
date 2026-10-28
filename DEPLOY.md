# Deploy e operação do NERI Clínica (Vercel + Neon)

## O que roda onde

| Peça | Onde | Como |
|---|---|---|
| App (PWA React) | CDN da Vercel | `frontend/dist`, gerado no build (`vercel.json`) |
| API | Função Node da Vercel | `api/index.mjs` atende `/api/*` e executa o mesmo Fastify de `backend/src/app.js` |
| Rotinas (retornos, aniversário, estoque, DRE, envio, Google Agenda) | Cron da Vercel | `vercel.json` chama `GET /api/cron/tick` com `Authorization: Bearer <CRON_SECRET>` |
| Banco | **Neon** (Postgres) | string *pooled* (host com `-pooler`) em `DATABASE_URL` |
| Julia (IA) | Google Gemini | `GEMINI_API_KEY` (projeto com cobrança ativa) |

O `tick()` de `backend/src/jobs.js` é idempotente e decide sozinho o que está na hora (aniversário só depois das 9h de São Paulo, DRE do mês anterior a partir do dia 1, etc.). Hoje o cron roda **1 vez por dia, às 08h de Brasília** (`0 11 * * *` em UTC). Planos pagos da Vercel permitem frequência maior: ajuste `schedule` em `vercel.json`.

## Plano da Vercel para vender

O plano **Hobby é só para uso pessoal/não comercial**. Para vender o NERI Clínica, assine o **Pro** (ou superior). O Pro também libera cron mais frequente e mais tempo de execução.

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

Marque as secretas como *Sensitive*. Nunca coloque valores no Git, no chat ou em arquivos do repositório.

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | string pooled do Neon (`?sslmode=require`) |
| `JWT_SECRET` | assina os logins (trocar derruba as sessões ativas) |
| `ENCRYPTION_KEY` | cifra CPF, prontuário, PDFs e credenciais. **Perdeu, perdeu os dados cifrados** (veja "Guardar a chave") |
| `CRON_SECRET` | protege `/api/cron/tick`; sem ele a rota fica fechada |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Julia. Padrão do modelo: `gemini-3.5-flash-lite` |
| `GEMINI_CLINIC_MONTHLY_TOKENS`, `GEMINI_TOTAL_MONTHLY_TOKENS` | teto de custo (padrão 1.000.000 por clínica e 5.000.000 no total, por mês) |
| `SARA_BUDGET_MS` | tempo máximo de uma resposta da Julia (padrão seguro: `40000`) |
| `PG_POOL_MAX` | `3` (a Vercel limita a 2 por instância) |
| `APP_URL` | `https://neri-clinica.vercel.app` (ou o domínio próprio) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | só se usar Google Agenda (`https://SEU-DOMINIO/api/google/callback`, o mesmo cadastrado no Google Cloud) |
| `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_ENV` | só se usar Pix com confirmação automática (`sandbox` por padrão) |

**Não** defina `PORT` na Vercel. `ANTHROPIC_API_KEY` e `SARA_MODEL` não são mais usadas: pode apagar.

O WhatsApp da Julia **não usa variáveis**: cada clínica cadastra o número em Configurações → WhatsApp da clínica (dono).

## Primeira instalação

1. Crie o projeto no Neon e copie a string pooled.
2. Em `backend/`, copie `.env.example` para `.env` e preencha `DATABASE_URL`, `JWT_SECRET` e `ENCRYPTION_KEY` (os comandos para gerar estão no próprio arquivo).
3. Crie as tabelas e a primeira clínica:
   ```powershell
   cd backend
   npm install
   npm run db:schema
   $env:OWNER_PASSWORD = 'uma-senha-forte-com-10+-caracteres'
   npm run clinic:create -- "Nome da Clínica" dono@email.com "Nome do Dono"
   ```
   `db:schema` recusa rodar se o banco já tiver tabelas. **Não** use `db:init` em produção (carrega dados de demonstração e uma senha conhecida).
4. Importe o repositório na Vercel. Build, saída e rotas vêm do `vercel.json`. Cadastre as variáveis e faça o deploy.
5. Confira: `https://SEU-DOMINIO/api/health` responde `{"ok":true}`, e o login funciona.

Bancos já existentes **não precisam de migração manual**: `backend/src/schema.js` aplica, no primeiro acesso, só ADIÇÕES idempotentes (colunas e tabelas novas). Nada é apagado.

## Operação

### Monitoramento (faça antes de vender)
- **Disponibilidade:** crie um monitor gratuito (UptimeRobot, Better Stack ou similar) em `https://SEU-DOMINIO/api/health?deep=1` a cada 5 minutos, com alerta por e-mail/WhatsApp. Esse endereço também testa o banco: devolve 503 se o Neon cair.
- **Erros:** falhas da API aparecem nos logs da Vercel (Logs → filtro `error`). Erros de tela chegam ao mesmo log com `type: client_error` (rota `POST /api/client-error`, sem dados de paciente). Configure um alerta de erros na Vercel.
- **Custos:** no Google Cloud, crie orçamento e alertas para o projeto da chave Gemini.

### Backup e saída de dados
- **Neon:** confirme no painel que há restauração a um ponto no tempo e por quantos dias. Teste uma restauração em um branch antes de depender dela.
- **Backup portátil de uma clínica** (também serve para entregar os dados ao encerrar o contrato):
  ```powershell
  cd backend
  npm run clinic:export -- <id-da-clinica> clinica.json
  ```
  Senhas e tokens nunca saem. Campos cifrados (CPF, prontuário, PDFs, fotos) saem cifrados e só abrem com a `ENCRYPTION_KEY`. O arquivo contém dados de pacientes: guarde em local seguro.

### Guardar a chave
Guarde a `ENCRYPTION_KEY` em **dois lugares** (gerenciador de senhas e cofre da empresa), fora da Vercel. Sem ela, os dados cifrados são irrecuperáveis.

### Reverter
- **Código:** na Vercel, em Deployments, escolha um deploy anterior e *Promote to Production*.
- **Banco do Ciclo do Procedimento:** `db/rollback_ciclo_procedimento.sql` desfaz as tabelas e colunas desse ciclo (testado só em banco de teste; faça backup antes).

## Perfis e segurança

- **Perfis:** proprietário (tudo), gerente (tudo, menos a equipe), profissional (agenda, pacientes, prontuário, concluir atendimento) e recepção (agenda, pacientes e estoque, sem dados clínicos e sem custo). Só proprietário e gerente veem financeiro, painel da doutora e custo/margem.
- **Já configurado:** cabeçalhos de segurança no `vercel.json` (CSP restritiva, HSTS, `X-Frame-Options: DENY`), limite de tentativas de login, bloqueio por falhas, CORS desligado por padrão (app e API na mesma origem), segredos só em variáveis de ambiente.
- **Termos e privacidade:** o app mostra Termos de Uso e Política de Privacidade (`frontend/src/Legal.tsx`) e exige o aceite no primeiro acesso, com data e versão gravadas. **Antes de vender, peça a revisão de um advogado** e preencha os dados da empresa contratante (razão social, CNPJ, canal de suporte e encarregado de dados).
- **LGPD e provedores:** a Julia envia ao Gemini os trechos necessários (nome, nascimento e telefone quando o usuário pergunta; nunca CPF; prontuário só para perfis clínicos e com registro de cada consulta). O uso exige o plano **pago** do Gemini (o gratuito pode treinar com os dados). Mantenha contratos/termos com Vercel, Neon, Google, Meta e Asaas.
- **Autorização de contato:** cada paciente tem autorização por finalidade (retorno, aniversário, marketing). Pacientes antigos não têm a autorização de "retorno" até o registro na ficha.

## WhatsApp da Julia (clientes)

Em Configurações → WhatsApp da clínica, o dono cadastra o número, o Phone Number ID, o token permanente e o segredo do app da Meta (guardados cifrados, nunca exibidos). Na Meta, cadastre o webhook `https://SEU-DOMINIO/api/webhooks/whatsapp` com o token de verificação mostrado na tela e assine o campo `messages`. O número **não pode estar em uso** no WhatsApp comum e o negócio precisa ser verificado. O webhook só aceita mensagens com assinatura válida. As conversas ficam em `wa_messages`: avise os clientes e defina a retenção.

## Pix com confirmação automática (Asaas)

Opcional. Sem as variáveis, o app cobra por Pix estático (sem confirmação automática). Comece no **sandbox**: cadastre `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (32 a 255 caracteres, sem espaços) e `ASAAS_ENV=sandbox`. No Asaas, em Integrações → Webhooks, cadastre `https://SEU-DOMINIO/api/webhooks/asaas`, o mesmo segredo e os eventos de cobrança. Teste em Configurações → Pagamentos. Só depois troque para `production`. O CPF e o nome do paciente vão ao Asaas (registrado na auditoria).

## Instalar no celular

PWA com ícones próprios. No Android/Chrome aparece o botão **Instalar**; no iPhone, Safari → Compartilhar → *Adicionar à Tela de Início*.

## Limites conhecidos

- Cron diário no plano Hobby (e uso não comercial). Veja "Plano da Vercel para vender".
- Partida a frio: a primeira requisição após um período parado demora mais (função + conexão ao banco).
- Cada instância abre poucas conexões; em picos o gargalo é o Neon (use a string pooled).
- O token de login fica no navegador (localStorage). Migrar para cookie httpOnly é uma melhoria de segurança planejada e ainda não feita.
- Não há recuperação de senha por e-mail: o proprietário redefine a senha da equipe em Configurações → Equipe.
