import React, { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Upload,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type BankTransaction,
  type BankTxType,
} from '../../types/erp';
import { importBankTransactionsBatch, type BankTxInput } from '../../services/erpService';
import { uploadCompanyFile } from '../../services/storageService';
import {
  autoDetectBankColumns,
  buildBankPreviewFromSpreadsheet,
  extractCpfCnpjFromText,
  extractDocumentNumberFromText,
  extractPayerNameFromText,
  fileToBase64,
  formatCpfCnpj,
  normalizeTextKey,
  parseSpreadsheetWorkbook,
  type BankColumnField,
  type BankColumnMapping,
  type BankPreviewItem,
  type ParsedGenericWorkbook,
} from '../../utils/financeDocuments';
import { parseBankStatementFile } from '../../utils/parsers';
import { formatBRL, formatDateBR } from '../../utils/formatters';
import { Modal } from '../ui/CommonUI';
import { authorizedJsonFetch } from '../../lib/apiClient';

interface BankStatementImportModalProps {
  open: boolean;
  onClose: () => void;
  user: User;
  companyId: string;
  existingTransactions: BankTransaction[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const BANK_MAPPING_FIELDS: { field: BankColumnField; label: string; required?: boolean }[] = [
  { field: 'dataMovimento', label: 'Data do Movimento *', required: true },
  { field: 'descricao', label: 'Descrição / Histórico *', required: true },
  { field: 'valor', label: 'Valor Único (+/-)', required: false },
  { field: 'valorCredito', label: 'Valor Crédito (Entrada)' },
  { field: 'valorDebito', label: 'Valor Débito (Saída)' },
  { field: 'tipo', label: 'Tipo (Crédito/Débito)' },
  { field: 'nomePagador', label: 'Nome do Pagador / Cliente' },
  { field: 'cpfCnpjPagador', label: 'CPF / CNPJ do Pagador' },
  { field: 'documentoBancario', label: 'Nº Documento / NSU' },
  { field: 'fitId', label: 'Identificador Bancário (FITID)' },
  { field: 'banco', label: 'Banco' },
  { field: 'conta', label: 'Conta' },
];

type SourceMode = 'none' | 'spreadsheet' | 'ofx' | 'pdf';

export const BankStatementImportModal: React.FC<BankStatementImportModalProps> = ({
  open,
  onClose,
  user,
  companyId,
  existingTransactions,
  onNotify,
}) => {
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>('none');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // Planilha (Excel / CSV)
  const [workbook, setWorkbook] = useState<ParsedGenericWorkbook | null>(null);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [mapping, setMapping] = useState<BankColumnMapping>({
    dataMovimento: '',
    descricao: '',
    nomePagador: '',
    cpfCnpjPagador: '',
    valor: '',
    valorCredito: '',
    valorDebito: '',
    tipo: '',
    fitId: '',
    documentoBancario: '',
    banco: '',
    conta: '',
  });
  const [defaultBanco, setDefaultBanco] = useState('Extrato Bancário');
  const [defaultConta, setDefaultConta] = useState('');

  // OFX / PDF linhas diretas
  const [directRows, setDirectRows] = useState<BankPreviewItem[]>([]);
  const [rowSelectionOverrides, setRowSelectionOverrides] = useState<Record<number, boolean>>({});
  const [filterView, setFilterView] = useState<'todos' | 'validos' | 'duplicados' | 'erros'>('todos');
  const [archiveInStorage, setArchiveInStorage] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState(false);
  const [importing, setImporting] = useState(false);

  const resetState = () => {
    setOriginalFile(null);
    setSourceMode('none');
    setParsing(false);
    setParseError(null);
    setWorkbook(null);
    setSelectedSheet('');
    setDirectRows([]);
    setRowSelectionOverrides({});
    setFilterView('todos');
    setArchiveInStorage(false);
    setConfirmedCheck(false);
    setImporting(false);
  };

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open]);

  const existingDuplicateHelpers = useMemo(() => {
    const existingFitIds = new Set(existingTransactions.map((b) => b.fitId).filter(Boolean));
    const existingFingerprints = new Set(
      existingTransactions.map((b) => `${b.dataMovimento}|${b.valor.toFixed(2)}|${normalizeTextKey(b.descricao)}`)
    );
    return { existingFitIds, existingFingerprints };
  }, [existingTransactions]);

