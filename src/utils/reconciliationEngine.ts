import * as XLSX from 'xlsx';
import type {
  BankTransaction,
  Invoice,
  ReconciliationConfidence,
  ReconciliationRecord,
} from '../types/erp';
import {
  digitsOnly,
  extractCpfCnpjFromText,
  extractPayerNameFromText,
  normalizeTextKey,
} from './financeDocuments';
import { formatDateBR } from './formatters';

export type ReconciliationSituationType =
  | 'nota_totalmente_recebida'
  | 'nota_parcialmente_recebida'
  | 'nota_sem_recebimento'
  | 'recebimento_sem_nf'
  | 'recebimento_multiplas_candidatas'
  | 'pagamento_parcelado'
  | 'pagamento_agrupado'
  | 'possivel_duplicidade'
  | 'correspondencia_incerta_revisao';

export type ReconciliationReportKey =
  | 'notas_totalmente_recebidas'
  | 'notas_parcialmente_recebidas'
  | 'notas_sem_recebimento'
  | 'recebimentos_sem_nf'
  | 'conciliacoes_pendentes'
  | 'divergencias_valores'
  | 'possiveis_duplicidades';

export interface ReconciliationFilters {
  dataInicio: string;
  dataFim: string;
  clienteOuPagador: string;
  banco: string;
  valorMin: string;
  valorMax: string;
}

export interface MultiCriteriaCandidate {
  invoice: Invoice;
  confidenceScore: number;
  confidenceLevel: Exclude<ReconciliationConfidence, 'manual'>;
  criteriaMatched: string[];
  criteriaDivergent: string[];
  diffValor: number;
  daysApart: number;
  amountOnlyWarning: boolean;
  nameSimilarWithoutDoc: boolean;
}

export interface GroupedInvoiceCandidate {
  bankTx: BankTransaction;
  invoices: Invoice[];
  sumOpenInvoices: number;
  diffValor: number;
  confidenceLevel: 'alta' | 'media' | 'baixa';
  justification: string;
}

export interface DuplicateFlagItem {
  entityType: 'Extrato Bancário' | 'Nota Fiscal';
  id: string;
  referenceLabel: string;
  partyName: string;
  date: string;
  amount: number;
  reason: string;
  relatedIds: string[];
}

export interface DivergenceItem {
  id: string;
  origin: 'Nota Fiscal' | 'Conciliação';
  invoiceNumber: string;
  clienteNome: string;
  date: string;
  expectedAmount: number;
  receivedAmount: number;
  difference: number;
  detail: string;
}

export interface PendingReconciliationItem {
  bankTx: BankTransaction;
  availableAmount: number;
  situations: ReconciliationSituationType[];
  topCandidates: MultiCriteriaCandidate[];
  groupedCandidate: GroupedInvoiceCandidate | null;
  requiresHumanReviewReason: string;
}

export interface ReconciliationDiagnosticsResult {
  situationCounts: Record<ReconciliationSituationType, number>;
  reports: {
    notasTotalmenteRecebidas: Invoice[];
    notasParcialmenteRecebidas: Invoice[];
    notasSemRecebimento: Invoice[];
    recebimentosSemNf: BankTransaction[];
    conciliacoesPendentes: PendingReconciliationItem[];
    divergenciasValores: DivergenceItem[];
    possiveisDuplicidades: DuplicateFlagItem[];
  };
  rejectedPairKeys: Set<string>;
  invoiceLinkedCreditCount: Map<string, number>;
  bankLinkedInvoiceCount: Map<string, number>;
}

export interface AiReconciliationSuggestion {
  bankTransactionId: string;
  invoiceIds: string[];
  matchType: 'unica' | 'parcela' | 'agrupado' | 'revisao_incerta';
  confidenceLevel: 'alta' | 'media' | 'baixa';
  confidenceScore: number;
  invoiceTotal: number;
  receivedAmount: number;
  differenceAmount: number;
  justification: string;
}

