import React, { useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, History, MapPin, Package } from 'lucide-react';
import type { InventoryProduct, StockMovement } from '../../types/erp';
import { formatBRL, formatDateBR, formatNumberBR } from '../../utils/formatters';
import { Modal } from '../ui/CommonUI';

interface ProductHistoryModalProps {
  product: InventoryProduct | null;
  movements: StockMovement[];
  canEdit: boolean;
  onClose: () => void;
  onGoToMovements: () => void;
}

export const ProductHistoryModal: React.FC<ProductHistoryModalProps> = ({
  product,
  movements,
  canEdit,
  onClose,
  onGoToMovements,
}) => {
  const productMovements = useMemo(() => {
    if (!product) return [];
    return movements
      .filter((m) => m.productId === product.id)
      .sort((a, b) => b.dataMovimentacao.localeCompare(a.dataMovimentacao));
  }, [product, movements]);

  return (
    <Modal
      open={Boolean(product)}
      title={product ? `Histórico do Produto: ${product.nome}` : 'Histórico do Produto'}
      subtitle={
        product
          ? `Código: ${product.sku} · Categoria: ${product.categoria}`
          : undefined
      }
      onClose={onClose}
      maxWidth="max-w-3xl"
    >
      {product && (
        <div className="space-y-5">
          {/* Resumo cadastral */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs">
            <div>
              <span className="text-slate-500 block">Saldo Atual</span>
              <strong
                className={`text-sm font-mono ${
                  product.quantidade <= product.estoqueMinimo
                    ? 'text-amber-700'
                    : 'text-slate-900'
                }`}
              >
                {formatNumberBR(product.quantidade, 2)} {product.unidade}
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">Estoque Mínimo</span>
              <strong className="text-sm font-mono text-slate-800">
                {formatNumberBR(product.estoqueMinimo, 2)} {product.unidade}
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">Custo Unitário</span>
              <strong className="text-sm font-mono text-slate-800">
                {formatBRL(product.custoUnitario)}
              </strong>
            </div>
            <div>
              <span className="text-slate-500 block">Localização</span>
              <span className="font-medium text-slate-800 inline-flex items-center gap-1 mt-0.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                {product.localizacao || 'Não informada'}
              </span>
            </div>
          </div>

          {product.observacoes && (
            <div className="bg-white border border-slate-200 rounded-lg p-3 text-xs text-slate-700">
              <strong className="text-slate-900">Observações cadastrais:</strong>{' '}
              {product.observacoes}
              {product.origemImportacao === 'planilha' && product.arquivoImportacao && (
                <span className="block text-[11px] text-slate-500 mt-1">
                  Origem: importado da planilha {product.arquivoImportacao}
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600 inline-flex items-center gap-1.5">
              <History className="w-4 h-4" />
              Movimentações Registradas ({productMovements.length})
            </h4>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onGoToMovements();
                }}
                className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer"
              >
                Registrar Nova Movimentação
              </button>
            )}
          </div>

          {productMovements.length === 0 ? (
            <div className="border border-slate-200 rounded-xl py-8 px-4 text-center text-xs text-slate-500 flex flex-col items-center gap-2">
              <Package className="w-6 h-6 text-slate-400" />
              Nenhuma movimentação registrada ainda para este item.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                    <tr>
                      <th className="text-left font-medium px-3 py-2.5">Data</th>
                      <th className="text-left font-medium px-3 py-2.5">Tipo / Motivo</th>
                      <th className="text-left font-medium px-3 py-2.5">Responsável / Obs.</th>
                      <th className="text-right font-medium px-3 py-2.5">Qtd.</th>
                      <th className="text-right font-medium px-3 py-2.5">Saldo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productMovements.map((mov) => (
                      <tr key={mov.id} className="hover:bg-slate-50/70">
                        <td className="px-3 py-2.5 font-mono text-slate-600 whitespace-nowrap">
                          {formatDateBR(mov.dataMovimentacao)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
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
                          <span className="block text-[11px] text-slate-500">{mov.motivo}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">
                          <p className="font-medium text-slate-900">{mov.responsavel}</p>
                          {(mov.documentoReferencia || mov.observacoes) && (
                            <p className="text-[11px] text-slate-500">
                              {[mov.documentoReferencia ? `Ref: ${mov.documentoReferencia}` : '', mov.observacoes]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {mov.tipo === 'entrada' ? '+' : '-'}
                          {formatNumberBR(mov.quantidade, 2)} {product.unidade}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-600 whitespace-nowrap">
                          {formatNumberBR(mov.saldoAnterior, 2)} →{' '}
                          <strong className="text-slate-900">
                            {formatNumberBR(mov.saldoAtual, 2)}
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
