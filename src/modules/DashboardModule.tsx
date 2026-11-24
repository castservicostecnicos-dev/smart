import React, { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Boxes,
  FileCheck2,
  FileWarning,
  Receipt,
  TrendingUp,
} from 'lucide-react';
import type {
  BankTransaction,
  FinancialTransaction,
  InventoryProduct,
  Invoice,
  MenuSection,
  StockMovement,
  UserRole,
} from '../types/erp';
import { formatBRL, formatDateBR, formatNumberBR } from '../utils/formatters';
import { CategoryValueChart, MonthlyCashflowChart } from '../components/charts/ErpCharts';
import { SkeletonTable } from '../components/ui/CommonUI';

interface DashboardModuleProps {
  loading: boolean;
  userRole?: UserRole;
  financials: FinancialTransaction[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  inventory: InventoryProduct[];
  stockMovements: StockMovement[];
  onNavigate: (section: MenuSection) => void;
}

export const DashboardModule: React.FC<DashboardModuleProps> = ({
  loading,
  userRole,
  financials,
  invoices,
  bankTransactions,
  inventory,
  stockMovements,
  onNavigate,
}) => {
  const isAdmin = userRole === 'ADMINISTRADOR';
  const hasFinanceAccess = !userRole || userRole === 'ADMINISTRADOR' || userRole === 'FINANCEIRO' || userRole === 'CONSULTA';
  const metrics = useMemo(() => {
    const receitas = financials.filter((f) => f.tipo === 'receita' && f.status !== 'cancelado');
    const despesas = financials.filter((f) => f.tipo === 'despesa' && f.status !== 'cancelado');

    const totalRecebimentos = receitas
      .filter((r) => r.status === 'pago')
      .reduce((acc, r) => acc + r.valor, 0);

    const totalReceitasPrevistas = receitas.reduce((acc, r) => acc + r.valor, 0);
    const hasDespesas = despesas.length > 0;
    const totalDespesas = despesas.reduce((acc, d) => acc + d.valor, 0);

    const activeInvoices = invoices.filter((inv) => inv.statusRecebimento !== 'cancelada');
    const totalNfsEmitidas = activeInvoices.length;
    const valorTotalNfs = activeInvoices.reduce((acc, inv) => acc + inv.valor, 0);

    const nfsPendentes = activeInvoices.filter(
      (inv) => inv.statusRecebimento === 'pendente' || inv.statusRecebimento === 'parcial'
    );
    const valorNfsPendentes = nfsPendentes.reduce(
      (acc, inv) => acc + Math.max(0, inv.valor - inv.valorRecebido),
      0
    );

    const recebimentosSemNf = bankTransactions.filter(
      (b) =>
        b.tipo === 'credito' &&
        (b.statusConciliacao === 'sem_nf_localizada' ||
          b.statusConciliacao === 'nao_conciliado' ||
          b.statusConciliacao === 'conciliado_parcial')
    );
    const valorRecebimentosSemNf = recebimentosSemNf.reduce(
      (acc, b) => acc + Math.max(0, b.valor - Number(b.valorConciliado || 0)),
      0
    );

    const valorTotalEstoque = inventory.reduce(
      (acc, p) => acc + p.quantidade * p.custoUnitario,
      0
    );

    const produtosAbaixoMinimo = inventory.filter(
      (p) => p.quantidade <= p.estoqueMinimo
    );

    return {
      totalRecebimentos,
      totalReceitasPrevistas,
      hasDespesas,
      totalDespesas,
      totalNfsEmitidas,
      valorTotalNfs,
      qtdNfsPendentes: nfsPendentes.length,
      valorNfsPendentes,
      qtdRecebimentosSemNf: recebimentosSemNf.length,
      valorRecebimentosSemNf,
      valorTotalEstoque,
      produtosAbaixoMinimo,
    };
  }, [financials, invoices, bankTransactions, inventory]);

  const monthlySeries = useMemo(() => {
    const map = new Map<string, { label: string; receitas: number; despesas: number }>();
    for (const item of financials) {
      if (item.status === 'cancelado' || !item.dataVencimento) continue;
      const monthKey = item.dataVencimento.slice(0, 7);
      const parts = monthKey.split('-');
      const label = parts.length === 2 ? `${parts[1]}/${parts[0]}` : monthKey;
      const current = map.get(monthKey) ?? { label, receitas: 0, despesas: 0 };
      if (item.tipo === 'receita') {
        current.receitas += item.valor;
      } else {
        current.despesas += item.valor;
      }
      map.set(monthKey, current);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([, v]) => v);
  }, [financials]);

  const inventoryByCategory = useMemo(() => {
    const map = new Map<string, { label: string; value: number; count: number }>();
    for (const prod of inventory) {
      const val = prod.quantidade * prod.custoUnitario;
      const cur = map.get(prod.categoria) ?? { label: prod.categoria, value: 0, count: 0 };
      cur.value += val;
      cur.count += 1;
      map.set(prod.categoria, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [inventory]);

  const recentMovements = useMemo(() => {
    const stockItems = stockMovements.map((m) => ({
      id: `stk-${m.id}`,
      data: m.dataMovimentacao,
      origem: 'Estoque',
      titulo: `${m.tipo === 'entrada' ? 'Entrada' : 'Saída'}: ${m.productName}`,
      detalhe: `${formatNumberBR(m.quantidade, 2)} · ${m.motivo} · ${m.responsavel}`,
      valor: m.quantidade * m.custoUnitario,
      positivo: m.tipo === 'entrada',
    }));

    const finItems = hasFinanceAccess
      ? financials.map((f) => ({
          id: `fin-${f.id}`,
          data: f.dataVencimento,
          origem: 'Financeiro',
          titulo: f.descricao,
          detalhe: `${f.contraparte} · ${f.formaPagamento}`,
          valor: f.valor,
          positivo: f.tipo === 'receita',
        }))
      : [];

    return [...stockItems, ...finItems]
      .sort((a, b) => b.data.localeCompare(a.data))
      .slice(0, 8);
  }, [stockMovements, financials, hasFinanceAccess]);

  if (loading) {
    return (
      <div className="space-y-6 w-full min-w-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="min-h-28 bg-white border border-slate-200 rounded-xl p-5 animate-pulse" />
          ))}
        </div>
        <SkeletonTable rows={6} />
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full min-w-0">
      {/* Cabeçalho contextual */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-[#0B1F3A] text-white rounded-xl p-5 sm:p-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-white break-words">
            Painel Executivo da Operação
          </h2>
          <p className="text-sm text-blue-100/80 mt-1 break-words">
            Indicadores consolidados em tempo real de climatização, refrigeração, faturamento e estoque.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('ai-assistant')}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            <Bot className="w-4 h-4 shrink-0" />
            <span>Consultar Assistente IA</span>
          </button>
        </div>
      </div>

      {/* Banner de Perfil: Setor Financeiro (2ª linha) ou Operação / Estoque */}
      {!isAdmin && hasFinanceAccess && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">
              Setor Financeiro — Conferência de Notas, Extrato e Divergências
            </h3>
            <p className="text-xs text-slate-600 mt-0.5 break-words">
              Seu acesso contempla conferência de notas fiscais, extrato bancário, criação de arquivos CSV, identificação de divergências e movimentação de estoque.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('invoices')}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
            >
              Conferência de Notas
            </button>
            <button
              type="button"
              onClick={() => onNavigate('reconciliation')}
              className="px-3 py-1.5 text-xs font-medium text-blue-800 bg-white border border-blue-300 hover:bg-blue-100 rounded-lg cursor-pointer"
            >
              Extrato e Divergências
            </button>
            <button
              type="button"
              onClick={() => onNavigate('inventory-movements')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              Estoque (Inserir/Retirar)
            </button>
          </div>
        </div>
      )}

      {!hasFinanceAccess && (
        <div className="bg-slate-100 border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">
              Acesso Operacional e Estoque Liberado
            </h3>
            <p className="text-xs text-slate-600 mt-0.5 break-words">
              Você pode consultar o estoque, cadastrar produtos e inserir ou retirar itens. A conferência de notas fiscais e extrato bancário é restrita ao ADM ou usuários flegados no Setor Financeiro.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="px-3 py-1.5 text-xs font-medium text-white bg-[#0B1F3A] hover:bg-blue-900 rounded-lg cursor-pointer"
            >
              Abrir Estoque
            </button>
            <button
              type="button"
              onClick={() => onNavigate('inventory-movements')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              Inserir / Retirar Itens
            </button>
          </div>
        </div>
      )}

      {/* Grade de Indicadores Principais */}
      <section aria-label="Indicadores Principais" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {hasFinanceAccess && (
          <>
            {/* 1. Total de recebimentos */}
            <button
              type="button"
              onClick={() => onNavigate('financial')}
              className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
                <span className="break-words">Total de Recebimentos</span>
                <TrendingUp className="w-4 h-4 text-blue-700 shrink-0" />
              </div>
              <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2 break-words">
                {formatBRL(metrics.totalRecebimentos)}
              </p>
              <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums break-words">
                Previsto total: {formatBRL(metrics.totalReceitasPrevistas)}
              </p>
            </button>

            {/* 2. Total de despesas (quando houver dados cadastrados) */}
            <button
              type="button"
              onClick={() => onNavigate('financial')}
              className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
                <span className="break-words">Total de Despesas</span>
                <ArrowDownRight className="w-4 h-4 text-slate-500 shrink-0" />
              </div>
              {metrics.hasDespesas ? (
                <>
                  <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2 break-words">
                    {formatBRL(metrics.totalDespesas)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1.5 break-words">
                    Despesas ativas registradas
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-medium text-slate-600 mt-2.5 break-words">
                    Nenhuma despesa cadastrada
                  </p>
                  <p className="text-xs text-blue-700 mt-1.5 break-words">
                    Registrar no módulo Financeiro →
                  </p>
                </>
              )}
            </button>

            {/* 3. Total de notas fiscais emitidas */}
            <button
              type="button"
              onClick={() => onNavigate('invoices')}
              className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
                <span className="break-words">Notas Fiscais Emitidas</span>
                <Receipt className="w-4 h-4 text-blue-700 shrink-0" />
              </div>
              <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
                {metrics.totalNfsEmitidas}
              </p>
              <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums break-words">
                Volume fiscal: {formatBRL(metrics.valorTotalNfs)}
              </p>
            </button>

            {/* 4. Notas fiscais pendentes de recebimento */}
            <button
              type="button"
              onClick={() => onNavigate('invoices')}
              className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
                <span className="break-words">NFs Pendentes de Recebimento</span>
                <FileCheck2 className="w-4 h-4 text-amber-600 shrink-0" />
              </div>
              <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
                {metrics.qtdNfsPendentes}
              </p>
              <p className="text-xs text-amber-700 font-medium mt-1.5 font-mono tabular-nums break-words">
                Saldo a receber: {formatBRL(metrics.valorNfsPendentes)}
              </p>
            </button>

            {/* 5. Recebimentos sem nota fiscal localizada */}
            <button
              type="button"
              onClick={() => onNavigate('reconciliation')}
              className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between"
            >
              <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
                <span className="break-words">Recebimentos sem NF Localizada</span>
                <FileWarning className="w-4 h-4 text-red-600 shrink-0" />
              </div>
              <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2">
                {metrics.qtdRecebimentosSemNf}
              </p>
              <p className="text-xs text-red-700 font-medium mt-1.5 font-mono tabular-nums break-words">
                Valor pendente: {formatBRL(metrics.valorRecebimentosSemNf)}
              </p>
            </button>
          </>
        )}

        {/* 6. Valor total do estoque */}
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className={`w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer flex flex-col justify-between ${
            !hasFinanceAccess ? 'sm:col-span-1 xl:col-span-2' : ''
          }`}
        >
          <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="break-words">Valor Total do Estoque</span>
            <Boxes className="w-4 h-4 text-blue-700 shrink-0" />
          </div>
          <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-2 break-words">
            {formatBRL(metrics.valorTotalEstoque)}
          </p>
          <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums">
            {inventory.length} {inventory.length === 1 ? 'item cadastrado' : 'itens cadastrados'}
          </p>
        </button>

        {/* 7. Produtos abaixo do estoque mínimo */}
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="w-full min-w-0 text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-400 transition-colors cursor-pointer sm:col-span-2 flex flex-col justify-between"
        >
          <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500">
            <span className="break-words">Produtos Abaixo do Estoque Mínimo</span>
            <AlertTriangle
              className={`w-4 h-4 shrink-0 ${
                metrics.produtosAbaixoMinimo.length > 0 ? 'text-amber-600' : 'text-emerald-600'
              }`}
            />
          </div>
          <div className="flex flex-wrap items-baseline gap-2.5 mt-2">
            <p className="text-xl sm:text-2xl font-semibold text-slate-900 font-mono tabular-nums">
              {metrics.produtosAbaixoMinimo.length}
            </p>
            <span className="text-xs text-slate-600 break-words">
              {metrics.produtosAbaixoMinimo.length > 0
                ? 'Itens em nível crítico ou de reposição imediata'
                : inventory.length > 0
                  ? 'Todos os itens estão acima do estoque mínimo'
                  : 'Nenhum produto cadastrado no estoque'}
            </span>
          </div>
          {metrics.produtosAbaixoMinimo.length > 0 && (
            <p className="text-xs text-amber-800 mt-2 break-words leading-relaxed">
              Críticos:{' '}
              {metrics.produtosAbaixoMinimo
                .slice(0, 3)
                .map((p) => `${p.nome} (${p.quantidade} ${p.unidade})`)
                .join(' · ')}
            </p>
          )}
        </button>
      </section>

      {/* Gráficos Financeiro e de Estoque */}
      <section className={`grid grid-cols-1 ${hasFinanceAccess ? 'lg:grid-cols-2' : ''} gap-6`}>
        {hasFinanceAccess && (
          <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 min-w-0 w-full">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-slate-900 break-words">
                  Fluxo Financeiro por Competência
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 break-words">
                  Comparativo mensal de recebimentos e despesas lançadas
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('financial')}
                className="text-xs font-medium text-blue-700 hover:underline cursor-pointer shrink-0"
              >
                Ver financeiro
              </button>
            </div>
            <MonthlyCashflowChart data={monthlySeries} />
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 min-w-0 w-full">
          <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-slate-900 break-words">
                Valor de Estoque por Categoria
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 break-words">
                Distribuição do capital imobilizado em equipamentos e insumos
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-medium text-blue-700 hover:underline cursor-pointer shrink-0"
            >
              Ver estoque
            </button>
          </div>
          <CategoryValueChart data={inventoryByCategory} />
        </div>
      </section>

      {/* Últimas Movimentações e Alertas de Estoque */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden min-w-0 w-full">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-slate-900 break-words">
                Últimas Movimentações
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 break-words">
                {hasFinanceAccess
                  ? 'Atividades recentes do financeiro e do almoxarifado'
                  : 'Atividades recentes de entrada e saída do estoque'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('inventory-movements')}
              className="text-xs font-medium text-blue-700 hover:underline cursor-pointer shrink-0"
            >
              Movimentações
            </button>
          </div>

          {recentMovements.length === 0 ? (
            <div className="p-8 sm:p-10 text-center">
              <p className="text-sm font-medium text-slate-700">
                Ainda não há movimentações registradas
              </p>
              <p className="text-xs text-slate-500 mt-1">
                As últimas entradas, saídas de estoque e lançamentos financeiros aparecerão aqui automaticamente.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile Cards (zero lateral scroll) */}
              <div className="md:hidden divide-y divide-slate-100">
                {recentMovements.map((mov) => (
                  <div key={mov.id} className="p-4 space-y-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatDateBR(mov.data)} · {mov.origem}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 font-mono tabular-nums font-semibold shrink-0 ${
                          mov.positivo ? 'text-emerald-700' : 'text-slate-700'
                        }`}
                      >
                        {mov.positivo ? (
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowDownRight className="w-3.5 h-3.5" />
                        )}
                        {formatBRL(mov.valor)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-900 break-words">{mov.titulo}</p>
                    <p className="text-xs text-slate-500 break-words">{mov.detalhe}</p>
                  </div>
                ))}
              </div>

              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <tr>
                      <th className="text-left font-medium px-6 py-3">Data</th>
                      <th className="text-left font-medium px-4 py-3">Origem</th>
                      <th className="text-left font-medium px-4 py-3">Descrição</th>
                      <th className="text-right font-medium px-6 py-3">Valor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {recentMovements.map((mov) => (
                      <tr key={mov.id} className="hover:bg-slate-50/70">
                        <td className="px-6 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                          {formatDateBR(mov.data)}
                        </td>
                        <td className="px-4 py-3 text-xs font-medium text-slate-700 whitespace-nowrap">
                          {mov.origem}
                        </td>
                        <td className="px-4 py-3 min-w-0">
                          <p className="font-medium text-slate-900 break-words">{mov.titulo}</p>
                          <p className="text-xs text-slate-500 break-words">{mov.detalhe}</p>
                        </td>
                        <td className="px-6 py-3 text-right font-mono tabular-nums font-medium whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 ${mov.positivo ? 'text-emerald-700' : 'text-slate-700'}`}>
                            {mov.positivo ? (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            ) : (
                              <ArrowDownRight className="w-3.5 h-3.5" />
                            )}
                            {formatBRL(mov.valor)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Lista de reposição */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-w-0 w-full">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900 break-words">
                Alerta de Estoque Mínimo
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 break-words">
                Equipamentos e insumos para reposição
              </p>
            </div>
          </div>

          {metrics.produtosAbaixoMinimo.length === 0 ? (
            <div className="p-8 text-center flex-1 flex flex-col items-center justify-center">
              <p className="text-sm font-medium text-slate-700">
                Nenhum item abaixo do mínimo
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Quando algum produto atingir o estoque mínimo configurado, ele será destacado aqui.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 flex-1">
              {metrics.produtosAbaixoMinimo.slice(0, 6).map((prod) => (
                <div key={prod.id} className="px-5 sm:px-6 py-3.5 flex items-start justify-between gap-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 break-words">{prod.nome}</p>
                    <p className="text-xs text-slate-500 break-words mt-0.5">
                      SKU: {prod.sku} · Mínimo: {prod.estoqueMinimo} {prod.unidade}
                    </p>
                  </div>
                  <span className="text-xs font-mono tabular-nums font-semibold text-amber-800 shrink-0">
                    {prod.quantidade} {prod.unidade}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
