import type { User } from 'firebase/auth';
import { collection, deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';
import { db, handleFirestoreError, OperationType, storage } from '../lib/firebase';
import {
  FIELD_LIMITS,
  type CompanyDocument,
  type StorageFolder,
} from '../types/erp';
import { sanitizeId } from '../utils/formatters';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_EXTENSIONS = new Set([
  'xml',
  'csv',
  'ofx',
  'pdf',
  'xlsx',
  'xls',
  'txt',
  'json',
]);

function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._\-]/g, '_');
  return cleaned.slice(0, 140) || 'arquivo.dat';
}

function resolveContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'xml':
      return 'application/xml';
    case 'csv':
      return 'text/csv';
    case 'ofx':
      return 'application/x-ofx';
    case 'pdf':
      return 'application/pdf';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'json':
      return 'application/json';
    default:
      return 'text/plain';
  }
}

export function translateStorageError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: string }).code)
      : '';

  if (
    code === 'storage/bucket-not-found' ||
    code === 'storage/project-not-found' ||
    msg.includes('404') ||
    msg.toLowerCase().includes('billing') ||
    msg.toLowerCase().includes('blaze')
  ) {
    return 'O Firebase Storage ainda não está ativado neste projeto ou requer atualização para o Plano Blaze no Console do Firebase.';
  }
  if (code === 'storage/unauthorized') {
    return 'Permissão negada no Firebase Storage para este perfil ou empresa (ou regras storage.rules ainda não implantadas).';
  }
  if (code === 'storage/retry-limit-exceeded') {
    return 'Tempo limite excedido ao enviar arquivo para o Firebase Storage. Verifique sua conexão e se o Storage está ativado.';
  }
  return msg || 'Erro ao comunicar com o Firebase Storage.';
}

export async function uploadCompanyFile(
  user: User,
  companyId: string,
  pasta: StorageFolder,
  file: File,
  entidadeReferenciaId?: string,
  onProgress?: (pct: number) => void
): Promise<CompanyDocument> {
  const safeCompanyId = sanitizeId(companyId);
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Extensão ".${ext}" não permitida. Envie arquivos XML, OFX, CSV, PDF, XLSX, XLS, TXT ou JSON.`
    );
  }
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new Error('O arquivo deve ter entre 1 byte e 10 MB.');
  }

  const safeName = sanitizeFileName(file.name);
  const storagePath = `companies/${safeCompanyId}/${pasta}/${Date.now()}_${safeName}`;
  const storageRef = ref(storage, storagePath);
  const contentType = resolveContentType(file);

  let downloadUrl = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file, { contentType });
      task.on(
        'state_changed',
        (snap) => {
          if (onProgress && snap.totalBytes > 0) {
            onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
          }
        },
        (error) => reject(error),
        () => resolve()
      );
    });
    downloadUrl = await getDownloadURL(storageRef);
  } catch (err) {
    throw new Error(translateStorageError(err));
  }

  const docRef = doc(collection(db, 'companies', safeCompanyId, 'documents'));
  const auditRef = doc(collection(db, 'companies', safeCompanyId, 'auditLogs'));
  const path = `companies/${safeCompanyId}/documents/${docRef.id}`;

  const docPayload = {
    companyId: safeCompanyId,
    ownerId: sanitizeId(user.uid),
    nome: file.name.trim().slice(0, FIELD_LIMITS.fileName),
    pasta,
    contentType: contentType.slice(0, 140),
    tamanhoBytes: file.size,
    storagePath: storagePath.slice(0, FIELD_LIMITS.storagePath),
    downloadUrl: downloadUrl.slice(0, FIELD_LIMITS.downloadUrl),
    entidadeReferenciaId: entidadeReferenciaId ? sanitizeId(entidadeReferenciaId) : '',
    uploadedByName: (user.displayName || user.email || 'Usuário').trim().slice(0, FIELD_LIMITS.userName),
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(docRef, docPayload);
    await setDoc(auditRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      userEmail: (user.email || 'usuario@empresa.com').trim().slice(0, FIELD_LIMITS.userEmail),
      userName: (user.displayName || user.email || 'Usuário').trim().slice(0, FIELD_LIMITS.userName),
      modulo: 'Documentos (Storage)',
      acao: 'storage',
      entidadeId: docRef.id,
      resumo: `Enviou arquivo "${docPayload.nome}" na pasta ${pasta}`.slice(0, FIELD_LIMITS.auditResumo),
      origem: 'Storage',
      resultado: 'sucesso',
      dadosAnteriores: 'Sem arquivo cadastrado',
      dadosPosteriores: `${docPayload.nome} (${pasta}, ${file.size} bytes)`.slice(0, FIELD_LIMITS.auditDados),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return {
    id: docRef.id,
    ...docPayload,
    createdAt: new Date(),
  };
}

export async function deleteCompanyDocument(
  user: User,
  companyId: string,
  docItem: CompanyDocument
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeDocId = sanitizeId(docItem.id);
  const path = `companies/${safeCompanyId}/documents/${safeDocId}`;

  try {
    try {
      await deleteObject(ref(storage, docItem.storagePath));
    } catch (storageErr: unknown) {
      const code =
        typeof storageErr === 'object' && storageErr !== null && 'code' in storageErr
          ? String((storageErr as { code?: string }).code)
          : '';
      if (code !== 'storage/object-not-found') {
        throw new Error(translateStorageError(storageErr));
      }
    }

    await deleteDoc(doc(db, 'companies', safeCompanyId, 'documents', safeDocId));
    await setDoc(doc(collection(db, 'companies', safeCompanyId, 'auditLogs')), {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      userEmail: (user.email || 'usuario@empresa.com').trim().slice(0, FIELD_LIMITS.userEmail),
      userName: (user.displayName || user.email || 'Usuário').trim().slice(0, FIELD_LIMITS.userName),
      modulo: 'Documentos (Storage)',
      acao: 'excluir',
      entidadeId: safeDocId,
      resumo: `Removeu arquivo "${docItem.nome}" do Storage`.slice(0, FIELD_LIMITS.auditResumo),
      origem: 'Storage',
      resultado: 'sucesso',
      dadosAnteriores: `${docItem.nome} (${docItem.pasta})`.slice(0, FIELD_LIMITS.auditDados),
      dadosPosteriores: 'Arquivo excluído',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    if (error instanceof Error && !error.message.includes('{')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
