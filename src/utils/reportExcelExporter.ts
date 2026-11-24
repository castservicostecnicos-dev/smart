import * as XLSX from 'xlsx';
import type {
  BankTransaction,
  Customer,
  FinancialTransaction,
  InventoryProduct,
  Invoice,
  ReconciliationRecord,
  StockMovement,
} from '../types/erp';
import { formatDateBR, formatTimestampBR, todayISO } from './formatters';

export type InventoryReportId =
  | 'estoque_atual'
  | 'abaixo_minimo'
  | 'entradas_periodo'
  | 'saidas_periodo'
  | 'movimentacoes_produto'
  | 'consumo_categoria'
  | 'valor_estimado_estoque';

export type FinancialReportId =
  | 'recebimentos_periodo'
  | 'recebimentos_cliente'
  | 'notas_emitidas'
  | 'notas_totalmente_recebidas'
  | 'notas_parcialmente_recebidas'
  | 'notas_sem_recebimento'
  | 'recebimentos_sem_nota'
  | 'divergencias_conciliacao';

export type ReportId = InventoryReportId | FinancialReportId;

export type ReportSituationFilter =
  | 'todas'
  | 'recebida_paga'
  | 'parcial'
  | 'pendente'
  | 'sem_nf'
  | 'abaixo_minimo'
  | 'com_divergencia'
  | 'cancelada';

export interface CustomerOption {
  key: string;
  label: string;
  documento?: string;
}

export interface ReportFilterState {
  startDate: string;
  endDate: string;
  customerKey: string;
  productId: string;
  situation: ReportSituationFilter;
}

export interface ReportSheetDefinition {
  sheetName: string;
  title: string;
  headers: string[];
  rows: (string | number)[][];
  totalsRow?: (string | number)[];
  currencyCols?: number[];
  numberCols?: number[];
}

export interface ReportMetric {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
}

export interface BuiltReportData {
  id: ReportId;
  domain: 'estoque' | 'financeiro';
  title: string;
  description: string;
  metrics: ReportMetric[];
  headers: string[];
  rows: (string | number)[][];
  totalsRow?: (string | number)[];
  currencyCols: number[];
  numberCols: number[];
  emptyMessage: string;
  extraCategorySheets?: ReportSheetDefinition[];
}

const SITUATION_LABELS: Record<ReportSituationFilter, string> = {
  todas: 'Todas as situações',
  recebida_paga: 'Recebida / Paga / Conciliada',
  parcial: 'Parcialmente recebida',
  pendente: 'Pendente / Sem recebimento',
  sem_nf: 'Sem nota fiscal localizada',
  abaixo_minimo: 'Abaixo ou no mínimo (Estoque)',
  com_divergencia: 'Com divergência / Revisão',
  cancelada: 'Cancelada',
};

