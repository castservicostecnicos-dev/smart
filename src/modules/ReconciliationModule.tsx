import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  FilterX,
  History,
  Info,
  Landmark,
  Layers,
  Link2,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Split,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type BankTransaction,
  type BankTxType,
  type Customer,
  type Invoice,
  type ReconciliationRecord,
  type ReconciliationStatus,
} from '../types/erp';
import {
  deleteBankTransaction,
  importBankTransactionsBatch,
  markBankTxWithoutInvoice,
  reconcileBankWithInvoice,
  reconcileMultipleBankTxsToInvoice,
  rejectReconciliationSuggestion,
  splitBankTxAcrossInvoices,
} from '../services/erpService';
import { digitsOnly, formatCpfCnpj } from '../utils/financeDocuments';
import { formatBRL, formatDateBR, todayISO } from '../utils/formatters';
import { authorizedJsonFetch } from '../lib/apiClient';
import {
  buildReconciliationDiagnostics,
  evaluateMultiCriteriaMatch,
  exportReconciliationExcelWorkbook,
  getBankTxAvailableAmount,
  getInvoiceOpenAmount,
  type AiReconciliationSuggestion,
  type ReconciliationFilters,
} from '../utils/reconciliationEngine';
import { BankStatementImportModal } from '../components/finance/BankStatementImportModal';
import {
  GroupCreditsToInvoiceModal,
  SplitCreditAcrossInvoicesModal,
} from '../components/finance/ReconciliationSplitAndGroupModals';
import { ReconciliationReportsPanel } from '../components/finance/ReconciliationReportsPanel';
import { ConfirmDialog, EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';

interface ReconciliationModuleProps {
  user: User;
  companyId: string;
  companyName?: string;
  canEdit: boolean;
  loading: boolean;
  bankTransactions: BankTransaction[];
  invoices: Invoice[];
  reconciliations?: ReconciliationRecord[];
  customers?: Customer[];
  toleranceDays: number;
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

type WorkspaceTab = 'inteligente' | 'extratos' | 'relatorios' | 'historico';

const STATUS_LABELS: Record<ReconciliationStatus, { label: string; cls: string }> = {
  nao_conciliado: { label: 'Aguardando Conciliação', cls: 'text-amber-700' },
  conciliado_nf: { label: 'Conciliado com NF', cls: 'text-emerald-700' },
  conciliado_parcial: { label: 'Conciliado Parcialmente', cls: 'text-blue-700' },
  conciliado_financeiro: { label: 'Conciliado Financeiro', cls: 'text-blue-700' },
  sem_nf_localizada: { label: 'Sem NF Localizada (Pendência)', cls: 'text-red-700' },
};

const CONFIDENCE_LABELS: Record<'alta' | 'media' | 'baixa', { label: string; cls: string }> = {
  alta: { label: 'Confiança Alta', cls: 'text-emerald-700' },
  media: { label: 'Confiança Média — Revisar', cls: 'text-amber-700' },
  baixa: { label: 'Confiança Baixa — Revisão Obrigatória', cls: 'text-red-700' },
};

const SITUATION_CARDS: Array<{
  key: keyof ReturnType<typeof buildReconciliationDiagnostics>['situationCounts'];
  label: string;
  tone: string;
}> = [
  { key: 'nota_totalmente_recebida', label: 'NFs Totalmente Recebidas', tone: 'text-emerald-700' },
  { key: 'nota_parcialmente_recebida', label: 'NFs Parcialmente Recebidas', tone: 'text-blue-700' },
  { key: 'nota_sem_recebimento', label: 'NFs Sem Recebimento', tone: 'text-slate-700' },
  { key: 'recebimento_sem_nf', label: 'Receb. Sem NF (Pendência)', tone: 'text-red-700' },
  { key: 'recebimento_multiplas_candidatas', label: 'Receb. p/ Várias NFs', tone: 'text-amber-700' },
  { key: 'pagamento_parcelado', label: 'Pagamentos Parcelados', tone: 'text-blue-700' },
  { key: 'pagamento_agrupado', label: 'Pagamentos Agrupados', tone: 'text-indigo-700' },
  { key: 'possivel_duplicidade', label: 'Possíveis Duplicidades', tone: 'text-red-700' },
  { key: 'correspondencia_incerta_revisao', label: 'Revisão Humana Incerta', tone: 'text-amber-700' },
];

export const ReconciliationModule: React.FC<ReconciliationModuleProps> = ({
  user,
  companyId,
  companyName = 'Empresa',
  canEdit,
  loading,
  bankTransactions,
  invoices,
  reconciliations = [],
  customers = [],
  toleranceDays,
  onNotify,
}) => {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('inteligente');

  // Filtros do extrato e relatórios
  const [search, setSearch] = useState('');
  const [filterPagador, setFilterPagador] = useState('');
  const [filterDataInicio, setFilterDataInicio] = useState('');
  const [filterDataFim, setFilterDataFim] = useState('');
  const [filterValorMin, setFilterValorMin] = useState('');
  const [filterValorMax, setFilterValorMax] = useState('');
  const [filterStatus, setFilterStatus] = useState<'todos' | ReconciliationStatus>('todos');
  const [filterTipo, setFilterTipo] = useState<'todos' | BankTxType>('todos');

  const [reportFilters, setReportFilters] = useState<ReconciliationFilters>({
    dataInicio: '',
    dataFim: '',
    clienteOuPagador: '',
    banco: '',
    valorMin: '',
    valorMax: '',
  });

  // Modais e ações
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualModal, setManualModal] = useState(false);
  const [manualForm, setManualForm] = useState({
    banco: '',
    conta: '',
    tipo: 'credito' as BankTxType,
    descricao: '',
    nomePagador: '',
    cpfCnpjPagador: '',
    documentoBancario: '',
    valor: 0,
    dataMovimento: todayISO(),
  });
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({});

  const [linkTarget, setLinkTarget] = useState<BankTransaction | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [createFinReceipt, setCreateFinReceipt] = useState(true);
  const [splitTarget, setSplitTarget] = useState<BankTransaction | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupPreselectedCreditIds, setGroupPreselectedCreditIds] = useState<string[]>([]);
  const [groupPreselectedInvoiceId, setGroupPreselectedInvoiceId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BankTransaction | null>(null);

  // IA Gemini
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiReconciliationSuggestion[]>([]);
  const [aiAnalyzedOnce, setAiAnalyzedOnce] = useState(false);

  const bankOptions = useMemo(
    () => Array.from(new Set(bankTransactions.map((b) => b.banco).filter(Boolean))).sort(),
    [bankTransactions]
  );

  const diagnostics = useMemo(
    () => buildReconciliationDiagnostics(bankTransactions, invoices, reconciliations, toleranceDays, reportFilters),
    [bankTransactions, invoices, reconciliations, toleranceDays, reportFilters]
  );

  const diagnosticsAll = useMemo(
    () => buildReconciliationDiagnostics(bankTransactions, invoices, reconciliations, toleranceDays),
    [bankTransactions, invoices, reconciliations, toleranceDays]
  );

  const invoiceMap = useMemo(() => new Map(invoices.map((i) => [i.id, i])), [invoices]);
  const bankMap = useMemo(() => new Map(bankTransactions.map((b) => [b.id, b])), [bankTransactions]);

  const activeAiSuggestions = useMemo(() => {
    return aiSuggestions.filter((s) => {
      const tx = bankMap.get(s.bankTransactionId);
      if (!tx || getBankTxAvailableAmount(tx) <= 0.01) return false;
      const validInvoices = s.invoiceIds
        .map((id) => invoiceMap.get(id))
        .filter((inv): inv is Invoice => Boolean(inv))
        .filter(
          (inv) =>
            inv.statusRecebimento !== 'cancelada' &&
            inv.statusRecebimento !== 'recebida' &&
            !diagnosticsAll.rejectedPairKeys.has(`${tx.id}::${inv.id}`)
        );
      return validInvoices.length > 0;
    });
  }, [aiSuggestions, bankMap, invoiceMap, diagnosticsAll.rejectedPairKeys]);

  const hasActiveFilters = Boolean(
    search ||
      filterPagador ||
      filterDataInicio ||
      filterDataFim ||
      filterValorMin ||
      filterValorMax ||
      filterStatus !== 'todos' ||
      filterTipo !== 'todos'
  );

  const clearFilters = () => {
    setSearch('');
    setFilterPagador('');
    setFilterDataInicio('');
    setFilterDataFim('');
    setFilterValorMin('');
    setFilterValorMax('');
    setFilterStatus('todos');
    setFilterTipo('todos');
  };

  const summary = useMemo(() => {
    const creditos = bankTransactions.filter((b) => b.tipo === 'credito');
    const conciliados = creditos.filter((b) => b.statusConciliacao === 'conciliado_nf');
    const semNf = creditos.filter(
      (b) =>
        b.statusConciliacao === 'sem_nf_localizada' ||
        b.statusConciliacao === 'nao_conciliado' ||
        b.statusConciliacao === 'conciliado_parcial'
    );
    return {
      totalCreditos: creditos.reduce((s, b) => s + b.valor, 0),
      qtdConciliados: conciliados.length,
      valorConciliados: conciliados.reduce((s, b) => s + b.valor, 0),
      qtdSemNf: semNf.length,
      valorSemNf: semNf.reduce((s, b) => s + (getBankTxAvailableAmount(b) || b.valor), 0),
    };
  }, [bankTransactions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qp = filterPagador.trim().toLowerCase();
    const qpDigits = digitsOnly(filterPagador);
    const minVal = filterValorMin ? Number(filterValorMin) : null;
    const maxVal = filterValorMax ? Number(filterValorMax) : null;

    return bankTransactions
      .filter((tx) => {
        if (filterStatus !== 'todos' && tx.statusConciliacao !== filterStatus) return false;
        if (filterTipo !== 'todos' && tx.tipo !== filterTipo) return false;
        if (filterDataInicio && tx.dataMovimento < filterDataInicio) return false;
        if (filterDataFim && tx.dataMovimento > filterDataFim) return false;
        if (minVal !== null && Number.isFinite(minVal) && tx.valor < minVal) return false;
        if (maxVal !== null && Number.isFinite(maxVal) && tx.valor > maxVal) return false;
        if (qp) {
          const payerHay = `${tx.nomePagador ?? ''} ${tx.cpfCnpjPagador ?? ''}`.toLowerCase();
          const docMatch = qpDigits.length >= 3 && digitsOnly(tx.cpfCnpjPagador).includes(qpDigits);
          if (!payerHay.includes(qp) && !docMatch) return false;
        }
        if (q) {
          const hay = `${tx.banco} ${tx.descricao} ${tx.nomePagador ?? ''} ${tx.cpfCnpjPagador ?? ''} ${tx.documentoBancario ?? ''} ${tx.fitId ?? ''} ${tx.invoiceNumber ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.dataMovimento.localeCompare(a.dataMovimento));
  }, [
    bankTransactions,
    search,
    filterPagador,
    filterDataInicio,
    filterDataFim,
    filterValorMin,
    filterValorMax,
    filterStatus,
    filterTipo,
  ]);

  const candidateInvoices = useMemo(() => {
    if (!linkTarget) return [];
    return invoices
      .filter((inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida')
      .map((inv) => evaluateMultiCriteriaMatch(linkTarget, inv, toleranceDays))
      .sort((a, b) => b.confidenceScore - a.confidenceScore || Math.abs(a.diffValor) - Math.abs(b.diffValor));
  }, [linkTarget, invoices, toleranceDays]);

  const selectedCandidate = useMemo(
    () => candidateInvoices.find((c) => c.invoice.id === selectedInvoiceId) ?? null,
    [candidateInvoices, selectedInvoiceId]
  );

  const handleAnalyzeWithGemini = async () => {
    setAiError(null);
    const openCredits = bankTransactions
      .filter((tx) => tx.tipo === 'credito' && getBankTxAvailableAmount(tx) > 0.01)
      .map((tx) => ({
        id: tx.id,
        banco: tx.banco,
        dataMovimento: tx.dataMovimento,
        valor: tx.valor,
        valorDisponivel: getBankTxAvailableAmount(tx),
        descricao: tx.descricao,
        nomePagador: tx.nomePagador || '',
        cpfCnpjPagador: tx.cpfCnpjPagador || '',
        documentoBancario: tx.documentoBancario || '',
        fitId: tx.fitId || '',
      }));

    const openInvs = invoices
      .filter((inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida')
      .map((inv) => ({
        id: inv.id,
        numero: inv.numero,
        serie: inv.serie,
        tipo: inv.tipo,
        dataEmissao: inv.dataEmissao,
        dataVencimento: inv.dataVencimento || '',
        clienteNome: inv.clienteNome,
        clienteDocumento: inv.clienteDocumento || '',
        valor: inv.valor,
        valorRecebido: inv.valorRecebido,
        valorEmAberto: getInvoiceOpenAmount(inv),
        itensResumo: inv.itensResumo || inv.descricaoServicos || '',
      }));

    if (openCredits.length === 0 || openInvs.length === 0) {
      onNotify(
        'info',
        'São necessários créditos bancários pendentes e notas fiscais de saída em aberto para análise inteligente.'
      );
      return;
    }

    const rejectedPairs = Array.from(diagnosticsAll.rejectedPairKeys).map((key) => {
      const [bankTransactionId, invoiceId] = key.split('::');
      return { bankTransactionId, invoiceId };
    });

    setAiLoading(true);
    try {
      const resp = await authorizedJsonFetch('/api/reconciliation/suggest', {
        bankCredits: openCredits,
        openInvoices: openInvs,
        rejectedPairs,
        toleranceDays,
      });
      const data = (await resp.json()) as { suggestions?: AiReconciliationSuggestion[]; error?: string };
      if (!resp.ok) {
        throw new Error(data.error || 'Falha ao consultar sugestões de conciliação no Gemini.');
      }
      setAiSuggestions(data.suggestions ?? []);
      setAiAnalyzedOnce(true);
      onNotify(
        'success',
        data.suggestions && data.suggestions.length > 0
          ? `Análise concluída: ${data.suggestions.length} sugestão(ões) multicritério gerada(s) para sua revisão.`
          : 'Análise concluída: nenhuma correspondência segura foi identificada nos documentos em aberto.'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao consultar Gemini.';
      setAiError(msg);
      onNotify('error', msg);
    } finally {
      setAiLoading(false);
    }
  };

  const handleConfirmAiSuggestion = async (suggestion: AiReconciliationSuggestion) => {
    if (!canEdit || saving) return;
    const bankTx = bankMap.get(suggestion.bankTransactionId);
    const matchedInvoices = suggestion.invoiceIds
      .map((id) => invoiceMap.get(id))
      .filter((inv): inv is Invoice => Boolean(inv));
    if (!bankTx || matchedInvoices.length === 0) return;

    setSaving(true);
    try {
      if (matchedInvoices.length === 1) {
        const inv = matchedInvoices[0];
        const invOpen = getInvoiceOpenAmount(inv) || inv.valor;
        const txAvail = getBankTxAvailableAmount(bankTx) || bankTx.valor;
        const alloc = suggestion.matchType === 'parcela' ? txAvail : Math.min(txAvail, txAvail);
        await reconcileBankWithInvoice(user, companyId, bankTx, inv, {
          createFinancialReceipt: true,
          allocatedAmount: alloc > 0 ? alloc : bankTx.valor,
          meta: {
            confianca: suggestion.confidenceLevel,
            justificativa: suggestion.justification,
            origemDecisao: 'ia_confirmada',
          },
        });
        onNotify(
          'success',
          `Conciliação confirmada: ${inv.tipo} ${inv.numero} (Em aberto ${formatBRL(invOpen)}).`
        );
      } else {
        // Pagamento agrupado: distribuir crédito disponível pelas notas fiscais em ordem
        let remaining = getBankTxAvailableAmount(bankTx) || bankTx.valor;
        const allocs: Array<{ invoice: Invoice; allocatedAmount: number }> = [];
        for (let idx = 0; idx < matchedInvoices.length; idx += 1) {
          const inv = matchedInvoices[idx];
          const invOpen = getInvoiceOpenAmount(inv) || inv.valor;
          const part =
            idx === matchedInvoices.length - 1
              ? Math.max(0, Math.round(remaining * 100) / 100)
              : Math.min(invOpen, Math.max(0, Math.round(remaining * 100) / 100));
          if (part > 0) {
            allocs.push({ invoice: inv, allocatedAmount: part });
            remaining = Math.round((remaining - part) * 100) / 100;
          }
        }
        await splitBankTxAcrossInvoices(user, companyId, bankTx, allocs, {
          createFinancialReceipt: true,
          meta: {
            confianca: suggestion.confidenceLevel,
            justificativa: suggestion.justification,
            origemDecisao: 'ia_confirmada',
          },
        });
        onNotify('success', `Pagamento agrupado confirmado em ${allocs.length} notas fiscais.`);
      }
      setAiSuggestions((prev) => prev.filter((item) => item !== suggestion));
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao confirmar sugestão.');
    } finally {
      setSaving(false);
    }
  };

  const handleRejectAiSuggestion = async (suggestion: AiReconciliationSuggestion) => {
    if (!canEdit || saving) return;
    const bankTx = bankMap.get(suggestion.bankTransactionId);
    const firstInv = invoiceMap.get(suggestion.invoiceIds[0]);
    if (!bankTx || !firstInv) return;

    setSaving(true);
    try {
      await rejectReconciliationSuggestion(user, companyId, bankTx, firstInv, suggestion.justification);
      setAiSuggestions((prev) => prev.filter((item) => item !== suggestion));
      onNotify('info', 'Sugestão rejeitada e registrada no histórico de auditoria.');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao registrar rejeição.');
    } finally {
      setSaving(false);
    }
  };

  const handleManualSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    const errs: Record<string, string> = {};
    if (!manualForm.banco.trim()) errs.banco = 'Informe o banco.';
    if (!manualForm.descricao.trim()) errs.descricao = 'Informe a descrição.';
    if (!Number.isFinite(manualForm.valor) || manualForm.valor <= 0) errs.valor = 'Valor deve ser maior que zero.';
    if (!manualForm.dataMovimento) errs.dataMovimento = 'Informe a data.';
    setManualErrors(errs);
    if (Object.keys(errs).length > 0 || saving) return;

    setSaving(true);
    try {
      const cleanDoc = digitsOnly(manualForm.cpfCnpjPagador);
      const matchedCustomer =
        cleanDoc.length === 11 || cleanDoc.length === 14
          ? customers.find((c) => digitsOnly(c.documentoLimpo || c.documento) === cleanDoc)
          : undefined;

      await importBankTransactionsBatch(
        user,
        companyId,
        [
          {
            banco: manualForm.banco,
            conta: manualForm.conta,
            fitId: '',
            documentoBancario: manualForm.documentoBancario,
            nomePagador: manualForm.nomePagador,
            cpfCnpjPagador: manualForm.cpfCnpjPagador ? formatCpfCnpj(manualForm.cpfCnpjPagador) : '',
            customerId: matchedCustomer?.id ?? '',
            tipo: manualForm.tipo,
            descricao: manualForm.descricao,
            valor: manualForm.valor,
            dataMovimento: manualForm.dataMovimento,
            statusConciliacao: manualForm.tipo === 'credito' ? 'sem_nf_localizada' : 'nao_conciliado',
            valorConciliado: 0,
            invoiceId: '',
            invoiceNumber: '',
            financialTransactionId: '',
            origemArquivo: 'Lançamento Manual',
          },
        ],
        'Lançamento Manual'
      );
      onNotify('success', 'Movimentação bancária registrada.');
      setManualModal(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar movimentação bancária.');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmLink = async () => {
    if (!canEdit || !linkTarget || !selectedInvoiceId || saving) return;
    const inv = invoices.find((i) => i.id === selectedInvoiceId);
    if (!inv) return;
    setSaving(true);
    try {
      await reconcileBankWithInvoice(user, companyId, linkTarget, inv, {
        createFinancialReceipt: createFinReceipt,
        meta: {
          confianca: selectedCandidate?.confidenceLevel ?? 'manual',
          justificativa:
            selectedCandidate && selectedCandidate.criteriaMatched.length > 0
              ? `Vínculo manual (${selectedCandidate.criteriaMatched.join(', ')})`
              : `Vínculo manual direto com ${inv.tipo} ${inv.numero}`,
          origemDecisao: 'manual',
        },
      });
      onNotify(
        'success',
        `Recebimento conciliado com ${inv.tipo} nº ${inv.numero}${
          createFinReceipt ? ' e lançado no Financeiro como liquidado' : ''
        }.`
      );
      setLinkTarget(null);
      setSelectedInvoiceId('');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao conciliar com nota fiscal.');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkWithoutNf = async (tx: BankTransaction) => {
    if (!canEdit) return;
    try {
      await markBankTxWithoutInvoice(user, companyId, tx);
      onNotify('info', 'Movimento mantido como pendência de conferência sem nota fiscal localizada.');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao atualizar status.');
    }
  };

  const handleDelete = async () => {
    if (!canEdit || !deleteTarget) return;
    setSaving(true);
    try {
      await deleteBankTransaction(user, companyId, deleteTarget.id);
      onNotify('success', 'Registro bancário removido.');
      setDeleteTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao remover registro.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Navegação Interna do Módulo de Conciliação Inteligente */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setWorkspaceTab('inteligente')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              workspaceTab === 'inteligente'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            Conciliação Inteligente & IA
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceTab('extratos')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              workspaceTab === 'extratos'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Landmark className="w-4 h-4" />
            Extratos Bancários ({bankTransactions.length})
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceTab('relatorios')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              workspaceTab === 'relatorios'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            Relatórios (7 Visões)
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceTab('historico')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              workspaceTab === 'historico'
                ? 'bg-[#0B1F3A] text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <History className="w-4 h-4" />
            Histórico ({reconciliations.length})
          </button>
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setGroupPreselectedCreditIds([]);
                setGroupPreselectedInvoiceId('');
                setGroupModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              <Layers className="w-3.5 h-3.5" />
              Agrupar Parcelas em 1 NF
            </button>
            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <FileUp className="w-3.5 h-3.5" />
              Importar Extrato
            </button>
          </div>
        )}
      </div>

      {/* ==================== ABA 1: CONCILIAÇÃO INTELIGENTE & IA ==================== */}
      {workspaceTab === 'inteligente' && (
        <div className="space-y-6">
          {/* Painel das 9 Situações Identificadas */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Diagnóstico das 9 Situações de Conciliação
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Cruzamento multicritério (CPF/CNPJ, pagador, nº da NF, data, histórico e valores) · Documentos originais preservados.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportReconciliationExcelWorkbook(diagnosticsAll, reconciliations, companyName)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  Exportar Excel (.xlsx)
                </button>
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void handleAnalyzeWithGemini()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium text-white bg-[#0B1F3A] hover:bg-blue-900 rounded-lg disabled:opacity-60 cursor-pointer whitespace-nowrap"
                >
                  {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {aiLoading ? 'Analisando com Gemini...' : 'Analisar Pendências com Gemini IA'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {SITUATION_CARDS.map((card) => (
                <div
                  key={card.key}
                  className="border border-slate-200 rounded-lg p-3 bg-slate-50/40"
                >
                  <p className="text-[11px] font-medium text-slate-500 leading-snug">{card.label}</p>
                  <p className={`text-xl font-semibold font-mono tabular-nums mt-1 ${card.tone}`}>
                    {diagnosticsAll.situationCounts[card.key]}
                  </p>
                </div>
              ))}
            </div>

            <div className="bg-blue-50/70 border border-blue-200 rounded-lg p-3 flex items-start gap-2.5 text-xs text-blue-950">
              <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
              <span>
                <strong>Governança e Segurança Contábil:</strong> Correspondências incertas jamais são confirmadas automaticamente. Um recebimento sem nota fiscal localizada é tratado como <strong>pendência de conferência</strong>, nunca como prova de que não houve emissão de nota.
              </span>
            </div>
          </div>

          {aiError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-800 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{aiError}</span>
            </div>
          )}

          {/* Sugestões Estruturadas do Google Gemini */}
          {(activeAiSuggestions.length > 0 || aiAnalyzedOnce) && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-blue-700" />
                    Sugestões de Correspondência — Google Gemini ({activeAiSuggestions.length})
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Avalie a justificativa e o grau de confiança antes de confirmar, rejeitar ou dividir manualmente.
                  </p>
                </div>
              </div>

              {activeAiSuggestions.length === 0 ? (
                <p className="text-sm text-slate-500 py-3">
                  Nenhuma sugestão pendente da IA no momento. Utilize a fila de revisão manual abaixo para vincular, dividir ou agrupar lançamentos.
                </p>
              ) : (
                <div className="space-y-3">
                  {activeAiSuggestions.map((s, idx) => {
                    const bankTx = bankMap.get(s.bankTransactionId);
                    const matchedInvs = s.invoiceIds
                      .map((id) => invoiceMap.get(id))
                      .filter((inv): inv is Invoice => Boolean(inv));
                    if (!bankTx || matchedInvs.length === 0) return null;

                    const confMeta = CONFIDENCE_LABELS[s.confidenceLevel];
                    const invLabel = matchedInvs.map((inv) => `${inv.tipo} ${inv.numero}`).join(' + ');
                    const clientNames = Array.from(new Set(matchedInvs.map((inv) => inv.clienteNome))).join(' / ');

                    return (
                      <div
                        key={`${s.bankTransactionId}-${s.invoiceIds.join('-')}-${idx}`}
                        className="border border-slate-200 rounded-xl p-4 space-y-3 bg-white"
                      >
                        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                          <div className="space-y-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className={`font-semibold ${confMeta.cls}`}>
                                {confMeta.label} ({s.confidenceScore}%)
                              </span>
                              <span className="text-slate-300">·</span>
                              <span className="font-medium text-blue-700">
                                {s.matchType === 'agrupado'
                                  ? 'Pagamento Agrupado (Várias NFs)'
                                  : s.matchType === 'parcela'
                                    ? 'Pagamento em Parcela / Parcial'
                                    : s.matchType === 'revisao_incerta'
                                      ? 'Correspondência Incerta — Revisão Humana'
                                      : 'Correspondência Direta (1 NF)'}
                              </span>
                              <span className="text-slate-300">·</span>
                              <span className="text-slate-500 font-mono tabular-nums">
                                Data receb.: {formatDateBR(bankTx.dataMovimento)}
                              </span>
                            </div>

                            <p className="text-sm font-semibold text-slate-900">
                              NF relacionada: {invLabel} — Cliente: {clientNames}
                            </p>
                            <p className="text-xs text-slate-600">
                              Extrato: {bankTx.banco} · {bankTx.descricao}
                              {bankTx.nomePagador ? ` · Pagador: ${bankTx.nomePagador}` : ''}
                              {bankTx.cpfCnpjPagador ? ` (${bankTx.cpfCnpjPagador})` : ''}
                            </p>
                          </div>

                          <div className="grid grid-cols-3 gap-4 text-right shrink-0 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2">
                            <div>
                              <span className="text-[11px] text-slate-500 block">Valor da(s) NF(s)</span>
                              <span className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-slate-900">
                                {formatBRL(s.invoiceTotal)}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] text-slate-500 block">Valor Recebido</span>
                              <span className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-emerald-700">
                                {formatBRL(s.receivedAmount)}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] text-slate-500 block">Diferença</span>
                              <span
                                className={`text-xs sm:text-sm font-mono tabular-nums font-semibold ${
                                  Math.abs(s.differenceAmount) <= 0.05 ? 'text-slate-600' : 'text-amber-700'
                                }`}
                              >
                                {s.differenceAmount > 0
                                  ? `+${formatBRL(s.differenceAmount)}`
                                  : formatBRL(s.differenceAmount)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3">
                          <span className="font-semibold text-slate-900">Justificativa da correspondência: </span>
                          {s.justification}
                        </div>

                        {canEdit && (
                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => setSplitTarget(bankTx)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                            >
                              <Split className="w-3.5 h-3.5" />
                              Dividir entre NFs
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => {
                                setLinkTarget(bankTx);
                                setSelectedInvoiceId(matchedInvs[0]?.id ?? '');
                                setCreateFinReceipt(true);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                            >
                              <Link2 className="w-3.5 h-3.5" />
                              Relacionar Manualmente
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void handleRejectAiSuggestion(s)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Rejeitar
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void handleConfirmAiSuggestion(s)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Confirmar Conciliação
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Fila Determinística de Pendências & Revisão Humana */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Fila de Conferência de Recebimentos Pendentes ({diagnosticsAll.reports.conciliacoesPendentes.length})
                </h3>
                <p className="text-xs text-slate-500">
                  Créditos bancários aguardando vínculo com notas fiscais de saída, agrupamento ou conferência manual.
                </p>
              </div>
            </div>

            {loading ? (
              <div className="p-4">
                <SkeletonTable rows={5} />
              </div>
            ) : diagnosticsAll.reports.conciliacoesPendentes.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Todos os recebimentos bancários importados estão conciliados com suas respectivas notas fiscais.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {diagnosticsAll.reports.conciliacoesPendentes.map((item) => {
                  const tx = item.bankTx;
                  const top = item.topCandidates[0];
                  return (
                    <div key={tx.id} className="p-5 space-y-3 hover:bg-slate-50/50">
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono tabular-nums text-slate-500">
                              {formatDateBR(tx.dataMovimento)}
                            </span>
                            <span className="text-slate-300">·</span>
                            <span className="font-medium text-slate-700">{tx.banco}</span>
                            {tx.nomePagador && (
                              <>
                                <span className="text-slate-300">·</span>
                                <span className="text-slate-700 font-medium">{tx.nomePagador}</span>
                              </>
                            )}
                            {tx.cpfCnpjPagador && (
                              <span className="font-mono text-slate-500">({tx.cpfCnpjPagador})</span>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-slate-900">{tx.descricao}</p>
                          <p className="text-xs text-slate-600">{item.requiresHumanReviewReason}</p>
                        </div>

                        <div className="flex items-center gap-4 shrink-0">
                          <div className="text-right">
                            <span className="text-[11px] text-slate-500 block">Saldo p/ conciliar</span>
                            <span className="text-base font-mono tabular-nums font-semibold text-emerald-700">
                              {formatBRL(item.availableAmount)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {item.groupedCandidate && (
                        <div className="bg-blue-50/70 border border-blue-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                          <div className="text-blue-950">
                            <strong>Possível pagamento agrupado identificado:</strong>{' '}
                            {item.groupedCandidate.invoices.map((i) => `${i.tipo} ${i.numero}`).join(' + ')} (soma{' '}
                            {formatBRL(item.groupedCandidate.sumOpenInvoices)})
                          </div>
                          {canEdit && (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => setSplitTarget(tx)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg shrink-0 cursor-pointer"
                            >
                              <Split className="w-3.5 h-3.5" />
                              Revisar e Dividir
                            </button>
                          )}
                        </div>
                      )}

                      {top && (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                          <div className="space-y-0.5">
                            <p className="text-slate-900 font-medium">
                              Melhor candidata local: {top.invoice.tipo} {top.invoice.numero} — {top.invoice.clienteNome} (
                              {formatBRL(top.invoice.valor)})
                            </p>
                            <p className="text-slate-500">
                              {CONFIDENCE_LABELS[top.confidenceLevel].label} ({top.confidenceScore}%) ·{' '}
                              {top.criteriaMatched.length > 0
                                ? `Critérios coincidentes: ${top.criteriaMatched.join(', ')}`
                                : 'Sem critérios fortes além de valor/data'}
                              {top.criteriaDivergent.length > 0
                                ? ` · Divergências: ${top.criteriaDivergent.join(', ')}`
                                : ''}
                            </p>
                          </div>
                        </div>
                      )}

                      {canEdit && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setLinkTarget(tx);
                              setSelectedInvoiceId(top?.invoice.id ?? '');
                              setCreateFinReceipt(true);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            Relacionar Manualmente
                          </button>
                          <button
                            type="button"
                            onClick={() => setSplitTarget(tx)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                          >
                            <Split className="w-3.5 h-3.5" />
                            Dividir entre Notas
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setGroupPreselectedCreditIds([tx.id]);
                              setGroupPreselectedInvoiceId(top?.invoice.id ?? '');
                              setGroupModalOpen(true);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
                          >
                            <Layers className="w-3.5 h-3.5" />
                            Agrupar com Outras Parcelas
                          </button>
                          {tx.statusConciliacao !== 'sem_nf_localizada' && (
                            <button
                              type="button"
                              onClick={() => void handleMarkWithoutNf(tx)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 rounded-lg cursor-pointer"
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                              Manter Pendência sem NF
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== ABA 2: EXTRATOS BANCÁRIOS ==================== */}
      {workspaceTab === 'extratos' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Total de Créditos Bancários</p>
              <p className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
                {formatBRL(summary.totalCreditos)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Recebimentos Conciliados com NF</p>
              <p className="text-xl font-semibold text-emerald-700 font-mono tabular-nums mt-1.5">
                {summary.qtdConciliados} · {formatBRL(summary.valorConciliados)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Pendências sem NF Localizada</p>
              <p className="text-xl font-semibold text-red-700 font-mono tabular-nums mt-1.5">
                {summary.qtdSemNf} · {formatBRL(summary.valorSemNf)}
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
                    placeholder="Banco, histórico, doc, FITID ou NF..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <input
                  type="text"
                  value={filterPagador}
                  onChange={(e) => setFilterPagador(e.target.value)}
                  placeholder="Pagador / CPF-CNPJ..."
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg min-w-[170px]"
                />

                <select
                  value={filterTipo}
                  onChange={(e) => setFilterTipo(e.target.value as 'todos' | BankTxType)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="todos">Créditos e Débitos</option>
                  <option value="credito">Somente Entradas (Créditos)</option>
                  <option value="debito">Somente Saídas (Débitos)</option>
                </select>

                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value as 'todos' | ReconciliationStatus)}
                  className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="todos">Todas as situações</option>
                  <option value="sem_nf_localizada">Sem NF Localizada</option>
                  <option value="nao_conciliado">Aguardando Conciliação</option>
                  <option value="conciliado_parcial">Conciliado Parcialmente</option>
                  <option value="conciliado_nf">Conciliado com NF</option>
                </select>
              </div>

              {canEdit && (
                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setManualForm({
                        banco: '',
                        conta: '',
                        tipo: 'credito',
                        descricao: '',
                        nomePagador: '',
                        cpfCnpjPagador: '',
                        documentoBancario: '',
                        valor: 0,
                        dataMovimento: todayISO(),
                      });
                      setManualErrors({});
                      setManualModal(true);
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Lançamento Manual
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <span>Período de:</span>
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
              icon={<Landmark className="w-6 h-6" />}
              title={
                bankTransactions.length === 0
                  ? 'Nenhuma movimentação bancária importada'
                  : 'Nenhuma transação corresponde aos filtros'
              }
              description={
                bankTransactions.length === 0
                  ? 'Importe um extrato bancário em formato Excel (.xlsx/.xls), CSV, OFX ou PDF para cruzar recebimentos de clientes com suas notas fiscais de saída.'
                  : 'Ajuste os filtros de período, pagador, valor ou situação aplicados.'
              }
              actionLabel={canEdit && bankTransactions.length === 0 ? 'Importar Extrato Bancário' : undefined}
              onAction={canEdit && bankTransactions.length === 0 ? () => setImportModalOpen(true) : undefined}
            />
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <tr>
                      <th className="text-left font-medium px-5 py-3">Data</th>
                      <th className="text-left font-medium px-4 py-3">Banco / Histórico / Pagador</th>
                      <th className="text-left font-medium px-4 py-3">Situação Fiscal</th>
                      <th className="text-right font-medium px-4 py-3">Valor</th>
                      {canEdit && <th className="text-right font-medium px-5 py-3">Ações</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((tx) => {
                      const st = STATUS_LABELS[tx.statusConciliacao];
                      const avail = getBankTxAvailableAmount(tx);
                      return (
                        <tr key={tx.id} className="hover:bg-slate-50/70">
                          <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                            {formatDateBR(tx.dataMovimento)}
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-slate-900">{tx.descricao}</p>
                            {(tx.nomePagador || tx.cpfCnpjPagador) && (
                              <p className="text-xs text-slate-700 mt-0.5">
                                {tx.nomePagador || 'Pagador'}
                                {tx.cpfCnpjPagador && (
                                  <span className="font-mono text-slate-500 ml-1.5">({tx.cpfCnpjPagador})</span>
                                )}
                              </p>
                            )}
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {tx.banco}
                              {tx.conta ? ` · Conta ${tx.conta}` : ''}
                              {tx.documentoBancario ? ` · Doc ${tx.documentoBancario}` : ''}
                              {tx.fitId ? ` · ID ${tx.fitId.slice(0, 16)}` : ''}
                              {tx.origemArquivo ? ` · ${tx.origemArquivo}` : ''}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            <span className={`font-semibold ${st.cls}`}>{st.label}</span>
                            {tx.invoiceNumber && (
                              <span className="block text-slate-500 font-mono mt-0.5">
                                NF {tx.invoiceNumber}
                              </span>
                            )}
                            {tx.statusConciliacao === 'conciliado_parcial' && (
                              <span className="block text-blue-700 font-mono mt-0.5">
                                Disponível: {formatBRL(avail)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                            <span className={tx.tipo === 'credito' ? 'text-emerald-700' : 'text-slate-700'}>
                              {tx.tipo === 'credito' ? '+ ' : '- '}
                              {formatBRL(tx.valor)}
                            </span>
                          </td>
                          {canEdit && (
                            <td className="px-5 py-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                {tx.tipo === 'credito' && avail > 0.01 && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setLinkTarget(tx);
                                        setSelectedInvoiceId('');
                                        setCreateFinReceipt(true);
                                      }}
                                      title="Vincular Nota Fiscal de Saída"
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                                    >
                                      <Link2 className="w-3.5 h-3.5" />
                                      Conciliar NF
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSplitTarget(tx)}
                                      title="Dividir recebimento entre notas fiscais"
                                      className="p-1.5 text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer"
                                    >
                                      <Split className="w-4 h-4" />
                                    </button>
                                    {tx.statusConciliacao !== 'sem_nf_localizada' && (
                                      <button
                                        type="button"
                                        onClick={() => void handleMarkWithoutNf(tx)}
                                        title="Manter como pendência sem NF localizada"
                                        className="p-1.5 text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
                                      >
                                        <AlertTriangle className="w-4 h-4" />
                                      </button>
                                    )}
                                  </>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(tx)}
                                  title="Remover transação"
                                  className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
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
        </div>
      )}

      {/* ==================== ABA 3: RELATÓRIOS SEPARADOS ==================== */}
      {workspaceTab === 'relatorios' && (
        <ReconciliationReportsPanel
          companyName={companyName}
          canEdit={canEdit}
          filters={reportFilters}
          onChangeFilters={setReportFilters}
          onResetFilters={() =>
            setReportFilters({
              dataInicio: '',
              dataFim: '',
              clienteOuPagador: '',
              banco: '',
              valorMin: '',
              valorMax: '',
            })
          }
          diagnostics={diagnostics}
          reconciliations={reconciliations}
          bankOptions={bankOptions}
          onQuickLinkCredit={(tx) => {
            setLinkTarget(tx);
            setSelectedInvoiceId('');
            setCreateFinReceipt(true);
          }}
        />
      )}

      {/* ==================== ABA 4: HISTÓRICO AUDITÁVEL ==================== */}
      {workspaceTab === 'historico' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Histórico Imutável de Conciliações e Decisões ({reconciliations.length})
              </h3>
              <p className="text-xs text-slate-500">
                Registro completo de vínculos diretos, parcelamentos, rateios agrupados, pendências sem NF e sugestões rejeitadas.
              </p>
            </div>
          </div>

          {reconciliations.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nenhuma operação de conciliação registrada até o momento.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Data Extrato</th>
                    <th className="text-left font-medium px-4 py-3">Operação / Origem</th>
                    <th className="text-left font-medium px-4 py-3">Lançamento & Justificativa</th>
                    <th className="text-left font-medium px-4 py-3">NF</th>
                    <th className="text-right font-medium px-5 py-3">Valor Conciliado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reconciliations.map((rec) => {
                    const typeText =
                      rec.tipo === 'agrupado'
                        ? 'Agrupado (Split)'
                        : rec.tipo === 'parcelado'
                          ? 'Parcelado'
                          : rec.tipo === 'rejeitado'
                            ? 'Rejeitado após IA'
                            : rec.tipo === 'sem_nf'
                              ? 'Pendência sem NF'
                              : 'NF Única';
                    const typeCls =
                      rec.tipo === 'rejeitado'
                        ? 'text-red-700'
                        : rec.tipo === 'sem_nf'
                          ? 'text-amber-700'
                          : 'text-emerald-700';
                    return (
                      <tr key={rec.id} className="hover:bg-slate-50/70">
                        <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                          {formatDateBR(rec.bankData)}
                        </td>
                        <td className="px-4 py-3 text-xs whitespace-nowrap">
                          <span className={`font-semibold block ${typeCls}`}>{typeText}</span>
                          <span className="text-slate-500">
                            {rec.origemDecisao === 'ia_confirmada'
                              ? 'Confirmado via IA'
                              : rec.origemDecisao === 'ia_rejeitada'
                                ? 'Rejeitado via IA'
                                : 'Manual'}
                            {rec.confianca ? ` · ${rec.confianca}` : ''}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">{rec.bankDescricao}</p>
                          <p className="text-xs text-slate-600 mt-0.5">
                            {rec.justificativa || rec.observacoes}
                          </p>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700 whitespace-nowrap">
                          {rec.invoiceNumber ? `NF ${rec.invoiceNumber}` : '—'}
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                          {formatBRL(rec.valorConciliado)}
                          {typeof rec.diferencaValor === 'number' && Math.abs(rec.diferencaValor) > 0.05 && (
                            <span className="block text-[11px] font-normal text-amber-700">
                              Dif.: {rec.diferencaValor > 0 ? `+${formatBRL(rec.diferencaValor)}` : formatBRL(rec.diferencaValor)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================== MODAIS ==================== */}
      <BankStatementImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        user={user}
        companyId={companyId}
        existingTransactions={bankTransactions}
        onNotify={onNotify}
      />

      <SplitCreditAcrossInvoicesModal
        open={Boolean(splitTarget)}
        bankTx={splitTarget}
        invoices={invoices}
        saving={saving}
        onClose={() => setSplitTarget(null)}
        onConfirm={async (allocations, createReceipt, justificativa) => {
          if (!splitTarget) return;
          setSaving(true);
          try {
            await splitBankTxAcrossInvoices(user, companyId, splitTarget, allocations, {
              createFinancialReceipt: createReceipt,
              meta: {
                confianca: 'manual',
                justificativa: justificativa || undefined,
                origemDecisao: 'manual',
              },
            });
            onNotify('success', `Recebimento dividido entre ${allocations.length} nota(s) fiscal(is) com sucesso.`);
            setSplitTarget(null);
          } catch (err: unknown) {
            onNotify('error', err instanceof Error ? err.message : 'Erro ao dividir recebimento.');
          } finally {
            setSaving(false);
          }
        }}
      />

      <GroupCreditsToInvoiceModal
        open={groupModalOpen}
        bankCredits={bankTransactions}
        invoices={invoices}
        preselectedCreditIds={groupPreselectedCreditIds}
        preselectedInvoiceId={groupPreselectedInvoiceId}
        saving={saving}
        onClose={() => setGroupModalOpen(false)}
        onConfirm={async (selectedTxs, invoice, createReceipt, justificativa) => {
          setSaving(true);
          try {
            await reconcileMultipleBankTxsToInvoice(user, companyId, selectedTxs, invoice, {
              createFinancialReceipt: createReceipt,
              justificativa: justificativa || undefined,
            });
            onNotify(
              'success',
              `${selectedTxs.length} recebimento(s) vinculados à ${invoice.tipo} ${invoice.numero}.`
            );
            setGroupModalOpen(false);
          } catch (err: unknown) {
            onNotify('error', err instanceof Error ? err.message : 'Erro ao vincular parcelas.');
          } finally {
            setSaving(false);
          }
        }}
      />

      <Modal
        open={manualModal}
        title="Novo Movimento Bancário"
        onClose={() => setManualModal(false)}
        maxWidth="max-w-lg"
      >
        <form onSubmit={(e) => void handleManualSave(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Banco *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.banco}
                value={manualForm.banco}
                onChange={(e) => setManualForm({ ...manualForm, banco: e.target.value })}
                placeholder="Ex.: Banco do Brasil / Itaú / Sicredi"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {manualErrors.banco && <p className="text-xs text-red-600 mt-1">{manualErrors.banco}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tipo *</label>
              <select
                value={manualForm.tipo}
                onChange={(e) => setManualForm({ ...manualForm, tipo: e.target.value as BankTxType })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="credito">Crédito (Recebimento)</option>
                <option value="debito">Débito (Saída)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Histórico / Descrição *</label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.descricaoBanco}
              value={manualForm.descricao}
              onChange={(e) => setManualForm({ ...manualForm, descricao: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            {manualErrors.descricao && <p className="text-xs text-red-600 mt-1">{manualErrors.descricao}</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Pagador (Opcional)</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.nomePagador}
                value={manualForm.nomePagador}
                onChange={(e) => setManualForm({ ...manualForm, nomePagador: e.target.value })}
                placeholder="Nome / Razão Social"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">CPF / CNPJ do Pagador</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.cpfCnpjPagador}
                value={manualForm.cpfCnpjPagador}
                onChange={(e) => setManualForm({ ...manualForm, cpfCnpjPagador: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Nº Documento</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.documentoBancario}
                value={manualForm.documentoBancario}
                onChange={(e) => setManualForm({ ...manualForm, documentoBancario: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Data *</label>
              <input
                type="date"
                value={manualForm.dataMovimento}
                onChange={(e) => setManualForm({ ...manualForm, dataMovimento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Valor (R$) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={manualForm.valor || ''}
                onChange={(e) => setManualForm({ ...manualForm, valor: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {manualErrors.valor && <p className="text-xs text-red-600 mt-1">{manualErrors.valor}</p>}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setManualModal(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : 'Salvar Movimento'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(linkTarget)}
        title="Conciliar Recebimento com Nota Fiscal de Saída"
        subtitle={
          linkTarget
            ? `${formatDateBR(linkTarget.dataMovimento)} · ${linkTarget.descricao} · Disponível: ${formatBRL(
                getBankTxAvailableAmount(linkTarget) || linkTarget.valor
              )}`
            : undefined
        }
        onClose={() => setLinkTarget(null)}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          {candidateInvoices.length === 0 ? (
            <p className="text-sm text-slate-600">
              Não há notas fiscais de saída em aberto disponíveis para conciliação. Importe ou cadastre a NF no módulo Notas Fiscais.
            </p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {candidateInvoices.map((cand) => {
                const { invoice: inv, confidenceLevel, confidenceScore, criteriaMatched, amountOnlyWarning, nameSimilarWithoutDoc } = cand;
                return (
                  <label
                    key={inv.id}
                    className={`flex items-start justify-between gap-3 p-3 border rounded-lg cursor-pointer ${
                      selectedInvoiceId === inv.id
                        ? 'border-blue-600 bg-blue-50/50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <input
                        type="radio"
                        name="invoiceLink"
                        value={inv.id}
                        checked={selectedInvoiceId === inv.id}
                        onChange={() => setSelectedInvoiceId(inv.id)}
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
                        <p className="text-[11px] text-slate-600">
                          <span className={`font-semibold ${CONFIDENCE_LABELS[confidenceLevel].cls}`}>
                            {CONFIDENCE_LABELS[confidenceLevel].label} ({confidenceScore}%)
                          </span>
                          {criteriaMatched.length > 0 && ` · ${criteriaMatched.join(' · ')}`}
                          {amountOnlyWarning && ' · Atenção: apenas valor coincide'}
                          {nameSimilarWithoutDoc && ' · Nome semelhante sem CPF/CNPJ'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-sm font-mono tabular-nums font-semibold text-slate-900 block">
                        {formatBRL(inv.valor)}
                      </span>
                      {inv.valorRecebido > 0 && (
                        <span className="text-[11px] text-slate-500 font-mono">
                          Rec. {formatBRL(inv.valorRecebido)}
                        </span>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {(selectedCandidate?.nameSimilarWithoutDoc || selectedCandidate?.amountOnlyWarning) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2.5 text-xs text-amber-950">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>Revisão Humana Recomendada:</strong>{' '}
                {selectedCandidate.amountOnlyWarning
                  ? 'Apenas o valor coincide — confira CPF/CNPJ, nome do pagador e histórico antes de confirmar.'
                  : 'Nome semelhante sem confirmação por CPF/CNPJ coincidente. Não presuma que é o mesmo cliente sem conferir o documento.'}
              </span>
            </div>
          )}

          {candidateInvoices.length > 0 && (
            <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={createFinReceipt}
                onChange={(e) => setCreateFinReceipt(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Registrar também o recebimento como <strong>Liquidado</strong> no módulo Financeiro vinculado a esta nota e transação bancária.
              </span>
            </label>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setLinkTarget(null)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!selectedInvoiceId || saving}
              onClick={() => void handleConfirmLink()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              {saving ? 'Conciliando...' : 'Confirmar Conciliação'}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir movimentação bancária"
        message={`Deseja excluir o lançamento bancário "${deleteTarget?.descricao}"?`}
        confirmLabel="Excluir"
        danger
        loading={saving}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
