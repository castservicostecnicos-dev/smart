import * as XLSX from 'xlsx';
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
  type InventoryProduct,
  type InventoryUnit,
} from '../types/erp';
import type { InventoryInput } from '../services/erpService';
import { todayISO } from './formatters';

export type InventoryColumnField =
  | 'sku'
  | 'nome'
  | 'categoria'
  | 'unidade'
  | 'quantidade'
  | 'estoqueMinimo'
  | 'localizacao'
  | 'custoUnitario'
  | 'precoVenda'
  | 'observacoes';

export type ColumnMapping = Record<InventoryColumnField, string>;

export interface ParsedWorkbookData {
  fileName: string;
  sheetNames: string[];
  sheets: Record<string, { headers: string[]; rows: Record<string, string>[] }>;
}

export interface PreviewRowResult {
  rowIndex: number;
  rawRow: Record<string, string>;
  parsed: InventoryInput;
  errors: string[];
  duplicateInSheet: boolean;
  existingProduct: InventoryProduct | null;
  status: 'novo' | 'existente' | 'duplicado_planilha' | 'erro';
  selectedAction: 'create' | 'add_stock' | 'skip';
}

function normalizeHeader(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function parseLocalizedNumber(raw: unknown): { valid: boolean; value: number } {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { valid: true, value: Math.round(raw * 100) / 100 } : { valid: false, value: 0 };
  }
  const text = String(raw ?? '').trim();
  if (!text) return { valid: true, value: 0 };

  const cleaned = text.replace(/R\$/gi, '').replace(/\s+/g, '');
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return { valid: false, value: 0 };
  return { valid: true, value: Math.round(num * 100) / 100 };
}

export function normalizeUnitValue(raw: unknown): InventoryUnit {
  const txt = normalizeHeader(String(raw ?? ''));
  if (!txt) return 'un';
  if (['un', 'und', 'unid', 'unidade', 'unidades'].includes(txt)) return 'un';
  if (['m', 'mt', 'mts', 'metro', 'metros'].includes(txt)) return 'm';
  if (['kg', 'kilo', 'kilos', 'quilo', 'quilos', 'quilograma', 'quilogramas'].includes(txt)) return 'kg';
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(txt)) return 'l';
  if (['cx', 'cxa', 'caixa', 'caixas'].includes(txt)) return 'cx';
  if (['rl', 'rolo', 'rolos'].includes(txt)) return 'rl';
  if (['pc', 'pcs', 'peca', 'pecas', 'pç', 'pçs'].includes(txt)) return 'pc';
  if (['br', 'bar', 'barra', 'barras'].includes(txt)) return 'br';
  if (['kit', 'kits', 'cj', 'conjunto'].includes(txt)) return 'kit';
  return 'un';
}

export function normalizeCategoryValue(
  raw: unknown,
  fallback: InventoryCategory = 'Insumos de Instalação'
): InventoryCategory {
  const txt = normalizeHeader(String(raw ?? ''));
  if (!txt) return fallback;

  const exact = INVENTORY_CATEGORIES.find((cat) => normalizeHeader(cat) === txt);
  if (exact) return exact;

  if (txt.includes('split') || txt.includes('inverter') || txt.includes('hi wall') || txt.includes('evaporadora')) {
    return 'Equipamento Split/Inverter';
  }
  if (txt.includes('vrf') || txt.includes('comercial') || txt.includes('cassete') || txt.includes('piso teto') || txt.includes('chiller')) {
    return 'Equipamento Comercial/VRF';
  }
  if (txt.includes('refrigeracao') || txt.includes('industrial') || txt.includes('camara') || txt.includes('condensadora')) {
    return 'Refrigeração Industrial';
  }
  if (txt.includes('peca') || txt.includes('compressor') || txt.includes('capacitor') || txt.includes('placa') || txt.includes('motor')) {
    return 'Peças e Compressores';
  }
  if (txt.includes('tub') || txt.includes('cobre') || txt.includes('cano') || txt.includes('esponjoso')) {
    return 'Tubulação e Cobre';
  }
  if (txt.includes('gas') || txt.includes('fluido') || txt.includes('r410') || txt.includes('r32') || txt.includes('r22') || txt.includes('nitrogenio')) {
    return 'Gás Refrigerante';
  }
  if (txt.includes('insumo') || txt.includes('instalacao') || txt.includes('suporte') || txt.includes('fita') || txt.includes('porca') || txt.includes('cabo')) {
    return 'Insumos de Instalação';
  }
  return fallback;
}

