import * as XLSX from 'xlsx';
import type {
  BankTransaction,
  BankTxType,
  Customer,
  CustomerPersonType,
  Invoice,
  InvoiceType,
} from '../types/erp';

export function digitsOnly(raw: string | undefined | null): string {
  return (raw ?? '').replace(/\D/g, '');
}

export function isValidCpf(cpfRaw: string): boolean {
  const cpf = digitsOnly(cpfRaw);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(cpf[i]) * (10 - i);
  let rev = 11 - (sum % 11);
  if (rev >= 10) rev = 0;
  if (rev !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(cpf[i]) * (11 - i);
  rev = 11 - (sum % 11);
  if (rev >= 10) rev = 0;
  return rev === Number(cpf[10]);
}

export function isValidCnpj(cnpjRaw: string): boolean {
  const cnpj = digitsOnly(cnpjRaw);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;

  const calcDigit = (base: string, weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) {
      sum += Number(base[i]) * weights[i];
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calcDigit(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calcDigit(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

export function isValidCpfOrCnpjDigits(cleanDigits: string): boolean {
  if (cleanDigits.length === 11) return isValidCpf(cleanDigits);
  if (cleanDigits.length === 14) return isValidCnpj(cleanDigits);
  return false;
}

export function detectPersonType(raw: string | undefined | null): CustomerPersonType {
  const d = digitsOnly(raw);
  if (d.length === 11) return 'PF';
  if (d.length === 14) return 'PJ';
  return 'NAO_IDENTIFICADO';
}

export function formatCpfCnpj(raw: string | undefined | null): string {
  const d = digitsOnly(raw);
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
  }
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
  }
  return (raw ?? '').trim().slice(0, 24);
}

export function extractCpfCnpjFromText(text: string): string {
  if (!text) return '';
  // CNPJ formatado ou 14 dígitos isolados
  const formattedCnpj = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/.exec(text);
  if (formattedCnpj && isValidCnpj(formattedCnpj[0])) return formatCpfCnpj(formattedCnpj[0]);

  const formattedCpf = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.exec(text);
  if (formattedCpf && isValidCpf(formattedCpf[0])) return formatCpfCnpj(formattedCpf[0]);

  const raw14 = text.match(/(?<!\d)\d{14}(?!\d)/g) ?? [];
  for (const candidate of raw14) {
    if (isValidCnpj(candidate)) return formatCpfCnpj(candidate);
  }

  const raw11 = text.match(/(?<!\d)\d{11}(?!\d)/g) ?? [];
  for (const candidate of raw11) {
    if (isValidCpf(candidate)) return formatCpfCnpj(candidate);
  }

  return '';
}

export function extractDocumentNumberFromText(text: string): string {
  if (!text) return '';
  const match =
    /(?:DOC(?:UMENTO)?|NSU|AUT(?:ENT)?|ID|COMP(?:ROVANTE)?|BOLETO|NF-?E?)\s*[:#º°-]?\s*([A-Z0-9.\-/]{3,24})/i.exec(
      text
    );
  return match ? match[1].trim().slice(0, 80) : '';
}

export function extractPayerNameFromText(text: string): string {
  if (!text) return '';
  const patterns = [
    /(?:PIX\s+(?:RECEBIDO|ENV|CRED)?(?:\s+DE)?|TED\s+(?:RECEBIDA|CRED)?(?:\s+DE)?|DOC\s+RECEBIDO|RECEBIMENTO(?:\s+DE)?)\s*[-–:]\s*([A-Za-zÀ-ÿ0-9\s.&'/\-]{3,80})/i,
    /(?:PAGADOR|REMETENTE|CLIENTE)\s*[:\-]\s*([A-Za-zÀ-ÿ0-9\s.&'/\-]{3,80})/i,
  ];
  for (const regex of patterns) {
    const m = regex.exec(text);
    if (m && m[1]) {
      const cleaned = m[1]
        .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '')
        .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '')
        .replace(/(?<!\d)\d{11,14}(?!\d)/g, '')
        .replace(/[\s\-–:]+$/g, '')
        .trim();
      if (cleaned.length >= 3) return cleaned.slice(0, 160);
    }
  }
  return '';
}

export function normalizeTextKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function areNamesSimilar(a: string, b: string): boolean {
  const ka = normalizeTextKey(a);
  const kb = normalizeTextKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 5 && kb.includes(ka)) return true;
  if (kb.length >= 5 && ka.includes(kb)) return true;
  const tokensA = new Set(ka.split(' ').filter((t) => t.length >= 3));
  const tokensB = new Set(kb.split(' ').filter((t) => t.length >= 3));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) shared += 1;
  }
  return shared >= Math.min(2, tokensA.size, tokensB.size);
}

export interface CustomerMatchResult {
  matchType: 'exact_cpf_cnpj' | 'similar_name_only' | 'none';
  matchedCustomer: Customer | null;
  similarCandidates: Customer[];
}

/**
 * Regra estrita de identificação de clientes:
 * - Nunca presume que duas pessoas/empresas são iguais apenas porque possuem nomes semelhantes.
 * - Só vincula automaticamente quando há CPF/CNPJ exatamente coincidente (11 ou 14 dígitos).
 */
export function findCustomerMatch(
  customers: Customer[],
  nome: string,
  documento?: string
): CustomerMatchResult {
  const cleanDoc = digitsOnly(documento);
  if (cleanDoc.length === 11 || cleanDoc.length === 14) {
    const exact = customers.find((c) => digitsOnly(c.documentoLimpo || c.documento) === cleanDoc) ?? null;
    if (exact) {
      return {
        matchType: 'exact_cpf_cnpj',
        matchedCustomer: exact,
        similarCandidates: [],
      };
    }
  }

  const similarCandidates = nome.trim()
    ? customers.filter((c) => areNamesSimilar(c.nome, nome))
    : [];

  if (similarCandidates.length > 0) {
    return {
      matchType: 'similar_name_only',
      matchedCustomer: null,
      similarCandidates,
    };
  }

  return {
    matchType: 'none',
    matchedCustomer: null,
    similarCandidates: [],
  };
}

export function normalizeIsoDateLoose(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 20000 && raw < 80000) {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  const clean = String(raw ?? '').trim();
  if (!clean) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return clean.slice(0, 10);
  const brMatch = /^(\d{2})[/\-.](\d{2})[/\-.](\d{4})/.exec(clean);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
  const ofxMatch = /^(\d{4})(\d{2})(\d{2})/.exec(clean);
  if (ofxMatch) return `${ofxMatch[1]}-${ofxMatch[2]}-${ofxMatch[3]}`;
  return '';
}

export function parseLocalizedNumberLoose(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const isParenNegative = /^\(.*\)$/.test(s);
  let clean = s.replace(/[R$\s"()]/g, '').trim();
  if (!clean) return NaN;

  if (clean.includes(',') && clean.includes('.')) {
    if (clean.lastIndexOf(',') > clean.lastIndexOf('.')) {
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else {
      clean = clean.replace(/,/g, '');
    }
  } else if (clean.includes(',')) {
    clean = clean.replace(',', '.');
  }
  const num = Number(clean);
  if (!Number.isFinite(num)) return NaN;
  return isParenNegative ? -Math.abs(num) : num;
}

export interface GenericSheetData {
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface ParsedGenericWorkbook {
  fileName: string;
  sheetNames: string[];
  sheets: Record<string, GenericSheetData>;
}

export async function parseSpreadsheetWorkbook(file: File): Promise<ParsedGenericWorkbook> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['xlsx', 'xls', 'csv', 'txt'].includes(ext)) {
    throw new Error('Formato não suportado para leitura tabular. Envie .xlsx, .xls ou .csv.');
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
    throw new Error('O arquivo selecionado deve ter entre 1 byte e 10 MB.');
  }

  let workbook: XLSX.WorkBook;
  if (ext === 'csv' || ext === 'txt') {
    const text = await file.text();
    workbook = XLSX.read(text, { type: 'string', raw: false, cellFormula: false, cellHTML: false });
  } else {
    const buf = await file.arrayBuffer();
    workbook = XLSX.read(buf, { type: 'array', cellDates: true, cellFormula: false, cellHTML: false });
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Nenhuma aba com dados encontrada no arquivo.');
  }

  const sheets: Record<string, GenericSheetData> = {};
  const validSheetNames: string[] = [];

  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    if (!ws) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
    if (!matrix || matrix.length === 0) continue;
    if (matrix.length > 5005) {
      throw new Error(`A aba "${name}" excede o limite de 5.000 linhas por importação.`);
    }

    // Localiza primeira linha de cabeçalho real (com >= 2 células preenchidas)
    let headerIdx = matrix.findIndex((row) => Array.isArray(row) && row.filter((c) => String(c ?? '').trim() !== '').length >= 2);
    if (headerIdx === -1) headerIdx = 0;

    const rawHeaders = (matrix[headerIdx] as unknown[]) || [];
    const headers = rawHeaders.map((h, i) => {
      const label = String(h ?? '').trim();
      return label || `Coluna ${i + 1}`;
    });

    const rows: Record<string, unknown>[] = [];
    for (let r = headerIdx + 1; r < matrix.length; r += 1) {
      const rowArr = (matrix[r] as unknown[]) || [];
      const hasAny = rowArr.some((c) => String(c ?? '').trim() !== '');
      if (!hasAny) continue;
      const obj: Record<string, unknown> = {};
      headers.forEach((h, cIdx) => {
        obj[h] = rowArr[cIdx] ?? '';
      });
      rows.push(obj);
    }

    if (headers.length > 0 && rows.length > 0) {
      validSheetNames.push(name);
      sheets[name] = { headers, rows };
    }
  }

  if (validSheetNames.length === 0) {
    throw new Error('O arquivo selecionado está vazio ou não possui linhas de dados válidas.');
  }

  return {
    fileName: file.name,
    sheetNames: validSheetNames,
    sheets,
  };
}

function matchHeader(headers: string[], aliases: string[]): string {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeTextKey(h) }));
  for (const alias of aliases) {
    const exact = normalized.find((h) => h.key === alias);
    if (exact) return exact.raw;
  }
  for (const alias of aliases) {
    const partial = normalized.find((h) => h.key.includes(alias));
    if (partial) return partial.raw;
  }
  return '';
}

