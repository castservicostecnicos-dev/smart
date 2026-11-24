import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Edit3,
  FileCode2,
  FileUp,
  FilterX,
  Landmark,
  Link2,
  Plus,
  Search,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import {
  FINANCIAL_CATEGORIES_DESPESA,
  FINANCIAL_CATEGORIES_RECEITA,
  FIELD_LIMITS,
  type BankTransaction,
  type Customer,
  type FinancialStatus,
  type FinancialTransaction,
  type FinancialType,
  type Invoice,
  type PaymentMethod,
} from '../types/erp';
import {
  createFinancialTransaction,
  deleteFinancialTransaction,
  reconcileBankWithInvoice,
  updateFinancialTransaction,
  type FinancialInput,
} from '../services/erpService';
import { digitsOnly, formatCpfCnpj, scoreInvoiceCandidate } from '../utils/financeDocuments';
import { formatBRL, formatDateBR, todayISO } from '../utils/formatters';
import { BankStatementImportModal } from '../components/finance/BankStatementImportModal';
import { CustomerBasePanel } from '../components/finance/CustomerBasePanel';
import { OutboundInvoiceImportModal } from '../components/finance/OutboundInvoiceImportModal';
import { ConfirmDialog, EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';

interface FinancialModuleProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  loading: boolean;
  transactions: FinancialTransaction[];
  invoices: Invoice[];
  customers?: Customer[];
  bankTransactions?: BankTransaction[];
  toleranceDays?: number;
  defaultSerie?: string;
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const INITIAL_FORM: FinancialInput = {
  tipo: 'receita',
  descricao: '',
  categoria: FINANCIAL_CATEGORIES_RECEITA[0],
  contraparte: '',
  clienteDocumento: '',
  customerId: '',
  valor: 0,
  dataVencimento: todayISO(),
  dataPagamento: '',
  formaPagamento: 'PIX',
  status: 'pendente',
  invoiceId: '',
  invoiceNumber: '',
  bankTransactionId: '',
  reconciled: false,
  observacoes: '',
};

const STATUS_LABELS: Record<FinancialStatus, { label: string; color: string }> = {
  pendente: { label: 'Pendente', color: 'text-amber-700' },
  pago: { label: 'Liquidado', color: 'text-emerald-700' },
  atrasado: { label: 'Em Atraso', color: 'text-red-700' },
  cancelado: { label: 'Cancelado', color: 'text-slate-500' },
};

type FinancialTab = 'lancamentos' | 'documentos' | 'clientes';

export const FinancialModule: React.FC<FinancialModuleProps> = ({
  user,
  companyId,
  canEdit,
  loading,
  transactions,
  invoices,
  customers = [],
  bankTransactions = [],
  toleranceDays = 5,
  defaultSerie = '1',
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<FinancialTab>('lancamentos');

  const [search, setSearch] = useState('');
  const [filterCliente, setFilterCliente] = useState('');
  const [filterDataInicio, setFilterDataInicio] = useState('');
  const [filterDataFim, setFilterDataFim] = useState('');
  const [filterValorMin, setFilterValorMin] = useState('');
  const [filterValorMax, setFilterValorMax] = useState('');
  const [filterType, setFilterType] = useState<'todos' | FinancialType>('todos');
  const [filterStatus, setFilterStatus] = useState<'todos' | FinancialStatus>('todos');
  const [sortBy, setSortBy] = useState<'data_desc' | 'data_asc' | 'valor_desc' | 'valor_asc'>('data_desc');

  const [importBankOpen, setImportBankOpen] = useState(false);
  const [importInvoiceOpen, setImportInvoiceOpen] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FinancialInput>(INITIAL_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<FinancialTransaction | null>(null);

  // Conciliação direta na aba Documentos (Notas de Saída x Extratos)
  const [quickLinkBank, setQuickLinkBank] = useState<BankTransaction | null>(null);
  const [quickSelectedInvId, setQuickSelectedInvId] = useState('');

  const hasActiveFilters = Boolean(
    search ||
      filterCliente ||
      filterDataInicio ||
      filterDataFim ||
      filterValorMin ||
      filterValorMax ||
      filterType !== 'todos' ||
      filterStatus !== 'todos'
  );

  const clearFilters = () => {
    setSearch('');
    setFilterCliente('');
    setFilterDataInicio('');
    setFilterDataFim('');
    setFilterValorMin('');
    setFilterValorMax('');
    setFilterType('todos');
    setFilterStatus('todos');
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qc = filterCliente.trim().toLowerCase();
    const qcDigits = digitsOnly(filterCliente);
    const minVal = filterValorMin ? Number(filterValorMin) : null;
    const maxVal = filterValorMax ? Number(filterValorMax) : null;

    return transactions
      .filter((t) => {
        if (filterType !== 'todos' && t.tipo !== filterType) return false;
        if (filterStatus !== 'todos' && t.status !== filterStatus) return false;
        if (filterDataInicio && t.dataVencimento < filterDataInicio) return false;
        if (filterDataFim && t.dataVencimento > filterDataFim) return false;
        if (minVal !== null && Number.isFinite(minVal) && t.valor < minVal) return false;
        if (maxVal !== null && Number.isFinite(maxVal) && t.valor > maxVal) return false;
        if (qc) {
          const clientHay = `${t.contraparte} ${t.clienteDocumento ?? ''}`.toLowerCase();
          const docMatch = qcDigits.length >= 3 && digitsOnly(t.clienteDocumento).includes(qcDigits);
          if (!clientHay.includes(qc) && !docMatch) return false;
        }
        if (q) {
          const hay = `${t.descricao} ${t.contraparte} ${t.clienteDocumento ?? ''} ${t.categoria} ${t.invoiceNumber ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'data_desc') return b.dataVencimento.localeCompare(a.dataVencimento);
        if (sortBy === 'data_asc') return a.dataVencimento.localeCompare(b.dataVencimento);
        if (sortBy === 'valor_desc') return b.valor - a.valor;
        return a.valor - b.valor;
      });
  }, [
    transactions,
    search,
    filterCliente,
    filterDataInicio,
    filterDataFim,
    filterValorMin,
    filterValorMax,
    filterType,
    filterStatus,
    sortBy,
  ]);

  const totals = useMemo(() => {
    const receitasPagas = transactions
      .filter((t) => t.tipo === 'receita' && t.status === 'pago')
      .reduce((s, t) => s + t.valor, 0);
    const receitasPendentes = transactions
      .filter((t) => t.tipo === 'receita' && (t.status === 'pendente' || t.status === 'atrasado'))
      .reduce((s, t) => s + t.valor, 0);
    const despesasTotal = transactions
      .filter((t) => t.tipo === 'despesa' && t.status !== 'cancelado')
      .reduce((s, t) => s + t.valor, 0);
    return { receitasPagas, receitasPendentes, despesasTotal };
  }, [transactions]);

  const crossMatchSummary = useMemo(() => {
    const creditosSemNf = bankTransactions.filter(
      (b) => b.tipo === 'credito' && b.statusConciliacao !== 'conciliado_nf'
    );
    const nfsPendentes = invoices.filter(
      (i) => i.statusRecebimento === 'pendente' || i.statusRecebimento === 'parcial'
    );
    const valorCreditosSemNf = creditosSemNf.reduce((s, b) => s + b.valor, 0);
    const valorNfsPendentes = nfsPendentes.reduce(
      (s, i) => s + Math.max(0, i.valor - i.valorRecebido),
      0
    );
    return {
      creditosSemNf,
      nfsPendentes,
      valorCreditosSemNf,
      valorNfsPendentes,
    };
  }, [bankTransactions, invoices]);

  const quickCandidates = useMemo(() => {
    if (!quickLinkBank) return [];
    return invoices
      .filter((inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida')
      .map((inv) => scoreInvoiceCandidate(quickLinkBank, inv, toleranceDays))
      .sort((a, b) => b.score - a.score || a.diffValor - b.diffValor);
  }, [quickLinkBank, invoices, toleranceDays]);

  const selectedQuickCandidate = useMemo(
    () => quickCandidates.find((c) => c.inv.id === quickSelectedInvId) ?? null,
    [quickCandidates, quickSelectedInvId]
  );

  const openCreate = (tipo: FinancialType = 'receita') => {
    if (!canEdit) return;
    setEditingId(null);
    setForm({
      ...INITIAL_FORM,
      tipo,
      categoria: tipo === 'receita' ? FINANCIAL_CATEGORIES_RECEITA[0] : FINANCIAL_CATEGORIES_DESPESA[0],
      dataVencimento: todayISO(),
    });
    setFormErrors({});
    setModalOpen(true);
  };

  const openEdit = (tx: FinancialTransaction) => {
    if (!canEdit) return;
    setEditingId(tx.id);
    setForm({
      tipo: tx.tipo,
      descricao: tx.descricao,
      categoria: tx.categoria,
      contraparte: tx.contraparte,
      clienteDocumento: tx.clienteDocumento ?? '',
      customerId: tx.customerId ?? '',
      valor: tx.valor,
      dataVencimento: tx.dataVencimento,
      dataPagamento: tx.dataPagamento ?? '',
      formaPagamento: tx.formaPagamento,
      status: tx.status,
      invoiceId: tx.invoiceId ?? '',
      invoiceNumber: tx.invoiceNumber ?? '',
      bankTransactionId: tx.bankTransactionId ?? '',
      reconciled: tx.reconciled,
      observacoes: tx.observacoes ?? '',
    });
    setFormErrors({});
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!form.descricao.trim()) errors.descricao = 'Informe a descrição do lançamento.';
    if (!form.contraparte.trim()) {
      errors.contraparte = form.tipo === 'receita' ? 'Informe o cliente.' : 'Informe o fornecedor.';
    }
    if (!Number.isFinite(form.valor) || form.valor <= 0) {
      errors.valor = 'Informe um valor maior que R$ 0,00.';
    }
    if (!form.dataVencimento) errors.dataVencimento = 'Informe a data de vencimento.';
    if (form.status === 'pago' && !form.dataPagamento) {
      errors.dataPagamento = 'Informe a data em que foi liquidado.';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !validate() || saving) return;

    setSaving(true);
    try {
      const selectedInvoice = invoices.find((i) => i.id === form.invoiceId);
      const payload: FinancialInput = {
        ...form,
        clienteDocumento: form.clienteDocumento ? formatCpfCnpj(form.clienteDocumento) : '',
        invoiceNumber: selectedInvoice ? selectedInvoice.numero : form.invoiceNumber,
      };
      if (editingId) {
        await updateFinancialTransaction(user, companyId, editingId, payload);
        onNotify('success', 'Lançamento financeiro atualizado com sucesso.');
      } else {
        await createFinancialTransaction(user, companyId, payload);
        onNotify('success', 'Lançamento financeiro cadastrado com sucesso.');
      }
      setModalOpen(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar lançamento financeiro.');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkPaid = async (tx: FinancialTransaction) => {
    if (!canEdit) return;
    try {
      await updateFinancialTransaction(user, companyId, tx.id, {
        status: 'pago',
        dataPagamento: todayISO(),
      });
      onNotify('success', `${tx.tipo === 'receita' ? 'Recebimento' : 'Pagamento'} confirmado.`);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao atualizar status.');
    }
  };

  const handleDelete = async () => {
    if (!canEdit || !deleteTarget) return;
    setSaving(true);
    try {
      await deleteFinancialTransaction(user, companyId, deleteTarget.id, deleteTarget.descricao);
      onNotify('success', 'Lançamento removido do financeiro.');
      setDeleteTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao excluir lançamento.');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmQuickReconcile = async () => {
    if (!canEdit || !quickLinkBank || !quickSelectedInvId || saving) return;
    const inv = invoices.find((i) => i.id === quickSelectedInvId);
    if (!inv) return;
    setSaving(true);
    try {
      await reconcileBankWithInvoice(user, companyId, quickLinkBank, inv, {
        createFinancialReceipt: true,
      });
      onNotify(
        'success',
        `Recebimento de ${formatBRL(quickLinkBank.valor)} conciliado com ${inv.tipo} ${inv.numero} e registrado no Financeiro.`
      );
      setQuickLinkBank(null);
      setQuickSelectedInvId('');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao conciliar recebimento.');
    } finally {
      setSaving(false);
    }
  };

  const categoryOptions =
    form.tipo === 'receita' ? FINANCIAL_CATEGORIES_RECEITA : FINANCIAL_CATEGORIES_DESPESA;

  return (
    <div className="space-y-6">
      {/* Barra de Sub-navegação Financeira */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('lancamentos')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              activeTab === 'lancamentos'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Wallet className="w-4 h-4" />
            Lançamentos ({transactions.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('documentos')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              activeTab === 'documentos'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Landmark className="w-4 h-4" />
            Notas de Saída x Extratos ({crossMatchSummary.creditosSemNf.length} pend.)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('clientes')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              activeTab === 'clientes'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Users className="w-4 h-4" />
            Base de Clientes ({customers.length})
          </button>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setImportBankOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              Importar Extrato
            </button>
            <button
              type="button"
              onClick={() => setImportInvoiceOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer"
            >
              <FileCode2 className="w-3.5 h-3.5" />
              Importar NF de Saída
            </button>
          </div>
        )}
      </div>

      {activeTab === 'clientes' ? (
        <CustomerBasePanel
          user={user}
          companyId={companyId}
          canEdit={canEdit}
          customers={customers}
          invoices={invoices}
          bankTransactions={bankTransactions}
          financials={transactions}
          onNotify={onNotify}
        />
      ) : activeTab === 'documentos' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Créditos Bancários sem NF</p>
              <p className="text-lg font-semibold text-red-700 font-mono tabular-nums mt-1">
                {crossMatchSummary.creditosSemNf.length} · {formatBRL(crossMatchSummary.valorCreditosSemNf)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">NFs de Saída em Aberto</p>
              <p className="text-lg font-semibold text-amber-700 font-mono tabular-nums mt-1">
                {crossMatchSummary.nfsPendentes.length} · {formatBRL(crossMatchSummary.valorNfsPendentes)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Total de NFs de Saída</p>
              <p className="text-lg font-semibold text-blue-700 font-mono tabular-nums mt-1">
                {invoices.length} documentos
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Clientes na Base (CPF/CNPJ)</p>
              <p className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-1">
                {customers.length} cadastros
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Créditos Bancários Pendentes de Vínculo ({crossMatchSummary.creditosSemNf.length})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Recebimentos identificados em extratos aguardando correspondência com NF de saída.
                  </p>
                </div>
              </div>
              {crossMatchSummary.creditosSemNf.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  Nenhum crédito bancário pendente de conciliação.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {crossMatchSummary.creditosSemNf.map((tx) => (
                    <div key={tx.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-mono text-slate-500">
                          {formatDateBR(tx.dataMovimento)} · {tx.banco}
                        </p>
                        <p className="text-sm font-medium text-slate-900 truncate">{tx.descricao}</p>
                        {(tx.nomePagador || tx.cpfCnpjPagador) && (
                          <p className="text-xs text-slate-600">
                            {tx.nomePagador} {tx.cpfCnpjPagador ? `(${tx.cpfCnpjPagador})` : ''}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        <p className="text-sm font-mono font-semibold text-emerald-700">
                          + {formatBRL(tx.valor)}
                        </p>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setQuickLinkBank(tx);
                              setQuickSelectedInvId('');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                          >
                            <Link2 className="w-3 h-3" />
                            Relacionar NF
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  Notas Fiscais de Saída Aguardando Recebimento ({crossMatchSummary.nfsPendentes.length})
                </h3>
                <p className="text-xs text-slate-500">
                  Notas de saída importadas ou cadastradas com saldo pendente ou parcial.
                </p>
              </div>
              {crossMatchSummary.nfsPendentes.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  Nenhuma nota fiscal de saída pendente de recebimento.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {crossMatchSummary.nfsPendentes.map((inv) => (
                    <div key={inv.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-mono text-slate-500">
                          {inv.tipo} {inv.numero} · Emissão {formatDateBR(inv.dataEmissao)}
                          {inv.dataVencimento ? ` · Venc. ${formatDateBR(inv.dataVencimento)}` : ''}
                        </p>
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {inv.clienteNome}
                        </p>
                        {inv.clienteDocumento && (
                          <p className="text-xs font-mono text-slate-500">{inv.clienteDocumento}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono font-semibold text-amber-700">
                          {formatBRL(Math.max(0, inv.valor - inv.valorRecebido))}
                        </p>
                        {inv.valorRecebido > 0 && (
                          <p className="text-[11px] text-slate-500 font-mono">
                            Total {formatBRL(inv.valor)}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Recebimentos Liquidados</p>
              <p className="text-xl font-semibold text-emerald-700 font-mono tabular-nums mt-1.5">
                {formatBRL(totals.receitasPagas)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Recebimentos em Aberto</p>
              <p className="text-xl font-semibold text-amber-700 font-mono tabular-nums mt-1.5">
                {formatBRL(totals.receitasPendentes)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Total de Despesas</p>
              <p className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
                {formatBRL(totals.despesasTotal)}
              </p>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 flex-1">
                <div className="relative flex-1 min-w-[200px] max-w-xs">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Pesquisar descrição, categoria, NF..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                <input
                  type="text"
                  value={filterCliente}
                  onChange={(e) => setFilterCliente(e.target.value)}
                  placeholder="Cliente / Fornecedor / CPF-CNPJ..."
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg min-w-[180px]"
                />

                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value as 'todos' | FinancialType)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  aria-label="Filtrar por tipo"
                >
                  <option value="todos">Todos os tipos</option>
                  <option value="receita">Recebimentos</option>
                  <option value="despesa">Despesas</option>
                </select>

                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as 'todos' | FinancialStatus)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  aria-label="Filtrar por status"
                >
                  <option value="todos">Todas as situações</option>
                  <option value="pendente">Pendente</option>
                  <option value="pago">Liquidado</option>
                  <option value="atrasado">Em Atraso</option>
                  <option value="cancelado">Cancelado</option>
                </select>
              </div>

              {canEdit && (
                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openCreate('despesa')}
                    className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Nova Despesa
                  </button>
                  <button
                    type="button"
                    onClick={() => openCreate('receita')}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Novo Recebimento
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <span>Vencimento de:</span>
                <input
                  type="date"
                  value={filterDataInicio}
                  onChange={(e) => setFilterDataInicio(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
                <span>até</span>
                <input
                  type="date"
                  value={filterDataFim}
                  onChange={(e) => setFilterDataFim(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <span>Valor (R$):</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={filterValorMin}
                  onChange={(e) => setFilterValorMin(e.target.value)}
                  placeholder="Mín."
                  className="w-24 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                />
                <span>–</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={filterValorMax}
                  onChange={(e) => setFilterValorMax(e.target.value)}
                  placeholder="Máx."
                  className="w-24 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                />
              </div>

              <button
                type="button"
                onClick={() =>
                  setSortBy((prev) =>
                    prev === 'data_desc'
                      ? 'data_asc'
                      : prev === 'data_asc'
                        ? 'valor_desc'
                        : prev === 'valor_desc'
                          ? 'valor_asc'
                          : 'data_desc'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {sortBy === 'data_desc' && 'Mais recentes'}
                {sortBy === 'data_asc' && 'Mais antigos'}
                {sortBy === 'valor_desc' && 'Maior valor'}
                {sortBy === 'valor_asc' && 'Menor valor'}
              </button>

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
                >
                  <FilterX className="w-3.5 h-3.5" />
                  Limpar filtros
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <SkeletonTable rows={6} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Wallet className="w-6 h-6" />}
              title={
                transactions.length === 0
                  ? 'Nenhum lançamento financeiro cadastrado'
                  : 'Nenhum lançamento corresponde aos filtros'
              }
              description={
                transactions.length === 0
                  ? 'Registre recebimentos, despesas ou importe extratos bancários e notas fiscais de saída.'
                  : 'Ajuste os termos de pesquisa ou limpe os filtros selecionados.'
              }
              actionLabel={canEdit && transactions.length === 0 ? 'Cadastrar Primeiro Recebimento' : undefined}
              onAction={canEdit && transactions.length === 0 ? () => openCreate('receita') : undefined}
            />
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <tr>
                      <th className="text-left font-medium px-5 py-3">Vencimento</th>
                      <th className="text-left font-medium px-4 py-3">Tipo</th>
                      <th className="text-left font-medium px-4 py-3">Descrição / Cliente ou Fornecedor</th>
                      <th className="text-left font-medium px-4 py-3">Pagamento</th>
                      <th className="text-left font-medium px-4 py-3">Status</th>
                      <th className="text-right font-medium px-4 py-3">Valor</th>
                      {canEdit && <th className="text-right font-medium px-5 py-3">Ações</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((tx) => {
                      const st = STATUS_LABELS[tx.status];
                      return (
                        <tr key={tx.id} className="hover:bg-slate-50/70">
                          <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                            {formatDateBR(tx.dataVencimento)}
                          </td>
                          <td className="px-4 py-3 text-xs font-medium whitespace-nowrap">
                            <span className={tx.tipo === 'receita' ? 'text-blue-700' : 'text-slate-700'}>
                              {tx.tipo === 'receita' ? 'Recebimento' : 'Despesa'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-slate-900">{tx.descricao}</p>
                            <p className="text-xs text-slate-500">
                              {tx.contraparte}
                              {tx.clienteDocumento ? ` (${tx.clienteDocumento})` : ''}
                              {' · '}
                              {tx.categoria}
                              {tx.invoiceNumber ? ` · NF ${tx.invoiceNumber}` : ''}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                            {tx.formaPagamento}
                            {tx.dataPagamento ? ` · Pago em ${formatDateBR(tx.dataPagamento)}` : ''}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">
                            <span className={st.color}>{st.label}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap text-slate-900">
                            {tx.tipo === 'despesa' ? '- ' : ''}
                            {formatBRL(tx.valor)}
                          </td>
                          {canEdit && (
                            <td className="px-5 py-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                {tx.status !== 'pago' && tx.status !== 'cancelado' && (
                                  <button
                                    type="button"
                                    onClick={() => void handleMarkPaid(tx)}
                                    title="Marcar como liquidado"
                                    className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors cursor-pointer"
                                  >
                                    <CheckCircle2 className="w-4 h-4" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => openEdit(tx)}
                                  title="Editar lançamento"
                                  className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                                >
                                  <Edit3 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(tx)}
                                  title="Excluir lançamento"
                                  className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <BankStatementImportModal
        open={importBankOpen}
        onClose={() => setImportBankOpen(false)}
        user={user}
        companyId={companyId}
        existingTransactions={bankTransactions}
        onNotify={onNotify}
      />

      <OutboundInvoiceImportModal
        open={importInvoiceOpen}
        onClose={() => setImportInvoiceOpen(false)}
        user={user}
        companyId={companyId}
        defaultSerie={defaultSerie}
        existingInvoices={invoices}
        customers={customers}
        onNotify={onNotify}
      />

      {/* Modal Conciliação Rápida na Aba Notas de Saída x Extratos */}
      <Modal
        open={Boolean(quickLinkBank)}
        title="Relacionar Recebimento Bancário com Nota Fiscal de Saída"
        subtitle={
          quickLinkBank
            ? `${formatDateBR(quickLinkBank.dataMovimento)} · ${quickLinkBank.descricao} · ${formatBRL(quickLinkBank.valor)}`
            : undefined
        }
        onClose={() => setQuickLinkBank(null)}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          {quickCandidates.length === 0 ? (
            <p className="text-sm text-slate-600">
              Não há notas fiscais de saída em aberto disponíveis. Importe as notas fiscais no botão "Importar NF de Saída".
            </p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {quickCandidates.map(
                ({ inv, diffValor, cpfCnpjMatch, invoiceNumberMentioned, nameSimilarWithoutDoc }) => (
                  <label
                    key={inv.id}
                    className={`flex items-start justify-between gap-3 p-3 border rounded-lg cursor-pointer ${
                      quickSelectedInvId === inv.id
                        ? 'border-blue-600 bg-blue-50/50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <input
                        type="radio"
                        name="quickInvoiceLink"
                        value={inv.id}
                        checked={quickSelectedInvId === inv.id}
                        onChange={() => setQuickSelectedInvId(inv.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-slate-900">
                          {inv.tipo} {inv.numero} — {inv.clienteNome}
                        </p>
                        <p className="text-xs text-slate-500">
                          Emissão: {formatDateBR(inv.dataEmissao)}
                          {inv.clienteDocumento ? ` · ${inv.clienteDocumento}` : ' · Sem CPF/CNPJ'}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {cpfCnpjMatch && (
                            <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                              CPF/CNPJ coincidente
                            </span>
                          )}
                          {invoiceNumberMentioned && (
                            <span className="text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded">
                              Nº da NF localizado
                            </span>
                          )}
                          {diffValor < 0.05 && (
                            <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                              Valor exato
                            </span>
                          )}
                          {nameSimilarWithoutDoc && (
                            <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                              Nome semelhante sem CPF/CNPJ — conferir antes de confirmar
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className="text-sm font-mono tabular-nums font-semibold text-slate-900 shrink-0">
                      {formatBRL(inv.valor)}
                    </span>
                  </label>
                )
              )}
            </div>
          )}

          {selectedQuickCandidate?.nameSimilarWithoutDoc && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2.5 text-xs text-amber-950">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>Atenção:</strong> nome semelhante sem confirmação por CPF/CNPJ coincidente. Confira os dados antes de confirmar a baixa.
              </span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setQuickLinkBank(null)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!quickSelectedInvId || saving}
              onClick={() => void handleConfirmQuickReconcile()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              {saving ? 'Conciliando...' : 'Confirmar e Baixar NF'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={modalOpen}
        title={editingId ? 'Editar Lançamento Financeiro' : 'Novo Lançamento Financeiro'}
        subtitle="Preencha os dados fiscais e financeiros obrigatórios."
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Tipo de Lançamento *
              </label>
              <select
                value={form.tipo}
                onChange={(e) => {
                  const newTipo = e.target.value as FinancialType;
                  setForm((prev) => ({
                    ...prev,
                    tipo: newTipo,
                    categoria:
                      newTipo === 'receita'
                        ? FINANCIAL_CATEGORIES_RECEITA[0]
                        : FINANCIAL_CATEGORIES_DESPESA[0],
                  }));
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="receita">Recebimento (Receita)</option>
                <option value="despesa">Despesa (Custo / Pagamento)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Categoria *
              </label>
              <select
                value={form.categoria}
                onChange={(e) => setForm({ ...form, categoria: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {categoryOptions.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {form.tipo === 'receita' && customers.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Selecionar da Base de Clientes (Opcional)
              </label>
              <select
                value={form.customerId ?? ''}
                onChange={(e) => {
                  const c = customers.find((item) => item.id === e.target.value);
                  if (c) {
                    setForm((prev) => ({
                      ...prev,
                      customerId: c.id,
                      contraparte: c.nome,
                      clienteDocumento: c.documento ?? '',
                    }));
                  } else {
                    setForm((prev) => ({ ...prev, customerId: '' }));
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">-- Selecionar cliente cadastrado ou informar manualmente --</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome} {c.documento ? `(${c.documento})` : '(Sem CPF/CNPJ)'}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Descrição *
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.descricaoFinanceira}
              value={form.descricao}
              onChange={(e) => setForm({ ...form, descricao: e.target.value })}
              placeholder="Ex.: Instalação Split Inverter 18.000 BTUs - Loja Centro"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            {formErrors.descricao && (
              <p className="text-xs text-red-600 mt-1">{formErrors.descricao}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {form.tipo === 'receita' ? 'Cliente *' : 'Fornecedor / Favorecido *'}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.contraparte}
                value={form.contraparte}
                onChange={(e) => setForm({ ...form, contraparte: e.target.value })}
                placeholder="Nome ou Razão Social"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {formErrors.contraparte && (
                <p className="text-xs text-red-600 mt-1">{formErrors.contraparte}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                CPF / CNPJ
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.clienteDocumento}
                value={form.clienteDocumento ?? ''}
                onChange={(e) => setForm({ ...form, clienteDocumento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Valor (R$) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.valor || ''}
                onChange={(e) => setForm({ ...form, valor: Number(e.target.value) })}
                placeholder="0,00"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {formErrors.valor && (
                <p className="text-xs text-red-600 mt-1">{formErrors.valor}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Data de Vencimento *
              </label>
              <input
                type="date"
                value={form.dataVencimento}
                onChange={(e) => setForm({ ...form, dataVencimento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {formErrors.dataVencimento && (
                <p className="text-xs text-red-600 mt-1">{formErrors.dataVencimento}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Status *
              </label>
              <select
                value={form.status}
                onChange={(e) => {
                  const nextStatus = e.target.value as FinancialStatus;
                  setForm((prev) => ({
                    ...prev,
                    status: nextStatus,
                    dataPagamento:
                      nextStatus === 'pago' && !prev.dataPagamento ? todayISO() : prev.dataPagamento,
                  }));
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="pendente">Pendente</option>
                <option value="pago">Liquidado (Pago / Recebido)</option>
                <option value="atrasado">Em Atraso</option>
                <option value="cancelado">Cancelado</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Forma de Pagamento *
              </label>
              <select
                value={form.formaPagamento}
                onChange={(e) => setForm({ ...form, formaPagamento: e.target.value as PaymentMethod })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="PIX">PIX</option>
                <option value="Boleto">Boleto</option>
                <option value="Cartão">Cartão</option>
                <option value="Transferência">Transferência</option>
                <option value="Dinheiro">Dinheiro</option>
                <option value="Outro">Outro</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Data da Liquidação {form.status === 'pago' ? '*' : '(Opcional)'}
              </label>
              <input
                type="date"
                value={form.dataPagamento ?? ''}
                onChange={(e) => setForm({ ...form, dataPagamento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {formErrors.dataPagamento && (
                <p className="text-xs text-red-600 mt-1">{formErrors.dataPagamento}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Vincular Nota Fiscal de Saída (Opcional)
              </label>
              <select
                value={form.invoiceId ?? ''}
                onChange={(e) => {
                  const inv = invoices.find((i) => i.id === e.target.value);
                  setForm({
                    ...form,
                    invoiceId: e.target.value,
                    invoiceNumber: inv ? inv.numero : '',
                  });
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Sem nota fiscal vinculada</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.tipo} {inv.numero} — {inv.clienteNome} ({formatBRL(inv.valor)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Observações
            </label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.observacoes}
              value={form.observacoes ?? ''}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : editingId ? 'Salvar Alterações' : 'Cadastrar Lançamento'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir lançamento financeiro"
        message={`Confirma a exclusão permanente de "${deleteTarget?.descricao}" no valor de ${formatBRL(deleteTarget?.valor)}?`}
        confirmLabel="Excluir"
        danger
        loading={saving}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
