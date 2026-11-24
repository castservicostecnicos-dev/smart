import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai/web';
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
} from '../shared/erpAiCore';

export interface AssetsFetcher {
  fetch(request: Request | string): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS?: AssetsFetcher;
  GEMINI_API_KEY?: string;
  FIREBASE_PROJECT_ID?: string;
  APP_URL?: string;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface GoogleJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

const GOOGLE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const WORKER_SCHEMA_TOKENS: SchemaTokens = {
  OBJECT: Type.OBJECT,
  STRING: Type.STRING,
  NUMBER: Type.NUMBER,
  ARRAY: Type.ARRAY,
  BOOLEAN: Type.BOOLEAN,
};

let cachedJwks: GoogleJwk[] | null = null;
let cachedJwksExpiresAt = 0;

function base64UrlToUint8Array(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPartJson<T>(part: string): T {
  const bytes = base64UrlToUint8Array(part);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

async function getFirebasePublicJwks(): Promise<GoogleJwk[]> {
  const now = Date.now();
  if (cachedJwks && now < cachedJwksExpiresAt) {
    return cachedJwks;
  }

  const resp = await fetch(GOOGLE_JWK_URL);
  if (!resp.ok) {
    throw new Error('Falha ao obter chaves públicas de autenticação do Firebase.');
  }

  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  const data = (await resp.json()) as { keys?: GoogleJwk[] };
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw new Error('Lista de chaves públicas Firebase indisponível.');
  }

  cachedJwks = data.keys;
  cachedJwksExpiresAt = now + Math.max(60, maxAgeSeconds) * 1000;
  return data.keys;
}

export async function verifyFirebaseIdTokenWebCrypto(
  token: string,
  expectedProjectId: string
): Promise<VerifiedFirebaseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token de autenticação malformado.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJwtPartJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = decodeJwtPartJson<FirebaseJwtPayload>(payloadB64);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Algoritmo ou identificador de chave inválido.');
  }

  const jwks = await getFirebasePublicJwks();
  const matchingKey = jwks.find((k) => k.kid === header.kid);
  if (!matchingKey) {
    throw new Error('Chave de assinatura do token não encontrada.');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    matchingKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64UrlToUint8Array(signatureB64);
  const isValidSig = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes,
    signedData
  );

  if (!isValidSig) {
    throw new Error('Assinatura do token Firebase inválida.');
  }

  return validateFirebasePayloadClaims(payload, expectedProjectId);
}

function buildCorsHeaders(request: Request, env: WorkerEnv, projectId: string): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin) return {};

  const requestOrigin = new URL(request.url).origin;
  const extraOrigins = (env.APP_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const allowedOrigins = new Set<string>([
    requestOrigin,
    `https://${projectId}.web.app`,
    `https://${projectId}.firebaseapp.com`,
    'http://localhost:3000',
    'http://localhost:8787',
    ...extraOrigins,
  ]);

  const isAllowed = allowedOrigins.has(origin);

  if (!isAllowed) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}

async function readJsonBodyWithLimit<T>(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: 'Payload acima do limite permitido pelo servidor.' };
  }

  const rawBuffer = await request.arrayBuffer();
  if (rawBuffer.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'Payload acima do limite permitido pelo servidor.' };
  }

  if (rawBuffer.byteLength === 0) {
    return { ok: true, data: {} as T };
  }

  try {
    const text = new TextDecoder().decode(rawBuffer);
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: 'Corpo JSON inválido.' };
  }
}

