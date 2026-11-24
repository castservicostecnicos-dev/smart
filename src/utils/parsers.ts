import type { BankTxType, InvoiceType } from '../types/erp';
import {
  extractCpfCnpjFromText,
  extractDocumentNumberFromText,
  extractPayerNameFromText,
  formatCpfCnpj,
  normalizeIsoDateLoose,
} from './financeDocuments';

export interface ParsedXmlInvoice {
  numero: string;
  serie: string;
  chaveAcesso: string;
  tipo: InvoiceType;
  clienteNome: string;
  clienteDocumento: string;
  valor: number;
  dataEmissao: string;
  dataVencimento: string;
  itensResumo: string;
  descricaoServicos: string;
}

export interface ParsedBankRow {
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
}

function firstTagText(root: Document | Element, tagNames: string[]): string {
  for (const tag of tagNames) {
    const el = root.getElementsByTagName(tag)[0] || root.getElementsByTagNameNS('*', tag)[0];
    if (el && el.textContent && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }
  return '';
}

export function parseNFeXml(xmlContent: string): ParsedXmlInvoice {
  if (xmlContent.length > 5 * 1024 * 1024) {
    throw new Error('O arquivo XML excede o limite seguro de 5 MB.');
  }
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xmlContent)) {
    throw new Error('XML bloqueado por conter declarações externas não permitidas (DOCTYPE/ENTITY).');
  }

  const trimmed = xmlContent.trim();
  if (!trimmed.startsWith('<')) {
    throw new Error('O arquivo selecionado não possui estrutura XML válida.');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, 'application/xml');
  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    throw new Error('Não foi possível interpretar o XML da nota fiscal. Verifique se o arquivo está íntegro.');
  }

  // Verificar estritamente NF de Saída em leiaute NF-e / NFC-e
  const tpNF = firstTagText(doc, ['tpNF']);
  if (tpNF === '0') {
    throw new Error(
      'XML identificado como Nota Fiscal de ENTRADA (tpNF = 0). Nesta etapa, o sistema importa exclusivamente Notas Fiscais de SAÍDA.'
    );
  }

  const isNfse =
    doc.getElementsByTagName('CompNfse').length > 0 ||
    doc.getElementsByTagName('InfNfse').length > 0 ||
    doc.getElementsByTagName('NFSe').length > 0 ||
    doc.getElementsByTagName('DPS').length > 0;

  const mod = firstTagText(doc, ['mod']);
  const tipo: InvoiceType = isNfse ? 'NFS-e' : mod === '65' ? 'NFC-e' : 'NF-e';

  const numero = firstTagText(doc, ['nNF', 'Numero', 'nNFSe', 'nDPS']);
  const serie = firstTagText(doc, ['serie', 'Serie']) || '1';
  const chaveAcesso = firstTagText(doc, ['chNFe', 'chNFSe', 'chaveAcesso', 'CodigoVerificacao']).slice(0, 60);

  const rawDate = firstTagText(doc, ['dhEmi', 'dEmi', 'DataEmissao', 'dhProc', 'dCompet']);
  const dataEmissao = normalizeIsoDateLoose(rawDate);

  const rawDueDate = firstTagText(doc, ['dVenc', 'DataVencimento']);
  const dataVencimento = normalizeIsoDateLoose(rawDueDate);

  const rawValor = firstTagText(doc, ['vNF', 'ValorServicos', 'ValorLiquidoNfse', 'vLiq', 'vServ', 'vProd']);
  const valor = Number(rawValor.replace(',', '.'));

  // Destinatário / Tomador (cliente na NF de saída)
  const destEl =
    doc.getElementsByTagName('dest')[0] ||
    doc.getElementsByTagName('TomadorServico')[0] ||
    doc.getElementsByTagName('Tomador')[0] ||
    doc.getElementsByTagName('toma')[0];

  const clienteNome = destEl
    ? firstTagText(destEl, ['xNome', 'RazaoSocial', 'Nome'])
    : firstTagText(doc, ['xNome', 'RazaoSocial']);

  const rawDoc = destEl ? firstTagText(destEl, ['CNPJ', 'CPF', 'Cnpj', 'Cpf']) : '';
  const clienteDocumento = rawDoc ? formatCpfCnpj(rawDoc) : '';

  // Itens (<det><prod>...) e informações complementares (<infCpl>)
  const detEls = Array.from(doc.getElementsByTagName('det'));
  const itemLines: string[] = [];
  for (const det of detEls.slice(0, 8)) {
    const xProd = firstTagText(det, ['xProd']);
    const qCom = firstTagText(det, ['qCom']);
    const vProd = firstTagText(det, ['vProd']);
    if (xProd) {
      const qtyLabel = qCom ? ` (${Number(qCom.replace(',', '.')).toLocaleString('pt-BR')}x)` : '';
      const valLabel = vProd ? ` R$ ${Number(vProd.replace(',', '.')).toFixed(2).replace('.', ',')}` : '';
      itemLines.push(`${xProd}${qtyLabel}${valLabel}`);
    }
  }

  const infCpl = firstTagText(doc, ['infCpl', 'Discriminacao', 'xDescServ', 'xServ']);
  const itensResumo = [itemLines.join(' | '), infCpl].filter(Boolean).join(' — ').slice(0, 600);
  const descricaoServicos = (itemLines[0] || infCpl || '').slice(0, 300);

  if (!numero || !dataEmissao || !Number.isFinite(valor) || valor <= 0 || !clienteNome) {
    throw new Error(
      'XML reconhecido, porém campos obrigatórios da nota fiscal de saída (número, data de emissão, cliente ou valor) não foram localizados.'
    );
  }

  return {
    numero: numero.slice(0, 40),
    serie: serie.slice(0, 10),
    chaveAcesso,
    tipo,
    clienteNome: clienteNome.slice(0, 160),
    clienteDocumento: clienteDocumento.slice(0, 24),
    valor: Math.round(valor * 100) / 100,
    dataEmissao,
    dataVencimento,
    itensResumo,
    descricaoServicos,
  };
}