export function getSituationLabel(sit: ReportSituationFilter): string {
  return SITUATION_LABELS[sit] ?? 'Todas as situações';
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function digitsOnly(val?: string): string {
  return (val ?? '').replace(/\D/g, '');
}

function inDateRange(isoDate: string | undefined, start: string, end: string): boolean {
  if (!isoDate) return !start && !end;
  const clean = isoDate.slice(0, 10);
  if (start && clean < start) return false;
  if (end && clean > end) return false;
  return true;
}

function safeSheetName(raw: string, used: Set<string>): string {
  const cleaned = raw.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  let candidate = cleaned.slice(0, 31) || 'Planilha';
  let idx = 2;
  while (used.has(candidate)) {
    const suffix = ` ${idx}`;
    candidate = `${cleaned.slice(0, 31 - suffix.length)}${suffix}`;
    idx += 1;
  }
  used.add(candidate);
  return candidate;
}

export function buildCustomerFilterKey(params: {
  customerId?: string;
  documento?: string;
  nome?: string;
}): string {
  if (params.customerId) return `cid:${params.customerId}`;
  const docDigits = digitsOnly(params.documento);
  if (docDigits.length === 11 || docDigits.length === 14) return `doc:${docDigits}`;
  const normName = (params.nome ?? '').trim().toLowerCase();
  return normName ? `name:${normName}` : 'sem_identificacao';
}

export function extractCustomerOptions(
  customers: Customer[],
  invoices: Invoice[],
  financials: FinancialTransaction[],
  bankTransactions: BankTransaction[]
): CustomerOption[] {
  const map = new Map<string, CustomerOption>();

  for (const c of customers) {
    const key = buildCustomerFilterKey({
      customerId: c.id,
      documento: c.documentoLimpo || c.documento,
      nome: c.nome,
    });
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: c.documento ? `${c.nome} (${c.documento})` : c.nome,
        documento: c.documentoLimpo || digitsOnly(c.documento),
      });
    }
  }

  for (const inv of invoices) {
    const key = buildCustomerFilterKey({
      customerId: inv.customerId,
      documento: inv.clienteDocumento,
      nome: inv.clienteNome,
    });
    if (!map.has(key) && inv.clienteNome) {
      map.set(key, {
        key,
        label: inv.clienteDocumento ? `${inv.clienteNome} (${inv.clienteDocumento})` : inv.clienteNome,
        documento: digitsOnly(inv.clienteDocumento),
      });
    }
  }

  for (const fin of financials) {
    if (fin.tipo !== 'receita') continue;
    const key = buildCustomerFilterKey({
      customerId: fin.customerId,
      documento: fin.clienteDocumento,
      nome: fin.contraparte,
    });
    if (!map.has(key) && fin.contraparte) {
      map.set(key, {
        key,
        label: fin.clienteDocumento ? `${fin.contraparte} (${fin.clienteDocumento})` : fin.contraparte,
        documento: digitsOnly(fin.clienteDocumento),
      });
    }
  }

  for (const b of bankTransactions) {
    if (b.tipo !== 'credito' || !b.nomePagador) continue;
    const key = buildCustomerFilterKey({
      customerId: b.customerId,
      documento: b.cpfCnpjPagador,
      nome: b.nomePagador,
    });
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: b.cpfCnpjPagador ? `${b.nomePagador} (${b.cpfCnpjPagador})` : b.nomePagador,
        documento: digitsOnly(b.cpfCnpjPagador),
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

function matchesCustomerFilter(
  selectedKey: string,
  selectedDocDigits: string | undefined,
  candidate: { customerId?: string; documento?: string; nome?: string }
): boolean {
  if (!selectedKey || selectedKey === 'all') return true;
  const candKey = buildCustomerFilterKey(candidate);
  if (candKey === selectedKey) return true;
  const candDoc = digitsOnly(candidate.documento);
  if (selectedDocDigits && candDoc && candDoc === selectedDocDigits) return true;
  if (selectedKey.startsWith('name:')) {
    const targetName = selectedKey.slice(5);
    return (candidate.nome ?? '').trim().toLowerCase() === targetName;
  }
  return false;
}

export function buildInventoryReport(
  reportId: InventoryReportId,
  filters: ReportFilterState,
  inventory: InventoryProduct[],
  stockMovements: StockMovement[]
): BuiltReportData {
  const productById = new Map(inventory.map((p) => [p.id, p]));
  const filteredProducts = inventory.filter((p) => {
    if (filters.productId !== 'all' && p.id !== filters.productId) return false;
    if (filters.situation === 'abaixo_minimo' && p.quantidade > p.estoqueMinimo) return false;
    return true;
  });

  const filteredMovements = stockMovements
    .filter((m) => {
      if (!inDateRange(m.dataMovimentacao, filters.startDate, filters.endDate)) return false;
      if (filters.productId !== 'all' && m.productId !== filters.productId) return false;
      return true;
    })
    .sort((a, b) => b.dataMovimentacao.localeCompare(a.dataMovimentacao));

  if (reportId === 'estoque_atual') {
    const itemsWithCost = filteredProducts.filter((p) => p.custoUnitario > 0).length;
    const totalQty = round2(filteredProducts.reduce((s, p) => s + p.quantidade, 0));
    const totalValue = round2(
      filteredProducts.reduce((s, p) => s + p.quantidade * p.custoUnitario, 0)
    );
    const lowCount = filteredProducts.filter((p) => p.quantidade <= p.estoqueMinimo).length;

    const rows = filteredProducts
      .slice()
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((p) => [
        p.sku,
        p.nome,
        p.categoria,
        p.localizacao || '—',
        p.unidade,
        round2(p.quantidade),
        round2(p.estoqueMinimo),
        p.quantidade <= p.estoqueMinimo ? 'Abaixo/No Mínimo' : 'Normal',
        p.custoUnitario > 0 ? round2(p.custoUnitario) : 0,
        p.custoUnitario > 0 ? round2(p.quantidade * p.custoUnitario) : 0,
      ]);

    return {
      id: reportId,
      domain: 'estoque',
      title: 'Estoque Atual',
      description: 'Posição real dos produtos e insumos cadastrados no estoque da empresa.',
      metrics: [
        { label: 'Itens Listados', value: String(filteredProducts.length) },
        { label: 'Abaixo do Mínimo', value: String(lowCount), tone: lowCount > 0 ? 'warning' : 'positive' },
        { label: 'Com Custo Cadastrado', value: `${itemsWithCost}/${filteredProducts.length}` },
        { label: 'Valor Estimado (Custo)', value: `R$ ${totalValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
      ],
      headers: [
        'Código',
        'Produto',
        'Categoria',
        'Localização',
        'Unid.',
        'Saldo Atual',
        'Estoque Mín.',
        'Situação',
        'Custo Unit. (R$)',
        'Valor Estimado (R$)',
      ],
      rows,
      totalsRow: ['TOTAIS', `${filteredProducts.length} produtos`, '', '', '', totalQty, '', '', '', totalValue],
      currencyCols: [8, 9],
      numberCols: [5, 6],
      emptyMessage: 'Nenhum produto encontrado no estoque para os filtros aplicados.',
    };
  }

  if (reportId === 'abaixo_minimo') {
    const lowProducts = filteredProducts
      .filter((p) => p.quantidade <= p.estoqueMinimo)
      .sort((a, b) => a.quantidade - a.estoqueMinimo - (b.quantidade - b.estoqueMinimo));

    const totalDeficit = round2(
      lowProducts.reduce((s, p) => s + Math.max(0, p.estoqueMinimo - p.quantidade), 0)
    );
    const totalRepositionCost = round2(
      lowProducts.reduce(
        (s, p) => s + Math.max(0, p.estoqueMinimo - p.quantidade) * (p.custoUnitario || 0),
        0
      )
    );

    const rows = lowProducts.map((p) => {
      const deficit = round2(Math.max(0, p.estoqueMinimo - p.quantidade));
      const repCost = round2(deficit * (p.custoUnitario || 0));
      return [
        p.sku,
        p.nome,
        p.categoria,
        p.unidade,
        round2(p.quantidade),
        round2(p.estoqueMinimo),
        deficit,
        p.custoUnitario > 0 ? round2(p.custoUnitario) : 0,
        repCost,
        p.localizacao || '—',
      ];
    });

    return {
      id: reportId,
      domain: 'estoque',
      title: 'Produtos Abaixo do Mínimo',
      description: 'Itens com saldo atual menor ou igual ao estoque mínimo definido para reposição.',
      metrics: [
        { label: 'Produtos Críticos', value: String(lowProducts.length), tone: lowProducts.length > 0 ? 'danger' : 'positive' },
        { label: 'Déficit Total (Unidades)', value: totalDeficit.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
        { label: 'Custo Est. Reposição', value: `R$ ${totalRepositionCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
      ],
      headers: [
        'Código',
        'Produto',
        'Categoria',
        'Unid.',
        'Saldo Atual',
        'Estoque Mín.',
        'Necessidade Reposição',
        'Custo Unit. (R$)',
        'Custo Est. Reposição (R$)',
        'Localização',
      ],
      rows,
      totalsRow: ['TOTAIS', `${lowProducts.length} itens`, '', '', '', '', totalDeficit, '', totalRepositionCost, ''],
      currencyCols: [7, 8],
      numberCols: [4, 5, 6],
      emptyMessage: 'Nenhum produto está abaixo ou igual ao estoque mínimo para os filtros selecionados.',
    };
  }

  if (reportId === 'entradas_periodo' || reportId === 'saidas_periodo') {
    const isEntrada = reportId === 'entradas_periodo';
    const movs = filteredMovements.filter((m) => m.tipo === (isEntrada ? 'entrada' : 'saida'));
    const totalQty = round2(movs.reduce((s, m) => s + m.quantidade, 0));
    const totalCost = round2(
      movs.reduce((s, m) => {
        const unitCost = m.custoUnitario > 0 ? m.custoUnitario : (productById.get(m.productId)?.custoUnitario ?? 0);
        return s + m.quantidade * unitCost;
      }, 0)
    );

    const rows = movs.map((m) => {
      const prod = productById.get(m.productId);
      const unitCost = m.custoUnitario > 0 ? m.custoUnitario : (prod?.custoUnitario ?? 0);
      return [
        formatDateBR(m.dataMovimentacao),
        m.productSku,
        m.productName,
        prod?.categoria || '—',
        m.motivo,
        prod?.unidade || 'un',
        round2(m.quantidade),
        round2(m.saldoAnterior),
        round2(m.saldoAtual),
        m.responsavel,
        m.documentoReferencia || '—',
        round2(m.quantidade * unitCost),
      ];
    });

    return {
      id: reportId,
      domain: 'estoque',
      title: isEntrada ? 'Entradas de Estoque por Período' : 'Saídas de Estoque por Período',
      description: isEntrada
        ? 'Compras, entradas de material e devoluções registradas no período.'
        : 'Retiradas para instalação, uso em manutenção, vendas, ajustes e perdas no período.',
      metrics: [
        { label: isEntrada ? 'Lançamentos de Entrada' : 'Lançamentos de Saída', value: String(movs.length) },
        { label: 'Volume Movimentado', value: totalQty.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
        { label: 'Valor Estimado (Custo)', value: `R$ ${totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
      ],
      headers: [
        'Data',
        'Código',
        'Produto',
        'Categoria',
        'Motivo',
        'Unid.',
        'Quantidade',
        'Saldo Anterior',
        'Saldo Posterior',
        'Responsável',
        'Referência',
        'Valor Est. (R$)',
      ],
      rows,
      totalsRow: ['TOTAIS', `${movs.length} registros`, '', '', '', '', totalQty, '', '', '', '', totalCost],
      currencyCols: [11],
      numberCols: [6, 7, 8],
      emptyMessage: `Nenhuma ${isEntrada ? 'entrada' : 'saída'} registrada no estoque para os filtros selecionados.`,
    };
  }

  if (reportId === 'movimentacoes_produto') {
    const movs = filteredMovements
      .slice()
      .sort((a, b) => a.productName.localeCompare(b.productName, 'pt-BR') || b.dataMovimentacao.localeCompare(a.dataMovimentacao));

    const totalEntradas = round2(movs.filter((m) => m.tipo === 'entrada').reduce((s, m) => s + m.quantidade, 0));
    const totalSaidas = round2(movs.filter((m) => m.tipo === 'saida').reduce((s, m) => s + m.quantidade, 0));

    const rows = movs.map((m) => {
      const prod = productById.get(m.productId);
      return [
        m.productSku,
        m.productName,
        prod?.categoria || '—',
        formatDateBR(m.dataMovimentacao),
        m.tipo === 'entrada' ? 'Entrada' : 'Saída',
        m.motivo,
        prod?.unidade || 'un',
        round2(m.quantidade),
        round2(m.saldoAnterior),
        round2(m.saldoAtual),
        m.responsavel,
        m.observacoes || '—',
      ];
    });

    return {
      id: reportId,
      domain: 'estoque',
      title: 'Movimentações por Produto',
      description: 'Histórico detalhado de entradas e saídas ordenado por produto com rastreamento de saldo.',
      metrics: [
        { label: 'Movimentações', value: String(movs.length) },
        { label: 'Total Entradas', value: totalEntradas.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), tone: 'positive' },
        { label: 'Total Saídas', value: totalSaidas.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), tone: 'warning' },
      ],
      headers: [
        'Código',
        'Produto',
        'Categoria',
        'Data',
        'Tipo',
        'Motivo',
        'Unid.',
        'Quantidade',
        'Saldo Anterior',
        'Saldo Posterior',
        'Responsável',
        'Observações',
      ],
      rows,
      totalsRow: ['TOTAIS', `${movs.length} movimentações`, '', '', '', '', '', round2(totalEntradas + totalSaidas), '', '', '', ''],
      currencyCols: [],
      numberCols: [7, 8, 9],
      emptyMessage: 'Nenhuma movimentação encontrada para os produtos e período selecionados.',
    };
  }

  if (reportId === 'consumo_categoria') {
    const catMap = new Map<
      string,
      {
        categoria: string;
        qtdProdutos: number;
        saldoAtualTotal: number;
        entradasQtd: number;
        saidasQtd: number;
        custoConsumido: number;
        valorAtualEstoque: number;
      }
    >();

    for (const p of filteredProducts) {
      const cur = catMap.get(p.categoria) ?? {
        categoria: p.categoria,
        qtdProdutos: 0,
        saldoAtualTotal: 0,
        entradasQtd: 0,
        saidasQtd: 0,
        custoConsumido: 0,
        valorAtualEstoque: 0,
      };
      cur.qtdProdutos += 1;
      cur.saldoAtualTotal = round2(cur.saldoAtualTotal + p.quantidade);
      cur.valorAtualEstoque = round2(cur.valorAtualEstoque + p.quantidade * (p.custoUnitario || 0));
      catMap.set(p.categoria, cur);
    }

    for (const m of filteredMovements) {
      const prod = productById.get(m.productId);
      const cat = prod?.categoria || 'Outros';
      const cur = catMap.get(cat) ?? {
        categoria: cat,
        qtdProdutos: 0,
        saldoAtualTotal: 0,
        entradasQtd: 0,
        saidasQtd: 0,
        custoConsumido: 0,
        valorAtualEstoque: 0,
      };
      const unitCost = m.custoUnitario > 0 ? m.custoUnitario : (prod?.custoUnitario ?? 0);
      if (m.tipo === 'entrada') {
        cur.entradasQtd = round2(cur.entradasQtd + m.quantidade);
      } else {
        cur.saidasQtd = round2(cur.saidasQtd + m.quantidade);
        cur.custoConsumido = round2(cur.custoConsumido + m.quantidade * unitCost);
      }
      catMap.set(cat, cur);
    }

    const cats = Array.from(catMap.values()).sort((a, b) => b.saidasQtd - a.saidasQtd || b.valorAtualEstoque - a.valorAtualEstoque);
    const totalEntradas = round2(cats.reduce((s, c) => s + c.entradasQtd, 0));
    const totalSaidas = round2(cats.reduce((s, c) => s + c.saidasQtd, 0));
    const totalConsumedCost = round2(cats.reduce((s, c) => s + c.custoConsumido, 0));
    const totalStockVal = round2(cats.reduce((s, c) => s + c.valorAtualEstoque, 0));

    const rows = cats.map((c) => [
      c.categoria,
      c.qtdProdutos,
      c.saldoAtualTotal,
      c.entradasQtd,
      c.saidasQtd,
      c.custoConsumido,
      c.valorAtualEstoque,
    ]);

    return {
      id: reportId,
      domain: 'estoque',
      title: 'Consumo por Categoria',
      description: 'Consolidação de entradas, saídas (consumo) e valor estimado atual por categoria HVAC-R.',
      metrics: [
        { label: 'Categorias', value: String(cats.length) },
        { label: 'Volume Consumido (Saídas)', value: totalSaidas.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) },
        { label: 'Custo Est. Consumido', value: `R$ ${totalConsumedCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
        { label: 'Valor Atual em Estoque', value: `R$ ${totalStockVal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
      ],
      headers: [
        'Categoria',
        'Produtos Cad.',
        'Saldo Atual Total',
        'Entradas no Período',
        'Consumo / Saídas',
        'Custo Est. Consumido (R$)',
        'Valor Atual Estoque (R$)',
      ],
      rows,
      totalsRow: [
        'TOTAIS',
        cats.reduce((s, c) => s + c.qtdProdutos, 0),
        round2(cats.reduce((s, c) => s + c.saldoAtualTotal, 0)),
        totalEntradas,
        totalSaidas,
        totalConsumedCost,
        totalStockVal,
      ],
      currencyCols: [5, 6],
      numberCols: [1, 2, 3, 4],
      emptyMessage: 'Nenhuma categoria com produtos ou movimentações para os filtros selecionados.',
    };
  }

  // valor_estimado_estoque
  const withCost = filteredProducts.filter((p) => p.custoUnitario > 0);
  const withoutCost = filteredProducts.filter((p) => !p.custoUnitario || p.custoUnitario <= 0);
  const totalCusto = round2(withCost.reduce((s, p) => s + p.quantidade * p.custoUnitario, 0));
  const totalVendaPotencial = round2(
    filteredProducts.reduce((s, p) => s + p.quantidade * (p.precoVenda > 0 ? p.precoVenda : 0), 0)
  );

  const rows = filteredProducts
    .slice()
    .sort((a, b) => b.quantidade * b.custoUnitario - a.quantidade * a.custoUnitario)
    .map((p) => [
      p.sku,
      p.nome,
      p.categoria,
      p.unidade,
      round2(p.quantidade),
      p.custoUnitario > 0 ? 'Custo cadastrado' : 'Sem custo informado',
      p.custoUnitario > 0 ? round2(p.custoUnitario) : 0,
      p.custoUnitario > 0 ? round2(p.quantidade * p.custoUnitario) : 0,
      p.precoVenda > 0 ? round2(p.precoVenda) : 0,
      p.precoVenda > 0 ? round2(p.quantidade * p.precoVenda) : 0,
    ]);

  return {
    id: reportId,
    domain: 'estoque',
    title: 'Valor Estimado do Estoque',
    description:
      'Avaliação financeira real dos itens com custo unitário cadastrado, destacando itens sem custo informado.',
    metrics: [
      { label: 'Valor Estimado (Custo)', value: `R$ ${totalCusto.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
      { label: 'Itens com Custo', value: `${withCost.length} de ${filteredProducts.length}`, tone: 'positive' },
      { label: 'Sem Custo Informado', value: String(withoutCost.length), tone: withoutCost.length > 0 ? 'warning' : 'default' },
      { label: 'Potencial de Venda', value: `R$ ${totalVendaPotencial.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
    ],
    headers: [
      'Código',
      'Produto',
      'Categoria',
      'Unid.',
      'Saldo Atual',
      'Situação do Custo',
      'Custo Unit. (R$)',
      'Valor Custo Total (R$)',
      'Preço Venda Unit. (R$)',
      'Potencial Venda (R$)',
    ],
    rows,
    totalsRow: [
      'TOTAIS',
      `${filteredProducts.length} itens`,
      '',
      '',
      round2(filteredProducts.reduce((s, p) => s + p.quantidade, 0)),
      '',
      '',
      totalCusto,
      '',
      totalVendaPotencial,
    ],
    currencyCols: [6, 7, 8, 9],
    numberCols: [4],
    emptyMessage: 'Nenhum item de estoque encontrado para cálculo de valor estimado.',
  };
}

export function buildFinancialReport(
  reportId: FinancialReportId,
  filters: ReportFilterState,
  customerOptions: CustomerOption[],
  financials: FinancialTransaction[],
  invoices: Invoice[],
  bankTransactions: BankTransaction[],
  reconciliations: ReconciliationRecord[]
): BuiltReportData {
  const selectedCustomer = customerOptions.find((c) => c.key === filters.customerKey);
  const selectedDocDigits = selectedCustomer?.documento;

  const filterInvoice = (inv: Invoice, ignoreSituation = false) => {
    if (!inDateRange(inv.dataEmissao, filters.startDate, filters.endDate)) return false;
    if (
      !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
        customerId: inv.customerId,
        documento: inv.clienteDocumento,
        nome: inv.clienteNome,
      })
    ) {
      return false;
    }
    if (!ignoreSituation && filters.situation !== 'todas') {
      if (filters.situation === 'recebida_paga' && inv.statusRecebimento !== 'recebida') return false;
      if (filters.situation === 'parcial' && inv.statusRecebimento !== 'parcial') return false;
      if (filters.situation === 'pendente' && inv.statusRecebimento !== 'pendente') return false;
      if (filters.situation === 'cancelada' && inv.statusRecebimento !== 'cancelada') return false;
      if (filters.situation === 'sem_nf') return false;
    }
    return true;
  };

  if (reportId === 'recebimentos_periodo') {
    const finReceipts = financials
      .filter((f) => {
        if (f.tipo !== 'receita') return false;
        const refDate = f.dataPagamento || f.dataVencimento;
        if (!inDateRange(refDate, filters.startDate, filters.endDate)) return false;
        if (
          !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
            customerId: f.customerId,
            documento: f.clienteDocumento,
            nome: f.contraparte,
          })
        ) {
          return false;
        }
        if (filters.situation !== 'todas') {
          if (filters.situation === 'recebida_paga' && f.status !== 'pago') return false;
          if (filters.situation === 'pendente' && f.status !== 'pendente' && f.status !== 'atrasado') return false;
          if (filters.situation === 'cancelada' && f.status !== 'cancelado') return false;
          if (filters.situation === 'sem_nf' && Boolean(f.invoiceId || f.invoiceNumber)) return false;
          if (filters.situation === 'parcial') return false;
        } else if (f.status === 'cancelado') {
          return false;
        }
        return true;
      })
      .map((f) => ({
        dateIso: f.dataPagamento || f.dataVencimento,
        origem: 'Lançamento Financeiro',
        cliente: f.contraparte,
        doc: f.clienteDocumento || '—',
        descricao: f.descricao,
        forma: f.formaPagamento,
        nf: f.invoiceNumber || '—',
        situacao:
          f.status === 'pago'
            ? 'Recebido'
            : f.status === 'pendente'
              ? 'Pendente'
              : f.status === 'atrasado'
                ? 'Atrasado'
                : 'Cancelado',
        valor: round2(f.valor),
      }));

    const bankCredits = bankTransactions
      .filter((b) => {
        if (b.tipo !== 'credito') return false;
        if (!inDateRange(b.dataMovimento, filters.startDate, filters.endDate)) return false;
        if (
          !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
            customerId: b.customerId,
            documento: b.cpfCnpjPagador,
            nome: b.nomePagador || b.descricao,
          })
        ) {
          return false;
        }
        if (filters.situation !== 'todas') {
          if (
            filters.situation === 'recebida_paga' &&
            b.statusConciliacao !== 'conciliado_nf' &&
            b.statusConciliacao !== 'conciliado_financeiro'
          ) {
            return false;
          }
          if (filters.situation === 'parcial' && b.statusConciliacao !== 'conciliado_parcial') return false;
          if (
            filters.situation === 'sem_nf' &&
            b.statusConciliacao !== 'sem_nf_localizada' &&
            b.statusConciliacao !== 'nao_conciliado'
          ) {
            return false;
          }
          if (filters.situation === 'pendente' && b.statusConciliacao !== 'nao_conciliado') return false;
        }
        return true;
      })
      .map((b) => ({
        dateIso: b.dataMovimento,
        origem: `Extrato (${b.banco})`,
        cliente: b.nomePagador || 'Pagador não identificado',
        doc: b.cpfCnpjPagador || '—',
        descricao: b.descricao,
        forma: 'Crédito Bancário',
        nf: b.invoiceNumber || '—',
        situacao:
          b.statusConciliacao === 'conciliado_nf'
            ? 'Conciliado com NF'
            : b.statusConciliacao === 'conciliado_parcial'
              ? 'Conciliação Parcial'
              : b.statusConciliacao === 'conciliado_financeiro'
                ? 'Conciliado Financeiro'
                : b.statusConciliacao === 'sem_nf_localizada'
                  ? 'Sem NF Localizada'
                  : 'Não Conciliado',
        valor: round2(b.valor),
      }));

    const combined = [...finReceipts, ...bankCredits].sort((a, b) =>
      b.dateIso.localeCompare(a.dateIso)
    );

    const totalFin = round2(finReceipts.reduce((s, r) => s + r.valor, 0));
    const totalBank = round2(bankCredits.reduce((s, r) => s + r.valor, 0));
    const totalGeral = round2(totalFin + totalBank);

    return {
      id: reportId,
      domain: 'financeiro',
      title: 'Recebimentos por Período',
      description: 'Entradas financeiras cadastradas e créditos bancários importados no período.',
      metrics: [
        { label: 'Total de Registros', value: String(combined.length) },
        { label: 'Lançamentos Financeiros', value: `R$ ${totalFin.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
        { label: 'Créditos em Extrato', value: `R$ ${totalBank.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: 'positive' },
      ],
      headers: [
        'Data',
        'Origem',
        'Cliente / Pagador',
        'CPF / CNPJ',
        'Descrição',
        'Forma / Canal',
        'NF Vinculada',
        'Situação',
        'Valor (R$)',
      ],
      rows: combined.map((r) => [
        formatDateBR(r.dateIso),
        r.origem,
        r.cliente,
        r.doc,
        r.descricao,
        r.forma,
        r.nf,
        r.situacao,
        r.valor,
      ]),
      totalsRow: ['TOTAIS', `${combined.length} recebimentos`, '', '', '', '', '', '', totalGeral],
      currencyCols: [8],
      numberCols: [],
      emptyMessage: 'Nenhum recebimento financeiro ou crédito bancário encontrado para os filtros aplicados.',
    };
  }

  if (reportId === 'recebimentos_cliente') {
    const clientMap = new Map<
      string,
      {
        nome: string;
        documento: string;
        qtdNfs: number;
        totalFaturado: number;
        totalRecebidoNfs: number;
        saldoPendenteNfs: number;
        totalCreditosBancarios: number;
        totalReceitasFin: number;
      }
    >();

    const ensureEntry = (key: string, nome: string, documento?: string) => {
      const existing = clientMap.get(key);
      if (existing) {
        if ((!existing.documento || existing.documento === '—') && documento) {
          existing.documento = documento;
        }
        return existing;
      }
      const created = {
        nome: nome || 'Cliente sem identificação',
        documento: documento || '—',
        qtdNfs: 0,
        totalFaturado: 0,
        totalRecebidoNfs: 0,
        saldoPendenteNfs: 0,
        totalCreditosBancarios: 0,
        totalReceitasFin: 0,
      };
      clientMap.set(key, created);
      return created;
    };

    for (const inv of invoices) {
      if (inv.statusRecebimento === 'cancelada') continue;
      if (!inDateRange(inv.dataEmissao, filters.startDate, filters.endDate)) continue;
      if (
        !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
          customerId: inv.customerId,
          documento: inv.clienteDocumento,
          nome: inv.clienteNome,
        })
      ) {
        continue;
      }
      const key = buildCustomerFilterKey({
        customerId: inv.customerId,
        documento: inv.clienteDocumento,
        nome: inv.clienteNome,
      });
      const item = ensureEntry(key, inv.clienteNome, inv.clienteDocumento);
      item.qtdNfs += 1;
      item.totalFaturado = round2(item.totalFaturado + inv.valor);
      item.totalRecebidoNfs = round2(item.totalRecebidoNfs + inv.valorRecebido);
      item.saldoPendenteNfs = round2(item.saldoPendenteNfs + Math.max(0, inv.valor - inv.valorRecebido));
    }

    for (const f of financials) {
      if (f.tipo !== 'receita' || f.status !== 'pago') continue;
      if (!inDateRange(f.dataPagamento || f.dataVencimento, filters.startDate, filters.endDate)) continue;
      if (
        !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
          customerId: f.customerId,
          documento: f.clienteDocumento,
          nome: f.contraparte,
        })
      ) {
        continue;
      }
      const key = buildCustomerFilterKey({
        customerId: f.customerId,
        documento: f.clienteDocumento,
        nome: f.contraparte,
      });
      const item = ensureEntry(key, f.contraparte, f.clienteDocumento);
      item.totalReceitasFin = round2(item.totalReceitasFin + f.valor);
    }

    for (const b of bankTransactions) {
      if (b.tipo !== 'credito') continue;
      if (!inDateRange(b.dataMovimento, filters.startDate, filters.endDate)) continue;
      if (
        !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
          customerId: b.customerId,
          documento: b.cpfCnpjPagador,
          nome: b.nomePagador || b.descricao,
        })
      ) {
        continue;
      }
      const key = buildCustomerFilterKey({
        customerId: b.customerId,
        documento: b.cpfCnpjPagador,
        nome: b.nomePagador || b.descricao,
      });
      const item = ensureEntry(key, b.nomePagador || b.descricao, b.cpfCnpjPagador);
      item.totalCreditosBancarios = round2(item.totalCreditosBancarios + b.valor);
    }

    let list = Array.from(clientMap.values());
    if (filters.situation === 'pendente') {
      list = list.filter((c) => c.saldoPendenteNfs > 0);
    } else if (filters.situation === 'recebida_paga') {
      list = list.filter((c) => c.totalRecebidoNfs > 0 || c.totalCreditosBancarios > 0 || c.totalReceitasFin > 0);
    }

    list.sort((a, b) => b.totalFaturado + b.totalCreditosBancarios - (a.totalFaturado + a.totalCreditosBancarios));

    const sumFat = round2(list.reduce((s, c) => s + c.totalFaturado, 0));
    const sumRecNf = round2(list.reduce((s, c) => s + c.totalRecebidoNfs, 0));
    const sumPend = round2(list.reduce((s, c) => s + c.saldoPendenteNfs, 0));
    const sumCred = round2(list.reduce((s, c) => s + c.totalCreditosBancarios, 0));
    const sumFin = round2(list.reduce((s, c) => s + c.totalReceitasFin, 0));

    return {
      id: reportId,
      domain: 'financeiro',
      title: 'Recebimentos por Cliente',
      description:
        'Consolidado por cliente identificado por CPF/CNPJ, sem agrupar automaticamente nomes semelhantes sem documento.',
      metrics: [
        { label: 'Clientes Listados', value: String(list.length) },
        { label: 'Faturado em NFs', value: `R$ ${sumFat.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
        { label: 'Recebido (NFs)', value: `R$ ${sumRecNf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: 'positive' },
        { label: 'Saldo Pendente NFs', value: `R$ ${sumPend.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: sumPend > 0 ? 'warning' : 'default' },
      ],
      headers: [
        'Cliente / Pagador',
        'CPF / CNPJ',
        'Qtd NFs',
        'Total NFs Emitidas (R$)',
        'Recebido em NFs (R$)',
        'Saldo Pendente NFs (R$)',
        'Créditos Extrato (R$)',
        'Receitas Financeiras (R$)',
      ],
      rows: list.map((c) => [
        c.nome,
        c.documento,
        c.qtdNfs,
        c.totalFaturado,
        c.totalRecebidoNfs,
        c.saldoPendenteNfs,
        c.totalCreditosBancarios,
        c.totalReceitasFin,
      ]),
      totalsRow: [
        'TOTAIS',
        `${list.length} clientes`,
        list.reduce((s, c) => s + c.qtdNfs, 0),
        sumFat,
        sumRecNf,
        sumPend,
        sumCred,
        sumFin,
      ],
      currencyCols: [3, 4, 5, 6, 7],
      numberCols: [2],
      emptyMessage: 'Nenhum cliente com movimentação fiscal ou recebimento encontrado para os filtros.',
    };
  }

  if (
    reportId === 'notas_emitidas' ||
    reportId === 'notas_totalmente_recebidas' ||
    reportId === 'notas_parcialmente_recebidas' ||
    reportId === 'notas_sem_recebimento'
  ) {
    const filtered = invoices
      .filter((inv) => {
        if (reportId === 'notas_emitidas') {
          if (filters.situation === 'todas' && inv.statusRecebimento === 'cancelada') return false;
          return filterInvoice(inv, false);
        }
        if (!filterInvoice(inv, true)) return false;
        if (reportId === 'notas_totalmente_recebidas') return inv.statusRecebimento === 'recebida';
        if (reportId === 'notas_parcialmente_recebidas') return inv.statusRecebimento === 'parcial';
        return inv.statusRecebimento === 'pendente';
      })
      .sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao));

    const totalValor = round2(filtered.reduce((s, n) => s + n.valor, 0));
    const totalRecebido = round2(filtered.reduce((s, n) => s + n.valorRecebido, 0));
    const totalPendente = round2(
      filtered.reduce((s, n) => s + Math.max(0, n.valor - n.valorRecebido), 0)
    );

    const statusLabel = (s: Invoice['statusRecebimento']) =>
      s === 'recebida'
        ? 'Totalmente Recebida'
        : s === 'parcial'
          ? 'Parcialmente Recebida'
          : s === 'pendente'
            ? 'Sem Recebimento'
            : 'Cancelada';

    const titleMap: Record<string, string> = {
      notas_emitidas: 'Notas Fiscais Emitidas (Saída)',
      notas_totalmente_recebidas: 'Notas Fiscais Totalmente Recebidas',
      notas_parcialmente_recebidas: 'Notas Fiscais Parcialmente Recebidas',
      notas_sem_recebimento: 'Notas Fiscais Sem Recebimento Identificado',
    };

    const descMap: Record<string, string> = {
      notas_emitidas: 'Relação completa das notas fiscais de saída emitidas e importadas.',
      notas_totalmente_recebidas: 'Notas fiscais de saída com recebimento integral confirmado.',
      notas_parcialmente_recebidas: 'Notas fiscais com pagamento parcial ou saldo remanescente em aberto.',
      notas_sem_recebimento: 'Notas fiscais de saída ainda sem recebimento conciliado.',
    };

    return {
      id: reportId,
      domain: 'financeiro',
      title: titleMap[reportId],
      description: descMap[reportId],
      metrics: [
        { label: 'Quantidade de NFs', value: String(filtered.length) },
        { label: 'Valor Total NFs', value: `R$ ${totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
        { label: 'Total Recebido', value: `R$ ${totalRecebido.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: 'positive' },
        { label: 'Saldo em Aberto', value: `R$ ${totalPendente.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: totalPendente > 0 ? 'warning' : 'default' },
      ],
      headers: [
        'Emissão',
        'Vencimento',
        'Tipo',
        'Número',
        'Série',
        'Cliente',
        'CPF / CNPJ',
        'Situação',
        'Valor Total (R$)',
        'Recebido (R$)',
        'Saldo Aberto (R$)',
      ],
      rows: filtered.map((n) => [
        formatDateBR(n.dataEmissao),
        formatDateBR(n.dataVencimento),
        n.tipo,
        n.numero,
        n.serie,
        n.clienteNome,
        n.clienteDocumento || '—',
        statusLabel(n.statusRecebimento),
        round2(n.valor),
        round2(n.valorRecebido),
        round2(Math.max(0, n.valor - n.valorRecebido)),
      ]),
      totalsRow: [
        'TOTAIS',
        `${filtered.length} notas`,
        '',
        '',
        '',
        '',
        '',
        '',
        totalValor,
        totalRecebido,
        totalPendente,
      ],
      currencyCols: [8, 9, 10],
      numberCols: [],
      emptyMessage: 'Nenhuma nota fiscal encontrada para esta classificação e filtros.',
    };
  }

  if (reportId === 'recebimentos_sem_nota') {
    const unmatched = bankTransactions
      .filter((b) => {
        if (b.tipo !== 'credito') return false;
        if (b.statusConciliacao !== 'sem_nf_localizada' && b.statusConciliacao !== 'nao_conciliado') {
          return false;
        }
        if (!inDateRange(b.dataMovimento, filters.startDate, filters.endDate)) return false;
        if (
          !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
            customerId: b.customerId,
            documento: b.cpfCnpjPagador,
            nome: b.nomePagador || b.descricao,
          })
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.dataMovimento.localeCompare(a.dataMovimento));

    const totalValor = round2(unmatched.reduce((s, b) => s + b.valor, 0));
    const totalDisp = round2(
      unmatched.reduce((s, b) => s + Math.max(0, b.valor - (b.valorConciliado || 0)), 0)
    );

    return {
      id: reportId,
      domain: 'financeiro',
      title: 'Recebimentos Sem Nota Localizada',
      description:
        'Créditos bancários que ainda não possuem nota fiscal de saída vinculada na conciliação.',
      metrics: [
        { label: 'Créditos Pendentes', value: String(unmatched.length), tone: unmatched.length > 0 ? 'danger' : 'positive' },
        { label: 'Valor Total Bruto', value: `R$ ${totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
        { label: 'Saldo Não Conciliado', value: `R$ ${totalDisp.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, tone: totalDisp > 0 ? 'danger' : 'default' },
      ],
      headers: [
        'Data',
        'Banco',
        'Pagador',
        'CPF / CNPJ Pagador',
        'Descrição Bancária',
        'Documento Bancário',
        'Status',
        'Valor Crédito (R$)',
        'Saldo Sem NF (R$)',
      ],
      rows: unmatched.map((b) => [
        formatDateBR(b.dataMovimento),
        b.banco,
        b.nomePagador || 'Não identificado',
        b.cpfCnpjPagador || '—',
        b.descricao,
        b.documentoBancario || '—',
        b.statusConciliacao === 'sem_nf_localizada' ? 'Sem NF Localizada' : 'Não Conciliado',
        round2(b.valor),
        round2(Math.max(0, b.valor - (b.valorConciliado || 0))),
      ]),
      totalsRow: ['TOTAIS', `${unmatched.length} créditos`, '', '', '', '', '', totalValor, totalDisp],
      currencyCols: [7, 8],
      numberCols: [],
      emptyMessage: 'Nenhum recebimento bancário sem nota fiscal localizada para os filtros aplicados.',
    };
  }

  // divergencias_conciliacao
  const bankById = new Map(bankTransactions.map((b) => [b.id, b]));
  const invById = new Map(invoices.map((i) => [i.id, i]));

  const rows: (string | number)[][] = [];

  for (const rec of reconciliations) {
    if (!inDateRange(rec.bankData, filters.startDate, filters.endDate)) continue;
    const bank = bankById.get(rec.bankTransactionId);
    const inv = rec.invoiceId ? invById.get(rec.invoiceId) : undefined;

    if (
      filters.customerKey !== 'all' &&
      !matchesCustomerFilter(filters.customerKey, selectedDocDigits, {
        customerId: inv?.customerId ?? bank?.customerId,
        documento: inv?.clienteDocumento ?? bank?.cpfCnpjPagador,
        nome: inv?.clienteNome ?? bank?.nomePagador ?? rec.bankDescricao,
      })
    ) {
      continue;
    }

    const diff = round2(rec.diferencaValor ?? 0);
    const hasDivergence =
      Math.abs(diff) > 0.01 ||
      rec.tipo === 'sem_nf' ||
      rec.tipo === 'rejeitado' ||
      rec.tipo === 'parcelado' ||
      rec.tipo === 'agrupado';

    if (!hasDivergence) continue;

    const tipoLabel =
      rec.tipo === 'sem_nf'
        ? 'Recebimento sem NF'
        : rec.tipo === 'rejeitado'
          ? 'Sugestão IA rejeitada'
          : rec.tipo === 'parcelado'
            ? 'Recebimento parcelado'
            : rec.tipo === 'agrupado'
              ? 'Pagamento agrupado de NFs'
              : 'Diferença de valor';

    rows.push([
      formatDateBR(rec.bankData),
      tipoLabel,
      inv?.clienteNome || bank?.nomePagador || '—',
      rec.invoiceNumber ? `NF ${rec.invoiceNumber}` : 'Sem NF',
      rec.bankDescricao,
      round2(rec.bankValor),
      round2(rec.valorConciliado),
      diff,
      rec.confianca || 'manual',
      rec.justificativa || rec.observacoes || 'Revisão operacional registrada',
    ]);
  }

  // Incluir NFs parciais cujo saldo ainda tem divergência de quitação
  for (const inv of invoices) {
    if (inv.statusRecebimento !== 'parcial') continue;
    if (!filterInvoice(inv, true)) continue;
    const aberto = round2(Math.max(0, inv.valor - inv.valorRecebido));
    rows.push([
      formatDateBR(inv.dataEmissao),
      'NF parcialmente recebida (saldo aberto)',
      inv.clienteNome,
      `NF ${inv.numero}`,
      `Emissão ${formatDateBR(inv.dataEmissao)}`,
      round2(inv.valorRecebido),
      round2(inv.valor),
      round2(-aberto),
      'revisao',
      `Recebido ${inv.valorRecebido.toFixed(2)} de ${inv.valor.toFixed(2)} (saldo pendente ${aberto.toFixed(2)})`,
    ]);
  }

  const totalDiferencas = round2(rows.reduce((s, r) => s + Math.abs(Number(r[7]) || 0), 0));

  return {
    id: reportId,
    domain: 'financeiro',
    title: 'Divergências da Conciliação',
    description:
      'Diferenças de valor entre extratos e NFs, pagamentos parciais, agrupados, rejeições e créditos sem NF.',
    metrics: [
      { label: 'Ocorrências', value: String(rows.length), tone: rows.length > 0 ? 'warning' : 'positive' },
      { label: 'Soma Absoluta das Diferenças', value: `R$ ${totalDiferencas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
    ],
    headers: [
      'Data',
      'Tipo de Divergência',
      'Cliente / Pagador',
      'NF Relacionada',
      'Histórico Bancário / Documento',
      'Valor Banco / Recebido (R$)',
      'Valor NF / Conciliado (R$)',
      'Diferença (R$)',
      'Confiança',
      'Justificativa / Detalhe',
    ],
    rows,
    totalsRow: ['TOTAIS', `${rows.length} ocorrências`, '', '', '', '', '', totalDiferencas, '', ''],
    currencyCols: [5, 6, 7],
    numberCols: [],
    emptyMessage: 'Nenhuma divergência de conciliação identificada para os filtros selecionados.',
  };
}

function appendFormattedSheet(
  wb: XLSX.WorkBook,
  usedSheetNames: Set<string>,
  opts: {
    sheetName: string;
    companyName: string;
    title: string;
    periodText: string;
    filtersText: string;
    headers: string[];
    rows: (string | number)[][];
    totalsRow?: (string | number)[];
    currencyCols?: number[];
    numberCols?: number[];
  }
): void {
  const safeName = safeSheetName(opts.sheetName, usedSheetNames);
  const currencySet = new Set(opts.currencyCols ?? []);
  const numberSet = new Set(opts.numberCols ?? []);

  const aoa: (string | number)[][] = [
    [`${opts.companyName} — ${opts.title}`],
    [`Período: ${opts.periodText} | Filtros: ${opts.filtersText} | Gerado em: ${formatTimestampBR(new Date())}`],
    [],
    opts.headers,
    ...opts.rows,
  ];

  if (opts.totalsRow && opts.rows.length > 0) {
    aoa.push(opts.totalsRow);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const headerRowIdx = 3;
  const firstDataRowIdx = 4;
  const lastDataRowIdx = firstDataRowIdx + opts.rows.length - 1;
  const totalsRowIdx = opts.totalsRow && opts.rows.length > 0 ? lastDataRowIdx + 1 : -1;

  // Formatar células numéricas e monetárias em reais (R$)
  const applyNumericFormatting = (rowIdx: number) => {
    for (let c = 0; c < opts.headers.length; c += 1) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      const cell = ws[addr];
      if (!cell || typeof cell.v !== 'number') continue;
      if (currencySet.has(c)) {
        cell.t = 'n';
        cell.z = 'R$ #,##0.00';
      } else if (numberSet.has(c)) {
        cell.t = 'n';
        cell.z = '#,##0.00';
      }
    }
  };

  for (let r = firstDataRowIdx; r <= lastDataRowIdx; r += 1) {
    applyNumericFormatting(r);
  }
  if (totalsRowIdx >= 0) {
    applyNumericFormatting(totalsRowIdx);
  }

  // Configurar AutoFilter nos cabeçalhos da tabela (excluindo linha de totais)
  if (opts.headers.length > 0) {
    const filterEndRow = opts.rows.length > 0 ? lastDataRowIdx : headerRowIdx;
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: headerRowIdx, c: 0 },
        e: { r: filterEndRow, c: opts.headers.length - 1 },
      }),
    };
  }

  // Mesclar linhas de título e subtítulo do cabeçalho
  if (opts.headers.length > 1) {
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: opts.headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: opts.headers.length - 1 } },
    ];
  }

  // Largura automática das colunas
  ws['!cols'] = opts.headers.map((header, colIdx) => {
    let maxLen = header.length + 4;
    for (const row of opts.rows) {
      const val = row[colIdx];
      const len =
        typeof val === 'number' && currencySet.has(colIdx)
          ? val.toFixed(2).length + 6
          : String(val ?? '').length + 2;
      if (len > maxLen) maxLen = len;
    }
    return { wch: Math.min(44, Math.max(12, maxLen)) };
  });

  XLSX.utils.book_append_sheet(wb, ws, safeName);
}

export function exportReportsWorkbookXlsx(params: {
  fileName: string;
  companyName: string;
  filters: ReportFilterState;
  customerLabel: string;
  productLabel: string;
  reports: BuiltReportData[];
}): void {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();

  const periodText =
    params.filters.startDate || params.filters.endDate
      ? `${params.filters.startDate ? formatDateBR(params.filters.startDate) : 'Início'} até ${
          params.filters.endDate ? formatDateBR(params.filters.endDate) : 'Atual'
        }`
      : 'Todo o histórico';

  const filtersText = [
    `Cliente: ${params.customerLabel}`,
    `Produto: ${params.productLabel}`,
    `Situação: ${getSituationLabel(params.filters.situation)}`,
  ].join(' · ');

  // Aba inicial de Resumo Executivo com totais reais de cada relatório incluído
  const summaryRows: (string | number)[][] = params.reports.map((rep) => [
    rep.domain === 'estoque' ? 'Estoque' : 'Financeiro / Fiscal',
    rep.title,
    rep.rows.length,
    rep.metrics.map((m) => `${m.label}: ${m.value}`).join(' | '),
  ]);

  appendFormattedSheet(wb, usedNames, {
    sheetName: 'Resumo Geral',
    companyName: params.companyName,
    title: 'Resumo Consolidado dos Relatórios Gerados',
    periodText,
    filtersText,
    headers: ['Categoria', 'Relatório', 'Qtd. Registros Reais', 'Indicadores Principais'],
    rows: summaryRows,
    totalsRow: [
      'TOTAIS',
      `${params.reports.length} relatórios`,
      params.reports.reduce((s, r) => s + r.rows.length, 0),
      '',
    ],
    numberCols: [2],
  });

  // Abas separadas por relatório / categoria
  for (const rep of params.reports) {
    appendFormattedSheet(wb, usedNames, {
      sheetName: rep.title,
      companyName: params.companyName,
      title: rep.title,
      periodText,
      filtersText,
      headers: rep.headers,
      rows: rep.rows,
      totalsRow: rep.totalsRow,
      currencyCols: rep.currencyCols,
      numberCols: rep.numberCols,
    });
  }

  const finalName = params.fileName.endsWith('.xlsx')
    ? params.fileName
    : `${params.fileName}_${todayISO()}.xlsx`;

  XLSX.writeFile(wb, finalName);
}
