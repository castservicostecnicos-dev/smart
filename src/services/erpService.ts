import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  DEFAULT_COMPANY_ID,
  FIELD_LIMITS,
  ISO_DATE_REGEX,
  isBootstrappedAdminEmail,
  normalizeUserRole,
  ROLE_DEFAULT_PERMISSIONS,
  type AiActionType,
  type AiChatMessage,
  type AiConversation,
  type AuditAction,
  type AuditOrigin,
  type AuditResult,
  type BankTransaction,
  type Company,
  type CompanyInvite,
  type CompanyMember,
  type Customer,
  type FinancialTransaction,
  type InventoryProduct,
  type Invoice,
  type MenuSection,
  type SavedReport,
  type StockMovementReason,
  type StockMovementType,
  type TaxRegime,
  type UserAccount,
  type UserCompanyMembership,
  type UserRole,
} from '../types/erp';
import { sanitizeId, todayISO } from '../utils/formatters';
import { detectPersonType, digitsOnly, formatCpfCnpj } from '../utils/financeDocuments';

function clip(value: string | undefined | null, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

function isBootstrappedAdminUser(user: User): boolean {
  return Boolean(user.emailVerified && isBootstrappedAdminEmail(user.email));
}

function ensureIsoDate(dateStr: string, fieldName: string): string {
  const clean = dateStr.trim().slice(0, 10);
  if (!ISO_DATE_REGEX.test(clean)) {
    throw new Error(`Data inválida no campo ${fieldName}. Use o formato válido.`);
  }
  return clean;
}

function ensureNonNegativeNumber(val: number, fieldName: string): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Valor inválido no campo ${fieldName}.`);
  }
  return Math.round(num * 100) / 100;
}

async function migrateLegacySingleCompanyIfNeeded(user: User, companyId: string): Promise<void> {
  if (!isBootstrappedAdminUser(user) || companyId !== DEFAULT_COMPANY_ID) return;

  const mappings: Array<{ legacy: string; target: string }> = [
    { legacy: 'financialTransactions', target: 'financialTransactions' },
    { legacy: 'invoices', target: 'invoices' },
    { legacy: 'bankTransactions', target: 'bankTransactions' },
    { legacy: 'inventory', target: 'products' },
    { legacy: 'stockMovements', target: 'stockMovements' },
    { legacy: 'auditLogs', target: 'auditLogs' },
  ];

  for (const mapItem of mappings) {
    try {
      const legacyQuery = query(
        collection(db, mapItem.legacy),
        where('companyId', '==', DEFAULT_COMPANY_ID)
      );
      const legacySnap = await getDocs(legacyQuery);
      if (legacySnap.empty) continue;

      const targetSnap = await getDocs(collection(db, 'companies', companyId, mapItem.target));
      if (!targetSnap.empty) continue;

      const batch = writeBatch(db);
      let count = 0;
      for (const d of legacySnap.docs) {
        if (count >= 400) break;
        const raw = d.data() as Record<string, unknown>;
        batch.set(doc(db, 'companies', companyId, mapItem.target, sanitizeId(d.id)), {
          ...raw,
          companyId,
          ownerId: sanitizeId(String(raw.ownerId || user.uid)),
          createdAt: raw.createdAt ?? serverTimestamp(),
          ...(mapItem.target !== 'stockMovements' && mapItem.target !== 'auditLogs'
            ? { updatedAt: raw.updatedAt ?? serverTimestamp() }
            : {}),
        });
        count += 1;
      }
      if (count > 0) {
        await batch.commit();
      }
    } catch {
      // Ignora caso não haja coleção legada ou já migrada
    }
  }
}

export async function bootstrapUserAndCompanies(user: User): Promise<{
  account: UserAccount;
  memberships: UserCompanyMembership[];
}> {
  const safeUid = sanitizeId(user.uid);
  const userPath = `users/${safeUid}`;
  const userRef = doc(db, 'users', safeUid);

  let account: UserAccount;
  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      account = { id: snap.id, ...(snap.data() as Omit<UserAccount, 'id'>) };
    } else {
      const payload = {
        uid: safeUid,
        name: clip(user.displayName || user.email?.split('@')[0] || 'Usuário', FIELD_LIMITS.userName),
        email: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
        activeCompanyId: isBootstrappedAdminUser(user) ? DEFAULT_COMPANY_ID : '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(userRef, payload);
      const createdSnap = await getDoc(userRef);
      account = { id: createdSnap.id, ...(createdSnap.data() as Omit<UserAccount, 'id'>) };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  // Se for administrador bootstrapado, garante a empresa matriz padrão
  if (isBootstrappedAdminUser(user)) {
    const defaultCompanyRef = doc(db, 'companies', DEFAULT_COMPANY_ID);
    const defaultMemberRef = doc(db, 'companies', DEFAULT_COMPANY_ID, 'members', safeUid);
    const userCompanyLinkRef = doc(db, 'users', safeUid, 'companies', DEFAULT_COMPANY_ID);

    try {
      const compSnap = await getDoc(defaultCompanyRef);
      if (!compSnap.exists()) {
        // Verifica se havia companySettings legado para aproveitar nome/CNPJ
        let legacyName = 'Gestão Inteligente Empresarial';
        let legacyRazao = 'Gestão Inteligente Empresarial Ltda';
        let legacyCnpj = '';
        let legacyRegime: TaxRegime = 'Simples Nacional';
        let legacyTolerance = 5;
        let legacySerie = '1';

        try {
          const legacySettingsSnap = await getDocs(
            query(collection(db, 'companySettings'), where('companyId', '==', DEFAULT_COMPANY_ID))
          );
          if (!legacySettingsSnap.empty) {
            const ls = legacySettingsSnap.docs[0].data() as Partial<Company>;
            if (ls.nomeFantasia) legacyName = ls.nomeFantasia;
            if (ls.razaoSocial) legacyRazao = ls.razaoSocial;
            if (ls.cnpj) legacyCnpj = ls.cnpj;
            if (ls.regimeTributario) legacyRegime = ls.regimeTributario;
            if (typeof ls.diasToleranciaConciliacao === 'number') {
              legacyTolerance = ls.diasToleranciaConciliacao;
            }
            if (ls.serieNfPadrao) legacySerie = ls.serieNfPadrao;
          }
        } catch {
          // Sem dados legados
        }

        const batch = writeBatch(db);
        batch.set(defaultCompanyRef, {
          companyId: DEFAULT_COMPANY_ID,
          ownerId: safeUid,
          razaoSocial: clip(legacyRazao, FIELD_LIMITS.razaoSocial),
          nomeFantasia: clip(legacyName, FIELD_LIMITS.nomeFantasia),
          cnpj: clip(legacyCnpj, FIELD_LIMITS.cnpj),
          inscricaoEstadual: '',
          telefone: '',
          email: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
          endereco: '',
          regimeTributario: legacyRegime,
          diasToleranciaConciliacao: legacyTolerance,
          serieNfPadrao: clip(legacySerie, FIELD_LIMITS.serieNf),
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(defaultMemberRef, {
          companyId: DEFAULT_COMPANY_ID,
          uid: safeUid,
          name: clip(account.name, FIELD_LIMITS.userName),
          email: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
          role: 'ADMINISTRADOR',
          department: 'Diretoria / Administração',
          active: true,
          permissions: [...ROLE_DEFAULT_PERMISSIONS.ADMINISTRADOR],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        batch.set(userCompanyLinkRef, {
          companyId: DEFAULT_COMPANY_ID,
          companyName: clip(legacyName, FIELD_LIMITS.nomeFantasia),
          uid: safeUid,
          role: 'ADMINISTRADOR',
          active: true,
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      } else {
        const memSnap = await getDoc(defaultMemberRef);
        if (!memSnap.exists()) {
          const compData = compSnap.data() as Company;
          const batch = writeBatch(db);
          batch.set(defaultMemberRef, {
            companyId: DEFAULT_COMPANY_ID,
            uid: safeUid,
            name: clip(account.name, FIELD_LIMITS.userName),
            email: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
            role: 'ADMINISTRADOR',
            department: 'Diretoria / Administração',
            active: true,
            permissions: [...ROLE_DEFAULT_PERMISSIONS.ADMINISTRADOR],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          batch.set(userCompanyLinkRef, {
            companyId: DEFAULT_COMPANY_ID,
            companyName: clip(compData.nomeFantasia, FIELD_LIMITS.nomeFantasia),
            uid: safeUid,
            role: 'ADMINISTRADOR',
            active: true,
            updatedAt: serverTimestamp(),
          });
          await batch.commit();
        }
      }

      await migrateLegacySingleCompanyIfNeeded(user, DEFAULT_COMPANY_ID);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `companies/${DEFAULT_COMPANY_ID}`);
    }
  }

  // Busca empresas vinculadas ao usuário
  const membershipsPath = `users/${safeUid}/companies`;
  try {
    const snap = await getDocs(query(collection(db, membershipsPath), where('uid', '==', safeUid)));
    const memberships = snap.docs.map((d) => {
      const data = d.data() as Omit<UserCompanyMembership, 'id'>;
      return {
        id: d.id,
        ...data,
        role: normalizeUserRole(data.role),
      };
    });
    return { account, memberships };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, membershipsPath);
  }
}

export function subscribeUserCompanies(
  user: User,
  onData: (memberships: UserCompanyMembership[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeUid = sanitizeId(user.uid);
  const path = `users/${safeUid}/companies`;
  return onSnapshot(
    query(collection(db, path), where('uid', '==', safeUid)),
    (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data() as Omit<UserCompanyMembership, 'id'>;
        return {
          id: d.id,
          ...data,
          role: normalizeUserRole(data.role),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribePendingInvitesForUser(
  user: User,
  onData: (invites: CompanyInvite[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const emailLower = (user.email ?? '').trim().toLowerCase();
  if (!emailLower) {
    onData([]);
    return () => {};
  }
  const path = 'invites';
  return onSnapshot(
    query(collection(db, path), where('email', '==', emailLower)),
    (snap) => {
      const list = snap.docs
        .map((d) => {
          const data = d.data() as Omit<CompanyInvite, 'id'>;
          return {
            id: d.id,
            ...data,
            role: normalizeUserRole(data.role),
          };
        })
        .filter((inv) => inv.status === 'pendente');
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeCompanyInvites(
  companyId: string,
  user: User,
  onData: (invites: CompanyInvite[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'invites';
  const q = isBootstrappedAdminUser(user)
    ? collection(db, path)
    : query(collection(db, path), where('invitedByUid', '==', sanitizeId(user.uid)));

  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs
        .map((d) => {
          const data = d.data() as Omit<CompanyInvite, 'id'>;
          return {
            id: d.id,
            ...data,
            role: normalizeUserRole(data.role),
          };
        })
        .filter((inv) => inv.companyId === companyId && inv.status === 'pendente');
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeCompanyDoc(
  companyId: string,
  onData: (company: Company | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeId = sanitizeId(companyId);
  const path = `companies/${safeId}`;
  return onSnapshot(
    doc(db, 'companies', safeId),
    (snap) => {
      if (snap.exists()) {
        onData({ id: snap.id, ...(snap.data() as Omit<Company, 'id'>) });
      } else {
        onData(null);
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeCurrentCompanyMember(
  companyId: string,
  uid: string,
  onData: (member: CompanyMember | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeCompanyId = sanitizeId(companyId);
  const safeUid = sanitizeId(uid);
  const path = `companies/${safeCompanyId}/members/${safeUid}`;
  return onSnapshot(
    doc(db, 'companies', safeCompanyId, 'members', safeUid),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Omit<CompanyMember, 'id'>;
        onData({
          id: snap.id,
          ...data,
          role: normalizeUserRole(data.role),
        });
      } else {
        onData(null);
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeCompanyMembers(
  companyId: string,
  onData: (members: CompanyMember[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeCompanyId = sanitizeId(companyId);
  const path = `companies/${safeCompanyId}/members`;
  return onSnapshot(
    query(collection(db, path), where('companyId', '==', safeCompanyId)),
    (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data() as Omit<CompanyMember, 'id'>;
        return {
          id: d.id,
          ...data,
          role: normalizeUserRole(data.role),
        };
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeCompanySubcollection<T>(
  companyId: string,
  subcollectionName: string,
  onData: (items: T[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeCompanyId = sanitizeId(companyId);
  const path = `companies/${safeCompanyId}/${subcollectionName}`;
  return onSnapshot(
    query(collection(db, path), where('companyId', '==', safeCompanyId)),
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Record<string, unknown>),
      })) as T[];
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

interface AuditLogMeta {
  origem?: AuditOrigin | string;
  resultado?: AuditResult;
  dadosAnteriores?: string;
  dadosPosteriores?: string;
}

async function writeAuditLog(
  user: User,
  companyId: string,
  modulo: string,
  acao: AuditAction,
  resumo: string,
  entidadeId?: string,
  meta?: AuditLogMeta
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const logRef = doc(collection(db, 'companies', safeCompanyId, 'auditLogs'));
  const path = `companies/${safeCompanyId}/auditLogs/${logRef.id}`;
  try {
    await setDoc(logRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      userEmail: clip((user.email || 'usuario@empresa.com').toLowerCase(), FIELD_LIMITS.userEmail),
      userName: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.userName),
      modulo: clip(modulo, 60),
      acao,
      entidadeId: entidadeId ? sanitizeId(entidadeId) : '',
      resumo: clip(resumo, FIELD_LIMITS.auditResumo),
      origem: clip(meta?.origem || 'Interface Web', FIELD_LIMITS.auditOrigem),
      resultado: meta?.resultado ?? 'sucesso',
      dadosAnteriores: clip(meta?.dadosAnteriores || '', FIELD_LIMITS.auditDados),
      dadosPosteriores: clip(meta?.dadosPosteriores || '', FIELD_LIMITS.auditDados),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// ==================== GESTÃO MULTIEMPRESA ====================
export interface CreateCompanyInput {
  razaoSocial: string;
  nomeFantasia: string;
  cnpj?: string;
  regimeTributario: TaxRegime;
  telefone?: string;
  email?: string;
  endereco?: string;
  serieNfPadrao?: string;
  diasToleranciaConciliacao?: number;
}

export async function createCompany(user: User, input: CreateCompanyInput): Promise<string> {
  const safeUid = sanitizeId(user.uid);
  const slugBase = input.nomeFantasia
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
  const companyId = sanitizeId(`${slugBase || 'empresa'}-${Date.now().toString(36)}`);
  const path = `companies/${companyId}`;

  try {
    const batch = writeBatch(db);
    const companyRef = doc(db, 'companies', companyId);
    const memberRef = doc(db, 'companies', companyId, 'members', safeUid);
    const userLinkRef = doc(db, 'users', safeUid, 'companies', companyId);
    const userRef = doc(db, 'users', safeUid);
    const auditRef = doc(collection(db, 'companies', companyId, 'auditLogs'));

    const nomeFantasia = clip(input.nomeFantasia, FIELD_LIMITS.nomeFantasia);
    batch.set(companyRef, {
      companyId,
      ownerId: safeUid,
      razaoSocial: clip(input.razaoSocial, FIELD_LIMITS.razaoSocial),
      nomeFantasia,
      cnpj: clip(input.cnpj, FIELD_LIMITS.cnpj),
      inscricaoEstadual: '',
      telefone: clip(input.telefone, FIELD_LIMITS.telefone),
      email: clip((input.email || user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
      endereco: clip(input.endereco, FIELD_LIMITS.endereco),
      regimeTributario: input.regimeTributario,
      diasToleranciaConciliacao: Math.max(0, Math.min(90, Math.round(Number(input.diasToleranciaConciliacao) || 5))),
      serieNfPadrao: clip(input.serieNfPadrao || '1', FIELD_LIMITS.serieNf),
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(memberRef, {
      companyId,
      uid: safeUid,
      name: clip(user.displayName || user.email?.split('@')[0] || 'Administrador', FIELD_LIMITS.userName),
      email: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
      role: 'ADMINISTRADOR',
      department: 'Diretoria / Administração',
      active: true,
      permissions: [...ROLE_DEFAULT_PERMISSIONS.ADMINISTRADOR],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(userLinkRef, {
      companyId,
      companyName: nomeFantasia,
      uid: safeUid,
      role: 'ADMINISTRADOR',
      active: true,
      updatedAt: serverTimestamp(),
    });

    batch.update(userRef, {
      activeCompanyId: companyId,
      updatedAt: serverTimestamp(),
    });

    batch.set(auditRef, {
      companyId,
      ownerId: safeUid,
      userEmail: clip((user.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
      userName: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.userName),
      modulo: 'Empresas',
      acao: 'criar',
      entidadeId: companyId,
      resumo: clip(`Cadastrou nova empresa: ${nomeFantasia}`, FIELD_LIMITS.auditResumo),
      origem: 'Administração',
      resultado: 'sucesso',
      dadosAnteriores: 'Empresa inexistente',
      dadosPosteriores: clip(`${nomeFantasia} | Regime: ${input.regimeTributario}`, FIELD_LIMITS.auditDados),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return companyId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function switchActiveCompany(user: User, companyId: string): Promise<void> {
  const safeUid = sanitizeId(user.uid);
  const safeCompanyId = sanitizeId(companyId);
  const path = `users/${safeUid}`;
  try {
    await updateDoc(doc(db, 'users', safeUid), {
      activeCompanyId: safeCompanyId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ==================== CONVITES E MEMBROS ====================
export async function inviteCompanyMember(
  adminUser: User,
  companyId: string,
  companyName: string,
  input: { email: string; name: string; department: string; role: UserRole }
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const inviteRef = doc(collection(db, 'invites'));
  const path = `invites/${inviteRef.id}`;
  const cleanEmail = clip(input.email.toLowerCase(), FIELD_LIMITS.userEmail);
  try {
    await setDoc(inviteRef, {
      companyId: safeCompanyId,
      companyName: clip(companyName, FIELD_LIMITS.nomeFantasia),
      email: cleanEmail,
      name: clip(input.name, FIELD_LIMITS.userName),
      department: clip(input.department, FIELD_LIMITS.department),
      role: input.role,
      status: 'pendente',
      invitedByUid: sanitizeId(adminUser.uid),
      invitedByEmail: clip((adminUser.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await writeAuditLog(
      adminUser,
      safeCompanyId,
      'Usuários e Permissões',
      'permissao',
      `Convidou ${cleanEmail} com perfil ${input.role}`,
      inviteRef.id,
      {
        origem: 'Administração',
        resultado: 'sucesso',
        dadosAnteriores: 'Sem convite ativo',
        dadosPosteriores: `${cleanEmail} (${input.role})`,
      }
    );
    return inviteRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function cancelCompanyInvite(
  adminUser: User,
  companyId: string,
  inviteId: string,
  email: string
): Promise<void> {
  const safeInviteId = sanitizeId(inviteId);
  const path = `invites/${safeInviteId}`;
  try {
    await updateDoc(doc(db, 'invites', safeInviteId), {
      status: 'cancelado',
      updatedAt: serverTimestamp(),
    });
    await writeAuditLog(
      adminUser,
      companyId,
      'Usuários e Permissões',
      'permissao',
      `Cancelou convite de ${clip(email, 80)}`,
      safeInviteId,
      {
        origem: 'Administração',
        resultado: 'sucesso',
        dadosAnteriores: `Convite pendente (${clip(email, 80)})`,
        dadosPosteriores: 'Status: cancelado',
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function acceptCompanyInvite(user: User, invite: CompanyInvite): Promise<void> {
  const safeUid = sanitizeId(user.uid);
  const safeCompanyId = sanitizeId(invite.companyId);
  const safeInviteId = sanitizeId(invite.id);
  const path = `companies/${safeCompanyId}/members/${safeUid}`;

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'companies', safeCompanyId, 'members', safeUid), {
      companyId: safeCompanyId,
      uid: safeUid,
      name: clip(user.displayName || invite.name || user.email?.split('@')[0] || 'Usuário', FIELD_LIMITS.userName),
      email: clip((user.email || invite.email).toLowerCase(), FIELD_LIMITS.userEmail),
      role: invite.role,
      department: clip(invite.department, FIELD_LIMITS.department),
      active: true,
      permissions: [...ROLE_DEFAULT_PERMISSIONS[invite.role]],
      inviteId: safeInviteId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'users', safeUid, 'companies', safeCompanyId), {
      companyId: safeCompanyId,
      companyName: clip(invite.companyName, FIELD_LIMITS.nomeFantasia),
      uid: safeUid,
      role: invite.role,
      active: true,
      inviteId: safeInviteId,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'invites', safeInviteId), {
      status: 'aceito',
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'users', safeUid), {
      activeCompanyId: safeCompanyId,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();

    await writeAuditLog(
      user,
      safeCompanyId,
      'Usuários e Permissões',
      'permissao',
      `Aceitou convite na empresa como ${invite.role}`,
      safeUid,
      {
        origem: 'Administração',
        resultado: 'sucesso',
        dadosAnteriores: `Convite pendente (${invite.email})`,
        dadosPosteriores: `Membro ativo (${invite.role})`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateCompanyMemberPermissions(
  adminUser: User,
  companyId: string,
  companyName: string,
  targetUid: string,
  updates: { role: UserRole; department: string; active: boolean; permissions: MenuSection[]; name: string; email: string }
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeTargetUid = sanitizeId(targetUid);
  const memberRef = doc(db, 'companies', safeCompanyId, 'members', safeTargetUid);
  const userCompanyRef = doc(db, 'users', safeTargetUid, 'companies', safeCompanyId);
  const path = `companies/${safeCompanyId}/members/${safeTargetUid}`;

  try {
    const prevSnap = await getDoc(memberRef);
    const prevData = prevSnap.exists() ? (prevSnap.data() as Partial<CompanyMember>) : null;
    const prevSummary = prevData
      ? `Perfil: ${prevData.role || '—'} | Ativo: ${prevData.active ? 'Sim' : 'Não'} | Telas: ${(prevData.permissions || []).length}`
      : 'Sem registro anterior';

    const batch = writeBatch(db);
    batch.update(memberRef, {
      name: clip(updates.name, FIELD_LIMITS.userName),
      role: updates.role,
      department: clip(updates.department, FIELD_LIMITS.department),
      active: Boolean(updates.active),
      permissions: updates.permissions.slice(0, 15),
      updatedAt: serverTimestamp(),
    });
    batch.set(
      userCompanyRef,
      {
        companyId: safeCompanyId,
        companyName: clip(companyName, FIELD_LIMITS.nomeFantasia),
        uid: safeTargetUid,
        role: updates.role,
        active: Boolean(updates.active),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();

    await writeAuditLog(
      adminUser,
      safeCompanyId,
      'Usuários e Permissões',
      'permissao',
      `Atualizou permissões de ${clip(updates.name, 80)} (${updates.role})`,
      safeTargetUid,
      {
        origem: 'Administração',
        resultado: 'sucesso',
        dadosAnteriores: prevSummary,
        dadosPosteriores: `Perfil: ${updates.role} | Ativo: ${updates.active ? 'Sim' : 'Não'} | Telas: ${updates.permissions.slice(0, 15).length}`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// ==================== BASE DE CLIENTES (CPF/CNPJ) ====================
export type CustomerInput = Omit<Customer, 'id' | 'companyId' | 'ownerId' | 'createdAt' | 'updatedAt'>;

export async function createCustomer(
  user: User,
  companyId: string,
  input: {
    nome: string;
    documento?: string;
    email?: string;
    telefone?: string;
    observacoes?: string;
  }
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const cleanDigits = digitsOnly(input.documento);
  const hasDoc = cleanDigits.length === 11 || cleanDigits.length === 14;
  const docId = hasDoc ? sanitizeId(`doc_${cleanDigits}`) : undefined;
  const docRef = docId
    ? doc(db, 'companies', safeCompanyId, 'customers', docId)
    : doc(collection(db, 'companies', safeCompanyId, 'customers'));
  const path = `companies/${safeCompanyId}/customers/${docRef.id}`;

  try {
    if (docId) {
      const existingSnap = await getDoc(docRef);
      if (existingSnap.exists()) {
        throw new Error(`Já existe um cliente cadastrado com o CPF/CNPJ ${formatCpfCnpj(cleanDigits)}.`);
      }
    }

    const tipoPessoa = detectPersonType(cleanDigits);
    const payload = {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      nome: clip(input.nome, FIELD_LIMITS.clienteNome),
      documento: hasDoc ? formatCpfCnpj(cleanDigits).slice(0, FIELD_LIMITS.clienteDocumento) : clip(input.documento, FIELD_LIMITS.clienteDocumento),
      documentoLimpo: cleanDigits.slice(0, FIELD_LIMITS.documentoLimpo),
      tipoPessoa,
      documentoNaoInformado: !hasDoc,
      email: clip(input.email, FIELD_LIMITS.userEmail),
      telefone: clip(input.telefone, FIELD_LIMITS.telefone),
      observacoes: clip(input.observacoes, FIELD_LIMITS.observacoes),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(docRef, payload);
    await writeAuditLog(
      user,
      safeCompanyId,
      'Clientes',
      'criar',
      `Cadastrou cliente ${payload.nome}${hasDoc ? ` (${payload.documento})` : ' (sem CPF/CNPJ)'}`,
      docRef.id,
      {
        origem: 'Interface Web',
        resultado: 'sucesso',
        dadosAnteriores: 'Novo registro',
        dadosPosteriores: `${payload.nome} (${payload.documento || 'sem CPF/CNPJ'})`,
      }
    );
    return docRef.id;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Já existe um cliente')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateCustomer(
  user: User,
  companyId: string,
  customerId: string,
  input: {
    nome?: string;
    documento?: string;
    email?: string;
    telefone?: string;
    observacoes?: string;
  }
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(customerId);
  const docRef = doc(db, 'companies', safeCompanyId, 'customers', safeId);
  const path = `companies/${safeCompanyId}/customers/${safeId}`;
  try {
    const prevSnap = await getDoc(docRef);
    const prev = prevSnap.exists() ? (prevSnap.data() as Partial<Customer>) : null;
    const prevSummary = prev ? `${prev.nome || '—'} (${prev.documento || 'sem doc'})` : 'Sem snapshot anterior';

    const updateData: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (input.nome !== undefined) updateData.nome = clip(input.nome, FIELD_LIMITS.clienteNome);
    if (input.documento !== undefined) {
      const cleanDigits = digitsOnly(input.documento);
      const hasDoc = cleanDigits.length === 11 || cleanDigits.length === 14;
      updateData.documento = hasDoc
        ? formatCpfCnpj(cleanDigits).slice(0, FIELD_LIMITS.clienteDocumento)
        : clip(input.documento, FIELD_LIMITS.clienteDocumento);
      updateData.documentoLimpo = cleanDigits.slice(0, FIELD_LIMITS.documentoLimpo);
      updateData.tipoPessoa = detectPersonType(cleanDigits);
      updateData.documentoNaoInformado = !hasDoc;
    }
    if (input.email !== undefined) updateData.email = clip(input.email, FIELD_LIMITS.userEmail);
    if (input.telefone !== undefined) updateData.telefone = clip(input.telefone, FIELD_LIMITS.telefone);
    if (input.observacoes !== undefined) updateData.observacoes = clip(input.observacoes, FIELD_LIMITS.observacoes);

    await updateDoc(docRef, updateData);
    await writeAuditLog(user, safeCompanyId, 'Clientes', 'editar', `Atualizou cadastro do cliente (${safeId})`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: prevSummary,
      dadosPosteriores: `${String(updateData.nome ?? prev?.nome ?? '—')} (${String(updateData.documento ?? prev?.documento ?? 'sem doc')})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteCustomer(
  user: User,
  companyId: string,
  customerId: string,
  nome: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(customerId);
  const path = `companies/${safeCompanyId}/customers/${safeId}`;
  try {
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'customers', safeId));
    await writeAuditLog(user, safeCompanyId, 'Clientes', 'excluir', `Excluiu cliente: ${clip(nome, 120)}`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: clip(nome, 120),
      dadosPosteriores: 'Registro removido',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ==================== FINANCEIRO ====================
export type FinancialInput = Omit<FinancialTransaction, 'id' | 'companyId' | 'ownerId' | 'createdAt' | 'updatedAt'>;

export async function createFinancialTransaction(
  user: User,
  companyId: string,
  input: FinancialInput
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const docRef = doc(collection(db, 'companies', safeCompanyId, 'financialTransactions'));
  const path = `companies/${safeCompanyId}/financialTransactions/${docRef.id}`;
  try {
    const payload = {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      tipo: input.tipo,
      descricao: clip(input.descricao, FIELD_LIMITS.descricaoFinanceira),
      categoria: clip(input.categoria, FIELD_LIMITS.categoria),
      contraparte: clip(input.contraparte, FIELD_LIMITS.contraparte),
      clienteDocumento: clip(input.clienteDocumento, FIELD_LIMITS.clienteDocumento),
      customerId: input.customerId ? sanitizeId(input.customerId) : '',
      valor: ensureNonNegativeNumber(input.valor, 'Valor'),
      dataVencimento: ensureIsoDate(input.dataVencimento, 'Data de Vencimento'),
      dataPagamento: input.dataPagamento ? ensureIsoDate(input.dataPagamento, 'Data de Pagamento') : '',
      formaPagamento: input.formaPagamento,
      status: input.status,
      invoiceId: input.invoiceId ? sanitizeId(input.invoiceId) : '',
      invoiceNumber: clip(input.invoiceNumber, FIELD_LIMITS.numeroNf),
      bankTransactionId: input.bankTransactionId ? sanitizeId(input.bankTransactionId) : '',
      reconciled: Boolean(input.reconciled),
      observacoes: clip(input.observacoes, FIELD_LIMITS.observacoes),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(docRef, payload);
    await writeAuditLog(
      user,
      safeCompanyId,
      'Financeiro',
      'criar',
      `Criou ${input.tipo === 'receita' ? 'recebimento' : 'despesa'}: ${payload.descricao}`,
      docRef.id,
      {
        origem: 'Interface Web',
        resultado: 'sucesso',
        dadosAnteriores: 'Novo lançamento',
        dadosPosteriores: `${payload.tipo} | R$ ${payload.valor.toFixed(2)} | ${payload.status} | ${payload.contraparte}`,
      }
    );
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateFinancialTransaction(
  user: User,
  companyId: string,
  id: string,
  input: Partial<FinancialInput>
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  const docRef = doc(db, 'companies', safeCompanyId, 'financialTransactions', safeId);
  const path = `companies/${safeCompanyId}/financialTransactions/${safeId}`;
  try {
    const prevSnap = await getDoc(docRef);
    const prev = prevSnap.exists() ? (prevSnap.data() as Partial<FinancialTransaction>) : null;
    const prevSummary = prev
      ? `${prev.descricao || '—'} | R$ ${Number(prev.valor || 0).toFixed(2)} | ${prev.status || '—'}`
      : 'Sem snapshot anterior';

    const updateData: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (input.tipo !== undefined) updateData.tipo = input.tipo;
    if (input.descricao !== undefined) updateData.descricao = clip(input.descricao, FIELD_LIMITS.descricaoFinanceira);
    if (input.categoria !== undefined) updateData.categoria = clip(input.categoria, FIELD_LIMITS.categoria);
    if (input.contraparte !== undefined) updateData.contraparte = clip(input.contraparte, FIELD_LIMITS.contraparte);
    if (input.clienteDocumento !== undefined) updateData.clienteDocumento = clip(input.clienteDocumento, FIELD_LIMITS.clienteDocumento);
    if (input.customerId !== undefined) updateData.customerId = input.customerId ? sanitizeId(input.customerId) : '';
    if (input.valor !== undefined) updateData.valor = ensureNonNegativeNumber(input.valor, 'Valor');
    if (input.dataVencimento !== undefined) updateData.dataVencimento = ensureIsoDate(input.dataVencimento, 'Vencimento');
    if (input.dataPagamento !== undefined) {
      updateData.dataPagamento = input.dataPagamento ? ensureIsoDate(input.dataPagamento, 'Pagamento') : '';
    }
    if (input.formaPagamento !== undefined) updateData.formaPagamento = input.formaPagamento;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.invoiceId !== undefined) updateData.invoiceId = input.invoiceId ? sanitizeId(input.invoiceId) : '';
    if (input.invoiceNumber !== undefined) updateData.invoiceNumber = clip(input.invoiceNumber, FIELD_LIMITS.numeroNf);
    if (input.bankTransactionId !== undefined) updateData.bankTransactionId = input.bankTransactionId ? sanitizeId(input.bankTransactionId) : '';
    if (input.reconciled !== undefined) updateData.reconciled = Boolean(input.reconciled);
    if (input.observacoes !== undefined) updateData.observacoes = clip(input.observacoes, FIELD_LIMITS.observacoes);

    await updateDoc(docRef, updateData);
    await writeAuditLog(user, safeCompanyId, 'Financeiro', 'editar', `Atualizou lançamento financeiro (${safeId})`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: prevSummary,
      dadosPosteriores: `${String(updateData.descricao ?? prev?.descricao ?? '—')} | R$ ${Number(updateData.valor ?? prev?.valor ?? 0).toFixed(2)} | ${String(updateData.status ?? prev?.status ?? '—')}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFinancialTransaction(
  user: User,
  companyId: string,
  id: string,
  label: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  const path = `companies/${safeCompanyId}/financialTransactions/${safeId}`;
  try {
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'financialTransactions', safeId));
    await writeAuditLog(user, safeCompanyId, 'Financeiro', 'excluir', `Excluiu lançamento financeiro: ${clip(label, 120)}`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: clip(label, 120),
      dadosPosteriores: 'Lançamento excluído',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ==================== NOTAS FISCAIS DE SAÍDA ====================
export type InvoiceInput = Omit<Invoice, 'id' | 'companyId' | 'ownerId' | 'createdAt' | 'updatedAt'>;

async function resolveVerifiedCustomerIdForSave(
  user: User,
  companyId: string,
  nome: string,
  documento?: string,
  explicitCustomerId?: string
): Promise<{ customerId: string; formattedDoc: string }> {
  if (explicitCustomerId) {
    return {
      customerId: sanitizeId(explicitCustomerId),
      formattedDoc: formatCpfCnpj(documento),
    };
  }
  const cleanDigits = digitsOnly(documento);
  if (cleanDigits.length !== 11 && cleanDigits.length !== 14) {
    return {
      customerId: '',
      formattedDoc: clip(documento, FIELD_LIMITS.clienteDocumento),
    };
  }
  const safeCompanyId = sanitizeId(companyId);
  const docId = sanitizeId(`doc_${cleanDigits}`);
  const custRef = doc(db, 'companies', safeCompanyId, 'customers', docId);
  const snap = await getDoc(custRef);
  const formatted = formatCpfCnpj(cleanDigits).slice(0, FIELD_LIMITS.clienteDocumento);
  if (!snap.exists()) {
    await setDoc(custRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      nome: clip(nome, FIELD_LIMITS.clienteNome),
      documento: formatted,
      documentoLimpo: cleanDigits,
      tipoPessoa: detectPersonType(cleanDigits),
      documentoNaoInformado: false,
      email: '',
      telefone: '',
      observacoes: 'Cadastrado automaticamente via documento fiscal por CPF/CNPJ',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  return { customerId: docId, formattedDoc: formatted };
}

export async function createInvoice(
  user: User,
  companyId: string,
  input: InvoiceInput
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const docRef = doc(collection(db, 'companies', safeCompanyId, 'invoices'));
  const path = `companies/${safeCompanyId}/invoices/${docRef.id}`;
  try {
    const resolvedCustomer = await resolveVerifiedCustomerIdForSave(
      user,
      safeCompanyId,
      input.clienteNome,
      input.clienteDocumento,
      input.customerId
    );
    const payload = {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      numero: clip(input.numero, FIELD_LIMITS.numeroNf),
      serie: clip(input.serie || '1', FIELD_LIMITS.serieNf),
      chaveAcesso: clip(input.chaveAcesso, FIELD_LIMITS.chaveAcesso),
      tipo: input.tipo,
      tipoOperacao: 'saida' as const,
      clienteNome: clip(input.clienteNome, FIELD_LIMITS.clienteNome),
      clienteDocumento: resolvedCustomer.formattedDoc,
      customerId: resolvedCustomer.customerId,
      valor: ensureNonNegativeNumber(input.valor, 'Valor da NF'),
      dataEmissao: ensureIsoDate(input.dataEmissao, 'Data de Emissão'),
      dataVencimento: input.dataVencimento ? ensureIsoDate(input.dataVencimento, 'Data de Vencimento') : '',
      statusRecebimento: input.statusRecebimento,
      valorRecebido: ensureNonNegativeNumber(input.valorRecebido, 'Valor Recebido'),
      origemImportacao: input.origemImportacao,
      itensResumo: clip(input.itensResumo, FIELD_LIMITS.itensResumo),
      descricaoServicos: clip(input.descricaoServicos, FIELD_LIMITS.descricaoServicos),
      storagePath: clip(input.storagePath, FIELD_LIMITS.storagePath),
      downloadUrl: clip(input.downloadUrl, FIELD_LIMITS.downloadUrl),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(docRef, payload);
    await writeAuditLog(
      user,
      safeCompanyId,
      'Notas Fiscais',
      input.origemImportacao === 'manual' ? 'criar' : 'importar',
      `${input.origemImportacao === 'manual' ? 'Cadastrou' : `Importou (${input.origemImportacao.toUpperCase()})`} ${input.tipo} de saída nº ${payload.numero} — ${payload.clienteNome}`,
      docRef.id,
      {
        origem: input.origemImportacao === 'manual' ? 'Interface Web' : 'Importação Fiscal/Bancária',
        resultado: 'sucesso',
        dadosAnteriores: 'Nota fiscal inexistente',
        dadosPosteriores: `${payload.tipo} nº ${payload.numero} | R$ ${payload.valor.toFixed(2)} | ${payload.clienteNome}`,
      }
    );
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function importInvoicesBatch(
  user: User,
  companyId: string,
  items: InvoiceInput[],
  fileName: string
): Promise<{ importedCount: number; createdCustomersCount: number }> {
  const safeCompanyId = sanitizeId(companyId);
  const path = `companies/${safeCompanyId}/invoices`;

  try {
    // 1. Criar clientes únicos que possuam CPF/CNPJ válido ainda não cadastrado (chave determinística doc_<digits>)
    const pendingCustomerMap = new Map<string, { nome: string; formatted: string; cleanDigits: string }>();
    for (const item of items) {
      if (item.customerId) continue;
      const cleanDigits = digitsOnly(item.clienteDocumento);
      if (cleanDigits.length !== 11 && cleanDigits.length !== 14) continue;
      const custId = sanitizeId(`doc_${cleanDigits}`);
      if (!pendingCustomerMap.has(custId)) {
        pendingCustomerMap.set(custId, {
          nome: clip(item.clienteNome, FIELD_LIMITS.clienteNome),
          formatted: formatCpfCnpj(cleanDigits).slice(0, FIELD_LIMITS.clienteDocumento),
          cleanDigits,
        });
      }
    }

    let createdCustomersCount = 0;
    const customerToCreate: Array<{ id: string; nome: string; formatted: string; cleanDigits: string }> = [];
    for (const [custId, meta] of pendingCustomerMap.entries()) {
      const existingSnap = await getDoc(doc(db, 'companies', safeCompanyId, 'customers', custId));
      if (!existingSnap.exists()) {
        customerToCreate.push({ id: custId, ...meta });
      }
    }

    for (let i = 0; i < customerToCreate.length; i += 300) {
      const slice = customerToCreate.slice(i, i + 300);
      const batch = writeBatch(db);
      for (const c of slice) {
        batch.set(doc(db, 'companies', safeCompanyId, 'customers', c.id), {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          nome: c.nome,
          documento: c.formatted,
          documentoLimpo: c.cleanDigits,
          tipoPessoa: detectPersonType(c.cleanDigits),
          documentoNaoInformado: false,
          email: '',
          telefone: '',
          observacoes: `Cadastrado via importação de notas (${clip(fileName, 80)})`,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        createdCustomersCount += 1;
      }
      await batch.commit();
    }

    // 2. Gravar notas fiscais de saída em lotes
    let importedCount = 0;
    for (let i = 0; i < items.length; i += 350) {
      const slice = items.slice(i, i + 350);
      const batch = writeBatch(db);
      for (const item of slice) {
        const ref = doc(collection(db, path));
        const cleanDigits = digitsOnly(item.clienteDocumento);
        const hasValidDoc = cleanDigits.length === 11 || cleanDigits.length === 14;
        const resolvedCustomerId = item.customerId
          ? sanitizeId(item.customerId)
          : hasValidDoc
            ? sanitizeId(`doc_${cleanDigits}`)
            : '';

        batch.set(ref, {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          numero: clip(item.numero, FIELD_LIMITS.numeroNf),
          serie: clip(item.serie || '1', FIELD_LIMITS.serieNf),
          chaveAcesso: clip(item.chaveAcesso, FIELD_LIMITS.chaveAcesso),
          tipo: item.tipo,
          tipoOperacao: 'saida' as const,
          clienteNome: clip(item.clienteNome, FIELD_LIMITS.clienteNome),
          clienteDocumento: hasValidDoc
            ? formatCpfCnpj(cleanDigits).slice(0, FIELD_LIMITS.clienteDocumento)
            : clip(item.clienteDocumento, FIELD_LIMITS.clienteDocumento),
          customerId: resolvedCustomerId,
          valor: ensureNonNegativeNumber(item.valor, 'Valor da NF'),
          dataEmissao: ensureIsoDate(item.dataEmissao, 'Data de Emissão'),
          dataVencimento: item.dataVencimento ? ensureIsoDate(item.dataVencimento, 'Data de Vencimento') : '',
          statusRecebimento: item.statusRecebimento,
          valorRecebido: ensureNonNegativeNumber(item.valorRecebido, 'Valor Recebido'),
          origemImportacao: item.origemImportacao,
          itensResumo: clip(item.itensResumo, FIELD_LIMITS.itensResumo),
          descricaoServicos: clip(item.descricaoServicos, FIELD_LIMITS.descricaoServicos),
          storagePath: clip(item.storagePath, FIELD_LIMITS.storagePath),
          downloadUrl: clip(item.downloadUrl, FIELD_LIMITS.downloadUrl),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        importedCount += 1;
      }
      await batch.commit();
    }

    await writeAuditLog(
      user,
      safeCompanyId,
      'Notas Fiscais',
      'importar',
      `Importou ${importedCount} nota(s) fiscal(is) de saída de "${clip(fileName, 100)}"${createdCustomersCount > 0 ? ` e criou ${createdCustomersCount} cliente(s) por CPF/CNPJ` : ''}`,
      undefined,
      {
        origem: 'Importação Fiscal/Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `Arquivo: ${clip(fileName, 80)}`,
        dadosPosteriores: `${importedCount} NF(s) importadas | ${createdCustomersCount} cliente(s) cadastrados`,
      }
    );

    return { importedCount, createdCustomersCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateInvoice(
  user: User,
  companyId: string,
  id: string,
  input: Partial<InvoiceInput>
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  const docRef = doc(db, 'companies', safeCompanyId, 'invoices', safeId);
  const path = `companies/${safeCompanyId}/invoices/${safeId}`;
  try {
    const prevSnap = await getDoc(docRef);
    const prev = prevSnap.exists() ? (prevSnap.data() as Partial<Invoice>) : null;
    const prevSummary = prev
      ? `NF ${prev.numero || '—'} | R$ ${Number(prev.valor || 0).toFixed(2)} | Recebido: R$ ${Number(prev.valorRecebido || 0).toFixed(2)} (${prev.statusRecebimento || '—'})`
      : 'Sem snapshot anterior';

    const updateData: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (input.numero !== undefined) updateData.numero = clip(input.numero, FIELD_LIMITS.numeroNf);
    if (input.serie !== undefined) updateData.serie = clip(input.serie, FIELD_LIMITS.serieNf);
    if (input.chaveAcesso !== undefined) updateData.chaveAcesso = clip(input.chaveAcesso, FIELD_LIMITS.chaveAcesso);
    if (input.tipo !== undefined) updateData.tipo = input.tipo;
    if (input.clienteNome !== undefined) updateData.clienteNome = clip(input.clienteNome, FIELD_LIMITS.clienteNome);
    if (input.clienteDocumento !== undefined) updateData.clienteDocumento = clip(input.clienteDocumento, FIELD_LIMITS.clienteDocumento);
    if (input.customerId !== undefined) updateData.customerId = input.customerId ? sanitizeId(input.customerId) : '';
    if (input.valor !== undefined) updateData.valor = ensureNonNegativeNumber(input.valor, 'Valor');
    if (input.dataEmissao !== undefined) updateData.dataEmissao = ensureIsoDate(input.dataEmissao, 'Data de Emissão');
    if (input.dataVencimento !== undefined) {
      updateData.dataVencimento = input.dataVencimento ? ensureIsoDate(input.dataVencimento, 'Data de Vencimento') : '';
    }
    if (input.statusRecebimento !== undefined) updateData.statusRecebimento = input.statusRecebimento;
    if (input.valorRecebido !== undefined) updateData.valorRecebido = ensureNonNegativeNumber(input.valorRecebido, 'Valor Recebido');
    if (input.itensResumo !== undefined) updateData.itensResumo = clip(input.itensResumo, FIELD_LIMITS.itensResumo);
    if (input.descricaoServicos !== undefined) updateData.descricaoServicos = clip(input.descricaoServicos, FIELD_LIMITS.descricaoServicos);
    if (input.storagePath !== undefined) updateData.storagePath = clip(input.storagePath, FIELD_LIMITS.storagePath);
    if (input.downloadUrl !== undefined) updateData.downloadUrl = clip(input.downloadUrl, FIELD_LIMITS.downloadUrl);

    await updateDoc(docRef, updateData);
    await writeAuditLog(user, safeCompanyId, 'Notas Fiscais', 'editar', `Atualizou nota fiscal (${safeId})`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: prevSummary,
      dadosPosteriores: `NF ${String(updateData.numero ?? prev?.numero ?? '—')} | R$ ${Number(updateData.valor ?? prev?.valor ?? 0).toFixed(2)} | Recebido: R$ ${Number(updateData.valorRecebido ?? prev?.valorRecebido ?? 0).toFixed(2)} (${String(updateData.statusRecebimento ?? prev?.statusRecebimento ?? '—')})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteInvoice(
  user: User,
  companyId: string,
  id: string,
  numero: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  const path = `companies/${safeCompanyId}/invoices/${safeId}`;
  try {
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'invoices', safeId));
    await writeAuditLog(user, safeCompanyId, 'Notas Fiscais', 'excluir', `Excluiu nota fiscal nº ${clip(numero, 40)}`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: `NF nº ${clip(numero, 40)}`,
      dadosPosteriores: 'Nota fiscal excluída',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ==================== CONCILIAÇÃO BANCÁRIA ====================
export type BankTxInput = Omit<BankTransaction, 'id' | 'companyId' | 'ownerId' | 'createdAt' | 'updatedAt'>;

export async function importBankTransactionsBatch(
  user: User,
  companyId: string,
  rows: BankTxInput[],
  fileName: string
): Promise<number> {
  const safeCompanyId = sanitizeId(companyId);
  const path = `companies/${safeCompanyId}/bankTransactions`;
  try {
    const chunkSize = 400;
    let totalSaved = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const item of slice) {
        const ref = doc(collection(db, path));
        const cleanDoc = digitsOnly(item.cpfCnpjPagador);
        const autoCustId =
          item.customerId
            ? sanitizeId(item.customerId)
            : cleanDoc.length === 11 || cleanDoc.length === 14
              ? sanitizeId(`doc_${cleanDoc}`)
              : '';
        batch.set(ref, {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          banco: clip(item.banco, FIELD_LIMITS.banco),
          conta: clip(item.conta, FIELD_LIMITS.conta),
          fitId: clip(item.fitId, FIELD_LIMITS.fitId),
          documentoBancario: clip(item.documentoBancario, FIELD_LIMITS.documentoBancario),
          nomePagador: clip(item.nomePagador, FIELD_LIMITS.nomePagador),
          cpfCnpjPagador:
            cleanDoc.length === 11 || cleanDoc.length === 14
              ? formatCpfCnpj(cleanDoc).slice(0, FIELD_LIMITS.cpfCnpjPagador)
              : clip(item.cpfCnpjPagador, FIELD_LIMITS.cpfCnpjPagador),
          customerId: autoCustId,
          tipo: item.tipo,
          descricao: clip(item.descricao, FIELD_LIMITS.descricaoBanco),
          valor: ensureNonNegativeNumber(item.valor, 'Valor Bancário'),
          dataMovimento: ensureIsoDate(item.dataMovimento, 'Data do Movimento'),
          statusConciliacao: item.statusConciliacao,
          invoiceId: item.invoiceId ? sanitizeId(item.invoiceId) : '',
          invoiceNumber: clip(item.invoiceNumber, FIELD_LIMITS.numeroNf),
          financialTransactionId: item.financialTransactionId ? sanitizeId(item.financialTransactionId) : '',
          origemArquivo: clip(fileName, FIELD_LIMITS.origemArquivo),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        totalSaved += 1;
      }
      await batch.commit();
    }
    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'importar',
      `Importou ${totalSaved} transações do arquivo ${clip(fileName, 100)}`,
      undefined,
      {
        origem: 'Importação Fiscal/Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `Extrato: ${clip(fileName, 80)}`,
        dadosPosteriores: `${totalSaved} lançamentos bancários gravados`,
      }
    );
    return totalSaved;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export interface ReconciliationDecisionMeta {
  confianca?: 'alta' | 'media' | 'baixa' | 'manual';
  justificativa?: string;
  origemDecisao?: 'manual' | 'ia_confirmada' | 'ia_rejeitada';
}

export async function reconcileBankWithInvoice(
  user: User,
  companyId: string,
  bankTx: BankTransaction,
  invoice: Invoice,
  options?: {
    createFinancialReceipt?: boolean;
    allocatedAmount?: number;
    meta?: ReconciliationDecisionMeta;
  }
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeBankId = sanitizeId(bankTx.id);
  const safeInvId = sanitizeId(invoice.id);
  const recRef = doc(collection(db, 'companies', safeCompanyId, 'reconciliations'));

  const resolvedCustomerId = invoice.customerId || bankTx.customerId || '';
  const alreadyAllocated = Math.max(0, Number(bankTx.valorConciliado || 0));
  const bankRemaining = Math.max(0, Math.round((bankTx.valor - alreadyAllocated) * 100) / 100);
  const amountToAllocate = ensureNonNegativeNumber(
    options?.allocatedAmount !== undefined ? options.allocatedAmount : bankRemaining > 0 ? bankRemaining : bankTx.valor,
    'Valor Conciliado'
  );
  if (amountToAllocate <= 0) {
    throw new Error('O valor a conciliar deve ser maior que zero.');
  }
  const newTxAllocated = Math.round((alreadyAllocated + amountToAllocate) * 100) / 100;
  if (newTxAllocated > bankTx.valor + 0.01) {
    throw new Error('O valor alocado excede o saldo disponível desta movimentação bancária.');
  }

  try {
    const batch = writeBatch(db);
    let createdFinId = '';

    if (options?.createFinancialReceipt) {
      const finRef = doc(collection(db, 'companies', safeCompanyId, 'financialTransactions'));
      createdFinId = finRef.id;
      batch.set(finRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        tipo: 'receita',
        descricao: clip(`Recebimento ${invoice.tipo} ${invoice.numero} — ${invoice.clienteNome}`, FIELD_LIMITS.descricaoFinanceira),
        categoria: invoice.tipo === 'NFS-e' ? 'Instalação de Ar-Condicionado' : 'Venda de Equipamentos',
        contraparte: clip(invoice.clienteNome, FIELD_LIMITS.contraparte),
        clienteDocumento: clip(invoice.clienteDocumento || bankTx.cpfCnpjPagador, FIELD_LIMITS.clienteDocumento),
        customerId: resolvedCustomerId ? sanitizeId(resolvedCustomerId) : '',
        valor: amountToAllocate,
        dataVencimento: ensureIsoDate(invoice.dataVencimento || invoice.dataEmissao, 'Data de Vencimento'),
        dataPagamento: ensureIsoDate(bankTx.dataMovimento, 'Data de Pagamento'),
        formaPagamento: bankTx.descricao.toUpperCase().includes('PIX')
          ? 'PIX'
          : bankTx.descricao.toUpperCase().includes('BOLETO')
            ? 'Boleto'
            : 'Transferência',
        status: 'pago',
        invoiceId: safeInvId,
        invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
        bankTransactionId: safeBankId,
        reconciled: true,
        observacoes: clip(`Lançado via conciliação bancária (${bankTx.banco})`, FIELD_LIMITS.observacoes),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const txFullyAllocated = newTxAllocated + 0.01 >= bankTx.valor;
    const prevInvNumbers = (bankTx.invoiceNumber || '').trim();
    const combinedInvNumber = prevInvNumbers
      ? Array.from(new Set([...prevInvNumbers.split(',').map((s) => s.trim()).filter(Boolean), invoice.numero])).join(', ')
      : invoice.numero;

    batch.update(doc(db, 'companies', safeCompanyId, 'bankTransactions', safeBankId), {
      statusConciliacao: txFullyAllocated ? 'conciliado_nf' : 'conciliado_parcial',
      valorConciliado: newTxAllocated,
      invoiceId: safeInvId,
      invoiceNumber: clip(combinedInvNumber, FIELD_LIMITS.numeroNf),
      ...(resolvedCustomerId ? { customerId: sanitizeId(resolvedCustomerId) } : {}),
      ...(createdFinId ? { financialTransactionId: createdFinId } : {}),
      updatedAt: serverTimestamp(),
    });

    const newReceived = Math.round((invoice.valorRecebido + amountToAllocate) * 100) / 100;
    const newStatus = newReceived + 0.01 >= invoice.valor ? 'recebida' : 'parcial';
    batch.update(doc(db, 'companies', safeCompanyId, 'invoices', safeInvId), {
      valorRecebido: newReceived,
      statusRecebimento: newStatus,
      updatedAt: serverTimestamp(),
    });

    const diffValor = Math.round((amountToAllocate - Math.max(0, invoice.valor - invoice.valorRecebido)) * 100) / 100;

    batch.set(recRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      bankTransactionId: safeBankId,
      bankDescricao: clip(bankTx.descricao, FIELD_LIMITS.descricaoBanco),
      bankValor: ensureNonNegativeNumber(bankTx.valor, 'Valor Bancário'),
      bankData: ensureIsoDate(bankTx.dataMovimento, 'Data'),
      invoiceId: safeInvId,
      invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
      financialTransactionId: createdFinId,
      tipo: newStatus === 'parcial' || invoice.valorRecebido > 0 ? 'parcelado' : 'nf',
      valorConciliado: amountToAllocate,
      diferencaValor: diffValor,
      confianca: options?.meta?.confianca ?? 'manual',
      justificativa: clip(
        options?.meta?.justificativa || `Conciliação confirmada com ${invoice.tipo} ${invoice.numero}`,
        FIELD_LIMITS.justificativa
      ),
      origemDecisao: options?.meta?.origemDecisao ?? 'manual',
      observacoes: clip(`Conciliação com ${invoice.tipo} ${invoice.numero}`, 300),
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'conciliar',
      `Conciliou R$ ${amountToAllocate.toFixed(2)} do extrato com ${invoice.tipo} ${invoice.numero} (${invoice.clienteNome})`,
      recRef.id,
      {
        origem: 'Conciliação Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `NF ${invoice.numero}: ${invoice.statusRecebimento} (R$ ${invoice.valorRecebido.toFixed(2)}) | Extrato: ${bankTx.statusConciliacao}`,
        dadosPosteriores: `NF ${invoice.numero}: ${newStatus} (R$ ${newReceived.toFixed(2)}) | Extrato alocado: R$ ${newTxAllocated.toFixed(2)}`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `companies/${safeCompanyId}/bankTransactions/${safeBankId}`);
  }
}

export async function splitBankTxAcrossInvoices(
  user: User,
  companyId: string,
  bankTx: BankTransaction,
  allocations: Array<{ invoice: Invoice; allocatedAmount: number }>,
  options?: {
    createFinancialReceipt?: boolean;
    meta?: ReconciliationDecisionMeta;
  }
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeBankId = sanitizeId(bankTx.id);
  const cleanAllocs = allocations.filter((a) => Number.isFinite(a.allocatedAmount) && a.allocatedAmount > 0);
  if (cleanAllocs.length === 0) {
    throw new Error('Informe pelo menos uma nota fiscal com valor alocado maior que zero.');
  }

  const alreadyAllocated = Math.max(0, Number(bankTx.valorConciliado || 0));
  const totalNewAlloc = Math.round(cleanAllocs.reduce((s, a) => s + a.allocatedAmount, 0) * 100) / 100;
  const newTxAllocated = Math.round((alreadyAllocated + totalNewAlloc) * 100) / 100;

  if (newTxAllocated > bankTx.valor + 0.01) {
    throw new Error('A soma dos valores divididos ultrapassa o saldo disponível do recebimento bancário.');
  }

  const groupId = sanitizeId(`grp_${Date.now()}_${safeBankId.slice(0, 12)}`);

  try {
    const batch = writeBatch(db);
    let firstFinId = '';

    for (const item of cleanAllocs) {
      const safeInvId = sanitizeId(item.invoice.id);
      const amount = Math.round(item.allocatedAmount * 100) / 100;
      const recRef = doc(collection(db, 'companies', safeCompanyId, 'reconciliations'));
      const resolvedCustomerId = item.invoice.customerId || bankTx.customerId || '';
      let createdFinId = '';

      if (options?.createFinancialReceipt) {
        const finRef = doc(collection(db, 'companies', safeCompanyId, 'financialTransactions'));
        createdFinId = finRef.id;
        if (!firstFinId) firstFinId = createdFinId;
        batch.set(finRef, {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          tipo: 'receita',
          descricao: clip(
            `Recebimento agrupado ${item.invoice.tipo} ${item.invoice.numero} — ${item.invoice.clienteNome}`,
            FIELD_LIMITS.descricaoFinanceira
          ),
          categoria: item.invoice.tipo === 'NFS-e' ? 'Instalação de Ar-Condicionado' : 'Venda de Equipamentos',
          contraparte: clip(item.invoice.clienteNome, FIELD_LIMITS.contraparte),
          clienteDocumento: clip(item.invoice.clienteDocumento || bankTx.cpfCnpjPagador, FIELD_LIMITS.clienteDocumento),
          customerId: resolvedCustomerId ? sanitizeId(resolvedCustomerId) : '',
          valor: amount,
          dataVencimento: ensureIsoDate(item.invoice.dataVencimento || item.invoice.dataEmissao, 'Data de Vencimento'),
          dataPagamento: ensureIsoDate(bankTx.dataMovimento, 'Data de Pagamento'),
          formaPagamento: bankTx.descricao.toUpperCase().includes('PIX')
            ? 'PIX'
            : bankTx.descricao.toUpperCase().includes('BOLETO')
              ? 'Boleto'
              : 'Transferência',
          status: 'pago',
          invoiceId: safeInvId,
          invoiceNumber: clip(item.invoice.numero, FIELD_LIMITS.numeroNf),
          bankTransactionId: safeBankId,
          reconciled: true,
          observacoes: clip(`Rateio de recebimento agrupado (${bankTx.banco})`, FIELD_LIMITS.observacoes),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const newReceived = Math.round((item.invoice.valorRecebido + amount) * 100) / 100;
      const newStatus = newReceived + 0.01 >= item.invoice.valor ? 'recebida' : 'parcial';
      batch.update(doc(db, 'companies', safeCompanyId, 'invoices', safeInvId), {
        valorRecebido: newReceived,
        statusRecebimento: newStatus,
        updatedAt: serverTimestamp(),
      });

      const invOpen = Math.max(0, item.invoice.valor - item.invoice.valorRecebido);
      batch.set(recRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        bankTransactionId: safeBankId,
        bankDescricao: clip(bankTx.descricao, FIELD_LIMITS.descricaoBanco),
        bankValor: ensureNonNegativeNumber(bankTx.valor, 'Valor Bancário'),
        bankData: ensureIsoDate(bankTx.dataMovimento, 'Data'),
        invoiceId: safeInvId,
        invoiceNumber: clip(item.invoice.numero, FIELD_LIMITS.numeroNf),
        financialTransactionId: createdFinId,
        tipo: cleanAllocs.length > 1 ? 'agrupado' : 'nf',
        valorConciliado: amount,
        diferencaValor: Math.round((amount - invOpen) * 100) / 100,
        confianca: options?.meta?.confianca ?? 'manual',
        justificativa: clip(
          options?.meta?.justificativa ||
            `Pagamento agrupado/dividido para ${item.invoice.tipo} ${item.invoice.numero}`,
          FIELD_LIMITS.justificativa
        ),
        origemDecisao: options?.meta?.origemDecisao ?? 'manual',
        grupoId: groupId,
        observacoes: clip(
          `Divisão de recebimento (${cleanAllocs.length} NFs) — NF ${item.invoice.numero}`,
          300
        ),
        createdAt: serverTimestamp(),
      });
    }

    const txFullyAllocated = newTxAllocated + 0.01 >= bankTx.valor;
    const prevNums = (bankTx.invoiceNumber || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const mergedNumbers = Array.from(
      new Set([...prevNums, ...cleanAllocs.map((a) => a.invoice.numero)])
    ).join(', ');

    batch.update(doc(db, 'companies', safeCompanyId, 'bankTransactions', safeBankId), {
      statusConciliacao: txFullyAllocated ? 'conciliado_nf' : 'conciliado_parcial',
      valorConciliado: newTxAllocated,
      invoiceId: cleanAllocs.length === 1 ? sanitizeId(cleanAllocs[0].invoice.id) : '',
      invoiceNumber: clip(mergedNumbers, FIELD_LIMITS.numeroNf),
      ...(firstFinId ? { financialTransactionId: firstFinId } : {}),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();

    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'conciliar',
      `Dividiu recebimento de R$ ${totalNewAlloc.toFixed(2)} entre ${cleanAllocs.length} nota(s) fiscal(is): ${cleanAllocs.map((a) => a.invoice.numero).join(', ')}`,
      safeBankId,
      {
        origem: 'Conciliação Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `Crédito R$ ${bankTx.valor.toFixed(2)} (alocado R$ ${alreadyAllocated.toFixed(2)})`,
        dadosPosteriores: `NFs ${cleanAllocs.map((a) => a.invoice.numero).join(', ')} | Alocado R$ ${newTxAllocated.toFixed(2)}`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `companies/${safeCompanyId}/bankTransactions/${safeBankId}`);
  }
}

export async function reconcileMultipleBankTxsToInvoice(
  user: User,
  companyId: string,
  bankTxs: BankTransaction[],
  invoice: Invoice,
  options?: { createFinancialReceipt?: boolean; justificativa?: string }
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeInvId = sanitizeId(invoice.id);
  if (bankTxs.length === 0) {
    throw new Error('Selecione ao menos um recebimento bancário para relacionar à nota fiscal.');
  }

  const groupId = sanitizeId(`parc_${Date.now()}_${safeInvId.slice(0, 12)}`);

  try {
    const batch = writeBatch(db);
    let addedTotal = 0;

    for (const tx of bankTxs) {
      const safeBankId = sanitizeId(tx.id);
      const alreadyAllocated = Math.max(0, Number(tx.valorConciliado || 0));
      const available = Math.max(0, Math.round((tx.valor - alreadyAllocated) * 100) / 100);
      const amount = available > 0 ? available : tx.valor;
      addedTotal = Math.round((addedTotal + amount) * 100) / 100;

      const recRef = doc(collection(db, 'companies', safeCompanyId, 'reconciliations'));
      const resolvedCustomerId = invoice.customerId || tx.customerId || '';
      let createdFinId = '';

      if (options?.createFinancialReceipt) {
        const finRef = doc(collection(db, 'companies', safeCompanyId, 'financialTransactions'));
        createdFinId = finRef.id;
        batch.set(finRef, {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          tipo: 'receita',
          descricao: clip(`Parcela ${invoice.tipo} ${invoice.numero} — ${invoice.clienteNome}`, FIELD_LIMITS.descricaoFinanceira),
          categoria: invoice.tipo === 'NFS-e' ? 'Instalação de Ar-Condicionado' : 'Venda de Equipamentos',
          contraparte: clip(invoice.clienteNome, FIELD_LIMITS.contraparte),
          clienteDocumento: clip(invoice.clienteDocumento || tx.cpfCnpjPagador, FIELD_LIMITS.clienteDocumento),
          customerId: resolvedCustomerId ? sanitizeId(resolvedCustomerId) : '',
          valor: amount,
          dataVencimento: ensureIsoDate(invoice.dataVencimento || invoice.dataEmissao, 'Data de Vencimento'),
          dataPagamento: ensureIsoDate(tx.dataMovimento, 'Data de Pagamento'),
          formaPagamento: tx.descricao.toUpperCase().includes('PIX')
            ? 'PIX'
            : tx.descricao.toUpperCase().includes('BOLETO')
              ? 'Boleto'
              : 'Transferência',
          status: 'pago',
          invoiceId: safeInvId,
          invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
          bankTransactionId: safeBankId,
          reconciled: true,
          observacoes: clip(`Parcela vinculada via conciliação (${tx.banco})`, FIELD_LIMITS.observacoes),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      batch.update(doc(db, 'companies', safeCompanyId, 'bankTransactions', safeBankId), {
        statusConciliacao: 'conciliado_nf',
        valorConciliado: Math.round((alreadyAllocated + amount) * 100) / 100,
        invoiceId: safeInvId,
        invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
        ...(resolvedCustomerId ? { customerId: sanitizeId(resolvedCustomerId) } : {}),
        ...(createdFinId ? { financialTransactionId: createdFinId } : {}),
        updatedAt: serverTimestamp(),
      });

      batch.set(recRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        bankTransactionId: safeBankId,
        bankDescricao: clip(tx.descricao, FIELD_LIMITS.descricaoBanco),
        bankValor: ensureNonNegativeNumber(tx.valor, 'Valor Bancário'),
        bankData: ensureIsoDate(tx.dataMovimento, 'Data'),
        invoiceId: safeInvId,
        invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
        financialTransactionId: createdFinId,
        tipo: bankTxs.length > 1 ? 'parcelado' : 'nf',
        valorConciliado: amount,
        confianca: 'manual',
        justificativa: clip(
          options?.justificativa || `Pagamento em parcelas vinculado à ${invoice.tipo} ${invoice.numero}`,
          FIELD_LIMITS.justificativa
        ),
        origemDecisao: 'manual',
        grupoId: groupId,
        observacoes: clip(`Parcelamento (${bankTxs.length} recebimentos) — NF ${invoice.numero}`, 300),
        createdAt: serverTimestamp(),
      });
    }

    const newReceived = Math.round((invoice.valorRecebido + addedTotal) * 100) / 100;
    const newStatus = newReceived + 0.01 >= invoice.valor ? 'recebida' : 'parcial';
    batch.update(doc(db, 'companies', safeCompanyId, 'invoices', safeInvId), {
      valorRecebido: newReceived,
      statusRecebimento: newStatus,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();

    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'conciliar',
      `Relacionou ${bankTxs.length} recebimento(s) (total R$ ${addedTotal.toFixed(2)}) à ${invoice.tipo} ${invoice.numero}`,
      safeInvId,
      {
        origem: 'Conciliação Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `NF ${invoice.numero}: ${invoice.statusRecebimento} (R$ ${invoice.valorRecebido.toFixed(2)})`,
        dadosPosteriores: `NF ${invoice.numero}: ${newStatus} (R$ ${newReceived.toFixed(2)}) via ${bankTxs.length} crédito(s)`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `companies/${safeCompanyId}/invoices/${safeInvId}`);
  }
}

export async function rejectReconciliationSuggestion(
  user: User,
  companyId: string,
  bankTx: BankTransaction,
  invoice: Invoice,
  justificativa: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeBankId = sanitizeId(bankTx.id);
  const safeInvId = sanitizeId(invoice.id);
  const recRef = doc(collection(db, 'companies', safeCompanyId, 'reconciliations'));

  try {
    await setDoc(recRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      bankTransactionId: safeBankId,
      bankDescricao: clip(bankTx.descricao, FIELD_LIMITS.descricaoBanco),
      bankValor: ensureNonNegativeNumber(bankTx.valor, 'Valor Bancário'),
      bankData: ensureIsoDate(bankTx.dataMovimento, 'Data'),
      invoiceId: safeInvId,
      invoiceNumber: clip(invoice.numero, FIELD_LIMITS.numeroNf),
      financialTransactionId: '',
      tipo: 'rejeitado',
      valorConciliado: 0,
      diferencaValor: Math.round((bankTx.valor - invoice.valor) * 100) / 100,
      confianca: 'baixa',
      justificativa: clip(justificativa || 'Correspondência rejeitada pelo usuário após conferência.', FIELD_LIMITS.justificativa),
      origemDecisao: 'ia_rejeitada',
      observacoes: clip(`Sugestão rejeitada: extrato x ${invoice.tipo} ${invoice.numero}`, 300),
      createdAt: serverTimestamp(),
    });

    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'conciliar',
      `Rejeitou correspondência sugerida entre crédito de R$ ${bankTx.valor.toFixed(2)} e ${invoice.tipo} ${invoice.numero}`,
      recRef.id,
      {
        origem: 'Conciliação Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `Sugestão pendente: Crédito ${safeBankId} x NF ${invoice.numero}`,
        dadosPosteriores: 'Correspondência marcada como rejeitada pela revisão humana',
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `companies/${safeCompanyId}/reconciliations/${recRef.id}`);
  }
}

export async function markBankTxWithoutInvoice(
  user: User,
  companyId: string,
  bankTx: BankTransaction
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(bankTx.id);
  const recRef = doc(collection(db, 'companies', safeCompanyId, 'reconciliations'));
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'companies', safeCompanyId, 'bankTransactions', safeId), {
      statusConciliacao: 'sem_nf_localizada',
      invoiceId: '',
      invoiceNumber: '',
      updatedAt: serverTimestamp(),
    });
    batch.set(recRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      bankTransactionId: safeId,
      bankDescricao: clip(bankTx.descricao, FIELD_LIMITS.descricaoBanco),
      bankValor: ensureNonNegativeNumber(bankTx.valor, 'Valor Bancário'),
      bankData: ensureIsoDate(bankTx.dataMovimento, 'Data'),
      invoiceId: '',
      invoiceNumber: '',
      financialTransactionId: '',
      tipo: 'sem_nf',
      valorConciliado: ensureNonNegativeNumber(bankTx.valor, 'Valor'),
      confianca: 'manual',
      justificativa: 'Recebimento mantido como pendência de conferência sem nota fiscal localizada nos documentos importados.',
      origemDecisao: 'manual',
      observacoes: 'Pendência de conferência: recebimento sem nota fiscal localizada',
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    await writeAuditLog(
      user,
      safeCompanyId,
      'Conciliação Bancária',
      'conciliar',
      `Sinalizou recebimento bancário (${safeId}) como pendência sem nota fiscal localizada`,
      safeId,
      {
        origem: 'Conciliação Bancária',
        resultado: 'sucesso',
        dadosAnteriores: `Status anterior: ${bankTx.statusConciliacao}`,
        dadosPosteriores: 'Status: sem_nf_localizada',
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `companies/${safeCompanyId}/bankTransactions/${safeId}`);
  }
}

export async function deleteBankTransaction(
  user: User,
  companyId: string,
  id: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  try {
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'bankTransactions', safeId));
    await writeAuditLog(user, safeCompanyId, 'Conciliação Bancária', 'excluir', `Removeu transação bancária (${safeId})`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: `Transação bancária ${safeId}`,
      dadosPosteriores: 'Transação removida',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `companies/${safeCompanyId}/bankTransactions/${safeId}`);
  }
}

// ==================== ESTOQUE E MOVIMENTAÇÕES ====================
export type InventoryInput = Omit<InventoryProduct, 'id' | 'companyId' | 'ownerId' | 'createdAt' | 'updatedAt'>;

export async function createInventoryProduct(
  user: User,
  companyId: string,
  input: InventoryInput
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const docRef = doc(collection(db, 'companies', safeCompanyId, 'products'));
  const path = `companies/${safeCompanyId}/products/${docRef.id}`;
  try {
    const qty = ensureNonNegativeNumber(input.quantidade, 'Quantidade');
    const payload = {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      sku: clip(input.sku, FIELD_LIMITS.sku),
      nome: clip(input.nome, FIELD_LIMITS.produtoNome),
      categoria: input.categoria,
      marca: clip(input.marca, FIELD_LIMITS.marca),
      modelo: clip(input.modelo, FIELD_LIMITS.modelo),
      capacidade: clip(input.capacidade, FIELD_LIMITS.capacidade),
      unidade: input.unidade,
      quantidade: qty,
      estoqueMinimo: ensureNonNegativeNumber(input.estoqueMinimo, 'Estoque Mínimo'),
      custoUnitario: ensureNonNegativeNumber(input.custoUnitario, 'Custo Unitário'),
      precoVenda: ensureNonNegativeNumber(input.precoVenda, 'Preço de Venda'),
      localizacao: clip(input.localizacao, FIELD_LIMITS.localizacao),
      observacoes: clip(input.observacoes, FIELD_LIMITS.observacoesProduto),
      origemImportacao: input.origemImportacao === 'planilha' ? 'planilha' : 'manual',
      arquivoImportacao: clip(input.arquivoImportacao, FIELD_LIMITS.origemArquivo),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    batch.set(docRef, payload);
    if (qty > 0) {
      const movRef = doc(collection(db, 'companies', safeCompanyId, 'stockMovements'));
      batch.set(movRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        productId: docRef.id,
        productName: payload.nome,
        productSku: payload.sku,
        tipo: 'entrada',
        motivo: 'Entrada de material',
        quantidade: qty,
        saldoAnterior: 0,
        saldoAtual: qty,
        custoUnitario: payload.custoUnitario,
        responsavel: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.responsavel),
        documentoReferencia: 'SALDO INICIAL',
        dataMovimentacao: todayISO(),
        observacoes: 'Saldo inicial registrado no cadastro do produto.',
        idempotencyKey: sanitizeId(`init_${docRef.id}`),
        createdAt: serverTimestamp(),
      });
    }
    const auditRef = doc(collection(db, 'companies', safeCompanyId, 'auditLogs'));
    batch.set(auditRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      userEmail: clip((user.email || 'usuario@empresa.com').toLowerCase(), FIELD_LIMITS.userEmail),
      userName: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.userName),
      modulo: 'Estoque',
      acao: 'criar',
      entidadeId: docRef.id,
      resumo: clip(`Cadastrou item ${payload.sku} — ${payload.nome} (Saldo: ${qty} ${payload.unidade})`, FIELD_LIMITS.auditResumo),
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: 'Produto não cadastrado',
      dadosPosteriores: `${payload.sku} — ${payload.nome} | Saldo: ${qty} ${payload.unidade}`,
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateInventoryProduct(
  user: User,
  companyId: string,
  id: string,
  input: Partial<InventoryInput>
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  const docRef = doc(db, 'companies', safeCompanyId, 'products', safeId);
  const path = `companies/${safeCompanyId}/products/${safeId}`;
  try {
    const prevSnap = await getDoc(docRef);
    const prev = prevSnap.exists() ? (prevSnap.data() as Partial<InventoryProduct>) : null;
    const prevSummary = prev
      ? `${prev.sku || '—'} — ${prev.nome || '—'} | Saldo: ${prev.quantidade ?? 0} ${prev.unidade || 'un'} | Mín: ${prev.estoqueMinimo ?? 0}`
      : 'Sem snapshot anterior';

    const updateData: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (input.sku !== undefined) updateData.sku = clip(input.sku, FIELD_LIMITS.sku);
    if (input.nome !== undefined) updateData.nome = clip(input.nome, FIELD_LIMITS.produtoNome);
    if (input.categoria !== undefined) updateData.categoria = input.categoria;
    if (input.marca !== undefined) updateData.marca = clip(input.marca, FIELD_LIMITS.marca);
    if (input.modelo !== undefined) updateData.modelo = clip(input.modelo, FIELD_LIMITS.modelo);
    if (input.capacidade !== undefined) updateData.capacidade = clip(input.capacidade, FIELD_LIMITS.capacidade);
    if (input.unidade !== undefined) updateData.unidade = input.unidade;
    if (input.quantidade !== undefined) updateData.quantidade = ensureNonNegativeNumber(input.quantidade, 'Quantidade');
    if (input.estoqueMinimo !== undefined) updateData.estoqueMinimo = ensureNonNegativeNumber(input.estoqueMinimo, 'Estoque Mínimo');
    if (input.custoUnitario !== undefined) updateData.custoUnitario = ensureNonNegativeNumber(input.custoUnitario, 'Custo');
    if (input.precoVenda !== undefined) updateData.precoVenda = ensureNonNegativeNumber(input.precoVenda, 'Preço');
    if (input.localizacao !== undefined) updateData.localizacao = clip(input.localizacao, FIELD_LIMITS.localizacao);
    if (input.observacoes !== undefined) updateData.observacoes = clip(input.observacoes, FIELD_LIMITS.observacoesProduto);

    await updateDoc(docRef, updateData);
    await writeAuditLog(user, safeCompanyId, 'Estoque', 'editar', `Atualizou cadastro do produto (${safeId})`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: prevSummary,
      dadosPosteriores: `${String(updateData.sku ?? prev?.sku ?? '—')} — ${String(updateData.nome ?? prev?.nome ?? '—')} | Saldo: ${String(updateData.quantidade ?? prev?.quantidade ?? 0)} ${String(updateData.unidade ?? prev?.unidade ?? 'un')} | Mín: ${String(updateData.estoqueMinimo ?? prev?.estoqueMinimo ?? 0)}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteInventoryProduct(
  user: User,
  companyId: string,
  id: string,
  name: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeId = sanitizeId(id);
  try {
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'products', safeId));
    await writeAuditLog(user, safeCompanyId, 'Estoque', 'excluir', `Removeu item do estoque: ${clip(name, 120)}`, safeId, {
      origem: 'Interface Web',
      resultado: 'sucesso',
      dadosAnteriores: clip(name, 120),
      dadosPosteriores: 'Produto removido',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `companies/${safeCompanyId}/products/${safeId}`);
  }
}

export interface ImportedProductAction {
  mode: 'create' | 'add_stock';
  existingProductId?: string;
  product: InventoryInput;
}

export async function importInventoryBatch(
  user: User,
  companyId: string,
  items: ImportedProductAction[],
  fileName: string
): Promise<{ createdCount: number; stockedExistingCount: number }> {
  const safeCompanyId = sanitizeId(companyId);
  const safeFile = clip(fileName, FIELD_LIMITS.origemArquivo);
  const respName = clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.responsavel);
  const isoToday = todayISO();

  let createdCount = 0;
  let stockedExistingCount = 0;

  const toCreate = items.filter((item) => item.mode === 'create');
  const toStockExisting = items.filter((item) => item.mode === 'add_stock' && item.existingProductId);

  const productsPath = `companies/${safeCompanyId}/products`;
  try {
    // 1. Criar novos produtos + saldo inicial em stockMovements atomicamente por lote
    const chunkSize = 150;
    for (let i = 0; i < toCreate.length; i += chunkSize) {
      const slice = toCreate.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const entry of slice) {
        const inp = entry.product;
        const prodRef = doc(collection(db, productsPath));
        const qty = ensureNonNegativeNumber(inp.quantidade, 'Quantidade');
        const custo = ensureNonNegativeNumber(inp.custoUnitario, 'Custo Unitário');
        const prodPayload = {
          companyId: safeCompanyId,
          ownerId: sanitizeId(user.uid),
          sku: clip(inp.sku, FIELD_LIMITS.sku),
          nome: clip(inp.nome, FIELD_LIMITS.produtoNome),
          categoria: inp.categoria,
          marca: clip(inp.marca, FIELD_LIMITS.marca),
          modelo: clip(inp.modelo, FIELD_LIMITS.modelo),
          capacidade: clip(inp.capacidade, FIELD_LIMITS.capacidade),
          unidade: inp.unidade,
          quantidade: qty,
          estoqueMinimo: ensureNonNegativeNumber(inp.estoqueMinimo, 'Estoque Mínimo'),
          custoUnitario: custo,
          precoVenda: ensureNonNegativeNumber(inp.precoVenda, 'Preço de Venda'),
          localizacao: clip(inp.localizacao, FIELD_LIMITS.localizacao),
          observacoes: clip(inp.observacoes, FIELD_LIMITS.observacoesProduto),
          origemImportacao: 'planilha' as const,
          arquivoImportacao: safeFile,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        batch.set(prodRef, prodPayload);

        if (qty > 0) {
          const movRef = doc(collection(db, 'companies', safeCompanyId, 'stockMovements'));
          batch.set(movRef, {
            companyId: safeCompanyId,
            ownerId: sanitizeId(user.uid),
            productId: prodRef.id,
            productName: prodPayload.nome,
            productSku: prodPayload.sku,
            tipo: 'entrada',
            motivo: 'Entrada de material',
            quantidade: qty,
            saldoAnterior: 0,
            saldoAtual: qty,
            custoUnitario: custo,
            responsavel: respName,
            documentoReferencia: safeFile.slice(0, FIELD_LIMITS.documentoReferencia),
            dataMovimentacao: isoToday,
            observacoes: clip(`Saldo inicial importado da planilha ${safeFile}`, FIELD_LIMITS.observacoesMovimento),
            idempotencyKey: sanitizeId(`imp_${prodRef.id}`),
            createdAt: serverTimestamp(),
          });
        }
        createdCount += 1;
      }
      await batch.commit();
    }

    // 2. Somar saldo inicial em produtos existentes usando transação atômica com chave de idempotência
    for (let idx = 0; idx < toStockExisting.length; idx += 1) {
      const entry = toStockExisting[idx];
      const qty = ensureNonNegativeNumber(entry.product.quantidade, 'Quantidade');
      if (qty <= 0 || !entry.existingProductId) continue;

      await recordStockMovement(user, safeCompanyId, {
        productId: entry.existingProductId,
        tipo: 'entrada',
        motivo: 'Entrada de material',
        quantidade: qty,
        responsavel: respName,
        documentoReferencia: safeFile.slice(0, FIELD_LIMITS.documentoReferencia),
        dataMovimentacao: isoToday,
        observacoes: clip(`Entrada via importação da planilha ${safeFile}`, FIELD_LIMITS.observacoesMovimento),
        idempotencyKey: `imp_${Date.now().toString(36)}_${idx}_${sanitizeId(entry.existingProductId)}`,
      });
      stockedExistingCount += 1;
    }

    await writeAuditLog(
      user,
      safeCompanyId,
      'Estoque',
      'importar',
      `Importou planilha "${safeFile}": ${createdCount} novos produtos e ${stockedExistingCount} entradas em itens existentes.`,
      undefined,
      {
        origem: 'Importação de Planilha',
        resultado: 'sucesso',
        dadosAnteriores: `Planilha: ${safeFile}`,
        dadosPosteriores: `${createdCount} criados | ${stockedExistingCount} saldos somados`,
      }
    );

    return { createdCount, stockedExistingCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, productsPath);
  }
}

export interface StockMovementInput {
  productId: string;
  tipo: StockMovementType;
  motivo: StockMovementReason;
  quantidade: number;
  responsavel: string;
  documentoReferencia?: string;
  dataMovimentacao: string;
  observacoes?: string;
  idempotencyKey?: string;
}

export async function recordStockMovement(
  user: User,
  companyId: string,
  input: StockMovementInput
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeProductId = sanitizeId(input.productId);
  const qty = Math.round(Number(input.quantidade) * 100) / 100;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('A quantidade movimentada deve ser maior que zero.');
  }

  const productRef = doc(db, 'companies', safeCompanyId, 'products', safeProductId);
  const safeIdempotency = input.idempotencyKey ? sanitizeId(input.idempotencyKey) : '';
  const movementRef = safeIdempotency
    ? doc(db, 'companies', safeCompanyId, 'stockMovements', safeIdempotency)
    : doc(collection(db, 'companies', safeCompanyId, 'stockMovements'));
  const auditRef = doc(collection(db, 'companies', safeCompanyId, 'auditLogs'));
  const path = `companies/${safeCompanyId}/stockMovements/${movementRef.id}`;
  const isAiOrigin = (input.observacoes ?? '').startsWith('[Assistente de IA]');
  const auditOrigin: AuditOrigin = isAiOrigin ? 'Assistente de IA' : 'Interface Web';
  let observedPrevBalance = '';

  try {
    await runTransaction(db, async (tx) => {
      if (safeIdempotency) {
        const existingMovementSnap = await tx.get(movementRef);
        if (existingMovementSnap.exists()) {
          throw new Error('Esta movimentação já foi registrada anteriormente (duplicidade bloqueada).');
        }
      }

      const productSnap = await tx.get(productRef);
      if (!productSnap.exists()) {
        throw new Error('Produto não encontrado no estoque.');
      }
      const productData = productSnap.data() as Omit<InventoryProduct, 'id'>;
      const saldoAnterior = Number(productData.quantidade) || 0;
      observedPrevBalance = `${productData.sku}: ${saldoAnterior} ${productData.unidade}`;
      const saldoAtual =
        input.tipo === 'entrada'
          ? Math.round((saldoAnterior + qty) * 100) / 100
          : Math.round((saldoAnterior - qty) * 100) / 100;

      if (saldoAtual < 0) {
        throw new Error(
          `Saldo insuficiente em estoque para ${productData.nome}. Disponível: ${saldoAnterior} ${productData.unidade}.`
        );
      }

      tx.update(productRef, {
        quantidade: saldoAtual,
        updatedAt: serverTimestamp(),
      });

      tx.set(movementRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        productId: safeProductId,
        productName: clip(productData.nome, FIELD_LIMITS.produtoNome),
        productSku: clip(productData.sku, FIELD_LIMITS.sku),
        tipo: input.tipo,
        motivo: input.motivo,
        quantidade: qty,
        saldoAnterior,
        saldoAtual,
        custoUnitario: Number(productData.custoUnitario) || 0,
        responsavel: clip(input.responsavel, FIELD_LIMITS.responsavel),
        documentoReferencia: clip(input.documentoReferencia, FIELD_LIMITS.documentoReferencia),
        dataMovimentacao: ensureIsoDate(input.dataMovimentacao, 'Data da Movimentação'),
        observacoes: clip(input.observacoes, FIELD_LIMITS.observacoesMovimento),
        ...(safeIdempotency ? { idempotencyKey: safeIdempotency } : {}),
        createdAt: serverTimestamp(),
      });

      tx.set(auditRef, {
        companyId: safeCompanyId,
        ownerId: sanitizeId(user.uid),
        userEmail: clip((user.email || 'usuario@empresa.com').toLowerCase(), FIELD_LIMITS.userEmail),
        userName: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.userName),
        modulo: 'Movimentações de Estoque',
        acao: 'movimentar',
        entidadeId: movementRef.id,
        resumo: clip(
          `${input.tipo === 'entrada' ? 'Entrada' : 'Saída'} de ${qty} ${productData.unidade} (${productData.nome}) — ${input.motivo} | Saldo: ${saldoAnterior} → ${saldoAtual}`,
          FIELD_LIMITS.auditResumo
        ),
        origem: auditOrigin,
        resultado: 'sucesso',
        dadosAnteriores: clip(observedPrevBalance, FIELD_LIMITS.auditDados),
        dadosPosteriores: clip(
          `${productData.sku}: ${saldoAtual} ${productData.unidade} (${input.tipo}: ${qty})`,
          FIELD_LIMITS.auditDados
        ),
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Saldo insuficiente') ||
        error.message.includes('não encontrado') ||
        error.message.includes('duplicidade bloqueada'))
    ) {
      void writeAuditLog(
        user,
        safeCompanyId,
        'Movimentações de Estoque',
        'movimentar',
        `Movimentação bloqueada: ${error.message}`,
        safeProductId,
        {
          origem: auditOrigin,
          resultado: 'bloqueado',
          dadosAnteriores: observedPrevBalance || `Produto ${safeProductId}`,
          dadosPosteriores: `Solicitado: ${input.tipo} ${qty} (${input.motivo}) — bloqueado`,
        }
      ).catch(() => undefined);
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// ==================== RELATÓRIOS ====================
export type ReportInput = Omit<SavedReport, 'id' | 'companyId' | 'ownerId' | 'createdByName' | 'createdAt'>;

export async function saveCompanyReport(
  user: User,
  companyId: string,
  input: ReportInput
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const reportRef = doc(collection(db, 'companies', safeCompanyId, 'reports'));
  const path = `companies/${safeCompanyId}/reports/${reportRef.id}`;
  try {
    await setDoc(reportRef, {
      companyId: safeCompanyId,
      ownerId: sanitizeId(user.uid),
      titulo: clip(input.titulo, FIELD_LIMITS.reportTitle),
      tipo: input.tipo,
      periodoInicio: input.periodoInicio ? ensureIsoDate(input.periodoInicio, 'Data Inicial') : '',
      periodoFim: input.periodoFim ? ensureIsoDate(input.periodoFim, 'Data Final') : '',
      totalRegistros: Math.max(0, Math.round(Number(input.totalRegistros) || 0)),
      valorResumo: Math.round((Number(input.valorResumo) || 0) * 100) / 100,
      fileName: clip(input.fileName, FIELD_LIMITS.fileName),
      storagePath: clip(input.storagePath, FIELD_LIMITS.storagePath),
      downloadUrl: clip(input.downloadUrl, FIELD_LIMITS.downloadUrl),
      createdByName: clip(user.displayName || user.email || 'Usuário', FIELD_LIMITS.userName),
      createdAt: serverTimestamp(),
    });
    await writeAuditLog(
      user,
      safeCompanyId,
      'Relatórios',
      'criar',
      `Registrou relatório "${clip(input.titulo, 100)}"`,
      reportRef.id,
      {
        origem: 'Interface Web',
        resultado: 'sucesso',
        dadosAnteriores: 'Relatório não gerado',
        dadosPosteriores: `${clip(input.titulo, 120)} (${input.totalRegistros} registros)`,
      }
    );
    return reportRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// ==================== CONFIGURAÇÕES DA EMPRESA ====================
export type SettingsInput = Omit<Company, 'id' | 'companyId' | 'ownerId' | 'active' | 'createdAt' | 'updatedAt'>;

export async function saveCompanySettings(
  user: User,
  companyId: string,
  input: SettingsInput
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const docRef = doc(db, 'companies', safeCompanyId);
  const path = `companies/${safeCompanyId}`;
  try {
    const prevSnap = await getDoc(docRef);
    const prev = prevSnap.exists() ? (prevSnap.data() as Partial<Company>) : null;
    const prevSummary = prev
      ? `${prev.nomeFantasia || '—'} | ${prev.regimeTributario || '—'} | Tolerância: ${prev.diasToleranciaConciliacao ?? 5}d | Série NF: ${prev.serieNfPadrao || '1'}`
      : 'Sem snapshot anterior';

    const data = {
      razaoSocial: clip(input.razaoSocial, FIELD_LIMITS.razaoSocial),
      nomeFantasia: clip(input.nomeFantasia, FIELD_LIMITS.nomeFantasia),
      cnpj: clip(input.cnpj, FIELD_LIMITS.cnpj),
      inscricaoEstadual: clip(input.inscricaoEstadual, FIELD_LIMITS.inscricaoEstadual),
      telefone: clip(input.telefone, FIELD_LIMITS.telefone),
      email: clip((input.email || '').toLowerCase(), FIELD_LIMITS.userEmail),
      endereco: clip(input.endereco, FIELD_LIMITS.endereco),
      regimeTributario: input.regimeTributario,
      diasToleranciaConciliacao: Math.max(0, Math.min(90, Math.round(Number(input.diasToleranciaConciliacao) || 0))),
      serieNfPadrao: clip(input.serieNfPadrao || '1', FIELD_LIMITS.serieNf),
      active: true,
      updatedAt: serverTimestamp(),
    };

    await updateDoc(docRef, data);
    // Sincroniza nomeFantasia no vínculo do usuário atual
    await updateDoc(doc(db, 'users', sanitizeId(user.uid), 'companies', safeCompanyId), {
      companyName: data.nomeFantasia,
      updatedAt: serverTimestamp(),
    });

    await writeAuditLog(
      user,
      safeCompanyId,
      'Configurações',
      'configurar',
      `Atualizou configurações da empresa ${data.nomeFantasia}`,
      safeCompanyId,
      {
        origem: 'Administração',
        resultado: 'sucesso',
        dadosAnteriores: prevSummary,
        dadosPosteriores: `${data.nomeFantasia} | ${data.regimeTributario} | Tolerância: ${data.diasToleranciaConciliacao}d | Série NF: ${data.serieNfPadrao}`,
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ==================== ASSISTENTE DE IA (CONVERSAS E AUDITORIA) ====================
function toMillisSafe(ts: unknown): number {
  if (!ts) return Date.now();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'object' && ts !== null && 'toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export function subscribeAiConversations(
  user: User,
  companyId: string,
  onData: (items: AiConversation[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeCompanyId = sanitizeId(companyId);
  const safeUid = sanitizeId(user.uid);
  const path = `companies/${safeCompanyId}/aiConversations`;
  return onSnapshot(
    query(
      collection(db, path),
      where('companyId', '==', safeCompanyId),
      where('ownerId', '==', safeUid)
    ),
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({
          id: d.id,
          ...(d.data() as Omit<AiConversation, 'id'>),
        }))
        .sort((a, b) => toMillisSafe(b.updatedAt) - toMillisSafe(a.updatedAt));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export function subscribeAiMessages(
  user: User,
  companyId: string,
  conversationId: string,
  onData: (items: AiChatMessage[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const safeCompanyId = sanitizeId(companyId);
  const safeConvId = sanitizeId(conversationId);
  const safeUid = sanitizeId(user.uid);
  const path = `companies/${safeCompanyId}/aiConversations/${safeConvId}/messages`;
  return onSnapshot(
    query(
      collection(db, path),
      where('companyId', '==', safeCompanyId),
      where('conversationId', '==', safeConvId),
      where('ownerId', '==', safeUid)
    ),
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({
          id: d.id,
          ...(d.data() as Omit<AiChatMessage, 'id'>),
        }))
        .sort((a, b) => {
          const diff = toMillisSafe(a.createdAt) - toMillisSafe(b.createdAt);
          if (diff !== 0) return diff;
          return a.id.localeCompare(b.id);
        });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err as Error);
      }
    }
  );
}

export async function createAiConversation(
  user: User,
  companyId: string,
  initialTitle: string
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const safeUid = sanitizeId(user.uid);
  const convRef = doc(collection(db, 'companies', safeCompanyId, 'aiConversations'));
  const path = `companies/${safeCompanyId}/aiConversations/${convRef.id}`;
  try {
    await setDoc(convRef, {
      companyId: safeCompanyId,
      ownerId: safeUid,
      title: clip(initialTitle || 'Nova conversa', FIELD_LIMITS.aiTitle),
      lastMessagePreview: '',
      messageCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return convRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function appendAiMessage(
  user: User,
  companyId: string,
  conversationId: string,
  input: {
    role: 'user' | 'model';
    text: string;
    actionType?: AiActionType;
    actionSummary?: string;
    newTitle?: string;
    nextMessageCount: number;
  }
): Promise<string> {
  const safeCompanyId = sanitizeId(companyId);
  const safeConvId = sanitizeId(conversationId);
  const safeUid = sanitizeId(user.uid);
  const convRef = doc(db, 'companies', safeCompanyId, 'aiConversations', safeConvId);
  const msgId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const msgRef = doc(db, 'companies', safeCompanyId, 'aiConversations', safeConvId, 'messages', msgId);
  const path = `companies/${safeCompanyId}/aiConversations/${safeConvId}/messages/${msgId}`;

  try {
    const batch = writeBatch(db);
    batch.set(msgRef, {
      companyId: safeCompanyId,
      conversationId: safeConvId,
      ownerId: safeUid,
      role: input.role,
      text: clip(input.text, FIELD_LIMITS.aiMessageText),
      actionType: input.actionType ?? 'none',
      ...(input.actionSummary
        ? { actionSummary: clip(input.actionSummary, FIELD_LIMITS.aiActionSummary) }
        : {}),
      createdAt: serverTimestamp(),
    });

    const convUpdate: Record<string, unknown> = {
      lastMessagePreview: clip(input.text.replace(/\s+/g, ' '), FIELD_LIMITS.aiPreview),
      messageCount: Math.max(0, Math.min(5000, Math.round(input.nextMessageCount))),
      updatedAt: serverTimestamp(),
    };
    if (input.newTitle) {
      convUpdate.title = clip(input.newTitle, FIELD_LIMITS.aiTitle);
    }
    batch.update(convRef, convUpdate);

    await batch.commit();
    return msgId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteAiConversation(
  user: User,
  companyId: string,
  conversationId: string
): Promise<void> {
  const safeCompanyId = sanitizeId(companyId);
  const safeConvId = sanitizeId(conversationId);
  const safeUid = sanitizeId(user.uid);
  const path = `companies/${safeCompanyId}/aiConversations/${safeConvId}`;

  try {
    const msgsSnap = await getDocs(
      query(
        collection(db, 'companies', safeCompanyId, 'aiConversations', safeConvId, 'messages'),
        where('companyId', '==', safeCompanyId),
        where('conversationId', '==', safeConvId),
        where('ownerId', '==', safeUid)
      )
    );
    const docs = msgsSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, 'companies', safeCompanyId, 'aiConversations', safeConvId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function recordAiAuditEvent(
  user: User,
  companyId: string,
  acao: AuditAction,
  resumo: string,
  entidadeId?: string
): Promise<void> {
  await writeAuditLog(user, companyId, 'Assistente de IA', acao, resumo, entidadeId, {
    origem: 'Assistente de IA',
    resultado: 'sucesso',
    dadosPosteriores: clip(resumo, FIELD_LIMITS.auditDados),
  });
}