function createWorkerGeminiCaller(env: WorkerEnv) {
  const apiKey = (env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY não configurada no Cloudflare Worker.');
  }

  const ai = new GoogleGenAI({ apiKey });
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

async function authenticateWorkerRequest(
  request: Request,
  projectId: string
): Promise<{ ok: true; claims: VerifiedFirebaseClaims } | { ok: false; status: number; error: string }> {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      error: 'Autenticação obrigatória. Faça login com e-mail verificado antes de utilizar os recursos de IA.',
    };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Token de autenticação ausente.' };
  }

  try {
    const claims = await verifyFirebaseIdTokenWebCrypto(token, projectId);
    return { ok: true, claims };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Token Firebase inválido.';
    const status = message.includes('não foi verificado') ? 403 : 401;
    return { ok: false, status, error: message };
  }
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  _ctx?: WorkerExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const projectId = (env.FIREBASE_PROJECT_ID || 'dark-forge-wcjpc').trim();

  if (url.pathname.startsWith('/api/')) {
    const corsHeaders = buildCorsHeaders(request, env, projectId);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse(
        200,
        {
          status: 'ok',
          runtime: 'cloudflare-worker',
          geminiConfigured: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
          firebaseProjectId: projectId,
          timestamp: new Date().toISOString(),
        },
        corsHeaders
      );
    }

    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'Método não permitido.' }, corsHeaders);
    }

    const authResult = await authenticateWorkerRequest(request, projectId);
    if (!authResult.ok) {
      return jsonResponse(authResult.status, { error: authResult.error }, corsHeaders);
    }

    const isPdfRoute =
      url.pathname === '/api/finance/parse-pdf-statement' ||
      url.pathname === '/api/finance/parse-pdf-invoice';
    const bodyLimitBytes = isPdfRoute ? 16 * 1024 * 1024 : 4 * 1024 * 1024;

    const parsedBody = await readJsonBodyWithLimit<Record<string, unknown>>(request, bodyLimitBytes);
    if (!parsedBody.ok) {
      return jsonResponse(parsedBody.status, { error: parsedBody.error }, corsHeaders);
    }

    try {
      const generateJson = createWorkerGeminiCaller(env);

      if (url.pathname === '/api/ai/chat') {
        const result = await executeAiChat(
          parsedBody.data as AiChatRequestBody,
          WORKER_SCHEMA_TOKENS,
          generateJson
        );
        return jsonResponse(result.status, result.body, corsHeaders);
      }

      if (url.pathname === '/api/ai/inventory-command') {
        const result = await executeInventoryCommand(
          parsedBody.data as InventoryCommandRequest,
          WORKER_SCHEMA_TOKENS,
          generateJson
        );
        return jsonResponse(result.status, result.body, corsHeaders);
      }

      if (url.pathname === '/api/finance/parse-pdf-statement') {
        const result = await executeParsePdfStatement(
          parsedBody.data as { fileName?: string; pdfBase64?: string },
          WORKER_SCHEMA_TOKENS,
          generateJson
        );
        return jsonResponse(result.status, result.body, corsHeaders);
      }

      if (url.pathname === '/api/finance/parse-pdf-invoice') {
        const result = await executeParsePdfInvoice(
          parsedBody.data as { fileName?: string; pdfBase64?: string },
          WORKER_SCHEMA_TOKENS,
          generateJson
        );
        return jsonResponse(result.status, result.body, corsHeaders);
      }

      if (url.pathname === '/api/reconciliation/suggest') {
        const result = await executeReconciliationSuggest(
          parsedBody.data as ReconciliationSuggestRequestBody,
          WORKER_SCHEMA_TOKENS,
          generateJson
        );
        return jsonResponse(result.status, result.body, corsHeaders);
      }

      return jsonResponse(404, { error: 'Rota de API não encontrada.' }, corsHeaders);
    } catch (error: unknown) {
      const mapped = mapGeminiErrorToHttp(error, 'Erro interno no servidor Cloudflare Worker.');
      console.error(`Erro em ${url.pathname}:`, mapped.error);
      return jsonResponse(mapped.status, { error: mapped.error }, corsHeaders);
    }
  }

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  return new Response('Assets estáticos não configurados.', { status: 404 });
}

export default {
  fetch: handleWorkerRequest,
};
