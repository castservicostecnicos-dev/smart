import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  Building2,
  Check,
  KeyRound,
  Loader2,
  MailCheck,
  Plus,
  RefreshCw,
  ShieldCheck,
  Snowflake,
} from 'lucide-react';
import { auth, googleProvider } from './lib/firebase';
import {
  ALL_MENU_SECTIONS,
  canEditSection,
  FIELD_LIMITS,
  isBootstrappedAdminEmail,
  normalizeUserRole,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_LABELS,
  type AuditLog,
  type BankTransaction,
  type Company,
  type CompanyDocument,
  type CompanyInvite,
  type CompanyMember,
  type Customer,
  type FinancialTransaction,
  type InventoryProduct,
  type Invoice,
  type MenuSection,
  type ReconciliationRecord,
  type SavedReport,
  type StockMovement,
  type TaxRegime,
  type UserAccount,
  type UserCompanyMembership,
  type UserRole,
} from './types/erp';
import {
  acceptCompanyInvite,
  bootstrapUserAndCompanies,
  createCompany,
  subscribeCompanyDoc,
  subscribeCompanyInvites,
  subscribeCompanyMembers,
  subscribeCompanySubcollection,
  subscribeCurrentCompanyMember,
  subscribePendingInvitesForUser,
  subscribeUserCompanies,
  switchActiveCompany,
} from './services/erpService';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SidebarLayout } from './components/layout/SidebarLayout';
import {
  Modal,
  OfflineIndicator,
  PWAInstallButton,
  ToastBanner,
  type ToastMessage,
} from './components/ui/CommonUI';
import { DashboardModule } from './modules/DashboardModule';
import { AiAssistantModule } from './modules/AiAssistantModule';
import { FinancialModule } from './modules/FinancialModule';
import { InvoicesModule } from './modules/InvoicesModule';
import { ReconciliationModule } from './modules/ReconciliationModule';
import { InventoryModule } from './modules/InventoryModule';
import { StockMovementsModule } from './modules/StockMovementsModule';
import { ReportsModule } from './modules/ReportsModule';
import { AuditLogsModule } from './modules/AuditLogsModule';
import { UsersPermissionsModule } from './modules/UsersPermissionsModule';
import { SettingsModule } from './modules/SettingsModule';

function translateFirebaseAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: string }).code)
      : '';
  switch (code) {
    case 'auth/operation-not-allowed':
      return 'O provedor E-mail/Senha ainda não foi ativado no Console do Firebase (Authentication > Sign-in method). Ative-o no painel do Firebase ou utilize o login Google.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos. Se for seu primeiro acesso por e-mail, selecione "Criar Conta".';
    case 'auth/email-already-in-use':
      return 'Este e-mail já está cadastrado. Utilize a aba "Entrar com E-mail" ou recupere a senha.';
    case 'auth/weak-password':
      return 'A senha deve possuir no mínimo 6 caracteres.';
    case 'auth/invalid-email':
      return 'Informe um endereço de e-mail válido.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns instantes e tente novamente.';
    case 'auth/popup-closed-by-user':
      return 'A janela de login Google foi fechada antes da conclusão.';
    default:
      return err instanceof Error ? err.message : 'Falha na autenticação.';
  }
}

