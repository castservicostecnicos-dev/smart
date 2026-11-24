export const DEFAULT_COMPANY_ID = 'gestao-empresarial';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'ale11062@gmail.com';
export const BOOTSTRAPPED_ADMIN_EMAILS = [
  'ale11062@gmail.com',
  'cast.servicostecnicos@gmail.com',
] as const;

export function isBootstrappedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  return (BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).includes(lower);
}

export type MenuSection =
  | 'dashboard'
  | 'ai-assistant'
  | 'financial'
  | 'invoices'
  | 'reconciliation'
  | 'inventory'
  | 'inventory-movements'
  | 'reports'
  | 'audit-logs'
  | 'users'
  | 'settings';

export type UserRole = 'ADMINISTRADOR' | 'FINANCEIRO' | 'ESTOQUE' | 'CONSULTA';

export function normalizeUserRole(rawRole: string | undefined | null): UserRole {
  switch ((rawRole ?? '').trim()) {
    case 'ADMINISTRADOR':
    case 'admin':
    case 'gerente':
      return 'ADMINISTRADOR';
    case 'FINANCEIRO':
    case 'financeiro':
      return 'FINANCEIRO';
    case 'ESTOQUE':
    case 'tecnico':
      return 'ESTOQUE';
    case 'CONSULTA':
    case 'visualizador':
    default:
      return 'CONSULTA';
  }
}

export type FinancialType = 'receita' | 'despesa';
export type FinancialStatus = 'pendente' | 'pago' | 'atrasado' | 'cancelado';
export type PaymentMethod = 'PIX' | 'Boleto' | 'Cartão' | 'Transferência' | 'Dinheiro' | 'Outro';

export type InvoiceType = 'NF-e' | 'NFS-e' | 'NFC-e';
export type InvoiceReceiptStatus = 'pendente' | 'recebida' | 'parcial' | 'cancelada';

export type BankTxType = 'credito' | 'debito';
export type ReconciliationStatus =
  | 'nao_conciliado'
  | 'conciliado_nf'
  | 'conciliado_parcial'
  | 'conciliado_financeiro'
  | 'sem_nf_localizada';

export type CustomerPersonType = 'PF' | 'PJ' | 'NAO_IDENTIFICADO';

export type InventoryCategory =
  | 'Equipamento Split/Inverter'
  | 'Equipamento Comercial/VRF'
  | 'Refrigeração Industrial'
  | 'Peças e Compressores'
  | 'Tubulação e Cobre'
  | 'Gás Refrigerante'
  | 'Insumos de Instalação';

export type InventoryUnit = 'un' | 'm' | 'kg' | 'l' | 'cx' | 'rl' | 'pc' | 'br' | 'kit';

export type StockMovementType = 'entrada' | 'saida';
export type StockMovementReason =
  | 'Compra'
  | 'Entrada de material'
  | 'Retirada para instalação'
  | 'Uso em manutenção'
  | 'Venda'
  | 'Devolução'
  | 'Ajuste de inventário'
  | 'Perda ou avaria'
  | 'Instalação'
  | 'Manutenção'
  | 'Ajuste';

export type AuditAction =
  | 'criar'
  | 'editar'
  | 'excluir'
  | 'importar'
  | 'conciliar'
  | 'movimentar'
  | 'permissao'
  | 'configurar'
  | 'storage';

export type AuditResult = 'sucesso' | 'bloqueado' | 'erro';

export type AuditOrigin =
  | 'Interface Web'
  | 'Importação de Planilha'
  | 'Importação Fiscal/Bancária'
  | 'Conciliação Bancária'
  | 'Assistente de IA'
  | 'Storage'
  | 'Administração';

export type TaxRegime = 'Simples Nacional' | 'Lucro Presumido' | 'Lucro Real' | 'MEI';

export type StorageFolder = 'fiscal' | 'financeiro' | 'conciliacao' | 'estoque' | 'relatorios';

