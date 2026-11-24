import React, { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  Info,
  Loader2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type Customer,
  type Invoice,
  type InvoiceType,
} from '../../types/erp';
import { importInvoicesBatch, type InvoiceInput } from '../../services/erpService';
import { uploadCompanyFile } from '../../services/storageService';
import {
  autoDetectInvoiceColumns,
  buildOutboundInvoicePreview,
  digitsOnly,
  fileToBase64,
  findCustomerMatch,
  formatCpfCnpj,
  parseSpreadsheetWorkbook,
  type InvoiceColumnField,
  type InvoiceColumnMapping,
  type OutboundInvoicePreviewItem,
  type ParsedGenericWorkbook,
} from '../../utils/financeDocuments';
import { parseNFeXml } from '../../utils/parsers';
import { formatBRL, formatDateBR } from '../../utils/formatters';
import { Modal } from '../ui/CommonUI';
import { authorizedJsonFetch } from '../../lib/apiClient';

interface OutboundInvoiceImportModalProps {
  open: boolean;
  onClose: () => void;
  user: User;
  companyId: string;
  defaultSerie: string;
  existingInvoices: Invoice[];
  customers: Customer[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const INVOICE_MAPPING_FIELDS: { field: InvoiceColumnField; label: string }[] = [
  { field: 'numero', label: 'Número da Nota *' },
  { field: 'serie', label: 'Série' },
  { field: 'chaveAcesso', label: 'Chave de Acesso / Verificação' },
  { field: 'tipo', label: 'Modelo (NF-e / NFS-e / NFC-e)' },
  { field: 'tipoOperacao', label: 'Operação (Saída / Entrada)' },
  { field: 'dataEmissao', label: 'Data de Emissão *' },
  { field: 'dataVencimento', label: 'Data de Vencimento' },
  { field: 'clienteNome', label: 'Nome do Cliente *' },
  { field: 'clienteDocumento', label: 'CPF / CNPJ do Cliente' },
  { field: 'valor', label: 'Valor Total (R$) *' },
  { field: 'itensResumo', label: 'Itens / Informações Adicionais' },
];

type ImportMode = 'none' | 'xml' | 'spreadsheet' | 'pdf';

export const OutboundInvoiceImportModal: React.FC<OutboundInvoiceImportModalProps> = ({
  open,
  onClose,
  user,
  companyId,
  defaultSerie,
  existingInvoices,
  customers,
  onNotify,
}) => {
  const [importMode, setImportMode] = useState<ImportMode>('none');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [fileErrors, setFileErrors] = useState<Array<{ fileName: string; message: string }>>([]);

  // Planilha
  const [workbook, setWorkbook] = useState<ParsedGenericWorkbook | null>(null);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [mapping, setMapping] = useState<InvoiceColumnMapping>({
    numero: '',
    serie: '',
    chaveAcesso: '',
    tipo: '',
    tipoOperacao: '',
    dataEmissao: '',
    dataVencimento: '',
    clienteNome: '',
    clienteDocumento: '',
    valor: '',
    itensResumo: '',
  });

  // XML / PDF prévia direta
  const [directItems, setDirectItems] = useState<Array<OutboundInvoicePreviewItem & { sourceFile?: File }>>([]);
  const [selectionOverrides, setSelectionOverrides] = useState<Record<number, boolean>>({});
  const [archiveInStorage, setArchiveInStorage] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState(false);
  const [importing, setImporting] = useState(false);

  const resetState = () => {
    setImportMode('none');
    setSelectedFiles([]);
    setParsing(false);
    setFileErrors([]);
    setWorkbook(null);
    setSelectedSheet('');
    setDirectItems([]);
    setSelectionOverrides({});
    setArchiveInStorage(false);
    setConfirmedCheck(false);
    setImporting(false);
  };

  useEffect(() => {
    if (!open) resetState();
  }, [open]);

  const existingKeys = useMemo(() => {
    return new Set(
      existingInvoices.map((inv) =>
        inv.chaveAcesso
          ? `key:${inv.chaveAcesso.trim()}`
          : `num:${inv.numero.trim()}|${inv.serie.trim()}|${digitsOnly(inv.clienteDocumento)}`
      )
    );
  }, [existingInvoices]);

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    resetState();
    setSelectedFiles(files);
    setParsing(true);
    setFileErrors([]);

    try {
      const firstExt = files[0].name.split('.').pop()?.toLowerCase() ?? '';
      const allXml = files.every((f) => f.name.toLowerCase().endsWith('.xml'));

      if (allXml) {
        const parsedList: Array<OutboundInvoicePreviewItem & { sourceFile?: File }> = [];
        const errs: Array<{ fileName: string; message: string }> = [];

        for (let i = 0; i < files.length; i += 1) {
          const f = files[i];
          try {
            const text = await f.text();
            const parsed = parseNFeXml(text);
            const sig = parsed.chaveAcesso
              ? `key:${parsed.chaveAcesso.trim()}`
              : `num:${parsed.numero.trim()}|${parsed.serie.trim()}|${digitsOnly(parsed.clienteDocumento)}`;
            const duplicateOfExisting = existingKeys.has(sig);
            const customerMatch = findCustomerMatch(
              customers,
              parsed.clienteNome,
              parsed.clienteDocumento
            );

            parsedList.push({
              rowIndex: i + 1,
              numero: parsed.numero,
              serie: parsed.serie,
              chaveAcesso: parsed.chaveAcesso,
              tipo: parsed.tipo,
              dataEmissao: parsed.dataEmissao,
              dataVencimento: parsed.dataVencimento,
              clienteNome: parsed.clienteNome,
              clienteDocumento: parsed.clienteDocumento,
              valor: parsed.valor,
              itensResumo: parsed.itensResumo || parsed.descricaoServicos,
              customerMatch,
              duplicateOfExisting,
              isInboundRejected: false,
              errors: [],
              include: !duplicateOfExisting,
              sourceFile: f,
            });
          } catch (err: unknown) {
            errs.push({
              fileName: f.name,
              message: err instanceof Error ? err.message : 'Falha ao ler XML.',
            });
          }
        }

        setFileErrors(errs);
        setDirectItems(parsedList);
        if (parsedList.length > 0) {
          setImportMode('xml');
        }
        return;
      }

      if (files.length > 1) {
        throw new Error(
          'Para arquivos Excel, CSV ou PDF selecione um arquivo por vez. Para múltiplos arquivos de uma vez, envie apenas XMLs.'
        );
      }

      const file = files[0];
      if (firstExt === 'xlsx' || firstExt === 'xls' || firstExt === 'csv') {
        const parsed = await parseSpreadsheetWorkbook(file);
        const firstSheet = parsed.sheetNames[0];
        const headers = parsed.sheets[firstSheet]?.headers ?? [];
        setWorkbook(parsed);
        setSelectedSheet(firstSheet);
        setMapping(autoDetectInvoiceColumns(headers));
        setImportMode('spreadsheet');
      } else if (firstExt === 'pdf') {
        if (file.size > 10 * 1024 * 1024) {
          throw new Error('O arquivo PDF excede o limite de 10 MB.');
        }
        const pdfBase64 = await fileToBase64(file);
        const res = await authorizedJsonFetch('/api/finance/parse-pdf-invoice', {
          fileName: file.name,
          pdfBase64,
        });
        const data = (await res.json()) as {
          error?: string;
          invoice?: {
            numero: string;
            serie: string;
            chaveAcesso: string;
            tipo: InvoiceType;
            dataEmissao: string;
            dataVencimento: string;
            clienteNome: string;
            clienteDocumento: string;
            valor: number;
            itensResumo: string;
          };
        };
        if (!res.ok || !data.invoice) {
          throw new Error(data.error || 'Não foi possível extrair os dados da nota fiscal em PDF.');
        }

        const inv = data.invoice;
        const formattedDoc = formatCpfCnpj(inv.clienteDocumento).slice(0, FIELD_LIMITS.clienteDocumento);
        const sig = inv.chaveAcesso
          ? `key:${inv.chaveAcesso.trim()}`
          : `num:${inv.numero.trim()}|${inv.serie.trim()}|${digitsOnly(formattedDoc)}`;
        const duplicateOfExisting = existingKeys.has(sig);
        const customerMatch = findCustomerMatch(customers, inv.clienteNome, formattedDoc);

        setDirectItems([
          {
            rowIndex: 1,
            numero: inv.numero,
            serie: inv.serie || defaultSerie || '1',
            chaveAcesso: inv.chaveAcesso,
            tipo: inv.tipo,
            dataEmissao: inv.dataEmissao,
            dataVencimento: inv.dataVencimento,
            clienteNome: inv.clienteNome,
            clienteDocumento: formattedDoc,
            valor: inv.valor,
            itensResumo: inv.itensResumo,
            customerMatch,
            duplicateOfExisting,
            isInboundRejected: false,
            errors: [],
            include: !duplicateOfExisting,
            sourceFile: file,
          },
        ]);
        setImportMode('pdf');
      } else {
        throw new Error(
          'Formato não suportado. Envie XML (.xml), planilha Excel (.xlsx/.xls), CSV ou PDF.'
        );
      }
    } catch (err: unknown) {
      setFileErrors([
        {
          fileName: files[0]?.name ?? 'Arquivo',
          message: err instanceof Error ? err.message : 'Erro ao processar arquivo de nota fiscal.',
        },
      ]);
      setImportMode('none');
    } finally {
      setParsing(false);
    }
  };

  const handleSheetChange = (sheetName: string) => {
    if (!workbook) return;
    setSelectedSheet(sheetName);
    const headers = workbook.sheets[sheetName]?.headers ?? [];
    setMapping(autoDetectInvoiceColumns(headers));
    setSelectionOverrides({});
    setConfirmedCheck(false);
  };

  const currentSheet = workbook && selectedSheet ? workbook.sheets[selectedSheet] : null;

  const basePreviewItems = useMemo<Array<OutboundInvoicePreviewItem & { sourceFile?: File }>>(() => {
    if (importMode === 'spreadsheet' && currentSheet) {
      return buildOutboundInvoicePreview(
        currentSheet.rows,
        mapping,
        defaultSerie || '1',
        existingInvoices,
        customers
      );
    }
    if (importMode === 'xml' || importMode === 'pdf') {
      return directItems;
    }
    return [];
  }, [importMode, currentSheet, mapping, defaultSerie, existingInvoices, customers, directItems]);

  const previewItems = useMemo(() => {
    return basePreviewItems.map((item) => {
      const override = selectionOverrides[item.rowIndex];
      const include =
        item.errors.length > 0 || item.isInboundRejected
          ? false
          : override !== undefined
            ? override
            : item.include;
      return { ...item, include };
    });
  }, [basePreviewItems, selectionOverrides]);

  const stats = useMemo(() => {
    const selected = previewItems.filter((i) => i.include);
    const inboundRejected = previewItems.filter((i) => i.isInboundRejected);
    const duplicated = previewItems.filter((i) => i.duplicateOfExisting);
    const withErrors = previewItems.filter((i) => i.errors.length > 0);
    const similarNameWarnings = selected.filter(
      (i) => i.customerMatch.matchType === 'similar_name_only'
    );
    const totalValor = selected.reduce((s, i) => s + i.valor, 0);
    return {
      total: previewItems.length,
      selectedCount: selected.length,
      inboundCount: inboundRejected.length,
      duplicatedCount: duplicated.length,
      errorCount: withErrors.length,
      similarNameCount: similarNameWarnings.length,
      totalValor,
    };
  }, [previewItems]);

  const handleConfirmImport = async () => {
    if (!confirmedCheck || importing) return;
    const toImport = previewItems.filter(
      (i) => i.include && i.errors.length === 0 && !i.isInboundRejected
    );
    if (toImport.length === 0) {
      onNotify('error', 'Selecione ao menos uma nota fiscal de saída válida para importar.');
      return;
    }

    setImporting(true);
    try {
      let sharedStorageMeta: { storagePath: string; downloadUrl: string } | null = null;
      if (archiveInStorage && importMode !== 'xml' && selectedFiles[0]) {
        const uploaded = await uploadCompanyFile(user, companyId, 'fiscal', selectedFiles[0]);
        sharedStorageMeta = {
          storagePath: uploaded.storagePath,
          downloadUrl: uploaded.downloadUrl,
        };
      }

      const inputs: InvoiceInput[] = [];
      for (const item of toImport) {
        let storagePath = sharedStorageMeta?.storagePath ?? '';
        let downloadUrl = sharedStorageMeta?.downloadUrl ?? '';

        if (archiveInStorage && importMode === 'xml' && item.sourceFile) {
          const uploaded = await uploadCompanyFile(user, companyId, 'fiscal', item.sourceFile);
          storagePath = uploaded.storagePath;
          downloadUrl = uploaded.downloadUrl;
        }

        const cleanDoc = digitsOnly(item.clienteDocumento);
        const hasValidDoc = cleanDoc.length === 11 || cleanDoc.length === 14;
        const resolvedCustomerId =
          item.customerMatch.matchType === 'exact_cpf_cnpj' && item.customerMatch.matchedCustomer
            ? item.customerMatch.matchedCustomer.id
            : '';

        inputs.push({
          numero: item.numero,
          serie: item.serie,
          chaveAcesso: item.chaveAcesso,
          tipo: item.tipo,
          tipoOperacao: 'saida',
          clienteNome: item.clienteNome,
          clienteDocumento: hasValidDoc ? formatCpfCnpj(cleanDoc) : item.clienteDocumento,
          customerId: resolvedCustomerId,
          valor: item.valor,
          dataEmissao: item.dataEmissao,
          dataVencimento: item.dataVencimento,
          statusRecebimento: 'pendente',
          valorRecebido: 0,
          origemImportacao:
            importMode === 'xml'
              ? 'xml'
              : importMode === 'pdf'
                ? 'pdf'
                : selectedFiles[0]?.name.toLowerCase().endsWith('.csv')
                  ? 'csv'
                  : 'excel',
          itensResumo: item.itensResumo,
          descricaoServicos: item.itensResumo.slice(0, FIELD_LIMITS.descricaoServicos),
          storagePath,
          downloadUrl,
        });
      }

      const batchLabel =
        selectedFiles.length > 1
          ? `${selectedFiles.length} arquivos XML`
          : selectedFiles[0]?.name || 'Importação';

      const result = await importInvoicesBatch(user, companyId, inputs, batchLabel);
      onNotify(
        'success',
        `${result.importedCount} nota(s) fiscal(is) de saída importada(s)${
          result.createdCustomersCount > 0
            ? ` e ${result.createdCustomersCount} cliente(s) cadastrado(s) por CPF/CNPJ`
            : ''
        }.`
      );
      onClose();
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Erro ao gravar notas fiscais importadas.'
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Importar Notas Fiscais de Saída"
      subtitle="XML (NF-e / NFS-e / NFC-e), Excel, CSV ou PDF. O sistema apenas importa documentos existentes e confere recebimentos."
      onClose={onClose}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-5">
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-blue-950">
          <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <strong>Exclusivo para Notas Fiscais de Saída:</strong> este módulo não emite notas automaticamente e rejeita notas de entrada/compra. Clientes são identificados apenas por <strong>CPF/CNPJ coincidente</strong> — nomes semelhantes sem documento nunca são mesclados automaticamente.
          </p>
        </div>

        <div className="border-2 border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <FileCode2 className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {selectedFiles.length === 0
                  ? 'Selecione os arquivos de Notas Fiscais de Saída'
                  : selectedFiles.length === 1
                    ? selectedFiles[0].name
                    : `${selectedFiles.length} arquivos XML selecionados`}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Aceita <strong>múltiplos .xml</strong>, ou <strong>.xlsx, .xls, .csv, .pdf</strong> (máx. 10 MB)
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer whitespace-nowrap self-start sm:self-auto">
            {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {parsing ? 'Lendo documentos...' : 'Selecionar Arquivos'}
            <input
              type="file"
              multiple
              accept=".xml,.xlsx,.xls,.csv,.pdf,text/xml,application/xml"
              disabled={parsing || importing}
              onChange={(e) => {
                void handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>
        </div>

        {parsing && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3 text-sm text-blue-900">
            <Loader2 className="w-5 h-5 animate-spin shrink-0 text-blue-700" />
            <span>Extraindo número, série, chave, cliente, CPF/CNPJ, vencimento e itens das notas de saída...</span>
          </div>
        )}

        {fileErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-900">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>Arquivos recusados ou com erro de leitura ({fileErrors.length})</span>
            </div>
            <ul className="space-y-1 text-xs text-red-800 list-disc list-inside">
              {fileErrors.map((err, i) => (
                <li key={i}>
                  <strong>{err.fileName}:</strong> {err.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {importMode === 'spreadsheet' && workbook && currentSheet && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Mapeamento de Colunas da Planilha Fiscal
                </h3>
                <p className="text-xs text-slate-500">
                  Confira o vínculo das colunas antes de importar. Linhas marcadas como Entrada serão bloqueadas.
                </p>
              </div>
              {workbook.sheetNames.length > 1 && (
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
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {INVOICE_MAPPING_FIELDS.map((mf) => (
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
                <p className="text-[11px] text-slate-500">Notas Selecionadas</p>
                <p className="text-base font-semibold text-blue-700 font-mono tabular-nums mt-0.5">
                  {stats.selectedCount} / {stats.total}
                </p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-[11px] text-blue-700">Total Faturado (Seleção)</p>
                <p className="text-base font-semibold text-blue-900 font-mono tabular-nums mt-0.5">
                  {formatBRL(stats.totalValor)}
                </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-[11px] text-amber-800">Duplicadas / Recusadas</p>
                <p className="text-base font-semibold text-amber-900 font-mono tabular-nums mt-0.5">
                  {stats.duplicatedCount} dup. · {stats.inboundCount} entrada
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-[11px] text-slate-500">Erros / Homônimos s/ Doc</p>
                <p className="text-base font-semibold text-slate-800 font-mono tabular-nums mt-0.5">
                  {stats.errorCount} erro(s) · {stats.similarNameCount} aviso(s)
                </p>
              </div>
            </div>

            {stats.similarNameCount > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2.5 text-xs text-amber-950">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Existem <strong>{stats.similarNameCount}</strong> nota(s) sem CPF/CNPJ cujo nome do cliente é parecido com clientes já cadastrados. Conforme a regra de segurança, elas <strong>não serão vinculadas automaticamente</strong> ao cadastro existente.
                </span>
              </div>
            )}

            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Imp.</th>
                      <th className="px-3 py-2 text-left">Nota / Série</th>
                      <th className="px-3 py-2 text-left">Emissão / Venc.</th>
                      <th className="px-3 py-2 text-left">Cliente / CPF-CNPJ / Base</th>
                      <th className="px-3 py-2 text-left">Itens / Informações</th>
                      <th className="px-3 py-2 text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewItems.map((item) => {
                      const cleanDoc = digitsOnly(item.clienteDocumento);
                      const hasValidDoc = cleanDoc.length === 11 || cleanDoc.length === 14;
                      return (
                        <tr
                          key={item.rowIndex}
                          className={
                            item.errors.length > 0 || item.isInboundRejected
                              ? 'bg-red-50/50'
                              : item.duplicateOfExisting
                                ? 'bg-amber-50/40'
                                : ''
                          }
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              disabled={item.errors.length > 0 || item.isInboundRejected}
                              checked={item.include}
                              onChange={(e) =>
                                setSelectionOverrides((prev) => ({
                                  ...prev,
                                  [item.rowIndex]: e.target.checked,
                                }))
                              }
                            />
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p className="font-mono font-semibold text-slate-900">
                              {item.tipo} {item.numero || '—'}
                            </p>
                            <p className="text-[11px] text-slate-500 font-mono">
                              Série {item.serie}
                              {item.chaveAcesso ? ` · ${item.chaveAcesso.slice(0, 12)}...` : ''}
                            </p>
                            {item.duplicateOfExisting && (
                              <span className="inline-block mt-0.5 text-[10px] font-semibold text-amber-800">
                                Já importada
                              </span>
                            )}
                            {item.errors.length > 0 && (
                              <span className="block mt-0.5 text-[10px] font-semibold text-red-700">
                                {item.errors[0]}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">
                            <p>{item.dataEmissao ? formatDateBR(item.dataEmissao) : '—'}</p>
                            {item.dataVencimento && (
                              <p className="text-[11px] text-slate-500">
                                Venc: {formatDateBR(item.dataVencimento)}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 min-w-[200px]">
                            <p className="font-medium text-slate-900">{item.clienteNome || '—'}</p>
                            {item.clienteDocumento ? (
                              <p className="text-[11px] font-mono text-slate-500">
                                {item.clienteDocumento}
                              </p>
                            ) : (
                              <p className="text-[11px] text-amber-700">CPF/CNPJ não informado</p>
                            )}
                            {hasValidDoc ? (
                              item.customerMatch.matchType === 'exact_cpf_cnpj' ? (
                                <span className="inline-block text-[10px] font-medium text-emerald-700 mt-0.5">
                                  CPF/CNPJ já cadastrado
                                </span>
                              ) : (
                                <span className="inline-block text-[10px] font-medium text-blue-700 mt-0.5">
                                  Será cadastrado por CPF/CNPJ
                                </span>
                              )
                            ) : item.customerMatch.matchType === 'similar_name_only' ? (
                              <span className="inline-block text-[10px] font-medium text-amber-700 mt-0.5">
                                Sem CPF/CNPJ — nome semelhante encontrado (não mesclado)
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 max-w-[240px]">
                            <p className="text-slate-600 line-clamp-2">
                              {item.itensResumo || 'Sem itens detalhados'}
                            </p>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold whitespace-nowrap text-slate-900">
                            {formatBRL(item.valor)}
                          </td>
                        </tr>
                      );
                    })}
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
                  Arquivar cópia intacta do(s) documento(s) original(is) no Firebase Storage (requer Plano Blaze / Storage ativo).
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
                  Confirmo a importação de <strong>{stats.selectedCount}</strong> Nota(s) Fiscal(is) de Saída com os dados conferidos na prévia acima.
                </span>
              </label>
            </div>
          </div>
        )}

        {importMode === 'none' && !parsing && fileErrors.length === 0 && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex items-start gap-3 text-xs text-slate-600">
            <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-slate-800">Formatos suportados para Notas Fiscais de Saída:</p>
              <p>
                • <strong>XML oficial</strong> (NF-e, NFS-e, NFC-e): permite selecionar vários XMLs simultaneamente; bloqueia automaticamente XMLs de entrada (<code>tpNF = 0</code>).
              </p>
              <p>
                • <strong>Planilhas Excel (.xlsx/.xls) e CSV</strong>: permite mapear as colunas de número, série, chave, cliente, CPF/CNPJ, emissão, vencimento, itens e valor total.
              </p>
              <p>
                • <strong>PDF de DANFE / NFS-e</strong>: extrai os campos quando o PDF possui conteúdo legível e recusa documentos de entrada.
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