  const buildDirectPreviewItems = (
    rows: Array<{
      banco: string;
      conta: string;
      fitId: string;
      documentoBancario: string;
      nomePagador: string;
      cpfCnpjPagador: string;
      tipo: BankTxType;
      descricao: string;
      valor: number;
      dataMovimento: string;
    }>
  ): BankPreviewItem[] => {
    return rows.map((r, idx) => {
      const errors: string[] = [];
      if (!r.dataMovimento) errors.push('Data inválida.');
      if (!r.descricao) errors.push('Descrição ausente.');
      if (!Number.isFinite(r.valor) || r.valor <= 0) errors.push('Valor inválido.');
      const rounded = Number.isFinite(r.valor) ? Math.round(r.valor * 100) / 100 : 0;
      const fp = `${r.dataMovimento}|${rounded.toFixed(2)}|${normalizeTextKey(r.descricao)}`;
      const duplicateOfExisting =
        (Boolean(r.fitId) && existingDuplicateHelpers.existingFitIds.has(r.fitId)) ||
        (Boolean(r.dataMovimento) && existingDuplicateHelpers.existingFingerprints.has(fp));

      return {
        rowIndex: idx + 1,
        dataMovimento: r.dataMovimento,
        descricao: r.descricao.slice(0, FIELD_LIMITS.descricaoBanco),
        nomePagador: (r.nomePagador || extractPayerNameFromText(r.descricao)).slice(0, FIELD_LIMITS.nomePagador),
        cpfCnpjPagador: formatCpfCnpj(r.cpfCnpjPagador || extractCpfCnpjFromText(r.descricao)).slice(
          0,
          FIELD_LIMITS.cpfCnpjPagador
        ),
        valor: rounded,
        tipo: r.tipo,
        fitId: (r.fitId || `imp-${idx + 1}-${r.dataMovimento}`).slice(0, FIELD_LIMITS.fitId),
        documentoBancario: (r.documentoBancario || extractDocumentNumberFromText(r.descricao)).slice(
          0,
          FIELD_LIMITS.documentoBancario
        ),
        banco: (r.banco || 'Extrato Bancário').slice(0, FIELD_LIMITS.banco),
        conta: (r.conta || '').slice(0, FIELD_LIMITS.conta),
        duplicateOfExisting,
        errors,
        include: errors.length === 0 && !duplicateOfExisting,
      };
    });
  };