export async function parseInventoryWorkbook(file: File): Promise<ParsedWorkbookData> {
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
    throw new Error('A planilha deve ter entre 1 byte e 10 MB.');
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: 'array',
    codepage: 65001,
    cellFormula: false,
    cellHTML: false,
  });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    throw new Error('A planilha selecionada não possui abas válidas.');
  }

  const sheets: Record<string, { headers: string[]; rows: Record<string, string>[] }> = {};
  for (const name of sheetNames) {
    const ws = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
    if (matrix.length > 5005) {
      throw new Error(`A aba "${name}" excede o limite de 5.000 linhas por importação.`);
    }
    // Localiza a primeira linha com pelo menos 2 células preenchidas como cabeçalho
    let headerIdx = matrix.findIndex(
      (row) => Array.isArray(row) && row.filter((c) => String(c ?? '').trim() !== '').length >= 2
    );
    if (headerIdx < 0) headerIdx = 0;

    const rawHeaders = Array.isArray(matrix[headerIdx]) ? (matrix[headerIdx] as unknown[]) : [];
    const headers: string[] = [];
    const seen = new Set<string>();
    rawHeaders.forEach((cell, idx) => {
      const base = String(cell ?? '').trim() || `Coluna_${idx + 1}`;
      let label = base;
      let suffix = 2;
      while (seen.has(label)) {
        label = `${base} (${suffix})`;
        suffix += 1;
      }
      seen.add(label);
      headers.push(label);
    });

    const rows: Record<string, string>[] = [];
    for (let r = headerIdx + 1; r < matrix.length; r += 1) {
      const line = matrix[r];
      if (!Array.isArray(line)) continue;
      const hasAnyValue = line.some((c) => String(c ?? '').trim() !== '');
      if (!hasAnyValue) continue;
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = String(line[idx] ?? '').trim();
      });
      rows.push(obj);
    }

    sheets[name] = { headers, rows };
  }

  return {
    fileName: file.name,
    sheetNames,
    sheets,
  };
}

const COLUMN_ALIASES: Record<InventoryColumnField, string[]> = {
  sku: ['codigo', 'cod', 'sku', 'referencia', 'ref', 'id produto', 'cod produto', 'part number'],
  nome: ['nome', 'produto', 'descricao', 'item', 'material', 'equipamento', 'nome do produto'],
  categoria: ['categoria', 'grupo', 'tipo', 'familia', 'departamento'],
  unidade: ['unidade', 'un', 'und', 'unid', 'unidade de medida', 'medida', 'u m'],
  quantidade: ['quantidade', 'qtd', 'qtde', 'saldo', 'saldo atual', 'estoque atual', 'estoque', 'disponivel'],
  estoqueMinimo: ['estoque minimo', 'minimo', 'est min', 'qtd minima', 'ponto de pedido'],
  localizacao: ['localizacao', 'local', 'endereco', 'prateleira', 'corredor', 'almoxarifado', 'galpao'],
  custoUnitario: ['custo', 'custo unitario', 'valor unitario', 'preco de custo', 'vlr unit', 'custo medio'],
  precoVenda: ['preco venda', 'preco de venda', 'valor venda', 'venda'],
  observacoes: ['observacoes', 'observacao', 'obs', 'notas', 'detalhes'],
};

export function autoDetectColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
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
  };

  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  (Object.keys(COLUMN_ALIASES) as InventoryColumnField[]).forEach((field) => {
    const aliases = COLUMN_ALIASES[field];
    // 1. Match exato
    const exact = normalizedHeaders.find((h) => aliases.includes(h.norm));
    if (exact) {
      mapping[field] = exact.raw;
      return;
    }
    // 2. Match parcial
    const partial = normalizedHeaders.find((h) =>
      aliases.some((alias) => alias.length >= 3 && (h.norm.includes(alias) || alias.includes(h.norm)))
    );
    if (partial) {
      mapping[field] = partial.raw;
    }
  });

  return mapping;
}

