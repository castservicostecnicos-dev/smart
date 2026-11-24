import React, { useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  CloudUpload,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  Printer,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import type {
  BankTransaction,
  CompanyDocument,
  Customer,
  FinancialTransaction,
  InventoryProduct,
  Invoice,
  ReconciliationRecord,
  SavedReport,
  StockMovement,
  StorageFolder,
  UserRole,
} from '../types/erp';
import { saveCompanyReport } from '../services/erpService';
import { deleteCompanyDocument, uploadCompanyFile } from '../services/storageService';
import {
  exportToCSV,
  formatBRL,
  formatDateBR,
  formatNumberBR,
  formatTimestampBR,
  todayISO,
} from '../utils/formatters';
import {
  buildFinancialReport,
  buildInventoryReport,
  exportReportsWorkbookXlsx,
  extractCustomerOptions,
  getSituationLabel,
  type BuiltReportData,
  type FinancialReportId,
  type InventoryReportId,
  type ReportFilterState,
  type ReportId,
  type ReportSituationFilter,
} from '../utils/reportExcelExporter';
import { CategoryValueChart, MonthlyCashflowChart } from '../components/charts/ErpCharts';
import { ConfirmDialog } from '../components/ui/CommonUI';

interface ReportsModuleProps {
  user: User;
  companyId: string;
  companyName: string;
  userRole: UserRole;
  hasFinanceAccess: boolean;
  hasInventoryAccess: boolean;
  canEdit: boolean;
  financials: FinancialTransaction[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  reconciliations: ReconciliationRecord[];
  customers: Customer[];
  inventory: InventoryProduct[];
  stockMovements: StockMovement[];
  savedReports: SavedReport[];
  documents: CompanyDocument[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const INVENTORY_REPORT_ITEMS: { id: InventoryReportId; label: string }[] = [
  { id: 'estoque_atual', label: 'Estoque atual' },
  { id: 'abaixo_minimo', label: 'Produtos abaixo do mínimo' },
  { id: 'entradas_periodo', label: 'Entradas por período' },
  { id: 'saidas_periodo', label: 'Saídas por período' },
  { id: 'movimentacoes_produto', label: 'Movimentações por produto' },
  { id: 'consumo_categoria', label: 'Consumo por categoria' },
  { id: 'valor_estimado_estoque', label: 'Valor estimado do estoque' },
];

const FINANCIAL_REPORT_ITEMS: { id: FinancialReportId; label: string }[] = [
  { id: 'recebimentos_periodo', label: 'Recebimentos por período' },
  { id: 'recebimentos_cliente', label: 'Recebimentos por cliente' },
  { id: 'notas_emitidas', label: 'Notas fiscais emitidas' },
  { id: 'notas_totalmente_recebidas', label: 'Notas totalmente recebidas' },
  { id: 'notas_parcialmente_recebidas', label: 'Notas parcialmente recebidas' },
  { id: 'notas_sem_recebimento', label: 'Notas sem recebimento identificado' },
  { id: 'recebimentos_sem_nota', label: 'Recebimentos sem nota localizada' },
  { id: 'divergencias_conciliacao', label: 'Divergências da conciliação' },
];

const FOLDER_LABELS: Record<StorageFolder, string> = {
  fiscal: 'Fiscal (XML/DANFE)',
  financeiro: 'Financeiro',
  conciliacao: 'Conciliação (OFX/CSV)',
  estoque: 'Estoque',
  relatorios: 'Relatórios',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function buildCsvBlob(headers: string[], rows: (string | number)[][]): Blob {
  const escapeCell = (val: string | number) => {
    const str = String(val ?? '');
    if (str.includes(';') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent =
    '\uFEFF' +
    [headers.map(escapeCell).join(';'), ...rows.map((row) => row.map(escapeCell).join(';'))].join('\r\n');
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}

function formatCellDisplay(
  val: string | number,
  colIdx: number,
  currencySet: Set<number>,
  numberSet: Set<number>
): string {
  if (typeof val === 'number') {
    if (currencySet.has(colIdx)) return formatBRL(val);
    if (numberSet.has(colIdx)) return formatNumberBR(val, 2);
  }
  return String(val ?? '—');
}

export const ReportsModule: React.FC<ReportsModuleProps> = ({
  user,
  companyId,
  companyName,
  hasFinanceAccess,
  hasInventoryAccess,
  canEdit,
  financials,
  invoices,
  bankTransactions,
  reconciliations,
  customers,
  inventory,
  stockMovements,
  savedReports,
  documents,
  onNotify,
}) => {
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const [activeDomain, setActiveDomain] = useState<'estoque' | 'financeiro'>(
    hasFinanceAccess ? 'financeiro' : 'estoque'
  );
  const [selectedReportId, setSelectedReportId] = useState<ReportId>(
    hasFinanceAccess ? 'recebimentos_periodo' : 'estoque_atual'
  );

  const [filters, setFilters] = useState<ReportFilterState>({
    startDate: '',
    endDate: '',
    customerKey: 'all',
    productId: 'all',
    situation: 'todas',
  });

  const [uploadFolder, setUploadFolder] = useState<StorageFolder>('relatorios');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [savingReport, setSavingReport] = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] = useState<CompanyDocument | null>(null);

  // Garantir domínio válido conforme permissões RBAC do usuário
  const effectiveDomain: 'estoque' | 'financeiro' =
    activeDomain === 'financeiro' && !hasFinanceAccess ? 'estoque' : activeDomain;

  const effectiveReportId: ReportId = useMemo(() => {
    if (effectiveDomain === 'estoque') {
      return INVENTORY_REPORT_ITEMS.some((r) => r.id === selectedReportId)
        ? selectedReportId
        : 'estoque_atual';
    }
    return FINANCIAL_REPORT_ITEMS.some((r) => r.id === selectedReportId)
      ? selectedReportId
      : 'recebimentos_periodo';
  }, [effectiveDomain, selectedReportId]);

  const customerOptions = useMemo(
    () =>
      hasFinanceAccess
        ? extractCustomerOptions(customers, invoices, financials, bankTransactions)
        : [],
    [hasFinanceAccess, customers, invoices, financials, bankTransactions]
  );

  const sortedProducts = useMemo(
    () => [...inventory].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    [inventory]
  );

  const customerLabel = useMemo(() => {
    if (filters.customerKey === 'all') return 'Todos os clientes';
    return customerOptions.find((c) => c.key === filters.customerKey)?.label ?? 'Cliente selecionado';
  }, [filters.customerKey, customerOptions]);

  const productLabel = useMemo(() => {
    if (filters.productId === 'all') return 'Todos os produtos';
    const prod = inventory.find((p) => p.id === filters.productId);
    return prod ? `${prod.sku} — ${prod.nome}` : 'Produto selecionado';
  }, [filters.productId, inventory]);

  // Construção determinística de todos os relatórios com dados reais do Firebase
  const allInventoryReports = useMemo<BuiltReportData[]>(() => {
    if (!hasInventoryAccess) return [];
    return INVENTORY_REPORT_ITEMS.map((item) =>
      buildInventoryReport(item.id, filters, inventory, stockMovements)
    );
  }, [hasInventoryAccess, filters, inventory, stockMovements]);

  const allFinancialReports = useMemo<BuiltReportData[]>(() => {
    if (!hasFinanceAccess) return [];
    return FINANCIAL_REPORT_ITEMS.map((item) =>
      buildFinancialReport(
        item.id,
        filters,
        customerOptions,
        financials,
        invoices,
        bankTransactions,
        reconciliations
      )
    );
  }, [
    hasFinanceAccess,
    filters,
    customerOptions,
    financials,
    invoices,
    bankTransactions,
    reconciliations,
  ]);

  const activeReport = useMemo<BuiltReportData>(() => {
    if (effectiveDomain === 'estoque') {
      return (
        allInventoryReports.find((r) => r.id === effectiveReportId) ??
        buildInventoryReport('estoque_atual', filters, inventory, stockMovements)
      );
    }
    return (
      allFinancialReports.find((r) => r.id === effectiveReportId) ??
      buildFinancialReport(
        'recebimentos_periodo',
        filters,
        customerOptions,
        financials,
        invoices,
        bankTransactions,
        reconciliations
      )
    );
  }, [
    effectiveDomain,
    effectiveReportId,
    allInventoryReports,
    allFinancialReports,
    filters,
    inventory,
    stockMovements,
    customerOptions,
    financials,
    invoices,
    bankTransactions,
    reconciliations,
  ]);

  // Séries para os gráficos reais
  const cashflowSeries = useMemo(() => {
    if (!hasFinanceAccess) return [];
    const map = new Map<string, { label: string; receitas: number; despesas: number }>();
    for (const item of financials) {
      if (item.status === 'cancelado' || !item.dataVencimento) continue;
      if (filters.startDate && item.dataVencimento < filters.startDate) continue;
      if (filters.endDate && item.dataVencimento > filters.endDate) continue;
      const key = item.dataVencimento.slice(0, 7);
      const parts = key.split('-');
      const label = parts.length === 2 ? `${parts[1]}/${parts[0]}` : key;
      const cur = map.get(key) ?? { label, receitas: 0, despesas: 0 };
      if (item.tipo === 'receita') cur.receitas += item.valor;
      else cur.despesas += item.valor;
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);
  }, [hasFinanceAccess, financials, filters.startDate, filters.endDate]);

  const categoryBreakdown = useMemo(() => {
    if (!hasInventoryAccess) return [];
    const map = new Map<string, { label: string; value: number; count: number }>();
    for (const prod of inventory) {
      if (filters.productId !== 'all' && prod.id !== filters.productId) continue;
      const val = prod.quantidade * prod.custoUnitario;
      const cur = map.get(prod.categoria) ?? { label: prod.categoria, value: 0, count: 0 };
      cur.value += val;
      cur.count += 1;
      map.set(prod.categoria, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [hasInventoryAccess, inventory, filters.productId]);

  const totalEstoqueCusto = useMemo(
    () => inventory.reduce((s, p) => s + p.quantidade * p.custoUnitario, 0),
    [inventory]
  );

  const applyCurrentMonthFilter = () => {
    const today = todayISO();
    const firstDay = `${today.slice(0, 7)}-01`;
    setFilters((prev) => ({ ...prev, startDate: firstDay, endDate: today }));
  };

  const applyLast30DaysFilter = () => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    const toIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setFilters((prev) => ({ ...prev, startDate: toIso(start), endDate: toIso(end) }));
  };

  const clearAllFilters = () => {
    setFilters({
      startDate: '',
      endDate: '',
      customerKey: 'all',
      productId: 'all',
      situation: 'todas',
    });
  };

  const handleExportActiveExcel = () => {
    exportReportsWorkbookXlsx({
      fileName: `relatorio_${activeReport.id}_${todayISO()}.xlsx`,
      companyName,
      filters,
      customerLabel,
      productLabel,
      reports: [activeReport],
    });
    onNotify('success', `Planilha Excel (.xlsx) "${activeReport.title}" exportada com filtros e totais.`);
  };

  const handleExportCategoryExcel = (scope: 'estoque' | 'financeiro' | 'completo') => {
    let targetReports: BuiltReportData[] = [];
    let slug = scope;
    if (scope === 'estoque') {
      targetReports = allInventoryReports;
    } else if (scope === 'financeiro') {
      targetReports = allFinancialReports;
    } else {
      targetReports = [...allFinancialReports, ...allInventoryReports];
      slug = 'completo';
    }

    if (targetReports.length === 0) {
      onNotify('info', 'Nenhum relatório disponível para este perfil e recorte.');
      return;
    }

    exportReportsWorkbookXlsx({
      fileName: `relatorios_${slug}_${todayISO()}.xlsx`,
      companyName,
      filters,
      customerLabel,
      productLabel,
      reports: targetReports,
    });

    onNotify(
      'success',
      `Arquivo Excel (.xlsx) gerado com ${targetReports.length} abas por categoria, datas DD/MM/AAAA, valores em R$ e totais.`
    );
  };

  const handleExportActiveCsv = () => {
    if (activeReport.rows.length === 0) {
      onNotify('info', 'Não há registros reais neste relatório para exportar em CSV.');
      return;
    }
    const currencySet = new Set(activeReport.currencyCols);
    const numberSet = new Set(activeReport.numberCols);
    const formattedRows = activeReport.rows.map((row) =>
      row.map((val, idx) =>
        typeof val === 'number'
          ? currencySet.has(idx) || numberSet.has(idx)
            ? val.toFixed(2).replace('.', ',')
            : val
          : val
      )
    );
    exportToCSV(`relatorio_${activeReport.id}_${todayISO()}`, activeReport.headers, formattedRows);
    onNotify('success', `Arquivo CSV "${activeReport.title}" exportado.`);
  };

  const handleSaveSnapshotReport = async () => {
    if (!canEdit || savingReport) return;
    setSavingReport(true);
    try {
      const currencySet = new Set(activeReport.currencyCols);
      const numberSet = new Set(activeReport.numberCols);
      const formattedRows = activeReport.rows.map((row) =>
        row.map((val, idx) =>
          typeof val === 'number' && (currencySet.has(idx) || numberSet.has(idx))
            ? val.toFixed(2).replace('.', ',')
            : val
        )
      );
      const csvBlob = buildCsvBlob(activeReport.headers, formattedRows);
      const fileName = `relatorio_${activeReport.id}_${Date.now()}.csv`;

      let storagePath = '';
      let downloadUrl = '';
      let storageWarning = '';

      try {
        const csvFile = new File([csvBlob], fileName, { type: 'text/csv' });
        const uploaded = await uploadCompanyFile(user, companyId, 'relatorios', csvFile);
        storagePath = uploaded.storagePath;
        downloadUrl = uploaded.downloadUrl;
      } catch (err: unknown) {
        storageWarning = err instanceof Error ? err.message : 'Firebase Storage indisponível.';
      }

      const firestoreTipo: SavedReport['tipo'] =
        activeReport.domain === 'estoque'
          ? 'estoque'
          : activeReport.id === 'divergencias_conciliacao' || activeReport.id === 'recebimentos_sem_nota'
            ? 'conciliacao'
            : activeReport.id.startsWith('notas_')
              ? 'notas_fiscais'
              : 'financeiro';

      const lastTotalCell = activeReport.totalsRow
        ? activeReport.totalsRow.findLast((v) => typeof v === 'number')
        : undefined;

      await saveCompanyReport(user, companyId, {
        titulo: activeReport.title,
        tipo: firestoreTipo,
        periodoInicio: filters.startDate || undefined,
        periodoFim: filters.endDate || undefined,
        totalRegistros: activeReport.rows.length,
        valorResumo: typeof lastTotalCell === 'number' ? lastTotalCell : 0,
        fileName,
        storagePath,
        downloadUrl,
      });

      if (storageWarning) {
        onNotify(
          'info',
          `Snapshot "${activeReport.title}" salvo no Firestore (Storage: ${storageWarning}).`
        );
      } else {
        onNotify('success', `Relatório "${activeReport.title}" salvo no Firestore e Firebase Storage.`);
      }
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar snapshot de relatório.');
    } finally {
      setSavingReport(false);
    }
  };

  const handleUploadDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !canEdit) return;
    setUploading(true);
    setUploadPct(0);
    try {
      await uploadCompanyFile(user, companyId, uploadFolder, file, undefined, setUploadPct);
      onNotify('success', `Arquivo "${file.name}" enviado para o Firebase Storage.`);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao enviar arquivo.');
    } finally {
      setUploading(false);
      setUploadPct(0);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const handleDeleteDocument = async () => {
    if (!deleteDocTarget || !canEdit) return;
    try {
      await deleteCompanyDocument(user, companyId, deleteDocTarget);
      onNotify('success', `Documento "${deleteDocTarget.nome}" removido.`);
      setDeleteDocTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao remover documento.');
    }
  };

  const currencySet = useMemo(() => new Set(activeReport.currencyCols), [activeReport.currencyCols]);
  const numberSet = useMemo(() => new Set(activeReport.numberCols), [activeReport.numberCols]);
  const previewRows = useMemo(() => activeReport.rows.slice(0, 150), [activeReport.rows]);

  return (
    <div className="space-y-6">
      {/* Barra de Filtros Globais + Pacotes Excel Multiabas */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 no-print">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Central de Relatórios Gerenciais e Exportação Excel
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Dados 100% reais do Cloud Firestore · Escolha período, cliente, produto e situação antes de gerar ou exportar.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasInventoryAccess && (
              <button
                type="button"
                onClick={() => handleExportCategoryExcel('estoque')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                Excel Estoque (7 abas)
              </button>
            )}
            {hasFinanceAccess && (
              <button
                type="button"
                onClick={() => handleExportCategoryExcel('financeiro')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-blue-700" />
                Excel Financeiro (8 abas)
              </button>
            )}
            <button
              type="button"
              onClick={() => handleExportCategoryExcel('completo')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              {hasFinanceAccess ? 'Excel Completo (Todas as Abas)' : 'Exportar Excel Completo'}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#0B1F3A] rounded-lg hover:bg-blue-900 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5" />
              Imprimir / PDF
            </button>
          </div>
        </div>

        {/* Grade de Filtros: Período, Cliente, Produto e Situação */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-3 border-t border-slate-100">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Data Inicial
            </label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilters((prev) => ({ ...prev, startDate: e.target.value }))}
              className="w-full px-3 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Data Final
            </label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilters((prev) => ({ ...prev, endDate: e.target.value }))}
              className="w-full px-3 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-lg"
            />
          </div>

          {hasFinanceAccess && (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Cliente (CPF/CNPJ)
              </label>
              <select
                value={filters.customerKey}
                onChange={(e) => setFilters((prev) => ({ ...prev, customerKey: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="all">Todos os clientes ({customerOptions.length})</option>
                {customerOptions.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {hasInventoryAccess && (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Produto
              </label>
              <select
                value={filters.productId}
                onChange={(e) => setFilters((prev) => ({ ...prev, productId: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="all">Todos os produtos ({sortedProducts.length})</option>
                {sortedProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.nome}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Situação
            </label>
            <select
              value={filters.situation}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  situation: e.target.value as ReportSituationFilter,
                }))
              }
              className="w-full px-3 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="todas">Todas as situações</option>
              {hasFinanceAccess && (
                <>
                  <option value="recebida_paga">Recebida / Paga / Conciliada</option>
                  <option value="parcial">Parcialmente recebida</option>
                  <option value="pendente">Pendente / Sem recebimento</option>
                  <option value="sem_nf">Sem nota fiscal localizada</option>
                  <option value="com_divergencia">Com divergência / Revisão</option>
                  <option value="cancelada">Cancelada</option>
                </>
              )}
              {hasInventoryAccess && (
                <option value="abaixo_minimo">Abaixo ou no mínimo (Estoque)</option>
              )}
            </select>
          </div>
        </div>

        {/* Atalhos rápidos de período e reset */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={applyCurrentMonthFilter}
              className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
            >
              Mês Atual
            </button>
            <button
              type="button"
              onClick={applyLast30DaysFilter}
              className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
            >
              Últimos 30 dias
            </button>
            {(filters.startDate ||
              filters.endDate ||
              filters.customerKey !== 'all' ||
              filters.productId !== 'all' ||
              filters.situation !== 'todas') && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 hover:text-blue-900 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Limpar filtros
              </button>
            )}
          </div>

          <span className="text-[11px] text-slate-500">
            Filtro ativo: {filters.startDate ? formatDateBR(filters.startDate) : 'Início'} a{' '}
            {filters.endDate ? formatDateBR(filters.endDate) : 'Atual'} ·{' '}
            {getSituationLabel(filters.situation)}
          </span>
        </div>
      </section>

      {/* Seletor de Categoria + Lista de Relatórios */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 no-print">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
            {hasFinanceAccess && (
              <button
                type="button"
                onClick={() => {
                  setActiveDomain('financeiro');
                  setSelectedReportId('recebimentos_periodo');
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  effectiveDomain === 'financeiro'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Financeiro e Conciliação ({FINANCIAL_REPORT_ITEMS.length})
              </button>
            )}
            {hasInventoryAccess && (
              <button
                type="button"
                onClick={() => {
                  setActiveDomain('estoque');
                  setSelectedReportId('estoque_atual');
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  effectiveDomain === 'estoque'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Estoque e Movimentações ({INVENTORY_REPORT_ITEMS.length})
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportActiveCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              CSV deste Relatório
            </button>
            <button
              type="button"
              onClick={handleExportActiveExcel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 cursor-pointer whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Exportar Excel (.xlsx)
            </button>
            {canEdit && (
              <button
                type="button"
                disabled={savingReport}
                onClick={() => void handleSaveSnapshotReport()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                {savingReport ? 'Salvando...' : 'Salvar na Nuvem'}
              </button>
            )}
          </div>
        </div>

        {/* Botões de seleção dos relatórios da categoria ativa */}
        <div className="px-5 py-3 bg-slate-50/70 border-b border-slate-200 flex flex-wrap gap-1.5 no-print">
          {(effectiveDomain === 'financeiro'
            ? FINANCIAL_REPORT_ITEMS
            : INVENTORY_REPORT_ITEMS
          ).map((item) => {
            const selected = item.id === activeReport.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedReportId(item.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                  selected
                    ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-blue-400 hover:text-blue-900'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Cabeçalho do Relatório Selecionado + Métricas Reais */}
        <div className="p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-slate-900">{activeReport.title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">{activeReport.description}</p>
            </div>
            <p className="text-xs text-slate-500 whitespace-nowrap">
              {activeReport.rows.length}{' '}
              {activeReport.rows.length === 1 ? 'registro real' : 'registros reais'}
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {activeReport.metrics.map((metric) => (
              <div
                key={metric.label}
                className="p-3.5 bg-slate-50/80 border border-slate-200 rounded-lg"
              >
                <p className="text-[11px] text-slate-500">{metric.label}</p>
                <p
                  className={`text-base sm:text-lg font-semibold font-mono tabular-nums mt-1 ${
                    metric.tone === 'positive'
                      ? 'text-emerald-700'
                      : metric.tone === 'warning'
                        ? 'text-amber-700'
                        : metric.tone === 'danger'
                          ? 'text-red-700'
                          : 'text-slate-900'
                  }`}
                >
                  {metric.value}
                </p>
              </div>
            ))}
          </div>

          {/* Tabela Real de Dados */}
          {activeReport.rows.length === 0 ? (
            <div className="py-10 px-4 text-center border border-dashed border-slate-200 rounded-xl">
              <p className="text-sm font-medium text-slate-700">{activeReport.emptyMessage}</p>
              <p className="text-xs text-slate-500 mt-1">
                Ajuste os filtros de período, cliente, produto ou situação acima, ou cadastre/importe os documentos nos módulos correspondentes.
              </p>
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
                    <tr>
                      {activeReport.headers.map((header, idx) => {
                        const isNumericCol = currencySet.has(idx) || numberSet.has(idx);
                        return (
                          <th
                            key={header}
                            className={`px-3 py-2.5 font-semibold whitespace-nowrap ${
                              isNumericCol ? 'text-right' : 'text-left'
                            }`}
                          >
                            {header}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewRows.map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-slate-50/80 transition-colors">
                        {row.map((cell, colIdx) => {
                          const isNumericCol = currencySet.has(colIdx) || numberSet.has(colIdx);
                          return (
                            <td
                              key={colIdx}
                              className={`px-3 py-2.5 ${
                                isNumericCol
                                  ? 'text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap'
                                  : 'text-left text-slate-700'
                              }`}
                            >
                              {formatCellDisplay(cell, colIdx, currencySet, numberSet)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  {activeReport.totalsRow && (
                    <tfoot className="bg-slate-100/80 border-t border-slate-200 font-semibold text-slate-900">
                      <tr>
                        {activeReport.totalsRow.map((cell, colIdx) => {
                          const isNumericCol = currencySet.has(colIdx) || numberSet.has(colIdx);
                          return (
                            <td
                              key={colIdx}
                              className={`px-3 py-2.5 whitespace-nowrap ${
                                isNumericCol ? 'text-right font-mono tabular-nums' : 'text-left'
                              }`}
                            >
                              {cell === ''
                                ? ''
                                : formatCellDisplay(cell, colIdx, currencySet, numberSet)}
                            </td>
                          );
                        })}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {activeReport.rows.length > previewRows.length && (
                <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-600">
                  Exibindo os primeiros {previewRows.length} de {activeReport.rows.length} registros na prévia. A exportação Excel (.xlsx) e CSV inclui todos os {activeReport.rows.length} registros.
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Gráficos Analíticos com Dados Reais */}
      {(hasFinanceAccess || hasInventoryAccess) && (
        <div
          className={`grid grid-cols-1 ${
            hasFinanceAccess && hasInventoryAccess ? 'lg:grid-cols-2' : ''
          } gap-6`}
        >
          {hasFinanceAccess && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h3 className="text-base font-semibold text-slate-900 mb-4">
                Evolução Financeira no Período
              </h3>
              <MonthlyCashflowChart data={cashflowSeries} />
            </div>
          )}
          {hasInventoryAccess && (
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h3 className="text-base font-semibold text-slate-900 mb-4">
                Valor Estimado do Estoque por Categoria ({formatBRL(totalEstoqueCusto)})
              </h3>
              <CategoryValueChart data={categoryBreakdown} />
            </div>
          )}
        </div>
      )}

      {/* Relatórios Salvos & Cofre de Documentos (Firebase Storage) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 no-print">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Histórico de Relatórios Salvos
              </h3>
              <p className="text-xs text-slate-500">
                Snapshots registrados no Cloud Firestore para {companyName}
              </p>
            </div>
          </div>

          {savedReports.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-200 rounded-lg">
              Nenhum relatório arquivado nesta empresa ainda. Use "Salvar na Nuvem" acima para registrar um snapshot.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {savedReports.slice(0, 10).map((rep) => (
                <div key={rep.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 truncate">{rep.titulo}</p>
                    <p className="text-slate-500">
                      {rep.createdByName} · {formatTimestampBR(rep.createdAt)} · {rep.totalRegistros}{' '}
                      registros
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono tabular-nums font-semibold text-slate-800">
                      {formatBRL(rep.valorResumo)}
                    </span>
                    {rep.downloadUrl && (
                      <a
                        href={rep.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-lg"
                        title="Baixar arquivo do Firebase Storage"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <FolderOpen className="w-5 h-5 text-blue-700 shrink-0" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Documentos e Planilhas (Storage)
                </h3>
                <p className="text-xs text-slate-500">
                  Arquivos protegidos por empresa e perfil RBAC
                </p>
              </div>
            </div>

            {canEdit && (
              <div className="flex items-center gap-2">
                <select
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value as StorageFolder)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {(Object.keys(FOLDER_LABELS) as StorageFolder[]).map((f) => (
                    <option key={f} value={f}>
                      {FOLDER_LABELS[f]}
                    </option>
                  ))}
                </select>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".xml,.csv,.ofx,.pdf,.xlsx,.xls,.txt,.json"
                  onChange={(e) => void handleUploadDocument(e)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => uploadInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <CloudUpload className="w-3.5 h-3.5" />
                  {uploading ? `Enviando ${uploadPct}%` : 'Enviar Arquivo'}
                </button>
              </div>
            )}
          </div>

          {documents.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-200 rounded-lg">
              Nenhum documento ou planilha armazenada no Firebase Storage para esta empresa.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {documents.slice(0, 10).map((docItem) => (
                <div key={docItem.id} className="py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 truncate">{docItem.nome}</p>
                    <p className="text-slate-500">
                      {FOLDER_LABELS[docItem.pasta]} · {formatBytes(docItem.tamanhoBytes)} ·{' '}
                      {docItem.uploadedByName}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <a
                      href={docItem.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-lg"
                      title="Abrir arquivo"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setDeleteDocTarget(docItem)}
                        className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                        title="Excluir arquivo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteDocTarget)}
        title="Excluir arquivo do Storage"
        message={`Deseja remover "${deleteDocTarget?.nome}" do Firebase Storage e do catálogo da empresa?`}
        confirmLabel="Excluir"
        danger
        onConfirm={() => void handleDeleteDocument()}
        onCancel={() => setDeleteDocTarget(null)}
      />
    </div>
  );
};