  const handleFileChange = async (file: File | null) => {
    if (!file) return;
    resetState();
    setOriginalFile(file);
    setParsing(true);
    setParseError(null);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        const parsed = await parseSpreadsheetWorkbook(file);
        const firstSheet = parsed.sheetNames[0];
        const headers = parsed.sheets[firstSheet]?.headers ?? [];
        setWorkbook(parsed);
        setSelectedSheet(firstSheet);
        setMapping(autoDetectBankColumns(headers));
        setSourceMode('spreadsheet');
      } else if (ext === 'ofx' || ext === 'txt') {
        const text = await file.text();
        if (ext === 'txt' && !text.includes('<OFX>') && !text.includes('<STMTTRN>')) {
          const parsed = await parseSpreadsheetWorkbook(file);
          const firstSheet = parsed.sheetNames[0];
          const headers = parsed.sheets[firstSheet]?.headers ?? [];
          setWorkbook(parsed);
          setSelectedSheet(firstSheet);
          setMapping(autoDetectBankColumns(headers));
          setSourceMode('spreadsheet');
        } else {
          const parsedRows = parseBankStatementFile(file.name, text);
          setDirectRows(buildDirectPreviewItems(parsedRows));
          setSourceMode('ofx');
        }
      } else if (ext === 'pdf') {
        if (file.size > 10 * 1024 * 1024) {
          throw new Error('O arquivo PDF excede o limite de 10 MB.');
        }
        const pdfBase64 = await fileToBase64(file);
        const res = await authorizedJsonFetch('/api/finance/parse-pdf-statement', {
          fileName: file.name,
          pdfBase64,
        });
        const data = (await res.json()) as {
          error?: string;
          banco?: string;
          conta?: string;
          transactions?: Array<{
            banco: string;
            conta: string;
            fitId: string;
            documentoBancario: string;
            nomePagador: string;
            cpfCnpjPagador: string;
            tipo: BankTxType;
            descricao: string;
            valor: number;
            dataMovimento: string;
          }>;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Não foi possível extrair os lançamentos do PDF.');
        }
        setDefaultBanco(data.banco || 'Extrato PDF');
        setDefaultConta(data.conta || '');
        setDirectRows(buildDirectPreviewItems(data.transactions ?? []));
        setSourceMode('pdf');
      } else {
        throw new Error(
          'Formato não suportado. Selecione arquivo Excel (.xlsx/.xls), CSV, OFX ou PDF.'
        );
      }
    } catch (err: unknown) {
      setParseError(
        err instanceof Error ? err.message : 'Falha ao ler o arquivo de extrato bancário.'
      );
      setSourceMode('none');
      setOriginalFile(null);
    } finally {
      setParsing(false);
    }
  };

  const handleSheetChange = (sheetName: string) => {
    if (!workbook) return;
    setSelectedSheet(sheetName);
    const headers = workbook.sheets[sheetName]?.headers ?? [];
    setMapping(autoDetectBankColumns(headers));
    setRowSelectionOverrides({});
    setConfirmedCheck(false);
  };

  const currentSheet = workbook && selectedSheet ? workbook.sheets[selectedSheet] : null;

  const basePreviewItems = useMemo<BankPreviewItem[]>(() => {
    if (sourceMode === 'spreadsheet' && currentSheet) {
      return buildBankPreviewFromSpreadsheet(
        currentSheet.rows,
        mapping,
        defaultBanco,
        defaultConta,
        existingTransactions
      );
    }
    if (sourceMode === 'ofx' || sourceMode === 'pdf') {
      return directRows;
    }
    return [];
  }, [
    sourceMode,
    currentSheet,
    mapping,
    defaultBanco,
    defaultConta,
    existingTransactions,
    directRows,
  ]);

  const previewItems = useMemo(() => {
    return basePreviewItems.map((item) => {
      const override = rowSelectionOverrides[item.rowIndex];
      const include = item.errors.length > 0 ? false : override !== undefined ? override : item.include;
      return { ...item, include };
    });
  }, [basePreviewItems, rowSelectionOverrides]);

  const stats = useMemo(() => {
    const selected = previewItems.filter((i) => i.include);
    const duplicated = previewItems.filter((i) => i.duplicateOfExisting);
    const withErrors = previewItems.filter((i) => i.errors.length > 0);
    const totalCredits = selected
      .filter((i) => i.tipo === 'credito')
      .reduce((s, i) => s + i.valor, 0);
    const totalDebits = selected
      .filter((i) => i.tipo === 'debito')
      .reduce((s, i) => s + i.valor, 0);
    return {
      total: previewItems.length,
      selectedCount: selected.length,
      duplicatedCount: duplicated.length,
      errorCount: withErrors.length,
      totalCredits,
      totalDebits,
    };
  }, [previewItems]);

  const filteredPreview = useMemo(() => {
    return previewItems.filter((item) => {
      if (filterView === 'validos') return item.errors.length === 0 && !item.duplicateOfExisting;
      if (filterView === 'duplicados') return item.duplicateOfExisting;
      if (filterView === 'erros') return item.errors.length > 0;
      return true;
    });
  }, [previewItems, filterView]);

  const handleConfirmImport = async () => {
    if (!originalFile || !confirmedCheck || importing) return;
    const toImport = previewItems.filter((i) => i.include && i.errors.length === 0);
    if (toImport.length === 0) {
      onNotify('error', 'Selecione ao menos uma movimentação válida para importar.');
      return;
    }

    setImporting(true);
    try {
      if (archiveInStorage) {
        await uploadCompanyFile(user, companyId, 'conciliacao', originalFile);
      }

      const payload: BankTxInput[] = toImport.map((item) => ({
        banco: item.banco,
        conta: item.conta,
        fitId: item.fitId,
        documentoBancario: item.documentoBancario,
        nomePagador: item.nomePagador,
        cpfCnpjPagador: item.cpfCnpjPagador,
        customerId: '',
        tipo: item.tipo,
        descricao: item.descricao,
        valor: item.valor,
        dataMovimento: item.dataMovimento,
        statusConciliacao: item.tipo === 'credito' ? 'sem_nf_localizada' : 'nao_conciliado',
        invoiceId: '',
        invoiceNumber: '',
        financialTransactionId: '',
        origemArquivo: originalFile.name.slice(0, FIELD_LIMITS.origemArquivo),
      }));

      const savedCount = await importBankTransactionsBatch(
        user,
        companyId,
        payload,
        originalFile.name
      );
      onNotify(
        'success',
        `${savedCount} movimentações bancárias de "${originalFile.name}" importadas com sucesso.`
      );
      onClose();
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao gravar movimentações do extrato.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Importar Extrato Bancário"
      subtitle="Aceita Excel (.xlsx, .xls), CSV, OFX e PDF (quando extraível). O arquivo original é preservado sem alterações."
      onClose={onClose}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-5">
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {originalFile ? originalFile.name : 'Selecione o arquivo de extrato bancário'}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Formatos suportados: <strong>.xlsx, .xls, .csv, .ofx, .txt, .pdf</strong> (máx. 10 MB)
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer whitespace-nowrap self-start sm:self-auto">
            {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {parsing ? 'Analisando arquivo...' : originalFile ? 'Trocar Arquivo' : 'Selecionar Extrato'}
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.ofx,.txt,.pdf"
              disabled={parsing || importing}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                void handleFileChange(file);
              }}
              className="hidden"
            />
          </label>
        </div>

        {parsing && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3 text-sm text-blue-900">
            <Loader2 className="w-5 h-5 animate-spin shrink-0 text-blue-700" />
            <span>Extraindo datas, descrições, pagadores, CPF/CNPJ e valores do extrato...</span>
          </div>
        )}

        {parseError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 text-sm text-red-800">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-semibold">Não foi possível processar o extrato</p>
              <p className="text-xs mt-1 leading-relaxed">{parseError}</p>
            </div>
          </div>
        )}

        {sourceMode === 'spreadsheet' && workbook && currentSheet && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Mapeamento de Colunas da Planilha
                </h3>
                <p className="text-xs text-slate-500">
                  Relacione as colunas do extrato aos campos do sistema antes de confirmar.
                </p>
              </div>
              {workbook.sheetNames.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-600">Aba:</span>
                  <select
                    value={selectedSheet}
                    onChange={(e) => handleSheetChange(e.target.value)}
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {workbook.sheetNames.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Banco padrão (quando não houver coluna)
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.banco}
                  value={defaultBanco}
                  onChange={(e) => setDefaultBanco(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Conta padrão (opcional)
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.conta}
                  value={defaultConta}
                  onChange={(e) => setDefaultConta(e.target.value)}
                  placeholder="Ex.: Ag 0001 / CC 12345-6"
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {BANK_MAPPING_FIELDS.map((mf) => (
                <div key={mf.field}>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    {mf.label}
                  </label>
                  <select
                    value={mapping[mf.field]}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [mf.field]: e.target.value }))
                    }
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">-- Não mapear --</option>
                    {currentSheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {previewItems.length > 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-[11px] text-slate-500">Selecionados p/ Importar</p>
                <p className="text-base font-semibold text-blue-700 font-mono tabular-nums mt-0.5">
                  {stats.selectedCount} / {stats.total}
                </p>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <p className="text-[11px] text-emerald-700">Total Entradas (Créditos)</p>
                <p className="text-base font-semibold text-emerald-800 font-mono tabular-nums mt-0.5">
                  {formatBRL(stats.totalCredits)}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-[11px] text-slate-500">Total Saídas (Débitos)</p>
                <p className="text-base font-semibold text-slate-800 font-mono tabular-nums mt-0.5">
                  {formatBRL(stats.totalDebits)}
                </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-[11px] text-amber-800">Duplicados / Erros</p>
                <p className="text-base font-semibold text-amber-900 font-mono tabular-nums mt-0.5">
                  {stats.duplicatedCount} dup. · {stats.errorCount} erro(s)
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  { id: 'todos', label: `Todos (${stats.total})` },
                  {
                    id: 'validos',
                    label: `Novos Válidos (${stats.total - stats.duplicatedCount - stats.errorCount})`,
                  },
                  { id: 'duplicados', label: `Duplicados (${stats.duplicatedCount})` },
                  { id: 'erros', label: `Com Erros (${stats.errorCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilterView(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer ${
                    filterView === tab.id
                      ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Imp.</th>
                      <th className="px-3 py-2 text-left">Data</th>
                      <th className="px-3 py-2 text-left">Descrição / Documento</th>
                      <th className="px-3 py-2 text-left">Pagador / CPF-CNPJ</th>
                      <th className="px-3 py-2 text-left">Situação</th>
                      <th className="px-3 py-2 text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredPreview.map((item) => (
                      <tr
                        key={item.rowIndex}
                        className={
                          item.errors.length > 0
                            ? 'bg-red-50/50'
                            : item.duplicateOfExisting
                              ? 'bg-amber-50/40'
                              : ''
                        }
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            disabled={item.errors.length > 0}
                            checked={item.include}
                            onChange={(e) =>
                              setRowSelectionOverrides((prev) => ({
                                ...prev,
                                [item.rowIndex]: e.target.checked,
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">
                          {item.dataMovimento ? formatDateBR(item.dataMovimento) : '—'}
                        </td>
                        <td className="px-3 py-2 min-w-[200px]">
                          <p className="font-medium text-slate-900">{item.descricao || '—'}</p>
                          <p className="text-[11px] text-slate-500 font-mono">
                            {item.banco}
                            {item.documentoBancario ? ` · Doc: ${item.documentoBancario}` : ''}
                            {item.fitId ? ` · ID: ${item.fitId.slice(0, 18)}` : ''}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <p className="text-slate-800">{item.nomePagador || 'Não identificado'}</p>
                          {item.cpfCnpjPagador && (
                            <p className="text-[11px] font-mono text-slate-500">
                              {item.cpfCnpjPagador}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {item.errors.length > 0 ? (
                            <span className="text-red-700 font-medium">
                              {item.errors[0]}
                            </span>
                          ) : item.duplicateOfExisting ? (
                            <span className="text-amber-700 font-medium">
                              Já existe no banco
                            </span>
                          ) : (
                            <span className="text-emerald-700 font-medium">Pronto</span>
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                            item.tipo === 'credito' ? 'text-emerald-700' : 'text-slate-700'
                          }`}
                        >
                          {item.tipo === 'credito' ? '+ ' : '- '}
                          {formatBRL(item.valor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-950 cursor-pointer">
                <input
                  type="checkbox"
                  checked={archiveInStorage}
                  onChange={(e) => setArchiveInStorage(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Arquivar cópia intacta do extrato original (<strong>{originalFile?.name}</strong>) no Firebase Storage para auditoria (requer Plano Blaze / Storage ativo).
                </span>
              </label>

              <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmedCheck}
                  onChange={(e) => setConfirmedCheck(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Confirmo que revisei os lançamentos na prévia acima e desejo gravar{' '}
                  <strong>{stats.selectedCount}</strong> movimentação(ões) bancária(s) no Firebase sem alterar o arquivo original.
                </span>
              </label>
            </div>
          </div>
        )}

        {sourceMode === 'none' && !parsing && !parseError && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex items-start gap-3 text-xs text-slate-600">
            <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-slate-800">Como funciona a importação de extratos:</p>
              <p>
                1. Planilhas Excel (.xlsx/.xls) e CSV permitem relacionar exatamente as colunas de data, histórico, pagador, CPF/CNPJ, valor, crédito/débito e identificador bancário.
              </p>
              <p>
                2. Arquivos OFX são interpretados diretamente com extração de FITID, documento, nome e CPF/CNPJ presente no histórico.
              </p>
              <p>
                3. PDFs bancários legíveis têm suas linhas extraídas automaticamente; caso seja um PDF escaneado sem texto legível, o sistema informa o motivo sem inventar dados.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
          <button
            type="button"
            disabled={importing}
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={importing || !confirmedCheck || stats.selectedCount === 0}
            onClick={() => void handleConfirmImport()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            {importing ? 'Importando...' : `Confirmar Importação (${stats.selectedCount})`}
          </button>
        </div>
      </div>
    </Modal>
  );
};