function daysBetweenISO(a: string, b: string): number {
  const ta = new Date(`${a}T12:00:00Z`).getTime();
  const tb = new Date(`${b}T12:00:00Z`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 999;
  return Math.round(Math.abs(ta - tb) / 86400000);
}

function tokenOverlapRatio(a: string, b: string): number {
  const stopWords = new Set(['ltda', 'me', 'epp', 'eireli', 'sa', 'pix', 'ted', 'doc', 'pagto', 'recebimento', 'de', 'da', 'do', 'dos', 'das', 'para', 'em', 'e']);
  const tokA = normalizeTextKey(a)
    .split(' ')
    .filter((t) => t.length >= 3 && !stopWords.has(t));
  const tokB = normalizeTextKey(b)
    .split(' ')
    .filter((t) => t.length >= 3 && !stopWords.has(t));
  if (tokA.length === 0 || tokB.length === 0) return 0;
  const setB = new Set(tokB);
  const common = tokA.filter((t) => setB.has(t)).length;
  return common / Math.max(1, Math.min(tokA.length, tokB.length));
}

export function getBankTxAvailableAmount(tx: BankTransaction): number {
  const allocated = Math.max(0, Number(tx.valorConciliado || 0));
  if (tx.statusConciliacao === 'conciliado_nf' && allocated === 0) return 0;
  return Math.max(0, Math.round((tx.valor - allocated) * 100) / 100);
}

export function getInvoiceOpenAmount(inv: Invoice): number {
  return Math.max(0, Math.round((inv.valor - inv.valorRecebido) * 100) / 100);
}

/**
 * Avaliação determinística multicritério entre um crédito bancário e uma nota fiscal de saída.
 * Regra absoluta: nunca concede confiança alta ou média usando somente valor monetário.
 */
export function evaluateMultiCriteriaMatch(
  bankTx: BankTransaction,
  inv: Invoice,
  toleranceDays: number
): MultiCriteriaCandidate {
  const criteriaMatched: string[] = [];
  const criteriaDivergent: string[] = [];

  const available = getBankTxAvailableAmount(bankTx) || bankTx.valor;
  const openInv = getInvoiceOpenAmount(inv) || inv.valor;
  const diffOpen = Math.round((available - openInv) * 100) / 100;
  const diffFull = Math.round((available - inv.valor) * 100) / 100;
  const diffValor = Math.abs(diffOpen) <= Math.abs(diffFull) ? diffOpen : diffFull;
  const absDiff = Math.abs(diffValor);

  const bankDoc = digitsOnly(bankTx.cpfCnpjPagador || extractCpfCnpjFromText(bankTx.descricao));
  const invDoc = digitsOnly(inv.clienteDocumento);
  const cpfCnpjMatch = Boolean(bankDoc && invDoc && bankDoc === invDoc);
  const cpfCnpjConflict = Boolean(bankDoc && invDoc && bankDoc !== invDoc);

  const numClean = inv.numero.replace(/^0+/, '');
  const hayBank = `${bankTx.descricao} ${bankTx.documentoBancario ?? ''} ${bankTx.fitId ?? ''}`;
  const invoiceNumberMentioned =
    Boolean(numClean && numClean.length >= 2) &&
    new RegExp(`(?<!\\d)0*${numClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(hayBank);

  const payerCandidate = bankTx.nomePagador || extractPayerNameFromText(bankTx.descricao);
  const nameRatio = payerCandidate ? tokenOverlapRatio(payerCandidate, inv.clienteNome) : 0;
  const descNameRatio = tokenOverlapRatio(bankTx.descricao, inv.clienteNome);
  const bestNameRatio = Math.max(nameRatio, descNameRatio);

  const itemContextRatio = inv.itensResumo || inv.descricaoServicos
    ? tokenOverlapRatio(bankTx.descricao, `${inv.itensResumo ?? ''} ${inv.descricaoServicos ?? ''}`)
    : 0;

  const daysEmissao = daysBetweenISO(bankTx.dataMovimento, inv.dataEmissao);
  const daysVenc = inv.dataVencimento ? daysBetweenISO(bankTx.dataMovimento, inv.dataVencimento) : 999;
  const daysApart = Math.min(daysEmissao, daysVenc);
  const dateClose = daysApart <= Math.max(1, toleranceDays);

  let score = 0;

  if (cpfCnpjMatch) {
    score += 40;
    criteriaMatched.push('CPF/CNPJ idêntico');
  } else if (cpfCnpjConflict) {
    score -= 35;
    criteriaDivergent.push('CPF/CNPJ divergente');
  }

  if (invoiceNumberMentioned) {
    score += 32;
    criteriaMatched.push(`Nº da NF (${inv.numero}) identificado no histórico/doc`);
  }

  if (bestNameRatio >= 0.65) {
    score += 18;
    criteriaMatched.push('Nome do pagador compatível');
  } else if (bestNameRatio >= 0.35) {
    score += 8;
    criteriaMatched.push('Semelhança parcial no nome');
  } else if (payerCandidate) {
    criteriaDivergent.push('Nome do pagador diferente do destinatário da NF');
  }

  if (absDiff <= 0.05) {
    score += 15;
    criteriaMatched.push('Valor exato');
  } else if (available < openInv - 0.05 && available > 0) {
    score += 6;
    criteriaMatched.push('Possível parcela / recebimento parcial');
  } else if (absDiff <= 5) {
    score += 5;
    criteriaDivergent.push(`Pequena diferença de valor (${diffValor > 0 ? '+' : ''}${diffValor.toFixed(2)})`);
  } else {
    criteriaDivergent.push(`Diferença de valor de R$ ${absDiff.toFixed(2)}`);
  }

  if (dateClose) {
    score += 10;
    criteriaMatched.push(`Data dentro da tolerância (${daysApart} dia(s))`);
  } else {
    criteriaDivergent.push(`Data distante (${daysApart} dias da emissão/vencimento)`);
  }

  if (itemContextRatio >= 0.35) {
    score += 8;
    criteriaMatched.push('Referência a itens/serviços compatível');
  }

  const nonValueSignals =
    (cpfCnpjMatch ? 1 : 0) +
    (invoiceNumberMentioned ? 1 : 0) +
    (bestNameRatio >= 0.65 ? 1 : 0) +
    (dateClose ? 1 : 0) +
    (itemContextRatio >= 0.35 ? 1 : 0);

  const amountOnlyWarning = absDiff <= 0.05 && nonValueSignals === 0;
  if (amountOnlyWarning) {
    score = Math.min(score, 25);
    criteriaDivergent.push('Apenas o valor coincide — insuficiência de outros critérios');
  }

  const boundedScore = Math.max(0, Math.min(99, Math.round(score)));
  const confidenceLevel: 'alta' | 'media' | 'baixa' =
    !amountOnlyWarning && !cpfCnpjConflict && (cpfCnpjMatch || invoiceNumberMentioned) && boundedScore >= 65
      ? 'alta'
      : !amountOnlyWarning && !cpfCnpjConflict && boundedScore >= 38
        ? 'media'
        : 'baixa';

  const nameSimilarWithoutDoc = bestNameRatio >= 0.45 && !cpfCnpjMatch;

  return {
    invoice: inv,
    confidenceScore: boundedScore,
    confidenceLevel,
    criteriaMatched,
    criteriaDivergent,
    diffValor,
    daysApart,
    amountOnlyWarning,
    nameSimilarWithoutDoc,
  };
}

function findGroupedSubsetForCredit(
  bankTx: BankTransaction,
  openInvoices: Invoice[],
  rejectedPairKeys: Set<string>,
  toleranceDays: number
): GroupedInvoiceCandidate | null {
  const target = getBankTxAvailableAmount(bankTx) || bankTx.valor;
  if (target <= 0 || openInvoices.length < 2) return null;

  const bankDoc = digitsOnly(bankTx.cpfCnpjPagador || extractCpfCnpjFromText(bankTx.descricao));
  const payerCandidate = bankTx.nomePagador || extractPayerNameFromText(bankTx.descricao);

  // Somente busca combinação agrupada quando há vínculo identificável de cliente (CPF/CNPJ ou nome compatível)
  const scopedInvoices = openInvoices
    .filter((inv) => !rejectedPairKeys.has(`${bankTx.id}::${inv.id}`))
    .filter((inv) => {
      const invDoc = digitsOnly(inv.clienteDocumento);
      if (bankDoc && invDoc) return bankDoc === invDoc;
      if (payerCandidate) return tokenOverlapRatio(payerCandidate, inv.clienteNome) >= 0.5;
      return tokenOverlapRatio(bankTx.descricao, inv.clienteNome) >= 0.6;
    })
    .slice(0, 14);

  if (scopedInvoices.length < 2) return null;

  // Tenta combinações de 2 ou 3 notas fiscais do mesmo cliente cuja soma aproxime o crédito
  let best: GroupedInvoiceCandidate | null = null;

  const evalSubset = (subset: Invoice[]) => {
    const sumOpen = Math.round(subset.reduce((s, inv) => s + (getInvoiceOpenAmount(inv) || inv.valor), 0) * 100) / 100;
    const diff = Math.round((target - sumOpen) * 100) / 100;
    if (Math.abs(diff) <= 0.15) {
      const hasDocMatch = subset.some((inv) => {
        const d = digitsOnly(inv.clienteDocumento);
        return Boolean(bankDoc && d && bankDoc === d);
      });
      const avgDays = Math.min(...subset.map((inv) => daysBetweenISO(bankTx.dataMovimento, inv.dataEmissao)));
      const confidenceLevel: 'alta' | 'media' | 'baixa' =
        hasDocMatch && avgDays <= toleranceDays * 3 ? 'alta' : hasDocMatch || avgDays <= toleranceDays * 2 ? 'media' : 'baixa';

      if (!best || Math.abs(diff) < Math.abs(best.diffValor)) {
        best = {
          bankTx,
          invoices: subset,
          sumOpenInvoices: sumOpen,
          diffValor: diff,
          confidenceLevel,
          justification: `Soma das NFs ${subset.map((i) => i.numero).join(' + ')} (${sumOpen.toFixed(2)}) compatível com pagamento único de ${subset[0].clienteNome}.`,
        };
      }
    }
  };

  for (let i = 0; i < scopedInvoices.length; i += 1) {
    for (let j = i + 1; j < scopedInvoices.length; j += 1) {
      evalSubset([scopedInvoices[i], scopedInvoices[j]]);
      for (let k = j + 1; k < scopedInvoices.length; k += 1) {
        evalSubset([scopedInvoices[i], scopedInvoices[j], scopedInvoices[k]]);
      }
    }
  }

  return best;
}

export function detectDuplicates(
  bankTransactions: BankTransaction[],
  invoices: Invoice[]
): DuplicateFlagItem[] {
  const duplicates: DuplicateFlagItem[] = [];

  // 1. Duplicidade em transações bancárias
  const bankByFitId = new Map<string, BankTransaction[]>();
  const bankByFingerprint = new Map<string, BankTransaction[]>();

  for (const tx of bankTransactions) {
    const cleanFit = (tx.fitId || '').trim();
    if (cleanFit && !cleanFit.startsWith('imp-') && !cleanFit.startsWith('pdf-')) {
      const list = bankByFitId.get(cleanFit) ?? [];
      list.push(tx);
      bankByFitId.set(cleanFit, list);
    }
    const fp = `${tx.dataMovimento}|${tx.tipo}|${tx.valor.toFixed(2)}|${normalizeTextKey(tx.nomePagador || tx.descricao)}`;
    const fpList = bankByFingerprint.get(fp) ?? [];
    fpList.push(tx);
    bankByFingerprint.set(fp, fpList);
  }

  const flaggedBankIds = new Set<string>();
  for (const [fitId, group] of bankByFitId.entries()) {
    if (group.length > 1) {
      group.forEach((tx) => {
        flaggedBankIds.add(tx.id);
        duplicates.push({
          entityType: 'Extrato Bancário',
          id: tx.id,
          referenceLabel: `${tx.banco} · FITID ${fitId}`,
          partyName: tx.nomePagador || tx.descricao,
          date: tx.dataMovimento,
          amount: tx.valor,
          reason: `Mesmo identificador bancário (FITID ${fitId}) repetido em ${group.length} lançamentos.`,
          relatedIds: group.map((g) => g.id).filter((id) => id !== tx.id),
        });
      });
    }
  }

  for (const [, group] of bankByFingerprint.entries()) {
    if (group.length > 1) {
      group.forEach((tx) => {
        if (flaggedBankIds.has(tx.id)) return;
        flaggedBankIds.add(tx.id);
        duplicates.push({
          entityType: 'Extrato Bancário',
          id: tx.id,
          referenceLabel: `${tx.banco} (${tx.tipo === 'credito' ? 'Crédito' : 'Débito'})`,
          partyName: tx.nomePagador || tx.descricao,
          date: tx.dataMovimento,
          amount: tx.valor,
          reason: `Mesma data, valor e pagador/histórico em ${group.length} lançamentos bancários.`,
          relatedIds: group.map((g) => g.id).filter((id) => id !== tx.id),
        });
      });
    }
  }

  // 2. Duplicidade em Notas Fiscais
  const activeInvoices = invoices.filter((inv) => inv.statusRecebimento !== 'cancelada');
  const invByChave = new Map<string, Invoice[]>();
  const invByNum = new Map<string, Invoice[]>();
  const invBySig = new Map<string, Invoice[]>();

  for (const inv of activeInvoices) {
    const chave = (inv.chaveAcesso || '').trim();
    if (chave.length >= 16) {
      const list = invByChave.get(chave) ?? [];
      list.push(inv);
      invByChave.set(chave, list);
    }
    const numKey = `${inv.tipo}|${inv.numero.trim()}|${inv.serie.trim()}`;
    const numList = invByNum.get(numKey) ?? [];
    numList.push(inv);
    invByNum.set(numKey, numList);

    const docSig = digitsOnly(inv.clienteDocumento) || normalizeTextKey(inv.clienteNome);
    const sigKey = `${inv.dataEmissao}|${inv.valor.toFixed(2)}|${docSig}`;
    const sigList = invBySig.get(sigKey) ?? [];
    sigList.push(inv);
    invBySig.set(sigKey, sigList);
  }

  const flaggedInvIds = new Set<string>();
  for (const [chave, group] of invByChave.entries()) {
    if (group.length > 1) {
      group.forEach((inv) => {
        flaggedInvIds.add(inv.id);
        duplicates.push({
          entityType: 'Nota Fiscal',
          id: inv.id,
          referenceLabel: `${inv.tipo} ${inv.numero} (Série ${inv.serie})`,
          partyName: inv.clienteNome,
          date: inv.dataEmissao,
          amount: inv.valor,
          reason: `Chave de acesso duplicada (${chave.slice(0, 20)}...).`,
          relatedIds: group.map((g) => g.id).filter((id) => id !== inv.id),
        });
      });
    }
  }

  for (const [, group] of invByNum.entries()) {
    if (group.length > 1) {
      group.forEach((inv) => {
        if (flaggedInvIds.has(inv.id)) return;
        flaggedInvIds.add(inv.id);
        duplicates.push({
          entityType: 'Nota Fiscal',
          id: inv.id,
          referenceLabel: `${inv.tipo} ${inv.numero} (Série ${inv.serie})`,
          partyName: inv.clienteNome,
          date: inv.dataEmissao,
          amount: inv.valor,
          reason: `Número e série repetidos em ${group.length} notas importadas.`,
          relatedIds: group.map((g) => g.id).filter((id) => id !== inv.id),
        });
      });
    }
  }

  for (const [, group] of invBySig.entries()) {
    if (group.length > 1) {
      group.forEach((inv) => {
        if (flaggedInvIds.has(inv.id)) return;
        flaggedInvIds.add(inv.id);
        duplicates.push({
          entityType: 'Nota Fiscal',
          id: inv.id,
          referenceLabel: `${inv.tipo} ${inv.numero}`,
          partyName: inv.clienteNome,
          date: inv.dataEmissao,
          amount: inv.valor,
          reason: `Mesmo cliente, mesma emissão e mesmo valor em ${group.length} notas.`,
          relatedIds: group.map((g) => g.id).filter((id) => id !== inv.id),
        });
      });
    }
  }

  return duplicates;
}

function matchesFilterText(haystack: string, query: string, docCandidate?: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (haystack.toLowerCase().includes(q)) return true;
  const qDigits = digitsOnly(q);
  if (qDigits.length >= 3 && digitsOnly(docCandidate).includes(qDigits)) return true;
  return false;
}

export function buildReconciliationDiagnostics(
  bankTransactions: BankTransaction[],
  invoices: Invoice[],
  reconciliations: ReconciliationRecord[],
  toleranceDays: number,
  filters?: Partial<ReconciliationFilters>
): ReconciliationDiagnosticsResult {
  const fDataInicio = filters?.dataInicio ?? '';
  const fDataFim = filters?.dataFim ?? '';
  const fParty = filters?.clienteOuPagador ?? '';
  const fBanco = (filters?.banco ?? '').trim().toLowerCase();
  const fMin = filters?.valorMin ? Number(filters.valorMin) : null;
  const fMax = filters?.valorMax ? Number(filters.valorMax) : null;

  const filterInvoice = (inv: Invoice) => {
    if (fDataInicio && inv.dataEmissao < fDataInicio) return false;
    if (fDataFim && inv.dataEmissao > fDataFim) return false;
    if (fMin !== null && Number.isFinite(fMin) && inv.valor < fMin) return false;
    if (fMax !== null && Number.isFinite(fMax) && inv.valor > fMax) return false;
    if (fParty && !matchesFilterText(`${inv.clienteNome} ${inv.numero}`, fParty, inv.clienteDocumento)) {
      return false;
    }
    return true;
  };

  const filterBankTx = (tx: BankTransaction) => {
    if (fDataInicio && tx.dataMovimento < fDataInicio) return false;
    if (fDataFim && tx.dataMovimento > fDataFim) return false;
    if (fBanco && !tx.banco.toLowerCase().includes(fBanco)) return false;
    if (fMin !== null && Number.isFinite(fMin) && tx.valor < fMin) return false;
    if (fMax !== null && Number.isFinite(fMax) && tx.valor > fMax) return false;
    if (
      fParty &&
      !matchesFilterText(`${tx.nomePagador ?? ''} ${tx.descricao} ${tx.invoiceNumber ?? ''}`, fParty, tx.cpfCnpjPagador)
    ) {
      return false;
    }
    return true;
  };

  const rejectedPairKeys = new Set<string>();
  const invoiceLinkedCreditMap = new Map<string, Set<string>>();
  const bankLinkedInvoiceMap = new Map<string, Set<string>>();

  for (const rec of reconciliations) {
    if (rec.tipo === 'rejeitado' && rec.bankTransactionId && rec.invoiceId) {
      rejectedPairKeys.add(`${rec.bankTransactionId}::${rec.invoiceId}`);
    }
    if ((rec.tipo === 'nf' || rec.tipo === 'agrupado' || rec.tipo === 'parcelado') && rec.invoiceId) {
      const cSet = invoiceLinkedCreditMap.get(rec.invoiceId) ?? new Set<string>();
      cSet.add(rec.bankTransactionId);
      invoiceLinkedCreditMap.set(rec.invoiceId, cSet);

      const iSet = bankLinkedInvoiceMap.get(rec.bankTransactionId) ?? new Set<string>();
      iSet.add(rec.invoiceId);
      bankLinkedInvoiceMap.set(rec.bankTransactionId, iSet);
    }
  }

  const invoiceLinkedCreditCount = new Map<string, number>();
  for (const [invId, set] of invoiceLinkedCreditMap.entries()) {
    invoiceLinkedCreditCount.set(invId, set.size);
  }
  const bankLinkedInvoiceCount = new Map<string, number>();
  for (const [bankId, set] of bankLinkedInvoiceMap.entries()) {
    bankLinkedInvoiceCount.set(bankId, set.size);
  }

  const filteredInvoices = invoices
    .filter((inv) => inv.statusRecebimento !== 'cancelada')
    .filter(filterInvoice);

  const notasTotalmenteRecebidas = filteredInvoices.filter(
    (inv) => inv.statusRecebimento === 'recebida' || inv.valorRecebido + 0.01 >= inv.valor
  );
  const notasParcialmenteRecebidas = filteredInvoices.filter(
    (inv) => inv.statusRecebimento === 'parcial' && inv.valorRecebido > 0 && inv.valorRecebido + 0.01 < inv.valor
  );
  const notasSemRecebimento = filteredInvoices.filter(
    (inv) => inv.statusRecebimento === 'pendente' && inv.valorRecebido <= 0.01
  );

  const openInvoicesAll = invoices.filter(
    (inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida' && getInvoiceOpenAmount(inv) > 0.01
  );

  const creditsFiltered = bankTransactions.filter((tx) => tx.tipo === 'credito').filter(filterBankTx);
  const recebimentosSemNf = creditsFiltered.filter((tx) => {
    const avail = getBankTxAvailableAmount(tx);
    return (
      avail > 0.01 &&
      (tx.statusConciliacao === 'sem_nf_localizada' ||
        tx.statusConciliacao === 'nao_conciliado' ||
        tx.statusConciliacao === 'conciliado_parcial')
    );
  });

  const allDuplicates = detectDuplicates(bankTransactions, invoices);
  const possiveisDuplicidades = allDuplicates.filter((dup) => {
    if (fDataInicio && dup.date < fDataInicio) return false;
    if (fDataFim && dup.date > fDataFim) return false;
    if (fMin !== null && Number.isFinite(fMin) && dup.amount < fMin) return false;
    if (fMax !== null && Number.isFinite(fMax) && dup.amount > fMax) return false;
    if (fParty && !matchesFilterText(`${dup.partyName} ${dup.referenceLabel}`, fParty)) return false;
    return true;
  });
  const duplicateIdSet = new Set(possiveisDuplicidades.map((d) => d.id));

  const conciliacoesPendentes: PendingReconciliationItem[] = [];
  let countMultipleCandidates = 0;
  let countUncertain = 0;
  let countGroupedDetected = 0;

  for (const tx of recebimentosSemNf) {
    const avail = getBankTxAvailableAmount(tx);
    const candidates = openInvoicesAll
      .filter((inv) => !rejectedPairKeys.has(`${tx.id}::${inv.id}`))
      .map((inv) => evaluateMultiCriteriaMatch(tx, inv, toleranceDays))
      .filter((c) => c.confidenceScore >= 20)
      .sort((a, b) => b.confidenceScore - a.confidenceScore)
      .slice(0, 5);

    const groupedCandidate = findGroupedSubsetForCredit(tx, openInvoicesAll, rejectedPairKeys, toleranceDays);
    if (groupedCandidate) countGroupedDetected += 1;

    const situations: ReconciliationSituationType[] = ['recebimento_sem_nf'];
    if (duplicateIdSet.has(tx.id)) situations.push('possivel_duplicidade');

    const viableCandidates = candidates.filter((c) => c.confidenceLevel !== 'baixa' || !c.amountOnlyWarning);
    if (viableCandidates.length >= 2) {
      situations.push('recebimento_multiplas_candidatas');
      countMultipleCandidates += 1;
    }

    if (groupedCandidate) {
      situations.push('pagamento_agrupado');
    }

    const hasUncertain =
      candidates.some((c) => c.confidenceLevel !== 'alta' || c.nameSimilarWithoutDoc || c.amountOnlyWarning) ||
      tx.statusConciliacao === 'conciliado_parcial';

    if (hasUncertain) {
      situations.push('correspondencia_incerta_revisao');
      countUncertain += 1;
    }

    let reason = 'Recebimento sem nota fiscal localizada — mantido como pendência de conferência.';
    if (groupedCandidate) {
      reason = groupedCandidate.justification;
    } else if (viableCandidates.length >= 2) {
      reason = `${viableCandidates.length} notas fiscais candidatas encontradas; escolha manualmente ou divida o recebimento.`;
    } else if (candidates[0]?.amountOnlyWarning) {
      reason = 'Apenas o valor coincide com nota em aberto. Exige revisão humana de CPF/CNPJ e histórico.';
    } else if (candidates[0]?.nameSimilarWithoutDoc) {
      reason = 'Nome semelhante sem confirmação por CPF/CNPJ. Verifique se não se trata de homônimo.';
    } else if (candidates[0]) {
      reason = `Sugestão principal: ${candidates[0].invoice.tipo} ${candidates[0].invoice.numero} (${candidates[0].criteriaMatched.join(', ')}).`;
    }

    conciliacoesPendentes.push({
      bankTx: tx,
      availableAmount: avail,
      situations,
      topCandidates: candidates,
      groupedCandidate,
      requiresHumanReviewReason: reason,
    });
  }

  // Divergências de valores (diferença entre valor da NF e total recebido, ou conciliações com diferença relevante)
  const divergenciasValores: DivergenceItem[] = [];
  for (const inv of filteredInvoices) {
    if (inv.valorRecebido > 0.01 && Math.abs(inv.valorRecebido - inv.valor) > 0.05) {
      const diff = Math.round((inv.valorRecebido - inv.valor) * 100) / 100;
      divergenciasValores.push({
        id: `inv-${inv.id}`,
        origin: 'Nota Fiscal',
        invoiceNumber: `${inv.tipo} ${inv.numero}`,
        clienteNome: inv.clienteNome,
        date: inv.dataEmissao,
        expectedAmount: inv.valor,
        receivedAmount: inv.valorRecebido,
        difference: diff,
        detail:
          diff < 0
            ? `Recebido a menor (${Math.abs(diff).toFixed(2)} pendente ou desconto/retenção).`
            : `Recebido a maior (+${diff.toFixed(2)} — possíveis juros, multa ou erro de vínculo).`,
      });
    }
  }

  for (const rec of reconciliations) {
    if (
      (rec.tipo === 'nf' || rec.tipo === 'parcelado' || rec.tipo === 'agrupado') &&
      typeof rec.diferencaValor === 'number' &&
      Math.abs(rec.diferencaValor) > 0.05
    ) {
      if (fDataInicio && rec.bankData < fDataInicio) continue;
      if (fDataFim && rec.bankData > fDataFim) continue;
      if (fParty && !matchesFilterText(`${rec.bankDescricao} ${rec.invoiceNumber ?? ''}`, fParty)) continue;
      divergenciasValores.push({
        id: `rec-${rec.id}`,
        origin: 'Conciliação',
        invoiceNumber: rec.invoiceNumber ? `NF ${rec.invoiceNumber}` : 'Sem NF',
        clienteNome: rec.bankDescricao,
        date: rec.bankData,
        expectedAmount: Math.round((rec.valorConciliado - rec.diferencaValor) * 100) / 100,
        receivedAmount: rec.valorConciliado,
        difference: rec.diferencaValor,
        detail: rec.justificativa || rec.observacoes || 'Diferença registrada no momento da conciliação.',
      });
    }
  }

  const parceladoInvoicesCount = Array.from(invoiceLinkedCreditCount.values()).filter((cnt) => cnt >= 2).length +
    reconciliations.filter((r) => r.tipo === 'parcelado').length;
  const agrupadoCreditsCount = Array.from(bankLinkedInvoiceCount.values()).filter((cnt) => cnt >= 2).length + countGroupedDetected;

  return {
    situationCounts: {
      nota_totalmente_recebida: notasTotalmenteRecebidas.length,
      nota_parcialmente_recebida: notasParcialmenteRecebidas.length,
      nota_sem_recebimento: notasSemRecebimento.length,
      recebimento_sem_nf: recebimentosSemNf.length,
      recebimento_multiplas_candidatas: countMultipleCandidates,
      pagamento_parcelado: parceladoInvoicesCount,
      pagamento_agrupado: agrupadoCreditsCount,
      possivel_duplicidade: possiveisDuplicidades.length,
      correspondencia_incerta_revisao: countUncertain,
    },
    reports: {
      notasTotalmenteRecebidas,
      notasParcialmenteRecebidas,
      notasSemRecebimento,
      recebimentosSemNf,
      conciliacoesPendentes,
      divergenciasValores,
      possiveisDuplicidades,
    },
    rejectedPairKeys,
    invoiceLinkedCreditCount,
    bankLinkedInvoiceCount,
  };
}

export function exportReconciliationExcelWorkbook(
  diagnostics: ReconciliationDiagnosticsResult,
  reconciliations: ReconciliationRecord[],
  companyName: string
): void {
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    { Indicador: 'Notas Fiscais Totalmente Recebidas', Quantidade: diagnostics.reports.notasTotalmenteRecebidas.length },
    { Indicador: 'Notas Fiscais Parcialmente Recebidas', Quantidade: diagnostics.reports.notasParcialmenteRecebidas.length },
    { Indicador: 'Notas Fiscais Sem Recebimento Identificado', Quantidade: diagnostics.reports.notasSemRecebimento.length },
    { Indicador: 'Recebimentos Sem NF Localizada (Pendência de Conferência)', Quantidade: diagnostics.reports.recebimentosSemNf.length },
    { Indicador: 'Conciliações Pendentes / Revisão Humana', Quantidade: diagnostics.reports.conciliacoesPendentes.length },
    { Indicador: 'Divergências de Valores', Quantidade: diagnostics.reports.divergenciasValores.length },
    { Indicador: 'Possíveis Duplicidades', Quantidade: diagnostics.reports.possiveisDuplicidades.length },
    { Indicador: 'Registros no Histórico de Conciliações', Quantidade: reconciliations.length },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Resumo');

  const mapInvoiceRow = (inv: Invoice) => ({
    Numero: inv.numero,
    Serie: inv.serie,
    Tipo: inv.tipo,
    Emissao: formatDateBR(inv.dataEmissao),
    Vencimento: inv.dataVencimento ? formatDateBR(inv.dataVencimento) : '',
    Cliente: inv.clienteNome,
    CPF_CNPJ: inv.clienteDocumento || '',
    Valor_Nota_BRL: inv.valor,
    Valor_Recebido_BRL: inv.valorRecebido,
    Saldo_Em_Aberto_BRL: getInvoiceOpenAmount(inv),
    Status: inv.statusRecebimento,
  });

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.notasTotalmenteRecebidas.length > 0
        ? diagnostics.reports.notasTotalmenteRecebidas.map(mapInvoiceRow)
        : [{ Aviso: 'Nenhuma nota totalmente recebida nos filtros selecionados.' }]
    ),
    'NFs Totalmente Recebidas'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.notasParcialmenteRecebidas.length > 0
        ? diagnostics.reports.notasParcialmenteRecebidas.map(mapInvoiceRow)
        : [{ Aviso: 'Nenhuma nota parcialmente recebida nos filtros selecionados.' }]
    ),
    'NFs Parcialmente Recebidas'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.notasSemRecebimento.length > 0
        ? diagnostics.reports.notasSemRecebimento.map(mapInvoiceRow)
        : [{ Aviso: 'Nenhuma nota sem recebimento nos filtros selecionados.' }]
    ),
    'NFs Sem Recebimento'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.recebimentosSemNf.length > 0
        ? diagnostics.reports.recebimentosSemNf.map((tx) => ({
            Data: formatDateBR(tx.dataMovimento),
            Banco: tx.banco,
            Pagador: tx.nomePagador || '',
            CPF_CNPJ: tx.cpfCnpjPagador || '',
            Historico: tx.descricao,
            Valor_Total_BRL: tx.valor,
            Saldo_Disponivel_BRL: getBankTxAvailableAmount(tx),
            Observacao: 'Pendência de conferência — não comprova inexistência de nota fiscal emitida',
          }))
        : [{ Aviso: 'Nenhum recebimento sem nota fiscal localizada nos filtros selecionados.' }]
    ),
    'Recebimentos Sem NF'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.conciliacoesPendentes.length > 0
        ? diagnostics.reports.conciliacoesPendentes.map((p) => ({
            Data: formatDateBR(p.bankTx.dataMovimento),
            Banco: p.bankTx.banco,
            Pagador: p.bankTx.nomePagador || '',
            Historico: p.bankTx.descricao,
            Valor_Disponivel_BRL: p.availableAmount,
            Motivo_Pendencia: p.requiresHumanReviewReason,
            Principal_NF_Candidata: p.topCandidates[0]
              ? `${p.topCandidates[0].invoice.tipo} ${p.topCandidates[0].invoice.numero} (${p.topCandidates[0].confidenceLevel})`
              : p.groupedCandidate
                ? `Agrupamento ${p.groupedCandidate.invoices.map((i) => i.numero).join(' + ')}`
                : 'Nenhuma candidata clara',
          }))
        : [{ Aviso: 'Nenhuma conciliação pendente nos filtros selecionados.' }]
    ),
    'Conciliacoes Pendentes'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.divergenciasValores.length > 0
        ? diagnostics.reports.divergenciasValores.map((d) => ({
            Origem: d.origin,
            Documento: d.invoiceNumber,
            Cliente_Ou_Historico: d.clienteNome,
            Data: formatDateBR(d.date),
            Valor_Esperado_BRL: d.expectedAmount,
            Valor_Recebido_BRL: d.receivedAmount,
            Diferenca_BRL: d.difference,
            Detalhe: d.detail,
          }))
        : [{ Aviso: 'Nenhuma divergência de valor encontrada nos filtros selecionados.' }]
    ),
    'Divergencias de Valores'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      diagnostics.reports.possiveisDuplicidades.length > 0
        ? diagnostics.reports.possiveisDuplicidades.map((dup) => ({
            Tipo_Registro: dup.entityType,
            Referencia: dup.referenceLabel,
            Cliente_Pagador: dup.partyName,
            Data: formatDateBR(dup.date),
            Valor_BRL: dup.amount,
            Motivo_Alerta: dup.reason,
          }))
        : [{ Aviso: 'Nenhuma possível duplicidade detectada nos filtros selecionados.' }]
    ),
    'Possiveis Duplicidades'
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      reconciliations.length > 0
        ? reconciliations.map((rec) => ({
            Data_Extrato: formatDateBR(rec.bankData),
            Historico_Bancario: rec.bankDescricao,
            Valor_Extrato_BRL: rec.bankValor,
            Tipo_Operacao: rec.tipo,
            NF_Relacionada: rec.invoiceNumber || '',
            Valor_Conciliado_BRL: rec.valorConciliado,
            Diferenca_BRL: rec.diferencaValor ?? 0,
            Confianca: rec.confianca || 'manual',
            Origem_Decisao: rec.origemDecisao || 'manual',
            Justificativa: rec.justificativa || rec.observacoes || '',
          }))
        : [{ Aviso: 'Nenhum histórico de conciliação registrado ainda.' }]
    ),
    'Historico Conciliacoes'
  );

  const safeSlug = normalizeTextKey(companyName || 'empresa').replace(/\s+/g, '-') || 'empresa';
  const todayStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `conciliacao-bancaria-${safeSlug}-${todayStr}.xlsx`);
}