function extractOfxTag(block: string, tag: string): string {
  const xmlRegex = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i');
  const match = xmlRegex.exec(block);
  return match ? match[1].trim() : '';
}

export function parseOfxStatement(content: string): ParsedBankRow[] {
  const bankId = extractOfxTag(content, 'BANKID') || extractOfxTag(content, 'ORG') || 'Banco OFX';
  const acctId = extractOfxTag(content, 'ACCTID') || '';

  const txBlocks = content.split(/<STMTTRN>/i).slice(1);
  if (txBlocks.length === 0) {
    throw new Error('Nenhuma transação (<STMTTRN>) encontrada neste arquivo OFX.');
  }
  if (txBlocks.length > 5000) {
    throw new Error('O arquivo OFX excede o limite de 5.000 lançamentos por importação.');
  }

  const results: ParsedBankRow[] = [];
  for (const rawBlock of txBlocks) {
    const block = rawBlock.split(/<\/STMTTRN>/i)[0] || rawBlock;
    const rawAmt = extractOfxTag(block, 'TRNAMT');
    const rawDate = extractOfxTag(block, 'DTPOSTED');
    const trnType = extractOfxTag(block, 'TRNTYPE').toUpperCase();
    const fitId = extractOfxTag(block, 'FITID');
    const checkNum = extractOfxTag(block, 'CHECKNUM') || extractOfxTag(block, 'REFNUM');
    const nameTag = extractOfxTag(block, 'NAME');
    const memoTag = extractOfxTag(block, 'MEMO');
    const memo = [nameTag, memoTag].filter(Boolean).join(' - ') || 'Lançamento bancário';

    const amount = Number(rawAmt.replace(',', '.'));
    const dataMovimento = normalizeIsoDateLoose(rawDate);

    if (!Number.isFinite(amount) || amount === 0 || !dataMovimento) {
      continue;
    }

    const tipo: BankTxType = amount > 0 || trnType === 'CREDIT' || trnType === 'DEP' ? 'credito' : 'debito';
    const cpfCnpjPagador = extractCpfCnpjFromText(memo);
    const nomePagador = (nameTag && !/^\d+$/.test(nameTag) ? nameTag : extractPayerNameFromText(memo)).slice(0, 160);
    const documentoBancario = (checkNum || extractDocumentNumberFromText(memo)).slice(0, 80);

    results.push({
      banco: bankId.slice(0, 100),
      conta: acctId.slice(0, 50),
      fitId: fitId.slice(0, 120),
      documentoBancario,
      nomePagador,
      cpfCnpjPagador,
      tipo,
      descricao: memo.slice(0, 220),
      valor: Math.round(Math.abs(amount) * 100) / 100,
      dataMovimento,
    });
  }

  if (results.length === 0) {
    throw new Error('O arquivo OFX não contém movimentações válidas com data e valor.');
  }

  return results;
}

