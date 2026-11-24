# Guia de Publicação — Gestão Inteligente Empresarial

Este guia descreve os passos recomendados para publicar o **Gestão Inteligente Empresarial** em produção utilizando **Firebase Hosting**, **Cloud Firestore**, **Firebase Storage**, **Firebase Authentication**, **Firebase App Check** e o servidor backend Node/Express (`server.ts`) no **Cloud Run** para proteção da chave da API Google Gemini.

---

## 1. Arquitetura de Produção e Segurança

- **Frontend (SPA React/Vite)**: gerado na pasta `dist/` via `npm run build` e servido com SSL automático pelo **Firebase Hosting**.
- **Banco e Autenticação**: **Cloud Firestore** (`ai-studio-1d642bf8-a8d2-441a-ba1c-9a57b3b15fa3`) e **Firebase Authentication** no projeto `dark-forge-wcjpc`.
- **Arquivos e Planilhas**: **Firebase Storage** (`dark-forge-wcjpc.firebasestorage.app`) com regras por empresa e perfil em `storage.rules`.
- **Backend IA e PDF (`server.ts`)**: executa as rotas `/api/ai/*`, `/api/finance/parse-pdf-*` e `/api/reconciliation/suggest`. Todas essas rotas exigem token JWT válido do **Firebase Authentication** (`Authorization: Bearer <idToken>`) e mantêm a variável `GEMINI_API_KEY` exclusivamente no servidor.

> **Importante:** Nunca coloque `GEMINI_API_KEY` em variáveis com prefixo `VITE_`. Variáveis `VITE_*` são incorporadas no bundle público do navegador.

---

## 2. Pré-requisitos no Firebase Console (`dark-forge-wcjpc`)

1. **Firebase Authentication**:
   - Em *Authentication > Sign-in method*, confirme os provedores **E-mail/Senha** e **Google** ativos.
   - Em *Authentication > Settings > Authorized domains*, adicione o domínio `.web.app`, `.firebaseapp.com` e o seu **domínio personalizado** (quando configurado).
2. **Firebase Storage (Plano Blaze)**:
   - Caso o Storage ainda não tenha sido inicializado no projeto, ative o plano Blaze no Console do Firebase e clique em *Storage > Get started* para criar o bucket padrão `dark-forge-wcjpc.firebasestorage.app`.
3. **Firebase App Check (Recomendado)**:
   - Registre o app Web com **reCAPTCHA v3** em *App Check > Apps*.
   - Defina `VITE_FIREBASE_APPCHECK_SITE_KEY` no build de produção.
   - Em *App Check > APIs*, ative a imposição gradualmente para Firestore e Storage após validar os acessos em produção.

---

## 3. Publicação do Backend (`/api/*`) no Cloud Run

Como o Firebase Hosting serve arquivos estáticos, o servidor `server.ts` deve ser publicado em um serviço Node.js (recomendado: **Google Cloud Run** na mesma conta GCP do projeto `dark-forge-wcjpc`):

```bash
# Exemplo de deploy no Cloud Run a partir da raiz do projeto
gcloud run deploy gestao-empresarial-api \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=dark-forge-wcjpc" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest"
```

Após o deploy, anote a URL HTTPS gerada pelo Cloud Run (ex.: `https://gestao-empresarial-api-xxxxx-ue.a.run.app`) e configure:

- `VITE_API_BASE_URL="https://gestao-empresarial-api-xxxxx-ue.a.run.app"` no ambiente de build do frontend.
- `APP_URL="https://seu-dominio.com.br,https://dark-forge-wcjpc.web.app"` nas variáveis de ambiente do Cloud Run para liberar CORS estritamente para as origens autorizadas.

*(Alternativa: se preferir servir no mesmo domínio via Firebase Hosting, você pode adicionar um rewrite `/api/**` para o serviço Cloud Run em `firebase.json` mantendo `VITE_API_BASE_URL` vazio).*

---

## 4. Build e Publicação no Firebase Hosting e Regras

```bash
# 1. Instalar dependências e validar regras/código
npm ci
npx eslint firestore.rules
npm run lint
npm run build

# 2. Autenticar na CLI do Firebase e selecionar o projeto
npx firebase-tools login
npx firebase-tools use dark-forge-wcjpc

# 3. Publicar regras do Firestore, regras do Storage e o Hosting
npx firebase-tools deploy --only firestore:rules,storage,hosting
```

---

## 5. Vinculação de Domínio Personalizado e SSL

1. No Firebase Console, acesse **Hosting > Add custom domain**.
2. Informe o domínio da empresa (ex.: `erp.suaempresa.com.br`).
3. Adicione o registro `TXT` de verificação e os registros `A` / `CNAME` fornecidos no painel do seu provedor de DNS.
4. Aguarde a emissão automática do certificado SSL gerenciado pelo Google.
5. Após a ativação do certificado:
   - Adicione o domínio em **Authentication > Settings > Authorized domains**.
   - Adicione `https://erp.suaempresa.com.br` em `APP_URL` no backend Cloud Run.
   - Atualize a lista de origens permitidas no reCAPTCHA v3 do **Firebase App Check**.

---

## 6. Checklist Pós-Publicação

- [ ] Login com e-mail/senha verificado e login Google funcionando no domínio final.
- [ ] Fluxo "Esqueci minha senha" entregando o e-mail de redefinição e redirecionando corretamente.
- [ ] Importação de planilha Excel/CSV de estoque e movimentação em tempo real entre dois navegadores simultâneos.
- [ ] Upload e visualização de anexos no Firebase Storage (notas XML/PDF, extratos e relatórios).
- [ ] Assistente de IA por texto/voz e sugestões Gemini na conciliação respondendo normalmente via `/api/*`.
- [ ] Registros de auditoria visíveis no módulo **Auditoria** com usuário, data/hora, origem, resultado e dados anteriores/posteriores.