function ErpWorkspace() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [emailVerifiedState, setEmailVerifiedState] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  // Multiempresa
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [userAccount, setUserAccount] = useState<UserAccount | null>(null);
  const [memberships, setMemberships] = useState<UserCompanyMembership[]>([]);
  const [pendingInvites, setPendingInvites] = useState<CompanyInvite[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string>('');
  const [activeCompany, setActiveCompany] = useState<Company | null>(null);
  const [currentMember, setCurrentMember] = useState<CompanyMember | null>(null);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [companyInvites, setCompanyInvites] = useState<CompanyInvite[]>([]);

  // Modal Nova Empresa
  const [newCompanyModalOpen, setNewCompanyModalOpen] = useState(false);
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [newCompanyForm, setNewCompanyForm] = useState({
    razaoSocial: '',
    nomeFantasia: '',
    cnpj: '',
    regimeTributario: 'Simples Nacional' as TaxRegime,
    telefone: '',
    email: '',
    endereco: '',
    serieNfPadrao: '1',
    diasToleranciaConciliacao: 5,
  });

  const [activeSection, setActiveSection] = useState<MenuSection>('dashboard');
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [dataLoading, setDataLoading] = useState(true);
  const [memberDocSettled, setMemberDocSettled] = useState(false);
  const [runtimeError, setRuntimeError] = useState<Error | null>(null);

  // Coleções isoladas da empresa ativa (Tempo Real Firestore)
  const [financials, setFinancials] = useState<FinancialTransaction[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);
  const [reconciliations, setReconciliations] = useState<ReconciliationRecord[]>([]);
  const [inventory, setInventory] = useState<InventoryProduct[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [savedReports, setSavedReports] = useState<SavedReport[]>([]);
  const [documents, setDocuments] = useState<CompanyDocument[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  if (runtimeError) {
    throw runtimeError;
  }

  const notify = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    const id = String(Date.now());
    setToast({ id, type, text });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 5000);
  }, []);

  const clearCompanyData = useCallback(() => {
    setActiveCompany(null);
    setCurrentMember(null);
    setCompanyMembers([]);
    setCompanyInvites([]);
    setFinancials([]);
    setInvoices([]);
    setCustomers([]);
    setBankTransactions([]);
    setReconciliations([]);
    setInventory([]);
    setStockMovements([]);
    setSavedReports([]);
    setDocuments([]);
    setAuditLogs([]);
  }, []);

  const runUserBootstrap = useCallback(async (firebaseUser: User) => {
    setBootstrapLoading(true);
    try {
      const { account, memberships: initialMemberships } = await bootstrapUserAndCompanies(firebaseUser);
      setUserAccount(account);
      setMemberships(initialMemberships);

      const activeOnes = initialMemberships.filter((m) => m.active);
      const preferred =
        account.activeCompanyId && activeOnes.some((m) => m.companyId === account.activeCompanyId)
          ? account.activeCompanyId
          : activeOnes[0]?.companyId ?? '';
      setActiveCompanyId(preferred);
    } catch (err) {
      setRuntimeError(err as Error);
    } finally {
      setBootstrapLoading(false);
    }
  }, []);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      const isVerified = Boolean(firebaseUser?.emailVerified);
      setEmailVerifiedState(isVerified);

      if (firebaseUser && isVerified) {
        await runUserBootstrap(firebaseUser);
      } else {
        setUserAccount(null);
        setMemberships([]);
        setPendingInvites([]);
        setActiveCompanyId('');
        clearCompanyData();
        setDataLoading(false);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, [runUserBootstrap, clearCompanyData]);

  // Listeners globais do usuário (empresas vinculadas + convites recebidos)
  useEffect(() => {
    if (!authReady || !user || !emailVerifiedState) return;

    const handleSubError = (err: Error) => {
      setRuntimeError(err);
    };

    const unsubCompanies = subscribeUserCompanies(
      user,
      (list) => {
        setMemberships(list);
        setActiveCompanyId((prev) => {
          const activeList = list.filter((m) => m.active);
          if (prev && activeList.some((m) => m.companyId === prev)) return prev;
          if (userAccount?.activeCompanyId && activeList.some((m) => m.companyId === userAccount.activeCompanyId)) {
            return userAccount.activeCompanyId;
          }
          return activeList[0]?.companyId ?? '';
        });
      },
      handleSubError
    );

    const unsubInvites = subscribePendingInvitesForUser(
      user,
      (invitesList) => setPendingInvites(invitesList),
      handleSubError
    );

    return () => {
      unsubCompanies();
      unsubInvites();
    };
  }, [authReady, user, emailVerifiedState, userAccount?.activeCompanyId]);

  // Listeners estruturais da empresa ativa (metadados + membro atual)
  useEffect(() => {
    if (!authReady || !user || !emailVerifiedState || !activeCompanyId) {
      clearCompanyData();
      setMemberDocSettled(false);
      setDataLoading(false);
      return;
    }

    setDataLoading(true);
    setMemberDocSettled(false);

    const handleSubError = (err: Error) => {
      setDataLoading(false);
      setRuntimeError(err);
    };

    const unsubs = [
      subscribeCompanyDoc(
        activeCompanyId,
        (comp) => setActiveCompany(comp),
        handleSubError
      ),
      subscribeCurrentCompanyMember(
        activeCompanyId,
        user.uid,
        (member) => {
          setCurrentMember(member);
          setMemberDocSettled(true);
        },
        handleSubError
      ),
      subscribeCompanyMembers(
        activeCompanyId,
        (membersList) => setCompanyMembers(membersList),
        handleSubError
      ),
    ];

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [authReady, user, emailVerifiedState, activeCompanyId, clearCompanyData]);

  const activeMembership = useMemo(
    () => memberships.find((m) => m.companyId === activeCompanyId) ?? null,
    [memberships, activeCompanyId]
  );

  const userRole = useMemo<UserRole>(() => {
    if (currentMember) return normalizeUserRole(currentMember.role);
    if (activeMembership) return normalizeUserRole(activeMembership.role);
    if (user?.emailVerified && isBootstrappedAdminEmail(user.email)) return 'ADMINISTRADOR';
    return 'CONSULTA';
  }, [currentMember, activeMembership, user]);

  const allowedSections = useMemo<MenuSection[]>(() => {
    if (userRole === 'ADMINISTRADOR') return ALL_MENU_SECTIONS.map((s) => s.id);
    if (currentMember?.permissions && currentMember.permissions.length > 0) {
      return currentMember.permissions;
    }
    return ROLE_DEFAULT_PERMISSIONS[userRole] ?? ['dashboard'];
  }, [userRole, currentMember]);

  // Listeners operacionais em tempo real condicionados estritamente às permissões RBAC
  useEffect(() => {
    if (!authReady || !user || !emailVerifiedState || !activeCompanyId || !memberDocSettled) {
      return;
    }

    const canReadFinance =
      userRole === 'ADMINISTRADOR' ||
      userRole === 'FINANCEIRO' ||
      allowedSections.some((s) => s === 'financial' || s === 'invoices' || s === 'reconciliation');

    const canReadInventory =
      userRole === 'ADMINISTRADOR' ||
      userRole === 'ESTOQUE' ||
      allowedSections.some((s) => s === 'inventory' || s === 'inventory-movements');

    const canReadAudit = userRole === 'ADMINISTRADOR' || allowedSections.includes('audit-logs');
    const isAdmin = userRole === 'ADMINISTRADOR';

    if (!canReadFinance) {
      setFinancials([]);
      setInvoices([]);
      setCustomers([]);
      setBankTransactions([]);
      setReconciliations([]);
    }
    if (!canReadInventory) {
      setInventory([]);
      setStockMovements([]);
    }
    if (!canReadAudit) {
      setAuditLogs([]);
    }
    if (!isAdmin) {
      setCompanyInvites([]);
    }

    const expectedCount =
      2 + // reports + documents
      (isAdmin ? 1 : 0) +
      (canReadFinance ? 5 : 0) +
      (canReadInventory ? 2 : 0) +
      (canReadAudit ? 1 : 0);

    const loadedKeys = new Set<string>();
    const markLoaded = (key: string) => {
      loadedKeys.add(key);
      if (loadedKeys.size >= expectedCount) {
        setDataLoading(false);
      }
    };

    const handleSubError = (err: Error) => {
      setDataLoading(false);
      setRuntimeError(err);
    };

    const unsubs: Array<() => void> = [
      subscribeCompanySubcollection<SavedReport>(
        activeCompanyId,
        'reports',
        (items) => {
          setSavedReports(items);
          markLoaded('reports');
        },
        handleSubError
      ),
      subscribeCompanySubcollection<CompanyDocument>(
        activeCompanyId,
        'documents',
        (items) => {
          setDocuments(items);
          markLoaded('documents');
        },
        handleSubError
      ),
    ];

    if (isAdmin) {
      unsubs.push(
        subscribeCompanyInvites(
          activeCompanyId,
          user,
          (invitesList) => {
            setCompanyInvites(invitesList);
            markLoaded('invites');
          },
          handleSubError
        )
      );
    }

    if (canReadFinance) {
      unsubs.push(
        subscribeCompanySubcollection<FinancialTransaction>(
          activeCompanyId,
          'financialTransactions',
          (items) => {
            setFinancials(items);
            markLoaded('financialTransactions');
          },
          handleSubError
        ),
        subscribeCompanySubcollection<Invoice>(
          activeCompanyId,
          'invoices',
          (items) => {
            setInvoices(items);
            markLoaded('invoices');
          },
          handleSubError
        ),
        subscribeCompanySubcollection<Customer>(
          activeCompanyId,
          'customers',
          (items) => {
            setCustomers(items);
            markLoaded('customers');
          },
          handleSubError
        ),
        subscribeCompanySubcollection<BankTransaction>(
          activeCompanyId,
          'bankTransactions',
          (items) => {
            setBankTransactions(items);
            markLoaded('bankTransactions');
          },
          handleSubError
        ),
        subscribeCompanySubcollection<ReconciliationRecord>(
          activeCompanyId,
          'reconciliations',
          (items) => {
            setReconciliations(items);
            markLoaded('reconciliations');
          },
          handleSubError
        )
      );
    }

    if (canReadInventory) {
      unsubs.push(
        subscribeCompanySubcollection<InventoryProduct>(
          activeCompanyId,
          'products',
          (items) => {
            setInventory(items);
            markLoaded('products');
          },
          handleSubError
        ),
        subscribeCompanySubcollection<StockMovement>(
          activeCompanyId,
          'stockMovements',
          (items) => {
            setStockMovements(items);
            markLoaded('stockMovements');
          },
          handleSubError
        )
      );
    }

    if (canReadAudit) {
      unsubs.push(
        subscribeCompanySubcollection<AuditLog>(
          activeCompanyId,
          'auditLogs',
          (items) => {
            setAuditLogs(items);
            markLoaded('auditLogs');
          },
          handleSubError
        )
      );
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [authReady, user, emailVerifiedState, activeCompanyId, memberDocSettled, userRole, allowedSections]);

  useEffect(() => {
    if (allowedSections.length > 0 && !allowedSections.includes(activeSection)) {
      setActiveSection(allowedSections[0]);
    }
  }, [allowedSections, activeSection]);

  const handleSwitchCompany = async (companyId: string) => {
    if (!user || !companyId || companyId === activeCompanyId) return;
    setActiveCompanyId(companyId);
    try {
      await switchActiveCompany(user, companyId);
      const chosen = memberships.find((m) => m.companyId === companyId);
      notify('info', `Empresa alterada para ${chosen?.companyName ?? companyId}.`);
    } catch (err: unknown) {
      notify('error', err instanceof Error ? err.message : 'Erro ao trocar de empresa.');
    }
  };

  const handleCreateCompanySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || creatingCompany) return;
    if (!newCompanyForm.razaoSocial.trim() || !newCompanyForm.nomeFantasia.trim()) {
      notify('error', 'Informe a Razão Social e o Nome Fantasia da empresa.');
      return;
    }
    setCreatingCompany(true);
    try {
      const createdId = await createCompany(user, newCompanyForm);
      setActiveCompanyId(createdId);
      setNewCompanyModalOpen(false);
      setNewCompanyForm({
        razaoSocial: '',
        nomeFantasia: '',
        cnpj: '',
        regimeTributario: 'Simples Nacional',
        telefone: '',
        email: '',
        endereco: '',
        serieNfPadrao: '1',
        diasToleranciaConciliacao: 5,
      });
      notify('success', 'Nova empresa criada e isolada no Cloud Firestore!');
    } catch (err: unknown) {
      notify('error', err instanceof Error ? err.message : 'Erro ao criar empresa.');
    } finally {
      setCreatingCompany(false);
    }
  };

  const handleAcceptInvite = async (invite: CompanyInvite) => {
    if (!user) return;
    try {
      await acceptCompanyInvite(user, invite);
      setActiveCompanyId(invite.companyId);
      notify('success', `Você agora faz parte da empresa ${invite.companyName} (${ROLE_LABELS[invite.role]}).`);
    } catch (err: unknown) {
      notify('error', err instanceof Error ? err.message : 'Erro ao aceitar convite.');
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);

    const email = emailInput.trim();
    if (!email || !passwordInput) {
      setAuthError('Informe o e-mail e a senha de acesso.');
      return;
    }

    setAuthLoading(true);
    try {
      if (authMode === 'login') {
        const cred = await signInWithEmailAndPassword(auth, email, passwordInput);
        if (!cred.user.emailVerified) {
          await sendEmailVerification(cred.user);
          setAuthInfo('Enviamos um link de verificação para o seu e-mail.');
        }
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, passwordInput);
        await sendEmailVerification(cred.user);
        setAuthInfo('Conta criada! Enviamos um link de confirmação para o seu e-mail.');
      }
    } catch (err: unknown) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);
    const email = emailInput.trim();
    if (!email) {
      setAuthError('Digite seu e-mail acima para receber o link de redefinição de senha.');
      return;
    }
    setAuthLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setAuthInfo(`Link de redefinição de senha enviado para ${email}.`);
    } catch (err: unknown) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError(null);
    setAuthInfo(null);
    setAuthLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRefreshVerification = async () => {
    if (!auth.currentUser) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
      const verified = Boolean(auth.currentUser.emailVerified);
      setEmailVerifiedState(verified);
      if (verified) {
        await runUserBootstrap(auth.currentUser);
      } else {
        setAuthError('O e-mail ainda consta como não verificado. Clique no link enviado para sua caixa de entrada.');
      }
    } catch (err: unknown) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!auth.currentUser) return;
    setAuthLoading(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      await sendEmailVerification(auth.currentUser);
      setAuthInfo(`E-mail de verificação reenviado para ${auth.currentUser.email}.`);
    } catch (err: unknown) {
      setAuthError(translateFirebaseAuthError(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  if (!authReady || bootstrapLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6">
        <Loader2 className="w-8 h-8 animate-spin text-[#0B1F3A] mb-3" />
        <p className="text-sm font-medium text-slate-600">
          Inicializando Gestão Inteligente Empresarial...
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="bg-[#0B1F3A] text-white p-7">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
                <Snowflake className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-semibold leading-tight">
                  Gestão Inteligente Empresarial
                </h1>
                <p className="text-xs text-blue-200">
                  Ar-Condicionado, Climatização e Refrigeração
                </p>
              </div>
            </div>
            <p className="text-xs text-blue-100/90 leading-relaxed">
              Plataforma multiempresa com Firebase Authentication, Cloud Firestore em tempo real, Storage e Assistente de IA.
            </p>
          </div>

          <div className="p-7 space-y-5">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError(null);
                  setAuthInfo(null);
                }}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  authMode === 'login'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Entrar com E-mail
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setAuthError(null);
                  setAuthInfo(null);
                }}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  authMode === 'register'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Criar Conta
              </button>
            </div>

            {authError && (
              <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg p-3 leading-relaxed">
                {authError}
              </div>
            )}

            {authInfo && (
              <div className="bg-blue-50 border border-blue-200 text-blue-900 text-xs rounded-lg p-3 leading-relaxed">
                {authInfo}
              </div>
            )}

            <form onSubmit={(e) => void handleEmailAuth(e)} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  E-mail Corporativo
                </label>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="seu-email@empresa.com"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">Senha</label>
                  {authMode === 'login' && (
                    <button
                      type="button"
                      onClick={() => void handleResetPassword()}
                      className="text-[11px] font-medium text-blue-700 hover:underline cursor-pointer"
                    >
                      Esqueci minha senha
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  required
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="••••••"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <button
                type="submit"
                disabled={authLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0B1F3A] hover:bg-blue-900 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                {authLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4" />
                )}
                {authMode === 'login' ? 'Entrar no Sistema' : 'Cadastrar Acesso'}
              </button>
            </form>

            <div className="relative flex items-center justify-center">
              <div className="border-t border-slate-200 w-full" />
              <span className="bg-white px-3 text-[11px] text-slate-400 whitespace-nowrap">
                ou continue com
              </span>
              <div className="border-t border-slate-200 w-full" />
            </div>

            <button
              type="button"
              disabled={authLoading}
              onClick={() => void handleGoogleLogin()}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4 text-blue-700" />
              Entrar com Conta Google
            </button>

            <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500">
                Autenticação protegida via Firebase
              </span>
              <PWAInstallButton variant="topbar" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!emailVerifiedState) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 space-y-5">
          <div className="flex items-center gap-3 text-blue-700">
            <MailCheck className="w-7 h-7 shrink-0" />
            <h2 className="text-lg font-semibold text-slate-900">
              Confirme seu e-mail para liberar o acesso
            </h2>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Para proteger os dados empresariais no Firebase, o acesso só é liberado após a verificação do endereço <strong>{user.email}</strong>. Abra a mensagem enviada para sua caixa de entrada e clique no link de confirmação.
          </p>

          {authError && (
            <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg p-3">
              {authError}
            </div>
          )}
          {authInfo && (
            <div className="bg-blue-50 border border-blue-200 text-blue-900 text-xs rounded-lg p-3">
              {authInfo}
            </div>
          )}

          <div className="flex flex-col gap-2.5 pt-2">
            <button
              type="button"
              disabled={authLoading}
              onClick={() => void handleRefreshVerification()}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0B1F3A] text-white text-sm font-medium rounded-lg hover:bg-blue-900 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${authLoading ? 'animate-spin' : ''}`} />
              Já verifiquei meu e-mail
            </button>
            <button
              type="button"
              disabled={authLoading}
              onClick={() => void handleResendVerification()}
              className="w-full px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              Reenviar link de verificação
            </button>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="w-full px-4 py-2 text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              Voltar e entrar com outra conta
            </button>
          </div>
        </div>
      </div>
    );
  }

  const activeCompanies = memberships.filter((m) => m.active);

  // Onboarding para novos usuários sem empresa vinculada (exibir convites pendentes ou criar empresa)
  if (!activeCompanyId || activeCompanies.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-xl w-full bg-white border border-slate-200 rounded-2xl shadow-sm p-8 space-y-6">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#0B1F3A] text-white flex items-center justify-center">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Vincular ou Cadastrar Empresa
                </h2>
                <p className="text-xs text-slate-500">
                  Conectado como {user.email}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              Sair
            </button>
          </div>

          {pendingInvites.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-blue-950">
                Você possui convites pendentes de acesso:
              </p>
              {pendingInvites.map((inv) => (
                <div
                  key={inv.id}
                  className="bg-white border border-blue-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{inv.companyName}</p>
                    <p className="text-xs text-slate-600">
                      Perfil atribuído: <strong>{ROLE_LABELS[inv.role]}</strong> · Convidado por {inv.invitedByEmail}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAcceptInvite(inv)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Aceitar Convite
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Ou cadastre sua própria empresa no sistema:
            </h3>
            <form onSubmit={(e) => void handleCreateCompanySubmit(e)} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Razão Social *</label>
                  <input
                    type="text"
                    required
                    maxLength={FIELD_LIMITS.razaoSocial}
                    value={newCompanyForm.razaoSocial}
                    onChange={(e) => setNewCompanyForm({ ...newCompanyForm, razaoSocial: e.target.value })}
                    placeholder="Ex.: Polar Climatização Ltda"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Nome Fantasia *</label>
                  <input
                    type="text"
                    required
                    maxLength={FIELD_LIMITS.nomeFantasia}
                    value={newCompanyForm.nomeFantasia}
                    onChange={(e) => setNewCompanyForm({ ...newCompanyForm, nomeFantasia: e.target.value })}
                    placeholder="Ex.: Polar Ar-Condicionado"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">CNPJ</label>
                  <input
                    type="text"
                    maxLength={FIELD_LIMITS.cnpj}
                    value={newCompanyForm.cnpj}
                    onChange={(e) => setNewCompanyForm({ ...newCompanyForm, cnpj: e.target.value })}
                    placeholder="00.000.000/0001-00"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Regime Tributário *</label>
                  <select
                    value={newCompanyForm.regimeTributario}
                    onChange={(e) =>
                      setNewCompanyForm({ ...newCompanyForm, regimeTributario: e.target.value as TaxRegime })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Simples Nacional">Simples Nacional</option>
                    <option value="Lucro Presumido">Lucro Presumido</option>
                    <option value="Lucro Real">Lucro Real</option>
                    <option value="MEI">MEI</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={creatingCompany}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#0B1F3A] rounded-lg hover:bg-blue-900 disabled:opacity-50 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                {creatingCompany ? 'Criando empresa...' : 'Criar Empresa e Acessar Painel'}
              </button>
            </form>
          </div>
        </div>
        <ToastBanner toast={toast} onDismiss={() => setToast(null)} />
      </div>
    );
  }

  if (currentMember && !currentMember.active) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 text-center">
          <h2 className="text-lg font-semibold text-slate-900">Acesso suspenso nesta empresa</h2>
          <p className="text-sm text-slate-600 mt-2">
            Seu acesso à empresa {activeCompany?.nomeFantasia ?? activeCompanyId} está inativo no momento.
          </p>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="mt-6 px-4 py-2 bg-[#0B1F3A] text-white text-sm font-medium rounded-lg hover:bg-blue-900 cursor-pointer"
          >
            Sair
          </button>
        </div>
      </div>
    );
  }

  const companyName =
    activeCompany?.nomeFantasia ||
    activeMembership?.companyName ||
    'Gestão Inteligente Empresarial';

  const effectiveProfile: CompanyMember | null =
    currentMember ??
    (user
      ? {
          id: user.uid,
          companyId: activeCompanyId,
          uid: user.uid,
          name: user.displayName || userAccount?.name || user.email?.split('@')[0] || 'Usuário',
          email: user.email || '',
          role: userRole,
          active: true,
          permissions: allowedSections,
        }
      : null);

  return (
    <SidebarLayout
      activeSection={activeSection}
      onSelectSection={setActiveSection}
      allowedSections={allowedSections}
      userProfile={effectiveProfile}
      userRole={userRole}
      companyName={companyName}
      activeCompanyId={activeCompanyId}
      companies={activeCompanies}
      onSwitchCompany={(cid) => void handleSwitchCompany(cid)}
      onOpenNewCompany={() => setNewCompanyModalOpen(true)}
      onSignOut={() => void handleSignOut()}
    >
      {pendingInvites.length > 0 && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-blue-950">
            <strong>Novo convite empresarial:</strong> Você foi convidado para acessar{' '}
            <strong>{pendingInvites[0].companyName}</strong> com perfil{' '}
            <strong>{ROLE_LABELS[pendingInvites[0].role]}</strong>.
          </div>
          <button
            type="button"
            onClick={() => void handleAcceptInvite(pendingInvites[0])}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer self-start sm:self-auto whitespace-nowrap"
          >
            <Check className="w-3.5 h-3.5" />
            Aceitar e Entrar
          </button>
        </div>
      )}

      {activeSection === 'dashboard' && (
        <DashboardModule
          loading={dataLoading}
          userRole={userRole}
          financials={financials}
          invoices={invoices}
          bankTransactions={bankTransactions}
          inventory={inventory}
          stockMovements={stockMovements}
          onNavigate={setActiveSection}
        />
      )}

      {activeSection === 'ai-assistant' && (
        <AiAssistantModule
          user={user}
          companyId={activeCompanyId}
          companyName={companyName}
          userRole={userRole}
          hasFinanceAccess={
            userRole === 'ADMINISTRADOR' ||
            userRole === 'FINANCEIRO' ||
            allowedSections.includes('financial') ||
            allowedSections.includes('invoices') ||
            allowedSections.includes('reconciliation')
          }
          hasInventoryAccess={
            userRole === 'ADMINISTRADOR' ||
            userRole === 'ESTOQUE' ||
            allowedSections.includes('inventory') ||
            allowedSections.includes('inventory-movements')
          }
          canWriteInventory={canEditSection(userRole, 'inventory-movements')}
          canSaveReports={userRole !== 'CONSULTA'}
          financials={financials}
          invoices={invoices}
          bankTransactions={bankTransactions}
          reconciliations={reconciliations}
          inventory={inventory}
          stockMovements={stockMovements}
          onNotify={notify}
        />
      )}

      {activeSection === 'financial' && (
        <FinancialModule
          user={user}
          companyId={activeCompanyId}
          canEdit={canEditSection(userRole, 'financial')}
          loading={dataLoading}
          transactions={financials}
          invoices={invoices}
          customers={customers}
          bankTransactions={bankTransactions}
          toleranceDays={activeCompany?.diasToleranciaConciliacao ?? 5}
          defaultSerie={activeCompany?.serieNfPadrao ?? '1'}
          onNotify={notify}
        />
      )}

      {activeSection === 'invoices' && (
        <InvoicesModule
          user={user}
          companyId={activeCompanyId}
          canEdit={canEditSection(userRole, 'invoices')}
          loading={dataLoading}
          invoices={invoices}
          customers={customers}
          defaultSerie={activeCompany?.serieNfPadrao ?? '1'}
          onNotify={notify}
        />
      )}

      {activeSection === 'reconciliation' && (
        <ReconciliationModule
          user={user}
          companyId={activeCompanyId}
          companyName={companyName}
          canEdit={canEditSection(userRole, 'reconciliation')}
          loading={dataLoading}
          bankTransactions={bankTransactions}
          invoices={invoices}
          reconciliations={reconciliations}
          customers={customers}
          toleranceDays={activeCompany?.diasToleranciaConciliacao ?? 5}
          onNotify={notify}
        />
      )}

      {activeSection === 'inventory' && (
        <InventoryModule
          user={user}
          companyId={activeCompanyId}
          companyName={companyName}
          canEdit={canEditSection(userRole, 'inventory')}
          loading={dataLoading}
          products={inventory}
          movements={stockMovements}
          onNotify={notify}
          onGoToMovements={() => setActiveSection('inventory-movements')}
        />
      )}

      {activeSection === 'inventory-movements' && (
        <StockMovementsModule
          user={user}
          companyId={activeCompanyId}
          canEdit={canEditSection(userRole, 'inventory-movements')}
          loading={dataLoading}
          products={inventory}
          movements={stockMovements}
          onNotify={notify}
        />
      )}

      {activeSection === 'reports' && (
        <ReportsModule
          user={user}
          companyId={activeCompanyId}
          companyName={companyName}
          userRole={userRole}
          hasFinanceAccess={
            userRole === 'ADMINISTRADOR' ||
            userRole === 'FINANCEIRO' ||
            allowedSections.includes('financial') ||
            allowedSections.includes('invoices') ||
            allowedSections.includes('reconciliation')
          }
          hasInventoryAccess={
            userRole === 'ADMINISTRADOR' ||
            userRole === 'ESTOQUE' ||
            allowedSections.includes('inventory') ||
            allowedSections.includes('inventory-movements')
          }
          canEdit={canEditSection(userRole, 'reports')}
          financials={financials}
          invoices={invoices}
          bankTransactions={bankTransactions}
          reconciliations={reconciliations}
          customers={customers}
          inventory={inventory}
          stockMovements={stockMovements}
          savedReports={savedReports}
          documents={documents}
          onNotify={notify}
        />
      )}

      {activeSection === 'audit-logs' && (
        <AuditLogsModule
          loading={dataLoading}
          logs={auditLogs}
          onNotify={notify}
        />
      )}

      {activeSection === 'users' && (
        <UsersPermissionsModule
          currentUser={user}
          companyId={activeCompanyId}
          companyName={companyName}
          currentUserRole={userRole}
          loading={dataLoading}
          members={companyMembers}
          invites={companyInvites}
          onNotify={notify}
        />
      )}

      {activeSection === 'settings' && (
        <SettingsModule
          user={user}
          companyId={activeCompanyId}
          canEdit={canEditSection(userRole, 'settings')}
          settings={activeCompany}
          onCreateCompany={() => setNewCompanyModalOpen(true)}
          onNotify={notify}
        />
      )}

      {/* Modal Nova Empresa */}
      <Modal
        open={newCompanyModalOpen}
        title="Cadastrar Nova Empresa"
        subtitle="Cada empresa possui banco, estoque, notas fiscais, conciliações, documentos e permissões totalmente isolados."
        onClose={() => setNewCompanyModalOpen(false)}
      >
        <form onSubmit={(e) => void handleCreateCompanySubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Razão Social *</label>
              <input
                type="text"
                required
                maxLength={FIELD_LIMITS.razaoSocial}
                value={newCompanyForm.razaoSocial}
                onChange={(e) => setNewCompanyForm({ ...newCompanyForm, razaoSocial: e.target.value })}
                placeholder="Ex.: Filial Sul Climatização Ltda"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nome Fantasia *</label>
              <input
                type="text"
                required
                maxLength={FIELD_LIMITS.nomeFantasia}
                value={newCompanyForm.nomeFantasia}
                onChange={(e) => setNewCompanyForm({ ...newCompanyForm, nomeFantasia: e.target.value })}
                placeholder="Ex.: Filial Sul"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">CNPJ</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.cnpj}
                value={newCompanyForm.cnpj}
                onChange={(e) => setNewCompanyForm({ ...newCompanyForm, cnpj: e.target.value })}
                placeholder="00.000.000/0001-00"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Regime Tributário *</label>
              <select
                value={newCompanyForm.regimeTributario}
                onChange={(e) =>
                  setNewCompanyForm({ ...newCompanyForm, regimeTributario: e.target.value as TaxRegime })
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="Simples Nacional">Simples Nacional</option>
                <option value="Lucro Presumido">Lucro Presumido</option>
                <option value="Lucro Real">Lucro Real</option>
                <option value="MEI">MEI</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Telefone</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.telefone}
                value={newCompanyForm.telefone}
                onChange={(e) => setNewCompanyForm({ ...newCompanyForm, telefone: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Série NF Padrão</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.serieNf}
                value={newCompanyForm.serieNfPadrao}
                onChange={(e) => setNewCompanyForm({ ...newCompanyForm, serieNfPadrao: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setNewCompanyModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={creatingCompany}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {creatingCompany ? 'Criando...' : 'Criar Empresa'}
            </button>
          </div>
        </form>
      </Modal>

      <ToastBanner toast={toast} onDismiss={() => setToast(null)} />
      <OfflineIndicator />
    </SidebarLayout>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ErpWorkspace />
    </ErrorBoundary>
  );
}
