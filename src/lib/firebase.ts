import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

let appCheckInstance: AppCheck | null = null;
let appCheckConfigured = false;

const resolvedAppCheckSiteKey = (
  import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY ||
  firebaseConfig.recaptchaSiteKey ||
  ''
).trim();

if (typeof window !== 'undefined' && resolvedAppCheckSiteKey) {
  try {
    const debugToken = import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN;
    if (debugToken) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        debugToken === 'true' ? true : debugToken;
    }
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(resolvedAppCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckConfigured = true;
  } catch (err) {
    console.warn('Não foi possível inicializar Firebase App Check:', err);
  }
}

export function getAppCheckStatus(): { configured: boolean; instance: AppCheck | null } {
  return {
    configured: appCheckConfigured,
    instance: appCheckInstance,
  };
}

export const FIREBASE_RUNTIME_INFO = {
  projectId: firebaseConfig.projectId,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
  storageBucket: firebaseConfig.storageBucket,
  authDomain: firebaseConfig.authDomain,
  appCheckConfigured,
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const start = performance.now();
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: true,
      latencyMs,
      message: `Conectado ao Cloud Firestore (${latencyMs} ms).`,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('the client is offline')) {
      console.error('Verifique a configuração do Firebase: o cliente está offline.');
      return {
        ok: false,
        latencyMs,
        message: 'Cliente offline ou configuração do Firebase inacessível.',
      };
    }
    // Permission denied on nonexistent test doc proves live server round-trip
    if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('insufficient')) {
      return {
        ok: true,
        latencyMs,
        message: `Conexão real verificada com o Cloud Firestore (${latencyMs} ms).`,
      };
    }
    return {
      ok: false,
      latencyMs,
      message: msg,
    };
  }
}

void testConnection();
