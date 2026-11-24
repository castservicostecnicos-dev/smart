import React, { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Info,
  Loader2,
  Upload,
} from 'lucide-react';
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
  type InventoryProduct,
} from '../../types/erp';
import {
  importInventoryBatch,
  type ImportedProductAction,
} from '../../services/erpService';
import { uploadCompanyFile } from '../../services/storageService';
import {
  autoDetectColumnMapping,
  buildImportPreview,
  parseInventoryWorkbook,
  type ColumnMapping,
  type InventoryColumnField,
  type ParsedWorkbookData,
  type PreviewRowResult,
} from '../../utils/inventorySpreadsheet';
import { formatBRL, formatNumberBR } from '../../utils/formatters';
import { Modal } from '../ui/CommonUI';

interface InventoryImportModalProps {
  open: boolean;
  onClose: () => void;
  user: User;
  companyId: string;
  existingProducts: InventoryProduct[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const MAPPING_FIELDS: { field: InventoryColumnField; label: string; required?: boolean }[] = [
  { field: 'nome', label: 'Nome do Produto *', required: true },
  { field: 'sku', label: 'Código / SKU' },
  { field: 'unidade', label: 'Unidade de Medida' },
  { field: 'quantidade', label: 'Quantidade Atual' },
  { field: 'estoqueMinimo', label: 'Estoque Mínimo' },
  { field: 'categoria', label: 'Categoria' },
  { field: 'localizacao', label: 'Localização' },
  { field: 'custoUnitario', label: 'Custo Unitário (R$)' },
  { field: 'precoVenda', label: 'Preço de Venda (R$)' },
  { field: 'observacoes', label: 'Observações' },
];

type PreviewTab = 'todos' | 'novo' | 'existente' | 'duplicado_planilha' | 'erro';

export const InventoryImportModal: React.FC<InventoryImportModalProps> = ({
  open,
  onClose,
  user,
  companyId,
  existingProducts,
  onNotify,
}) => {
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<ParsedWorkbookData | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [mapping, setMapping] = useState<ColumnMapping>({
    sku: '',
    nome: '',
    categoria: '',
    unidade: '',
    quantidade: '',
    estoqueMinimo: '',
    localizacao: '',
    custoUnitario: '',
    precoVenda: '',
    observacoes: '',
  });
  const [defaultCategory, setDefaultCategory] = useState<InventoryCategory>('Insumos de Instalação');
  const [existingStrategy, setExistingStrategy] = useState<'skip' | 'add_stock'>('skip');
  const [archiveInStorage, setArchiveInStorage] = useState(false);
  const [rowOverrides, setRowOverrides] = useState<Record<number, 'create' | 'add_stock' | 'skip'>>({});
  const [activeTab, setActiveTab] = useState<PreviewTab>('todos');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmedCheck, setConfirmedCheck] = useState(false);

  const resetState = () => {
    setOriginalFile(null);
    setWorkbook(null);
    setSelectedSheet('');
    setRowOverrides({});
    setActiveTab('todos');
    setParseError(null);
    setImporting(false);
    setConfirmedCheck(false);
  };

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open]);

  const currentSheet = workbook && selectedSheet ? workbook.sheets[selectedSheet] : null;

  const handleFileChange = async (file: File | null) => {
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setRowOverrides({});
    setConfirmedCheck(false);
    try {
      const parsed = await parseInventoryWorkbook(file);
      const firstSheet = parsed.sheetNames[0];
      const headers = parsed.sheets[firstSheet]?.headers ?? [];
      setOriginalFile(file);
      setWorkbook(parsed);
      setSelectedSheet(firstSheet);
      setMapping(autoDetectColumnMapping(headers));
      setActiveTab('todos');
    } catch (err: unknown) {
      setParseError(
        err instanceof Error ? err.message : 'Não foi possível ler a planilha selecionada.'
      );
      setWorkbook(null);
      setOriginalFile(null);
    } finally {
      setParsing(false);
    }
  };

  const handleSheetChange = (sheetName: string) => {
    if (!workbook) return;
    setSelectedSheet(sheetName);
    const headers = workbook.sheets[sheetName]?.headers ?? [];
    setMapping(autoDetectColumnMapping(headers));
    setRowOverrides({});
    setConfirmedCheck(false);
  };

  const previewRows = useMemo<PreviewRowResult[]>(() => {
    if (!currentSheet) return [];
    const base = buildImportPreview(
      currentSheet.rows,
      mapping,
      existingProducts,
      defaultCategory,
      existingStrategy
    );
    return base.map((row) => ({
      ...row,
      selectedAction: rowOverrides[row.rowIndex] ?? row.selectedAction,
    }));
  }, [currentSheet, mapping, existingProducts, defaultCategory, existingStrategy, rowOverrides]);

  const counts = useMemo(() => {
    let novos = 0;
    let existentes = 0;
    let duplicados = 0;
    let erros = 0;
    let actionableCreate = 0;
    let actionableAdd = 0;

    for (const r of previewRows) {
      if (r.status === 'novo') novos += 1;
      else if (r.status === 'existente') existentes += 1;
      else if (r.status === 'duplicado_planilha') duplicados += 1;
      else if (r.status === 'erro') erros += 1;

      if (r.errors.length === 0) {
        if (r.selectedAction === 'create') actionableCreate += 1;
        else if (r.selectedAction === 'add_stock' && r.existingProduct && r.parsed.quantidade > 0) {
          actionableAdd += 1;
        }
      }
    }

    return {
      total: previewRows.length,
      novos,
      existentes,
      duplicados,
      erros,
      actionableCreate,
      actionableAdd,
      totalActionable: actionableCreate + actionableAdd,
    };
  }, [previewRows]);

  const filteredPreview = useMemo(() => {
    if (activeTab === 'todos') return previewRows;
    return previewRows.filter((r) => r.status === activeTab);
  }, [previewRows, activeTab]);

  const handleConfirmImport = async () => {
    if (!workbook || importing || counts.totalActionable === 0 || !confirmedCheck) return;

    const actions: ImportedProductAction[] = [];
    for (const row of previewRows) {
      if (row.errors.length > 0) continue;
      if (row.selectedAction === 'create') {
        actions.push({
          mode: 'create',
          product: {
            ...row.parsed,
            arquivoImportacao: workbook.fileName,
          },
        });
      } else if (
        row.selectedAction === 'add_stock' &&
        row.existingProduct &&
        row.parsed.quantidade > 0
      ) {
        actions.push({
          mode: 'add_stock',
          existingProductId: row.existingProduct.id,
          product: {
            ...row.parsed,
            arquivoImportacao: workbook.fileName,
          },
        });
      }
    }

    if (actions.length === 0) {
      onNotify('info', 'Nenhum item selecionado para importação.');
      return;
    }

    setImporting(true);
    try {
      const result = await importInventoryBatch(user, companyId, actions, workbook.fileName);

      if (archiveInStorage && originalFile) {
        try {
          await uploadCompanyFile(user, companyId, 'estoque', originalFile);
        } catch (storageErr: unknown) {
          onNotify(
            'info',
            `Estoque importado (${result.createdCount} novos, ${result.stockedExistingCount} entradas), mas o arquivo original não pôde ser salvo no Storage: ${
              storageErr instanceof Error ? storageErr.message : 'verifique a ativação do Storage'
            }`
          );
          onClose();
          return;
        }
      }

      onNotify(
        'success',
        `Importação concluída no Firebase: ${result.createdCount} produto(s) criado(s) e ${result.stockedExistingCount} entrada(s) em itens existentes.`
      );
      onClose();
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Erro ao gravar importação de estoque no Firebase.'
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Importar Planilha de Estoque (.xlsx, .xls, .csv)"
      subtitle="Mapeie as colunas da planilha, revise duplicidades e erros e confirme antes de gravar no Firebase."
      onClose={() => {
        if (!importing) onClose();
      }}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-5">
        {/* Upload */}
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {workbook ? workbook.fileName : 'Selecione a planilha de estoque da empresa'}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Formatos aceitos: Excel (.xlsx, .xls) ou CSV (.csv). Os dados originais são preservados na prévia.
              </p>
            </div>
          </div>

          <label className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[#0B1F3A] hover:bg-blue-900 rounded-lg cursor-pointer shrink-0">
            {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {workbook ? 'Trocar Planilha' : 'Selecionar Arquivo'}
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              disabled={parsing || importing}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                void handleFileChange(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {parseError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{parseError}</span>
          </div>
        )}

        {workbook && currentSheet && (
          <>
            {/* Informativo transparente sobre saldos iniciais */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-blue-950 leading-relaxed">
              <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
              <div>
                <strong>Como os dados e saldos iniciais serão registrados:</strong> cada linha original da planilha permanece visível abaixo para conferência antes da gravação. Novos produtos serão criados com o saldo da planilha e gerarão automaticamente uma movimentação de entrada (<em>&quot;Entrada de material — Saldo inicial importado&quot;</em>) além do registro no Histórico de Operações.
              </div>
            </div>

            {/* Opções gerais e Aba */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
              {workbook.sheetNames.length > 1 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Aba da Planilha
                  </label>
                  <select
                    value={selectedSheet}
                    onChange={(e) => handleSheetChange(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {workbook.sheetNames.map((name) => (
                      <option key={name} value={name}>
                        {name} ({workbook.sheets[name]?.rows.length ?? 0} linhas)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Categoria Padrão (quando não informada)
                </label>
                <select
                  value={defaultCategory}
                  onChange={(e) => setDefaultCategory(e.target.value as InventoryCategory)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {INVENTORY_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Se o produto já existir no sistema
                </label>
                <select
                  value={existingStrategy}
                  onChange={(e) => {
                    setExistingStrategy(e.target.value as 'skip' | 'add_stock');
                    setRowOverrides({});
                  }}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="skip">Ignorar itens já cadastrados</option>
                  <option value="add_stock">Somar quantidade como Entrada de material</option>
                </select>
              </div>
            </div>

            {/* Mapeamento de Colunas */}
            <div className="border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  Relacionar Colunas da Planilha aos Campos do Sistema
                </h3>
                <span className="text-[11px] text-slate-500">
                  {currentSheet.headers.length} colunas detectadas · {currentSheet.rows.length} linhas de dados
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {MAPPING_FIELDS.map((mf) => (
                  <div key={mf.field}>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      {mf.label}
                    </label>
                    <select
                      value={mapping[mf.field]}
                      onChange={(e) =>
                        setMapping((prev) => ({ ...prev, [mf.field]: e.target.value }))
                      }
                      className={`w-full px-2.5 py-1.5 text-xs border rounded-lg bg-white ${
                        mf.required && !mapping[mf.field]
                          ? 'border-red-400 bg-red-50/40'
                          : 'border-slate-300'
                      }`}
                    >
                      <option value="">(Não mapear)</option>
                      {currentSheet.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {/* Resumo e Filtros da Prévia */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { id: 'todos', label: `Todos (${counts.total})` },
                    { id: 'novo', label: `Novos (${counts.novos})` },
                    { id: 'existente', label: `Já cadastrados (${counts.existentes})` },
                    { id: 'duplicado_planilha', label: `Duplicados na planilha (${counts.duplicados})` },
                    { id: 'erro', label: `Com erro (${counts.erros})` },
                  ] as { id: PreviewTab; label: string }[]
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer transition-colors ${
                      activeTab === tab.id
                        ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={archiveInStorage}
                  onChange={(e) => setArchiveInStorage(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Arquivar planilha original no Firebase Storage
              </label>
            </div>

            {/* Tabela de Prévia */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0 z-10">
                    <tr>
                      <th className="text-left font-medium px-3 py-2.5">Linha</th>
                      <th className="text-left font-medium px-3 py-2.5">Status</th>
                      <th className="text-left font-medium px-3 py-2.5">Código / Produto</th>
                      <th className="text-left font-medium px-3 py-2.5">Unid. / Cat.</th>
                      <th className="text-right font-medium px-3 py-2.5">Qtd. / Mín.</th>
                      <th className="text-right font-medium px-3 py-2.5">Custo</th>
                      <th className="text-left font-medium px-3 py-2.5">Ação na Importação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredPreview.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                          Nenhuma linha encontrada nesta categoria.
                        </td>
                      </tr>
                    ) : (
                      filteredPreview.map((row) => (
                        <tr
                          key={row.rowIndex}
                          className={
                            row.status === 'erro'
                              ? 'bg-red-50/40'
                              : row.status === 'duplicado_planilha'
                                ? 'bg-amber-50/40'
                                : 'hover:bg-slate-50/60'
                          }
                        >
                          <td className="px-3 py-2.5 font-mono text-slate-500">#{row.rowIndex}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {row.status === 'novo' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-medium">
                                <CheckCircle2 className="w-3 h-3" />
                                Novo
                              </span>
                            )}
                            {row.status === 'existente' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-medium">
                                Já cadastrado
                              </span>
                            )}
                            {row.status === 'duplicado_planilha' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-medium">
                                Duplicado na planilha
                              </span>
                            )}
                            {row.status === 'erro' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-50 text-red-800 border border-red-200 font-medium">
                                Erro
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 min-w-[200px]">
                            <p className="font-medium text-slate-900">
                              {row.parsed.nome || <span className="text-red-600 italic">(Sem nome)</span>}
                            </p>
                            <p className="text-[11px] font-mono text-slate-500">
                              SKU: {row.parsed.sku}
                              {row.parsed.localizacao ? ` · ${row.parsed.localizacao}` : ''}
                            </p>
                            {row.errors.length > 0 && (
                              <p className="text-[11px] text-red-700 font-medium mt-0.5">
                                {row.errors.join(' ')}
                              </p>
                            )}
                            {row.existingProduct && (
                              <p className="text-[11px] text-blue-700 mt-0.5">
                                Atual no estoque: {formatNumberBR(row.existingProduct.quantidade, 2)}{' '}
                                {row.existingProduct.unidade}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">
                            <span className="font-semibold text-slate-800">{row.parsed.unidade}</span>
                            <span className="block text-[11px] text-slate-500">{row.parsed.categoria}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                            <span className="font-semibold text-slate-900">
                              {formatNumberBR(row.parsed.quantidade, 2)}
                            </span>
                            <span className="block text-[11px] text-slate-500">
                              Mín: {formatNumberBR(row.parsed.estoqueMinimo, 2)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                            {formatBRL(row.parsed.custoUnitario)}
                          </td>
                          <td className="px-3 py-2.5">
                            {row.errors.length > 0 || row.status === 'duplicado_planilha' ? (
                              <span className="text-[11px] text-slate-500">Ignorado automaticamente</span>
                            ) : row.existingProduct ? (
                              <select
                                value={row.selectedAction}
                                onChange={(e) =>
                                  setRowOverrides((prev) => ({
                                    ...prev,
                                    [row.rowIndex]: e.target.value as 'add_stock' | 'skip',
                                  }))
                                }
                                className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                              >
                                <option value="skip">Ignorar existente</option>
                                {row.parsed.quantidade > 0 && (
                                  <option value="add_stock">
                                    Somar +{formatNumberBR(row.parsed.quantidade, 2)} (Entrada)
                                  </option>
                                )}
                              </select>
                            ) : (
                              <select
                                value={row.selectedAction}
                                onChange={(e) =>
                                  setRowOverrides((prev) => ({
                                    ...prev,
                                    [row.rowIndex]: e.target.value as 'create' | 'skip',
                                  }))
                                }
                                className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                              >
                                <option value="create">Criar novo produto</option>
                                <option value="skip">Ignorar linha</option>
                              </select>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Confirmação explícita */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <label className="inline-flex items-start gap-2.5 text-xs text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmedCheck}
                  onChange={(e) => setConfirmedCheck(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span>
                  Confirmo que revisei a prévia acima e autorizo a gravação de{' '}
                  <strong>{counts.actionableCreate} novo(s) produto(s)</strong> e{' '}
                  <strong>{counts.actionableAdd} entrada(s) de saldo</strong> no banco de dados da empresa.
                </span>
              </label>

              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  disabled={importing}
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={importing || counts.totalActionable === 0 || !confirmedCheck}
                  onClick={() => void handleConfirmImport()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {importing
                    ? 'Importando no Firebase...'
                    : `Confirmar Importação (${counts.totalActionable} itens)`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