// ==================== MAPEAMENTO DE EXTRATO BANCÁRIO (EXCEL / CSV) ====================

export type BankColumnField =
  | 'dataMovimento'
  | 'descricao'
  | 'nomePagador'
  | 'cpfCnpjPagador'
  | 'valor'
  | 'valorCredito'
  | 'valorDebito'
  | 'tipo'
  | 'fitId'
  | 'documentoBancario'
  | 'banco'
  | 'conta';

export type BankColumnMapping = Record<BankColumnField, string>;

export function autoDetectBankColumns(headers: string[]): BankColumnMapping {
  return {
    dataMovimento: matchHeader(headers, ['data movimento', 'data', 'dt', 'data lancamento', 'vencimento']),
    descricao: matchHeader(headers, ['descricao', 'historico', 'lancamento', 'memo', 'detalhes', 'observacao']),
    nomePagador: matchHeader(headers, ['pagador', 'nome pagador', 'cliente', 'remetente', 'favorecido', 'contraparte']),
    cpfCnpjPagador: matchHeader(headers, ['cpf cnpj', 'cpf/cnpj', 'cpf', 'cnpj', 'documento pagador', 'doc pagador']),
    valor: matchHeader(headers, ['valor', 'quantia', 'amount', 'valor r', 'total']),
    valorCredito: matchHeader(headers, ['credito', 'entrada', 'recebimento', 'valor credito']),
    valorDebito: matchHeader(headers, ['debito', 'saida', 'pagamento', 'valor debito']),
    tipo: matchHeader(headers, ['tipo', 'natureza', 'operacao', 'd c', 'c d']),
    fitId: matchHeader(headers, ['fitid', 'id bancario', 'identificador', 'id transacao', 'codigo operacao']),
    documentoBancario: matchHeader(headers, ['numero documento', 'n documento', 'documento', 'nr doc', 'nsu', 'comprovante']),
    banco: matchHeader(headers, ['banco', 'instituicao']),
    conta: matchHeader(headers, ['conta', 'agencia conta']),
  };
}