export function buildImportPreview(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  existingProducts: InventoryProduct[],
  defaultCategory: InventoryCategory,
  existingStrategy: 'add_stock' | 'skip'
): PreviewRowResult[] {
  const existingBySku = new Map<string, InventoryProduct>();
  const existingByName = new Map<string, InventoryProduct>();
  for (const prod of existingProducts) {
    if (prod.sku) existingBySku.set(prod.sku.trim().toLowerCase(), prod);
    if (prod.nome) existingByName.set(prod.nome.trim().toLowerCase(), prod);
  }

  const seenSheetSkus = new Set<string>();
  const seenSheetNames = new Set<string>();

  return rows.map((rawRow, idx) => {
    const errors: string[] = [];
    const rawSku = mapping.sku ? (rawRow[mapping.sku] ?? '').trim() : '';
    const rawNome = mapping.nome ? (rawRow[mapping.nome] ?? '').trim() : '';
    const rawCat = mapping.categoria ? (rawRow[mapping.categoria] ?? '').trim() : '';
    const rawUn = mapping.unidade ? (rawRow[mapping.unidade] ?? '').trim() : '';
    const rawQty = mapping.quantidade ? (rawRow[mapping.quantidade] ?? '').trim() : '0';
    const rawMin = mapping.estoqueMinimo ? (rawRow[mapping.estoqueMinimo] ?? '').trim() : '0';
    const rawLoc = mapping.localizacao ? (rawRow[mapping.localizacao] ?? '').trim() : '';
    const rawCost = mapping.custoUnitario ? (rawRow[mapping.custoUnitario] ?? '').trim() : '0';
    const rawPrice = mapping.precoVenda ? (rawRow[mapping.precoVenda] ?? '').trim() : '0';
    const rawObs = mapping.observacoes ? (rawRow[mapping.observacoes] ?? '').trim() : '';

    if (!rawNome) {
      errors.push('Nome do produto não informado.');
    }

    const sku = rawSku || `IMP-${String(idx + 1).padStart(4, '0')}`;
    if (!rawSku && rawNome) {
      // Gera SKU automático se planilha não tiver coluna de código
    }

    const qtyParsed = parseLocalizedNumber(rawQty);
    if (!qtyParsed.valid || qtyParsed.value < 0) {
      errors.push(`Quantidade inválida ("${rawQty}").`);
    }

    const minParsed = parseLocalizedNumber(rawMin);
    if (!minParsed.valid || minParsed.value < 0) {
      errors.push(`Estoque mínimo inválido ("${rawMin}").`);
    }

    const costParsed = parseLocalizedNumber(rawCost);
    if (!costParsed.valid || costParsed.value < 0) {
      errors.push(`Custo unitário inválido ("${rawCost}").`);
    }

    const priceParsed = parseLocalizedNumber(rawPrice);
    if (!priceParsed.valid || priceParsed.value < 0) {
      errors.push(`Preço de venda inválido ("${rawPrice}").`);
    }

    const skuKey = sku.toLowerCase();
    const nameKey = rawNome.toLowerCase();

    const duplicateInSheet =
      (Boolean(rawSku) && seenSheetSkus.has(skuKey)) ||
      (Boolean(rawNome) && seenSheetNames.has(nameKey));

    if (rawSku) seenSheetSkus.add(skuKey);
    if (rawNome) seenSheetNames.add(nameKey);

    const existingProduct =
      existingBySku.get(skuKey) ?? (nameKey ? existingByName.get(nameKey) : undefined) ?? null;

    let status: PreviewRowResult['status'] = 'novo';
    let selectedAction: PreviewRowResult['selectedAction'] = 'create';

    if (errors.length > 0) {
      status = 'erro';
      selectedAction = 'skip';
    } else if (duplicateInSheet) {
      status = 'duplicado_planilha';
      selectedAction = 'skip';
    } else if (existingProduct) {
      status = 'existente';
      selectedAction = existingStrategy === 'add_stock' && qtyParsed.value > 0 ? 'add_stock' : 'skip';
    }

    const parsed: InventoryInput = {
      sku: sku.slice(0, 50),
      nome: rawNome.slice(0, 160),
      categoria: normalizeCategoryValue(rawCat, defaultCategory),
      marca: '',
      modelo: '',
      capacidade: '',
      unidade: normalizeUnitValue(rawUn),
      quantidade: qtyParsed.valid ? qtyParsed.value : 0,
      estoqueMinimo: minParsed.valid ? minParsed.value : 0,
      custoUnitario: costParsed.valid ? costParsed.value : 0,
      precoVenda: priceParsed.valid ? priceParsed.value : 0,
      localizacao: rawLoc.slice(0, 80),
      observacoes: rawObs.slice(0, 500),
      origemImportacao: 'planilha',
    };

    return {
      rowIndex: idx + 1,
      rawRow,
      parsed,
      errors,
      duplicateInSheet,
      existingProduct,
      status,
      selectedAction,
    };
  });
}

export function exportInventoryToExcel(products: InventoryProduct[], companyName: string): void {
  const rows = products.map((p) => ({
    Código: p.sku,
    Produto: p.nome,
    Categoria: p.categoria,
    'Unidade de Medida': p.unidade,
    'Quantidade Atual': p.quantidade,
    'Estoque Mínimo': p.estoqueMinimo,
    Situação: p.quantidade <= p.estoqueMinimo ? 'ABAIXO DO MÍNIMO' : 'Normal',
    Localização: p.localizacao ?? '',
    'Custo Unitário (R$)': p.custoUnitario,
    'Valor Total em Estoque (R$)': Math.round(p.quantidade * p.custoUnitario * 100) / 100,
    'Preço de Venda (R$)': p.precoVenda,
    Observações: p.observacoes ?? '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 16 },
    { wch: 40 },
    { wch: 26 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 18 },
    { wch: 22 },
    { wch: 18 },
    { wch: 24 },
    { wch: 18 },
    { wch: 32 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estoque Atualizado');
  const safeSlug = companyName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30);

  XLSX.writeFile(wb, `estoque_${safeSlug || 'empresa'}_${todayISO()}.xlsx`);
}
