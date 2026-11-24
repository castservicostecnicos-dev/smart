# Guia de Publicação na Cloudflare — Cloudflare Workers (com Assets Estáticos)

## Por que Cloudflare Workers em vez de Cloudflare Pages?

O **Gestão Inteligente Empresarial** possui duas partes essenciais que precisam funcionar juntas com segurança:

1. **Frontend React + Vite + PWA (`dist/`)**: interface web que autentica no **Firebase Authentication** e sincroniza dados em tempo real com **Cloud Firestore** e **Firebase Storage**.
2. **Backend protegido (`/api/*`)**: rotas de servidor para o **Assistente de IA (Gemini)**, **extração inteligente de PDFs bancários/fiscais** e **sugestões de conciliação**, que validam o token JWT do Firebase e mantêm `GEMINI_API_KEY` oculta fora do navegador.

Comparação técnica:
- **Cloudflare Pages puro (estático)** não executa rotas de servidor nem protege `GEMINI_API_KEY` — exigiria outro servidor externo (ex.: Cloud Run) e configuração extra de CORS.
- **Cloudflare Workers com Assets Estáticos (`wrangler.jsonc`)** é a arquitetura recomendada pela própria Cloudflare para aplicações full-stack modernas:
  - Publica **o frontend SPA/PWA e toda a API `/api/*` em um único deploy e no mesmo domínio** (sem CORS entre domínios e sem precisar configurar `VITE_API_BASE_URL`).
  - Executa o Worker prioritariamente em `/api/*` (`run_worker_first: ["/api/*"]`) e entrega os arquivos estáticos com fallback automático de SPA (`single-page-application`).
  - Protege `GEMINI_API_KEY` como **Secret criptografado** na Cloudflare.

---

## 1. Pré-requisitos

1. Conta gratuita ou paga na **Cloudflare**.
2. Projeto Firebase ativo (`dark-forge-wcjpc`) com regras implantadas (`firestore.rules` e `storage.rules`).
3. Chave válida da **API Google Gemini** (`GEMINI_API_KEY`).

---

## 2. Publicação via Terminal (Wrangler CLI)

```bash
# 1. Instalar dependências e validar tipos/build
npm ci
npm run lint
npm run build

# 2. Autenticar na sua conta Cloudflare
npx wrangler login

# 3. Gravar o segredo da API Gemini com segurança (nunca vai para o navegador)
npx wrangler secret put GEMINI_API_KEY

# 4. (Opcional) Definir domínio customizado extra para CORS, se usar origens adicionais
# npx wrangler secret put APP_URL

# 5. Publicar frontend + API juntos na Cloudflare Workers
npm run cf:deploy
```

Ao final, o terminal exibirá a URL publicada, por exemplo:
`https://gestao-inteligente-empresarial.<seu-subdominio>.workers.dev`

---

## 3. Publicação Contínua via Painel Cloudflare + GitHub (Alternativa sem CLI local)

1. Suba o repositório para o **GitHub** / **GitLab** (certifique-se de **não** subir `.env` com segredos).
2. No painel da Cloudflare, acesse **Workers & Pages > Create > Workers > Connect to Git**.
3. Configure:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
4. Em **Settings > Variables and Secrets**, adicione:
   - **Secret**: `GEMINI_API_KEY` = *(sua chave da API Google Gemini)*
   - *(Opcional)* **Variable**: `FIREBASE_PROJECT_ID` = `dark-forge-wcjpc` *(já pré-configurada em `wrangler.jsonc`)*

---

## 4. Passo Obrigatório no Firebase Console após o Deploy

Sempre que publicar em um novo subdomínio `.workers.dev` ou domínio próprio da empresa:

1. Acesse **Firebase Console > Authentication > Settings > Authorized domains**.
2. Clique em **Add domain** e adicione:
   - `gestao-inteligente-empresarial.<seu-subdominio>.workers.dev`
   - Seu domínio personalizado (ex.: `erp.suaempresa.com.br`), caso utilize.
3. Sem esse passo, o login com Google e os redirecionamentos de verificação/recuperação de senha serão bloqueados pelo Firebase Authentication.

*(Se utilizar Firebase App Check com reCAPTCHA v3, inclua também os novos domínios nas origens autorizadas da chave reCAPTCHA).*

---

## 5. Domínio Personalizado na Cloudflare

1. No painel da Cloudflare, abra o Worker **gestao-inteligente-empresarial**.
2. Acesse **Settings > Domains & Routes > + Add > Custom Domain**.
3. Informe o domínio/subdomínio desejado (ex.: `erp.suaempresa.com.br`) gerenciado no DNS da Cloudflare — o certificado SSL/HTTPS é emitido automaticamente.
4. Adicione o novo domínio em **Firebase Console > Authentication > Settings > Authorized domains** (e em `APP_URL`, se houver chamadas cross-origin).

---

## 6. Verificação Pós-Publicação

1. Acesse `https://<seu-dominio>/api/health`: deve retornar JSON com `"status": "ok"`, `"runtime": "cloudflare-worker"` e `"geminiConfigured": true`.
2. Teste uma requisição sem autenticação em `POST https://<seu-dominio>/api/ai/chat`: deve retornar **HTTP `401`**.
3. Faça login no sistema com seu usuário administrador, valide o carregamento em tempo real do Firestore, o Assistente de IA e a exportação de relatórios.