export interface BankPreviewItem {
  rowIndex: number;
  dataMovimento: string;
  descricao: string;
  nomePagador: string;
  cpfCnpjPagador: string;
  valor: number;
  tipo: BankTxType;
  fitId: string;
  documentoBancario: string;
  banco: string;
  conta: string;
  duplicateOfExisting: boolean;
  errors: string[];
  include: boolean;
}

export function buildBankPreviewFromSpreadsheet(
  rows: Record<string, unknown>[],
  mapping: BankColumnMapping,
  defaultBanco: string,
  defaultConta: string,
  existingBankTxs: BankTransaction[]
): BankPreviewItem[] {
  const existingFitIds = new Set(existingBankTxs.map((b) => b.fitId).filter(Boolean));
  const existingFingerprints = new Set(
    existingBankTxs.map((b) => `${b.dataMovimento}|${b.valor.toFixed(2)}|${normalizeTextKey(b.descricao)}`)
  );

  return rows.map((row, idx) => {
    const errors: string[] = [];
    const dataMovimento = mapping.dataMovimento
      ? normalizeIsoDateLoose(row[mapping.dataMovimento])
      : '';
    const descricao = mapping.descricao ? String(row[mapping.descricao] ?? '').trim() : '';

    let tipo: BankTxType = 'credito';
    let valor = NaN;

    const credVal = mapping.valorCredito ? parseLocalizedNumberLoose(row[mapping.valorCredito]) : NaN;
    const debVal = mapping.valorDebito ? parseLocalizedNumberLoose(row[mapping.valorDebito]) : NaN;

    if (Number.isFinite(credVal) && Math.abs(credVal) > 0) {
      valor = Math.abs(credVal);
      tipo = 'credito';
    } else if (Number.isFinite(debVal) && Math.abs(debVal) > 0) {
      valor = Math.abs(debVal);
      tipo = 'debito';
    } else if (mapping.valor) {
      const rawVal = parseLocalizedNumberLoose(row[mapping.valor]);
      if (Number.isFinite(rawVal) && rawVal !== 0) {
        valor = Math.abs(rawVal);
        tipo = rawVal >= 0 ? 'credito' : 'debito';
      }
    }

    if (mapping.tipo && row[mapping.tipo]) {
      const rawTipo = normalizeTextKey(String(row[mapping.tipo]));
      if (rawTipo.includes('deb') || rawTipo.includes('said') || rawTipo === 'd') {
        tipo = 'debito';
      } else if (rawTipo.includes('cred') || rawTipo.includes('entrad') || rawTipo === 'c') {
        tipo = 'credito';
      }
    }

    const rawDoc = mapping.cpfCnpjPagador ? String(row[mapping.cpfCnpjPagador] ?? '').trim() : '';
    const cpfCnpjPagador = formatCpfCnpj(rawDoc || extractCpfCnpjFromText(descricao));

    const rawPagador = mapping.nomePagador ? String(row[mapping.nomePagador] ?? '').trim() : '';
    const nomePagador = (rawPagador || extractPayerNameFromText(descricao)).slice(0, 160);

    const rawDocBanc = mapping.documentoBancario
      ? String(row[mapping.documentoBancario] ?? '').trim()
      : '';
    const documentoBancario = (rawDocBanc || extractDocumentNumberFromText(descricao)).slice(0, 80);

    const rawFitId = mapping.fitId ? String(row[mapping.fitId] ?? '').trim() : '';
    const fitId = (rawFitId || `imp-${idx + 1}-${dataMovimento || 'nodate'}`).slice(0, 120);

    const banco = (
      (mapping.banco ? String(row[mapping.banco] ?? '').trim() : '') ||
      defaultBanco ||
      'Extrato Importado'
    ).slice(0, 100);
    const conta = (
      (mapping.conta ? String(row[mapping.conta] ?? '').trim() : '') ||
      defaultConta ||
      ''
    ).slice(0, 50);

    if (!dataMovimento) errors.push('Data inválida ou ausente.');
    if (!descricao) errors.push('Descrição ausente.');
    if (!Number.isFinite(valor) || valor <= 0) errors.push('Valor deve ser diferente de zero.');

    const roundedVal = Number.isFinite(valor) ? Math.round(valor * 100) / 100 : 0;
    const fp = `${dataMovimento}|${roundedVal.toFixed(2)}|${normalizeTextKey(descricao)}`;
    const duplicateOfExisting =
      (Boolean(rawFitId) && existingFitIds.has(rawFitId)) || (Boolean(dataMovimento) && existingFingerprints.has(fp));

    return {
      rowIndex: idx + 1,
      dataMovimento,
      descricao: descricao.slice(0, 220),
      nomePagador,
      cpfCnpjPagador,
      valor: roundedVal,
      tipo,
      fitId,
      documentoBancario,
      banco,
      conta,
      duplicateOfExisting,
      errors,
      include: errors.length === 0 && !duplicateOfExisting,
    };
  });
}

