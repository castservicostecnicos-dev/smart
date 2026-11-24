import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowUpDown,
  Boxes,
  Download,
  Edit3,
  FileSpreadsheet,
  History,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  INVENTORY_CATEGORIES,
  INVENTORY_UNITS,
  type InventoryCategory,
  type InventoryProduct,
  type InventoryUnit,
  type StockMovement,
} from '../types/erp';
import {
  createInventoryProduct,
  deleteInventoryProduct,
  updateInventoryProduct,
  type InventoryInput,
} from '../services/erpService';
import { formatBRL, formatNumberBR } from '../utils/formatters';
import { exportInventoryToExcel } from '../utils/inventorySpreadsheet';
import { ConfirmDialog, EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';
import { InventoryImportModal } from '../components/inventory/InventoryImportModal';
import { StockAiAssistantPanel } from '../components/inventory/StockAiAssistantPanel';
import { ProductHistoryModal } from '../components/inventory/ProductHistoryModal';

interface InventoryModuleProps {
  user: User;
  companyId: string;
  companyName: string;
  canEdit: boolean;
  loading: boolean;
  products: InventoryProduct[];
  movements: StockMovement[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
  onGoToMovements: () => void;
}

const EMPTY_FORM: InventoryInput = {
  sku: '',
  nome: '',
  categoria: INVENTORY_CATEGORIES[0],
  marca: '',
  modelo: '',
  capacidade: '',
  unidade: 'un',
  quantidade: 0,
  estoqueMinimo: 1,
  custoUnitario: 0,
  precoVenda: 0,
  localizacao: '',
  observacoes: '',
};

export const InventoryModule: React.FC<InventoryModuleProps> = ({
  user,
  companyId,
  companyName,
  canEdit,
  loading,
  products,
  movements,
  onNotify,
  onGoToMovements,
}) => {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<'todas' | InventoryCategory>('todas');
  const [onlyLowStock, setOnlyLowStock] = useState(false);
  const [sortBy, setSortBy] = useState<'nome_asc' | 'valor_desc' | 'qtd_asc'>('nome_asc');

  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [historyProduct, setHistoryProduct] = useState<InventoryProduct | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InventoryInput>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InventoryProduct | null>(null);

  const summary = useMemo(() => {
    const valorTotal = products.reduce((s, p) => s + p.quantidade * p.custoUnitario, 0);
    const valorVendaPotencial = products.reduce((s, p) => s + p.quantidade * p.precoVenda, 0);
    const lowStockItems = products.filter((p) => p.quantidade <= p.estoqueMinimo);
    return {
      valorTotal,
      valorVendaPotencial,
      abaixoMinimo: lowStockItems.length,
      lowStockItems,
    };
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (filterCategory !== 'todas' && p.categoria !== filterCategory) return false;
        if (onlyLowStock && p.quantidade > p.estoqueMinimo) return false;
        if (q) {
          const hay = `${p.sku} ${p.nome} ${p.marca ?? ''} ${p.modelo ?? ''} ${p.capacidade ?? ''} ${p.localizacao ?? ''} ${p.observacoes ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'nome_asc') return a.nome.localeCompare(b.nome);
        if (sortBy === 'valor_desc') {
          return b.quantidade * b.custoUnitario - a.quantidade * a.custoUnitario;
        }
        return a.quantidade - b.quantidade;
      });
  }, [products, search, filterCategory, onlyLowStock, sortBy]);

  const openCreate = () => {
    if (!canEdit) return;
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setModalOpen(true);
  };

  const openEdit = (prod: InventoryProduct) => {
    if (!canEdit) return;
    setEditingId(prod.id);
    setForm({
      sku: prod.sku,
      nome: prod.nome,
      categoria: prod.categoria,
      marca: prod.marca ?? '',
      modelo: prod.modelo ?? '',
      capacidade: prod.capacidade ?? '',
      unidade: prod.unidade,
      quantidade: prod.quantidade,
      estoqueMinimo: prod.estoqueMinimo,
      custoUnitario: prod.custoUnitario,
      precoVenda: prod.precoVenda,
      localizacao: prod.localizacao ?? '',
      observacoes: prod.observacoes ?? '',
    });
    setErrors({});
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.sku.trim()) errs.sku = 'Informe o código/SKU.';
    if (!form.nome.trim()) errs.nome = 'Informe o nome do produto ou equipamento.';
    if (form.quantidade < 0) errs.quantidade = 'Quantidade não pode ser negativa.';
    if (form.estoqueMinimo < 0) errs.estoqueMinimo = 'Estoque mínimo não pode ser negativo.';
    if (form.custoUnitario < 0) errs.custoUnitario = 'Custo inválido.';
    if (form.precoVenda < 0) errs.precoVenda = 'Preço inválido.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !validate() || saving) return;

    setSaving(true);
    try {
      if (editingId) {
        await updateInventoryProduct(user, companyId, editingId, form);
        onNotify('success', `Produto ${form.nome} atualizado.`);
      } else {
        await createInventoryProduct(user, companyId, form);
        onNotify('success', `Produto ${form.nome} cadastrado no estoque.`);
      }
      setModalOpen(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar produto.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!canEdit || !deleteTarget) return;
    setSaving(true);
    try {
      await deleteInventoryProduct(user, companyId, deleteTarget.id, deleteTarget.nome);
      onNotify('success', `Item "${deleteTarget.nome}" removido do estoque.`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao excluir item.');
    } finally {
      setSaving(false);
    }
  };

  const handleExportExcel = () => {
    const listToExport = filtered.length > 0 ? filtered : products;
    if (listToExport.length === 0) {
      onNotify('info', 'Não há produtos cadastrados para exportar.');
      return;
    }
    exportInventoryToExcel(listToExport, companyName);
    onNotify(
      'success',
      `Planilha Excel gerada com ${listToExport.length} ${listToExport.length === 1 ? 'produto' : 'produtos'}.`
    );
  };

  return (
    <div className="space-y-6">
      {/* KPIs Estoque */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Valor Total em Estoque (Custo)</p>
          <p className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
            {formatBRL(summary.valorTotal)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Potencial de Venda em Estoque</p>
          <p className="text-xl font-semibold text-blue-700 font-mono tabular-nums mt-1.5">
            {formatBRL(summary.valorVendaPotencial)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Produtos Abaixo do Mínimo</p>
          <p
            className={`text-xl font-semibold font-mono tabular-nums mt-1.5 ${
              summary.abaixoMinimo > 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {summary.abaixoMinimo} {summary.abaixoMinimo === 1 ? 'item' : 'itens'}
          </p>
        </div>
      </div>

      {/* Alerta de Estoque Mínimo */}
      {summary.abaixoMinimo > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <strong>Alerta de reposição:</strong> {summary.abaixoMinimo}{' '}
              {summary.abaixoMinimo === 1
                ? 'produto está igual ou abaixo do estoque mínimo'
                : 'produtos estão iguais ou abaixo do estoque mínimo'}
              {summary.lowStockItems.length > 0 && (
                <span className="text-amber-900">
                  {' '}
                  (
                  {summary.lowStockItems
                    .slice(0, 3)
                    .map((i) => `${i.nome}: ${i.quantidade} ${i.unidade}`)
                    .join(', ')}
                  {summary.lowStockItems.length > 3 ? '...' : ''})
                </span>
              )}
              .
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOnlyLowStock((prev) => !prev)}
            className="px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-lg hover:bg-amber-100/60 cursor-pointer shrink-0 self-start sm:self-auto"
          >
            {onlyLowStock ? 'Mostrar Todos os Itens' : 'Filtrar Abaixo do Mínimo'}
          </button>
        </div>
      )}

      {/* Assistente de Estoque por Texto e Voz */}
      <StockAiAssistantPanel
        user={user}
        companyId={companyId}
        canEdit={canEdit}
        products={products}
        onNotify={onNotify}
      />

      {/* Filtros e Ações */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar SKU, produto, localização, BTUs..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as 'todas' | InventoryCategory)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todas">Todas as categorias</option>
            {INVENTORY_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setOnlyLowStock((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
              onlyLowStock
                ? 'bg-amber-50 border-amber-400 text-amber-800'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Abaixo do mínimo
          </button>

          <button
            type="button"
            onClick={() =>
              setSortBy((s) =>
                s === 'nome_asc' ? 'valor_desc' : s === 'valor_desc' ? 'qtd_asc' : 'nome_asc'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {sortBy === 'nome_asc' && 'Ordem alfabética'}
            {sortBy === 'valor_desc' && 'Maior valor em estoque'}
            {sortBy === 'qtd_asc' && 'Menor quantidade'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={products.length === 0}
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Exportar Excel
          </button>

          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => setImportModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-[#0B1F3A] bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 whitespace-nowrap cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Importar Planilha
              </button>
              <button
                type="button"
                onClick={onGoToMovements}
                className="px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                Entrada / Saída
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Novo Produto
              </button>
            </>
          ) : (
            <span className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg whitespace-nowrap">
              Somente leitura
            </span>
          )}
        </div>
      </div>

      {/* Tabela */}
      {loading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Boxes className="w-6 h-6" />}
          title={
            products.length === 0
              ? 'Nenhum equipamento ou insumo cadastrado'
              : 'Nenhum item encontrado para os filtros atuais'
          }
          description={
            products.length === 0
              ? 'Cadastre produtos manualmente ou importe sua planilha Excel/CSV existente com o estoque atual da empresa.'
              : 'Limpe os filtros ou ajuste a busca para visualizar os itens.'
          }
          actionLabel={canEdit && products.length === 0 ? 'Importar Planilha de Estoque' : undefined}
          onAction={canEdit && products.length === 0 ? () => setImportModalOpen(true) : undefined}
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-5 py-3">Código / SKU</th>
                  <th className="text-left font-medium px-4 py-3">Equipamento / Material</th>
                  <th className="text-left font-medium px-4 py-3">Categoria / Local</th>
                  <th className="text-right font-medium px-4 py-3">Saldo / Mínimo</th>
                  <th className="text-right font-medium px-4 py-3">Custo Unit.</th>
                  <th className="text-right font-medium px-4 py-3">Total em Estoque</th>
                  <th className="text-right font-medium px-5 py-3">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((prod) => {
                  const isLow = prod.quantidade <= prod.estoqueMinimo;
                  const totalCost = prod.quantidade * prod.custoUnitario;
                  return (
                    <tr key={prod.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 font-mono text-xs text-slate-600 whitespace-nowrap">
                        {prod.sku}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{prod.nome}</p>
                        <p className="text-xs text-slate-500">
                          {[prod.marca, prod.modelo, prod.capacidade, prod.observacoes]
                            .filter(Boolean)
                            .join(' · ') || 'Sem observações adicionais'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <span className="block font-medium text-slate-700">{prod.categoria}</span>
                        <span className="text-[11px] text-slate-500">
                          {prod.localizacao || 'Sem localização'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            isLow ? 'text-amber-700' : 'text-slate-900'
                          }`}
                        >
                          {formatNumberBR(prod.quantidade, 2)} {prod.unidade}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          Mín: {formatNumberBR(prod.estoqueMinimo, 2)} {prod.unidade}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatBRL(prod.custoUnitario)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {formatBRL(totalCost)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setHistoryProduct(prod)}
                            title="Consultar histórico do produto"
                            className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-lg cursor-pointer"
                          >
                            <History className="w-4 h-4" />
                          </button>
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(prod)}
                                title="Editar produto"
                                className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(prod)}
                                title="Excluir produto"
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Produto */}
      <Modal
        open={modalOpen}
        title={editingId ? 'Editar Produto em Estoque' : 'Cadastrar Produto / Equipamento'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Código / SKU *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.sku}
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                placeholder="Ex.: AC-INV-12K"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
              {errors.sku && <p className="text-xs text-red-600 mt-1">{errors.sku}</p>}
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Nome do Produto *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.produtoNome}
                value={form.nome}
                onChange={(e) => setForm({ ...form, nome: e.target.value })}
                placeholder="Ex.: Porca de 3/8 / Tubo de Cobre 1/4 / Split Inverter 12.000 BTUs"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {errors.nome && <p className="text-xs text-red-600 mt-1">{errors.nome}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Categoria *</label>
              <select
                value={form.categoria}
                onChange={(e) => setForm({ ...form, categoria: e.target.value as InventoryCategory })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {INVENTORY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Unidade de Medida *
              </label>
              <select
                value={form.unidade}
                onChange={(e) => setForm({ ...form, unidade: e.target.value as InventoryUnit })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {INVENTORY_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Marca</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.marca}
                value={form.marca ?? ''}
                onChange={(e) => setForm({ ...form, marca: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Modelo</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.modelo}
                value={form.modelo ?? ''}
                onChange={(e) => setForm({ ...form, modelo: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Capacidade / Bitola
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.capacidade}
                value={form.capacidade ?? ''}
                onChange={(e) => setForm({ ...form, capacidade: e.target.value })}
                placeholder="Ex.: 12.000 BTUs / 1/4 pol"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Qtd. Atual *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.quantidade}
                onChange={(e) => setForm({ ...form, quantidade: Number(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {errors.quantidade && <p className="text-xs text-red-600 mt-1">{errors.quantidade}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Estoque Mín. *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.estoqueMinimo}
                onChange={(e) => setForm({ ...form, estoqueMinimo: Number(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {errors.estoqueMinimo && (
                <p className="text-xs text-red-600 mt-1">{errors.estoqueMinimo}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Custo Unit. (R$)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.custoUnitario}
                onChange={(e) => setForm({ ...form, custoUnitario: Number(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Preço Venda (R$)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.precoVenda}
                onChange={(e) => setForm({ ...form, precoVenda: Number(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Localização no Almoxarifado
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.localizacao}
              value={form.localizacao ?? ''}
              onChange={(e) => setForm({ ...form, localizacao: e.target.value })}
              placeholder="Ex.: Corredor B - Prateleira 2"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Observações</label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.observacoesProduto}
              value={form.observacoes ?? ''}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              placeholder="Especificações técnicas, fornecedor preferencial ou cuidados de armazenamento..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : editingId ? 'Salvar Alterações' : 'Cadastrar Produto'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Importação de Planilha */}
      <InventoryImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        user={user}
        companyId={companyId}
        existingProducts={products}
        onNotify={onNotify}
      />

      {/* Modal Histórico do Produto */}
      <ProductHistoryModal
        product={historyProduct}
        movements={movements}
        canEdit={canEdit}
        onClose={() => setHistoryProduct(null)}
        onGoToMovements={onGoToMovements}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir produto do estoque"
        message={`Deseja excluir "${deleteTarget?.nome}" (SKU: ${deleteTarget?.sku})?`}
        confirmLabel="Excluir"
        danger
        loading={saving}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