export const FIELD_LIMITS = {
  userName: 120,
  userEmail: 160,
  department: 80,
  razaoSocial: 180,
  nomeFantasia: 140,
  cnpj: 20,
  inscricaoEstadual: 30,
  telefone: 30,
  endereco: 250,
  serieNf: 10,
  descricaoFinanceira: 200,
  categoria: 80,
  contraparte: 160,
  observacoes: 500,
  numeroNf: 40,
  chaveAcesso: 60,
  clienteNome: 160,
  clienteDocumento: 24,
  documentoLimpo: 20,
  descricaoServicos: 300,
  itensResumo: 600,
  banco: 100,
  conta: 50,
  fitId: 120,
  descricaoBanco: 220,
  nomePagador: 160,
  cpfCnpjPagador: 24,
  documentoBancario: 80,
  origemArquivo: 120,
  sku: 50,
  produtoNome: 160,
  marca: 80,
  modelo: 80,
  capacidade: 60,
  localizacao: 80,
  responsavel: 120,
  documentoReferencia: 80,
  observacoesMovimento: 300,
  observacoesProduto: 500,
  auditResumo: 300,
  auditOrigem: 60,
  auditDados: 400,
  fileName: 200,
  storagePath: 360,
  downloadUrl: 1000,
  reportTitle: 140,
  justificativa: 400,
  grupoId: 80,
  aiTitle: 120,
  aiPreview: 200,
  aiMessageText: 8000,
  aiActionSummary: 300,
} as const;