// ==================== MAPEAMENTO DE NOTAS FISCAIS DE SAÍDA (EXCEL / CSV) ====================

export type InvoiceColumnField =
  | 'numero'
  | 'serie'
  | 'chaveAcesso'
  | 'tipo'
  | 'tipoOperacao'
  | 'dataEmissao'
  | 'dataVencimento'
  | 'clienteNome'
  | 'clienteDocumento'
  | 'valor'
  | 'itensResumo';

export type InvoiceColumnMapping = Record<InvoiceColumnField, string>;

export function autoDetectInvoiceColumns(headers: string[]): InvoiceColumnMapping {
  return {
    numero: matchHeader(headers, ['numero', 'n nf', 'nf', 'numero nota', 'num nf', 'nfe']),
    serie: matchHeader(headers, ['serie']),
    chaveAcesso: matchHeader(headers, ['chave acesso', 'chave', 'codigo verificacao']),
    tipo: matchHeader(headers, ['tipo nota', 'modelo', 'tipo documento', 'especie']),
    tipoOperacao: matchHeader(headers, ['operacao', 'natureza', 'entrada saida', 'tipo operacao']),
    dataEmissao: matchHeader(headers, ['emissao', 'data emissao', 'dt emissao', 'data']),
    dataVencimento: matchHeader(headers, ['vencimento', 'data vencimento', 'dt venc']),
    clienteNome: matchHeader(headers, ['cliente', 'destinatario', 'tomador', 'razao social', 'nome cliente']),
    clienteDocumento: matchHeader(headers, ['cpf cnpj', 'cpf/cnpj', 'cnpj', 'cpf', 'documento cliente', 'cnpj cpf']),
    valor: matchHeader(headers, ['valor total', 'valor nf', 'valor', 'total', 'liquido']),
    itensResumo: matchHeader(headers, ['itens', 'produtos', 'servicos', 'descricao', 'observacoes', 'informacoes adicionais']),
  };
}

