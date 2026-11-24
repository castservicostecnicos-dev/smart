import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  executeAiChat,
  executeInventoryCommand,
  executeParsePdfInvoice,
  executeParsePdfStatement,
  executeReconciliationSuggest,
  mapGeminiErrorToHttp,
  validateFirebasePayloadClaims,
  type AiCallSpec,
  type AiChatRequestBody,
  type FirebaseJwtPayload,
  type InventoryCommandRequest,
  type ReconciliationSuggestRequestBody,
  type SchemaTokens,
  type VerifiedFirebaseClaims,
} from './shared/erpAiCore';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

const NODE_SCHEMA_TOKENS: SchemaTokens = {
  OBJECT: Type.OBJECT,
  STRING: Type.STRING,
  NUMBER: Type.NUMBER,
  ARRAY: Type.ARRAY,
  BOOLEAN: Type.BOOLEAN,
};

function resolveFirebaseProjectId(): string {
  if (process.env.FIREBASE_PROJECT_ID?.trim()) {
    return process.env.FIREBASE_PROJECT_ID.trim();
  }
  try {
    const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (cfg.projectId) return cfg.projectId.trim();
    }
  } catch {
    // fallback abaixo
  }
  return 'dark-forge-wcjpc';
}

const FIREBASE_PROJECT_ID = resolveFirebaseProjectId();
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> | null = null;
let cachedCertsExpiresAt = 0;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now < cachedCertsExpiresAt) {
    return cachedCerts;
  }
  const resp = await fetch(GOOGLE_CERTS_URL);
  if (!resp.ok) {
    throw new Error('Falha ao obter chaves públicas de autenticação do Firebase.');
  }
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  const certs = (await resp.json()) as Record<string, string>;
  cachedCerts = certs;
  cachedCertsExpiresAt = now + Math.max(60, maxAgeSeconds) * 1000;
  return certs;
}

function base64UrlToBuffer(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

async function verifyFirebaseIdToken(token: string): Promise<VerifiedFirebaseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token de autenticação malformado.');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8')) as FirebaseJwtPayload;

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Algoritmo ou identificador de chave inválido.');
  }

  const certs = await getFirebasePublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Certificado de assinatura do token não encontrado.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const isValidSig = verifier.verify(certPem, base64UrlToBuffer(signatureB64));
  if (!isValidSig) {
    throw new Error('Assinatura do token Firebase inválida.');
  }

  return validateFirebasePayloadClaims(payload, FIREBASE_PROJECT_ID);
}

async function requireFirebaseAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Autenticação obrigatória. Faça login com e-mail verificado antes de utilizar os recursos de IA.',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Token de autenticação ausente.' });
    return;
  }

  try {
    const claims = await verifyFirebaseIdToken(token);
    (req as Request & { firebaseUser?: VerifiedFirebaseClaims }).firebaseUser = claims;
    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Token Firebase inválido.';
    const status = message.includes('não foi verificado') ? 403 : 401;
    res.status(status).json({ error: message });
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY não configurada no servidor.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function createNodeGeminiCaller() {
  const ai = getGeminiClient();
  const models = ['gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;

  return async (spec: AiCallSpec): Promise<string> => {
    let lastError: unknown;
    for (let i = 0; i < models.length; i += 1) {
      try {
        const resp = await ai.models.generateContent({
          model: models[i],
          contents: spec.contents as Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'],
          config: {
            systemInstruction: spec.systemInstruction,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseSchema: spec.responseSchema as NonNullable<
              Parameters<GoogleGenAI['models']['generateContent']>[0]['config']
            >['responseSchema'],
          },
        });
        return resp.text ?? '{}';
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429');
        if (!isTransient || i === models.length - 1) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 600 * (i + 1)));
      }
    }
    throw lastError;
  };
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.disable('x-powered-by');

  const extraOrigins = (process.env.APP_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const allowedOrigins = new Set<string>([
    `https://${FIREBASE_PROJECT_ID}.web.app`,
    `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
    'http://localhost:3000',
    ...extraOrigins,
  ]);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const origin = req.headers.origin;
    const hostHeader = req.headers.host;
    const isSameHostOrigin = Boolean(
      origin && hostHeader && (origin === `https://${hostHeader}` || origin === `http://${hostHeader}`)
    );
    if (origin && (isSameHostOrigin || allowedOrigins.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      runtime: 'node-express',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      firebaseProjectId: FIREBASE_PROJECT_ID,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/ai/chat', requireFirebaseAuth, async (req: Request, res: Response) => {
    try {
      const result = await executeAiChat(
        (req.body ?? {}) as AiChatRequestBody,
        NODE_SCHEMA_TOKENS,
        createNodeGeminiCaller()
      );
      res.status(result.status).json(result.body);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro interno ao consultar o Google Gemini.');
      console.error('Erro em /api/ai/chat:', mapped.error);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/api/ai/inventory-command', requireFirebaseAuth, async (req: Request, res: Response) => {
    try {
      const result = await executeInventoryCommand(
        (req.body ?? {}) as InventoryCommandRequest,
        NODE_SCHEMA_TOKENS,
        createNodeGeminiCaller()
      );
      res.status(result.status).json(result.body);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro ao interpretar comando de estoque.');
      console.error('Erro em /api/ai/inventory-command:', mapped.error);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  const pdfJsonParser = express.json({ limit: '16mb' });

  app.post('/api/finance/parse-pdf-statement', requireFirebaseAuth, pdfJsonParser, async (req: Request, res: Response) => {
    try {
      const result = await executeParsePdfStatement(
        (req.body ?? {}) as { fileName?: string; pdfBase64?: string },
        NODE_SCHEMA_TOKENS,
        createNodeGeminiCaller()
      );
      res.status(result.status).json(result.body);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro ao processar extrato PDF.');
      console.error('Erro em /api/finance/parse-pdf-statement:', mapped.error);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/api/finance/parse-pdf-invoice', requireFirebaseAuth, pdfJsonParser, async (req: Request, res: Response) => {
    try {
      const result = await executeParsePdfInvoice(
        (req.body ?? {}) as { fileName?: string; pdfBase64?: string },
        NODE_SCHEMA_TOKENS,
        createNodeGeminiCaller()
      );
      res.status(result.status).json(result.body);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro ao processar PDF da nota fiscal.');
      console.error('Erro em /api/finance/parse-pdf-invoice:', mapped.error);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  app.post('/api/reconciliation/suggest', requireFirebaseAuth, async (req: Request, res: Response) => {
    try {
      const result = await executeReconciliationSuggest(
        (req.body ?? {}) as ReconciliationSuggestRequestBody,
        NODE_SCHEMA_TOKENS,
        createNodeGeminiCaller()
      );
      res.status(result.status).json(result.body);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro ao analisar conciliações com Gemini.');
      console.error('Erro em /api/reconciliation/suggest:', mapped.error);
      res.status(mapped.status).json({ error: mapped.error });
    }
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Gestão Inteligente Empresarial ativo na porta ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Falha ao iniciar servidor:', err);
  process.exit(1);
});
