import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Plus,
  Search,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  STOCK_MOVEMENT_REASONS_ENTRADA,
  STOCK_MOVEMENT_REASONS_SAIDA,
  type InventoryProduct,
  type StockMovement,
  type StockMovementReason,
  type StockMovementType,
} from '../types/erp';
import { recordStockMovement } from '../services/erpService';
import { formatBRL, formatDateBR, formatNumberBR, todayISO } from '../utils/formatters';
import { EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';

interface StockMovementsModuleProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  loading: boolean;
  products: InventoryProduct[];
  movements: StockMovement[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

export const StockMovementsModule: React.FC<StockMovementsModuleProps> = ({
  user,
  companyId,
  canEdit,
  loading,
  products,
  movements,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [filterTipo, setFilterTipo] = useState<'todos' | StockMovementType>('todos');

  const [modalOpen, setModalOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [form, setForm] = useState({
    productId: '',
    tipo: 'saida' as StockMovementType,
    motivo: 'Retirada para instalação' as StockMovementReason,
    quantidade: 1,
    responsavel: user.displayName || user.email || '',
    documentoReferencia: '',
    dataMovimentacao: todayISO(),
    observacoes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const productUnitMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) {
      map.set(p.id, p.unidade);
    }
    return map;
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return movements
      .filter((m) => {
        if (filterTipo !== 'todos' && m.tipo !== filterTipo) return false;
        if (q) {
          const hay = `${m.productName} ${m.productSku} ${m.responsavel} ${m.motivo} ${m.documentoReferencia ?? ''} ${m.observacoes ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.dataMovimentacao.localeCompare(a.dataMovimentacao));
  }, [movements, search, filterTipo]);

  const openMovement = (tipo: StockMovementType) => {
    if (!canEdit) return;
    setIdempotencyKey(
      `mov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    );
    setForm({
      productId: products[0]?.id ?? '',
      tipo,
      motivo: tipo === 'entrada' ? 'Compra' : 'Retirada para instalação',
      quantidade: 1,
      responsavel: user.displayName || user.email || '',
      documentoReferencia: '',
      dataMovimentacao: todayISO(),
      observacoes: '',
    });
    setErrors({});
    setModalOpen(true);
  };

  const selectedProduct = products.find((p) => p.id === form.productId);
  const availableReasons =
    form.tipo === 'entrada' ? STOCK_MOVEMENT_REASONS_ENTRADA : STOCK_MOVEMENT_REASONS_SAIDA;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    const errs: Record<string, string> = {};
    if (!form.productId) errs.productId = 'Selecione um item do estoque.';
    if (!Number.isFinite(form.quantidade) || form.quantidade <= 0) {
      errs.quantidade = 'Informe uma quantidade maior que zero.';
    }
    if (
      form.tipo === 'saida' &&
      selectedProduct &&
      form.quantidade > selectedProduct.quantidade
    ) {
      errs.quantidade = `Saldo insuficiente. Disponível: ${selectedProduct.quantidade} ${selectedProduct.unidade}.`;
    }
    if (!form.responsavel.trim()) errs.responsavel = 'Informe o técnico ou responsável.';
    if (!form.dataMovimentacao) errs.dataMovimentacao = 'Informe a data.';
    setErrors(errs);
    if (Object.keys(errs).length > 0 || saving) return;

    setSaving(true);
    try {
      await recordStockMovement(user, companyId, {
        ...form,
        idempotencyKey,
      });
      onNotify(
        'success',
        `Movimentação de ${form.tipo === 'entrada' ? 'entrada' : 'saída'} registrada e saldo atualizado em tempo real.`
      );
      setModalOpen(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao registrar movimentação.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-blue-50/70 border border-blue-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-blue-950">
        <span>
          <strong>Sincronização em Tempo Real e Proteção Atômica:</strong> cada movimentação é executada via transação no Cloud Firestore com bloqueio de duplicidade, proibição de saldo negativo e atualização instantânea para todos os usuários autorizados.
        </span>
        {!canEdit && (
          <span className="font-semibold text-amber-800 whitespace-nowrap">
            Modo somente leitura
          </span>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar produto, SKU, técnico, motivo ou OS/NF..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <select
            value={filterTipo}
            onChange={(e) => setFilterTipo(e.target.value as 'todos' | StockMovementType)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todos">Entradas e Saídas</option>
            <option value="entrada">Somente Entradas</option>
            <option value="saida">Somente Saídas</option>
          </select>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={products.length === 0}
              onClick={() => openMovement('entrada')}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              Entrada no Estoque
            </button>
            <button
              type="button"
              disabled={products.length === 0}
              onClick={() => openMovement('saida')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              Registrar Saída
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ArrowLeftRight className="w-6 h-6" />}
          title={
            products.length === 0
              ? 'Cadastre produtos no Estoque antes de movimentar'
              : 'Nenhuma movimentação de estoque registrada'
          }
          description={
            products.length === 0
              ? 'Para registrar entradas de compras ou saídas para instalações e manutenções, adicione itens primeiro no módulo Estoque.'
              : 'Todas as entradas e saídas ficam gravadas de forma atômica com saldo anterior, saldo atualizado e responsável.'
          }
          actionLabel={canEdit && products.length > 0 ? 'Registrar Primeira Movimentação' : undefined}
          onAction={canEdit && products.length > 0 ? () => openMovement('entrada') : undefined}
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-5 py-3">Data</th>
                  <th className="text-left font-medium px-4 py-3">Tipo / Motivo</th>
                  <th className="text-left font-medium px-4 py-3">Produto</th>
                  <th className="text-left font-medium px-4 py-3">Responsável / Observações</th>
                  <th className="text-right font-medium px-4 py-3">Qtd.</th>
                  <th className="text-right font-medium px-5 py-3">Saldo Anterior → Atual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((mov) => {
                  const unitLabel = productUnitMap.get(mov.productId) ?? '';
                  return (
                    <tr key={mov.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatDateBR(mov.dataMovimentacao)}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            mov.tipo === 'entrada' ? 'text-emerald-700' : 'text-blue-700'
                          }`}
                        >
                          {mov.tipo === 'entrada' ? (
                            <ArrowDownLeft className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          )}
                          {mov.tipo === 'entrada' ? 'Entrada' : 'Saída'}
                        </span>
                        <span className="block text-slate-500 mt-0.5">{mov.motivo}</span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{mov.productName}</p>
                        <p className="text-xs font-mono text-slate-500">
                          SKU: {mov.productSku} · Custo: {formatBRL(mov.custoUnitario)}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <p className="font-medium text-slate-800">{mov.responsavel}</p>
                        {(mov.documentoReferencia || mov.observacoes) && (
                          <p className="text-slate-500">
                            {[
                              mov.documentoReferencia ? `Ref: ${mov.documentoReferencia}` : '',
                              mov.observacoes ?? '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap text-slate-900">
                        {mov.tipo === 'entrada' ? '+' : '-'}
                        {formatNumberBR(mov.quantidade, 2)} {unitLabel}
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatNumberBR(mov.saldoAnterior, 2)} →{' '}
                        <strong className="text-slate-900">
                          {formatNumberBR(mov.saldoAtual, 2)} {unitLabel}
                        </strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Movimentação */}
      <Modal
        open={modalOpen}
        title={form.tipo === 'entrada' ? 'Registrar Entrada no Estoque' : 'Registrar Saída de Estoque'}
        subtitle="A movimentação atualiza o saldo do produto de forma atômica e impede saldo negativo."
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Produto *</label>
            <select
              value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Selecione...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.nome} (Saldo: {p.quantidade} {p.unidade})
                </option>
              ))}
            </select>
            {errors.productId && <p className="text-xs text-red-600 mt-1">{errors.productId}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tipo *</label>
              <select
                value={form.tipo}
                onChange={(e) => {
                  const nextTipo = e.target.value as StockMovementType;
                  setForm({
                    ...form,
                    tipo: nextTipo,
                    motivo: nextTipo === 'entrada' ? 'Compra' : 'Retirada para instalação',
                  });
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="entrada">Entrada (+)</option>
                <option value="saida">Saída (-)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Motivo *</label>
              <select
                value={form.motivo}
                onChange={(e) => setForm({ ...form, motivo: e.target.value as StockMovementReason })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {availableReasons.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Quantidade {selectedProduct ? `(${selectedProduct.unidade})` : ''} *
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.quantidade}
                onChange={(e) => setForm({ ...form, quantidade: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {errors.quantidade && <p className="text-xs text-red-600 mt-1">{errors.quantidade}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Data *</label>
              <input
                type="date"
                value={form.dataMovimentacao}
                onChange={(e) => setForm({ ...form, dataMovimentacao: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Responsável / Técnico *
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.responsavel}
                value={form.responsavel}
                onChange={(e) => setForm({ ...form, responsavel: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {errors.responsavel && <p className="text-xs text-red-600 mt-1">{errors.responsavel}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                OS / NF de Referência
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.documentoReferencia}
                value={form.documentoReferencia}
                onChange={(e) => setForm({ ...form, documentoReferencia: e.target.value })}
                placeholder="Ex.: OS-402 / NF-1290"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {selectedProduct && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs text-slate-700 flex items-center justify-between">
              <span>
                Saldo atual: <strong>{formatNumberBR(selectedProduct.quantidade, 2)} {selectedProduct.unidade}</strong>
              </span>
              <span>
                Saldo após operação:{' '}
                <strong
                  className={
                    form.tipo === 'saida' && form.quantidade > selectedProduct.quantidade
                      ? 'text-red-700'
                      : 'text-emerald-700'
                  }
                >
                  {formatNumberBR(
                    form.tipo === 'entrada'
                      ? selectedProduct.quantidade + (Number(form.quantidade) || 0)
                      : selectedProduct.quantidade - (Number(form.quantidade) || 0),
                    2
                  )}{' '}
                  {selectedProduct.unidade}
                </strong>
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Observações</label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.observacoesMovimento}
              value={form.observacoes}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
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
              {saving ? 'Registrando...' : 'Confirmar Movimentação'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