export interface OutboundInvoicePreviewItem {
  rowIndex: number;
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
  customerMatch: CustomerMatchResult;
  duplicateOfExisting: boolean;
  isInboundRejected: boolean;
  errors: string[];
  include: boolean;
}

export function buildOutboundInvoicePreview(
  rows: Record<string, unknown>[],
  mapping: InvoiceColumnMapping,
  defaultSerie: string,
  existingInvoices: Invoice[],
  customers: Customer[]
): OutboundInvoicePreviewItem[] {
  const existingKeys = new Set(
    existingInvoices.map((inv) =>
      inv.chaveAcesso
        ? `key:${inv.chaveAcesso.trim()}`
        : `num:${inv.numero.trim()}|${inv.serie.trim()}|${digitsOnly(inv.clienteDocumento)}`
    )
  );

  return rows.map((row, idx) => {
    const errors: string[] = [];
    const numero = mapping.numero ? String(row[mapping.numero] ?? '').trim().slice(0, 40) : '';
    const serie = (mapping.serie ? String(row[mapping.serie] ?? '').trim() : '') || defaultSerie || '1';
    const chaveAcesso = mapping.chaveAcesso
      ? String(row[mapping.chaveAcesso] ?? '').replace(/\s+/g, '').slice(0, 60)
      : '';

    const rawOp = mapping.tipoOperacao ? normalizeTextKey(String(row[mapping.tipoOperacao] ?? '')) : '';
    const isInboundRejected =
      rawOp === 'entrada' || rawOp === '0' || rawOp.includes('entrada') || rawOp.includes('compra');
    if (isInboundRejected) {
      errors.push('Nota marcada como ENTRADA. Somente notas fiscais de SAÍDA são aceitas.');
    }

    const rawTipo = mapping.tipo ? String(row[mapping.tipo] ?? '').toUpperCase() : '';
    const tipo: InvoiceType = rawTipo.includes('NFS')
      ? 'NFS-e'
      : rawTipo.includes('NFC')
        ? 'NFC-e'
        : 'NF-e';

    const dataEmissao = mapping.dataEmissao ? normalizeIsoDateLoose(row[mapping.dataEmissao]) : '';
    const dataVencimento = mapping.dataVencimento ? normalizeIsoDateLoose(row[mapping.dataVencimento]) : '';
    const clienteNome = mapping.clienteNome
      ? String(row[mapping.clienteNome] ?? '').trim().slice(0, 160)
      : '';
    const rawDoc = mapping.clienteDocumento ? String(row[mapping.clienteDocumento] ?? '').trim() : '';
    const clienteDocumento = formatCpfCnpj(rawDoc).slice(0, 24);
    const valor = mapping.valor ? parseLocalizedNumberLoose(row[mapping.valor]) : NaN;
    const itensResumo = mapping.itensResumo
      ? String(row[mapping.itensResumo] ?? '').trim().slice(0, 600)
      : '';

    if (!numero) errors.push('Número da NF ausente.');
    if (!dataEmissao) errors.push('Data de emissão inválida/ausente.');
    if (!clienteNome) errors.push('Nome do cliente ausente.');
    if (!Number.isFinite(valor) || valor <= 0) errors.push('Valor total deve ser maior que zero.');

    const cleanValor = Number.isFinite(valor) ? Math.round(valor * 100) / 100 : 0;
    const keySig = chaveAcesso
      ? `key:${chaveAcesso}`
      : `num:${numero}|${serie}|${digitsOnly(clienteDocumento)}`;
    const duplicateOfExisting = Boolean(numero) && existingKeys.has(keySig);
    const customerMatch = findCustomerMatch(customers, clienteNome, clienteDocumento);

    return {
      rowIndex: idx + 1,
      numero,
      serie: serie.slice(0, 10),
      chaveAcesso,
      tipo,
      dataEmissao,
      dataVencimento,
      clienteNome,
      clienteDocumento,
      valor: cleanValor,
      itensResumo,
      customerMatch,
      duplicateOfExisting,
      isInboundRejected,
      errors,
      include: errors.length === 0 && !duplicateOfExisting,
    };
  });
}