export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface UserAccount {
  id: string;
  uid: string;
  name: string;
  email: string;
  activeCompanyId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserCompanyMembership {
  id: string;
  companyId: string;
  companyName: string;
  uid: string;
  role: UserRole;
  active: boolean;
  updatedAt?: unknown;
}

export interface Company {
  id: string;
  companyId: string;
  ownerId: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj?: string;
  inscricaoEstadual?: string;
  telefone?: string;
  email?: string;
  endereco?: string;
  regimeTributario: TaxRegime;
  diasToleranciaConciliacao: number;
  serieNfPadrao: string;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CompanySettings = Company;

export interface CompanyMember {
  id: string;
  companyId: string;
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  department?: string;
  active: boolean;
  permissions: MenuSection[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type UserProfile = CompanyMember;

export interface CompanyInvite {
  id: string;
  companyId: string;
  companyName: string;
  email: string;
  name: string;
  department?: string;
  role: UserRole;
  status: 'pendente' | 'aceito' | 'cancelado';
  invitedByUid: string;
  invitedByEmail: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Customer {
  id: string;
  companyId: string;
  ownerId: string;
  nome: string;
  documento?: string;
  documentoLimpo?: string;
  tipoPessoa: CustomerPersonType;
  documentoNaoInformado?: boolean;
  email?: string;
  telefone?: string;
  observacoes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface FinancialTransaction {
  id: string;
  companyId: string;
  ownerId: string;
  tipo: FinancialType;
  descricao: string;
  categoria: string;
  contraparte: string;
  clienteDocumento?: string;
  customerId?: string;
  valor: number;
  dataVencimento: string;
  dataPagamento?: string;
  formaPagamento: PaymentMethod;
  status: FinancialStatus;
  invoiceId?: string;
  invoiceNumber?: string;
  bankTransactionId?: string;
  reconciled: boolean;
  observacoes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Invoice {
  id: string;
  companyId: string;
  ownerId: string;
  numero: string;
  serie: string;
  chaveAcesso?: string;
  tipo: InvoiceType;
  tipoOperacao?: 'saida';
  clienteNome: string;
  clienteDocumento?: string;
  customerId?: string;
  valor: number;
  dataEmissao: string;
  dataVencimento?: string;
  statusRecebimento: InvoiceReceiptStatus;
  valorRecebido: number;
  origemImportacao: 'xml' | 'excel' | 'csv' | 'pdf' | 'manual';
  itensResumo?: string;
  descricaoServicos?: string;
  storagePath?: string;
  downloadUrl?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BankTransaction {
  id: string;
  companyId: string;
  ownerId: string;
  banco: string;
  conta?: string;
  fitId?: string;
  documentoBancario?: string;
  nomePagador?: string;
  cpfCnpjPagador?: string;
  customerId?: string;
  tipo: BankTxType;
  descricao: string;
  valor: number;
  dataMovimento: string;
  statusConciliacao: ReconciliationStatus;
  valorConciliado?: number;
  invoiceId?: string;
  invoiceNumber?: string;
  financialTransactionId?: string;
  origemArquivo?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type ReconciliationConfidence = 'alta' | 'media' | 'baixa' | 'manual';
export type ReconciliationDecisionOrigin = 'manual' | 'ia_confirmada' | 'ia_rejeitada';
export type ReconciliationRecordTipo = 'nf' | 'financeiro' | 'sem_nf' | 'agrupado' | 'parcelado' | 'rejeitado';

export interface ReconciliationRecord {
  id: string;
  companyId: string;
  ownerId: string;
  bankTransactionId: string;
  bankDescricao: string;
  bankValor: number;
  bankData: string;
  invoiceId?: string;
  invoiceNumber?: string;
  financialTransactionId?: string;
  tipo: ReconciliationRecordTipo;
  valorConciliado: number;
  diferencaValor?: number;
  confianca?: ReconciliationConfidence;
  justificativa?: string;
  origemDecisao?: ReconciliationDecisionOrigin;
  grupoId?: string;
  observacoes?: string;
  createdAt?: unknown;
}

export interface InventoryProduct {
  id: string;
  companyId: string;
  ownerId: string;
  sku: string;
  nome: string;
  categoria: InventoryCategory;
  marca?: string;
  modelo?: string;
  capacidade?: string;
  unidade: InventoryUnit;
  quantidade: number;
  estoqueMinimo: number;
  custoUnitario: number;
  precoVenda: number;
  localizacao?: string;
  observacoes?: string;
  origemImportacao?: 'manual' | 'planilha';
  arquivoImportacao?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StockMovement {
  id: string;
  companyId: string;
  ownerId: string;
  productId: string;
  productName: string;
  productSku: string;
  tipo: StockMovementType;
  motivo: StockMovementReason;
  quantidade: number;
  saldoAnterior: number;
  saldoAtual: number;
  custoUnitario: number;
  responsavel: string;
  documentoReferencia?: string;
  dataMovimentacao: string;
  observacoes?: string;
  idempotencyKey?: string;
  createdAt?: unknown;
}

export interface SavedReport {
  id: string;
  companyId: string;
  ownerId: string;
  titulo: string;
  tipo: 'financeiro' | 'notas_fiscais' | 'estoque' | 'conciliacao' | 'geral';
  periodoInicio?: string;
  periodoFim?: string;
  totalRegistros: number;
  valorResumo: number;
  fileName?: string;
  storagePath?: string;
  downloadUrl?: string;
  createdByName: string;
  createdAt?: unknown;
}

export interface CompanyDocument {
  id: string;
  companyId: string;
  ownerId: string;
  nome: string;
  pasta: StorageFolder;
  contentType: string;
  tamanhoBytes: number;
  storagePath: string;
  downloadUrl: string;
  entidadeReferenciaId?: string;
  uploadedByName: string;
  createdAt?: unknown;
}

export interface AuditLog {
  id: string;
  companyId: string;
  ownerId: string;
  userEmail: string;
  userName: string;
  modulo: string;
  acao: AuditAction;
  entidadeId?: string;
  resumo: string;
  origem?: string;
  resultado?: AuditResult;
  dadosAnteriores?: string;
  dadosPosteriores?: string;
  createdAt?: unknown;
}

export type AiActionType =
  | 'none'
  | 'stock_movement_preview'
  | 'report_preview'
  | 'stock_movement_confirmed'
  | 'report_saved';

export interface AiConversation {
  id: string;
  companyId: string;
  ownerId: string;
  title: string;
  lastMessagePreview?: string;
  messageCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AiChatMessage {
  id: string;
  companyId: string;
  conversationId: string;
  ownerId: string;
  role: 'user' | 'model';
  text: string;
  actionType?: AiActionType;
  actionSummary?: string;
  createdAt?: unknown;
}

export const INVENTORY_CATEGORIES: InventoryCategory[] = [
  'Equipamento Split/Inverter',
  'Equipamento Comercial/VRF',
  'Refrigeração Industrial',
  'Peças e Compressores',
  'Tubulação e Cobre',
  'Gás Refrigerante',
  'Insumos de Instalação',
];

export const INVENTORY_UNITS: { value: InventoryUnit; label: string; shortLabel: string }[] = [
  { value: 'un', label: 'Unidade (un)', shortLabel: 'un' },
  { value: 'm', label: 'Metro (m)', shortLabel: 'm' },
  { value: 'kg', label: 'Quilograma (kg)', shortLabel: 'kg' },
  { value: 'l', label: 'Litro (L)', shortLabel: 'L' },
  { value: 'cx', label: 'Caixa (cx)', shortLabel: 'cx' },
  { value: 'rl', label: 'Rolo (rl)', shortLabel: 'rl' },
  { value: 'pc', label: 'Peça (pç)', shortLabel: 'pç' },
  { value: 'br', label: 'Barra (br)', shortLabel: 'br' },
  { value: 'kit', label: 'Kit (kit)', shortLabel: 'kit' },
];

export const STOCK_MOVEMENT_REASONS_ENTRADA: StockMovementReason[] = [
  'Compra',
  'Entrada de material',
  'Devolução',
  'Ajuste de inventário',
];

export const STOCK_MOVEMENT_REASONS_SAIDA: StockMovementReason[] = [
  'Retirada para instalação',
  'Uso em manutenção',
  'Venda',
  'Ajuste de inventário',
  'Perda ou avaria',
];

export const ALL_STOCK_MOVEMENT_REASONS: StockMovementReason[] = [
  'Compra',
  'Entrada de material',
  'Retirada para instalação',
  'Uso em manutenção',
  'Venda',
  'Devolução',
  'Ajuste de inventário',
  'Perda ou avaria',
];

export const FINANCIAL_CATEGORIES_RECEITA = [
  'Instalação de Ar-Condicionado',
  'Manutenção Preventiva / PMOC',
  'Manutenção Corretiva',
  'Venda de Equipamentos',
  'Venda de Peças e Insumos',
  'Projeto de Climatização / Refrigeração',
  'Outros Recebimentos',
];

export const FINANCIAL_CATEGORIES_DESPESA = [
  'Compra de Equipamentos',
  'Peças e Insumos (Cobre/Gás)',
  'Folha de Pagamento e Técnicos',
  'Combustível e Frota',
  'Impostos e Tributos',
  'Aluguel e Energia',
  'Ferramentas e EPIs',
  'Despesas Administrativas',
];

export const ALL_MENU_SECTIONS: { id: MenuSection; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'ai-assistant', label: 'Assistente de IA' },
  { id: 'financial', label: 'Financeiro' },
  { id: 'invoices', label: 'Notas Fiscais' },
  { id: 'reconciliation', label: 'Conciliação Bancária' },
  { id: 'inventory', label: 'Estoque' },
  { id: 'inventory-movements', label: 'Movimentações de Estoque' },
  { id: 'reports', label: 'Relatórios' },
  { id: 'audit-logs', label: 'Histórico de Operações' },
  { id: 'users', label: 'Usuários e Permissões' },
  { id: 'settings', label: 'Configurações' },
];

export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, MenuSection[]> = {
  ADMINISTRADOR: ALL_MENU_SECTIONS.map((s) => s.id),
  FINANCEIRO: [
    'dashboard',
    'ai-assistant',
    'financial',
    'invoices',
    'reconciliation',
    'reports',
    'audit-logs',
  ],
  ESTOQUE: [
    'dashboard',
    'ai-assistant',
    'inventory',
    'inventory-movements',
    'reports',
  ],
  CONSULTA: [
    'dashboard',
    'financial',
    'invoices',
    'reconciliation',
    'inventory',
    'inventory-movements',
    'reports',
  ],
};

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMINISTRADOR: 'Administrador',
  FINANCEIRO: 'Financeiro',
  ESTOQUE: 'Estoque',
  CONSULTA: 'Consulta (Somente Leitura)',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  ADMINISTRADOR: 'Acesso completo a todos os módulos, empresas, usuários, permissões e configurações.',
  FINANCEIRO: 'Acesso completo ao financeiro, notas fiscais, conciliação bancária, relatórios e documentos fiscais.',
  ESTOQUE: 'Acesso completo ao catálogo de produtos, saldos e movimentações de entrada e saída.',
  CONSULTA: 'Acesso estritamente somente leitura para consulta de indicadores, listas e relatórios.',
};

export function canEditSection(role: UserRole | undefined | null, section: MenuSection): boolean {
  if (!role || role === 'CONSULTA') return false;
  if (role === 'ADMINISTRADOR') return true;
  if (role === 'FINANCEIRO') {
    return section === 'financial' || section === 'invoices' || section === 'reconciliation' || section === 'reports';
  }
  if (role === 'ESTOQUE') {
    return section === 'inventory' || section === 'inventory-movements';
  }
  return false;
}