function parseBrazilianNumber(raw: string): number {
  let clean = raw.replace(/[R$\s"]/g, '').trim();
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
  return Number(clean);
}

export function parseCsvStatement(content: string, defaultBankName = 'Extrato CSV'): ParsedBankRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error('O arquivo CSV precisa conter cabeçalho e ao menos uma linha de transação.');
  }
  if (lines.length > 5001) {
    throw new Error('O extrato CSV excede o limite seguro de 5.000 linhas por importação.');
  }

  const delimiter = lines[0].includes(';') ? ';' : ',';
  const splitRow = (line: string) =>
    line.split(delimiter).map((cell) => cell.replace(/^"|"$/g, '').trim());

  const headers = splitRow(lines[0]).map((h) => h.toLowerCase());
  const dateIdx = headers.findIndex((h) => h.includes('data') || h.includes('dt'));
  const descIdx = headers.findIndex(
    (h) => h.includes('desc') || h.includes('hist') || h.includes('memo') || h.includes('lanc')
  );
  const valIdx = headers.findIndex((h) => h.includes('valor') || h.includes('amount') || h.includes('quantia'));
  const tipoIdx = headers.findIndex((h) => h.includes('tipo') || h.includes('natureza'));
  const pagadorIdx = headers.findIndex((h) => h.includes('pagador') || h.includes('cliente') || h.includes('favorecido'));
  const docPessoaIdx = headers.findIndex((h) => h.includes('cpf') || h.includes('cnpj'));
  const numDocIdx = headers.findIndex((h) => h.includes('doc') || h.includes('nsu') || h.includes('comprovante'));

  if (dateIdx === -1 || descIdx === -1 || valIdx === -1) {
    throw new Error(
      'Cabeçalho CSV não reconhecido. O arquivo deve conter colunas de Data, Descrição/Histórico e Valor.'
    );
  }

  const results: ParsedBankRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (cols.length <= Math.max(dateIdx, descIdx, valIdx)) continue;

    const dataMovimento = normalizeIsoDateLoose(cols[dateIdx]);
    const descricao = cols[descIdx] || 'Lançamento bancário';
    const rawAmount = parseBrazilianNumber(cols[valIdx]);

    if (!dataMovimento || !Number.isFinite(rawAmount) || rawAmount === 0) continue;

    let tipo: BankTxType = rawAmount >= 0 ? 'credito' : 'debito';
    if (tipoIdx !== -1 && cols[tipoIdx]) {
      const t = cols[tipoIdx].toLowerCase();
      if (t.includes('deb') || t.includes('saíd') || t.includes('said') || t === 'd') {
        tipo = 'debito';
      } else if (t.includes('cred') || t.includes('entrad') || t === 'c') {
        tipo = 'credito';
      }
    }

    const rawDocPessoa = docPessoaIdx !== -1 ? cols[docPessoaIdx] : '';
    const cpfCnpjPagador = formatCpfCnpj(rawDocPessoa || extractCpfCnpjFromText(descricao));
    const nomePagador = (
      (pagadorIdx !== -1 ? cols[pagadorIdx] : '') || extractPayerNameFromText(descricao)
    ).slice(0, 160);
    const documentoBancario = (
      (numDocIdx !== -1 && numDocIdx !== docPessoaIdx ? cols[numDocIdx] : '') ||
      extractDocumentNumberFromText(descricao)
    ).slice(0, 80);

    results.push({
      banco: defaultBankName.slice(0, 100),
      conta: '',
      fitId: `csv-${i}-${dataMovimento}`,
      documentoBancario,
      nomePagador,
      cpfCnpjPagador,
      tipo,
      descricao: descricao.slice(0, 220),
      valor: Math.round(Math.abs(rawAmount) * 100) / 100,
      dataMovimento,
    });
  }

  if (results.length === 0) {
    throw new Error('Nenhuma transação válida encontrada no CSV. Verifique o formato das datas (DD/MM/AAAA) e valores.');
  }

  return results;
}

export function parseBankStatementFile(fileName: string, content: string): ParsedBankRow[] {
  if (content.length > 10 * 1024 * 1024) {
    throw new Error('O arquivo de extrato excede o limite máximo suportado (10 MB).');
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ofx') || content.includes('<OFX>') || content.includes('<STMTTRN>')) {
    return parseOfxStatement(content);
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return parseCsvStatement(content);
  }
  throw new Error('Formato de arquivo não suportado diretamente em texto. Utilize .OFX, .CSV, Excel ou PDF.');
}