// ==================== PONTUAÇÃO ESTRITA DE CONCILIAÇÃO NF x EXTRATO ====================

export interface InvoiceCandidateMatch {
  inv: Invoice;
  score: number;
  diffValor: number;
  cpfCnpjMatch: boolean;
  invoiceNumberMentioned: boolean;
  nameSimilarWithoutDoc: boolean;
}

export function scoreInvoiceCandidate(
  bankTx: BankTransaction,
  inv: Invoice,
  toleranceDays: number
): InvoiceCandidateMatch {
  const remaining = Math.max(0, inv.valor - inv.valorRecebido);
  const diffValor = Math.abs((remaining > 0 ? remaining : inv.valor) - bankTx.valor);
  const fullValorDiff = Math.abs(inv.valor - bankTx.valor);
  const bestValorDiff = Math.min(diffValor, fullValorDiff);

  const txTime = new Date(bankTx.dataMovimento).getTime();
  const invTime = new Date(inv.dataEmissao).getTime();
  const maxDiffMs = Math.max(1, toleranceDays) * 86400000;
  const dateClose = Math.abs(invTime - txTime) <= maxDiffMs;

  const bankDoc = digitsOnly(bankTx.cpfCnpjPagador || extractCpfCnpjFromText(bankTx.descricao));
  const invDoc = digitsOnly(inv.clienteDocumento);
  const cpfCnpjMatch = Boolean(bankDoc && invDoc && bankDoc === invDoc);

  const numClean = inv.numero.replace(/^0+/, '');
  const hay = `${bankTx.descricao} ${bankTx.documentoBancario ?? ''}`;
  const invoiceNumberMentioned =
    Boolean(numClean && numClean.length >= 2) &&
    new RegExp(`(?<!\\d)0*${numClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(hay);

  const payerCandidate = bankTx.nomePagador || extractPayerNameFromText(bankTx.descricao);
  const nameSimilar = payerCandidate ? areNamesSimilar(payerCandidate, inv.clienteNome) : false;
  const nameSimilarWithoutDoc = nameSimilar && !cpfCnpjMatch;

  let score = 0;
  if (cpfCnpjMatch) score += 5;
  if (invoiceNumberMentioned) score += 4;
  if (bestValorDiff < 0.05) score += 3;
  else if (bestValorDiff < 5) score += 1;
  if (dateClose) score += 2;

  return {
    inv,
    score,
    diffValor: bestValorDiff,
    cpfCnpjMatch,
    invoiceNumberMentioned,
    nameSimilarWithoutDoc,
  };
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error('Falha ao ler arquivo local para envio.'));
    reader.readAsDataURL(file);
  });
}
