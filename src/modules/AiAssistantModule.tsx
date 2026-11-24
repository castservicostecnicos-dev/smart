import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  FileSpreadsheet,
  FileText,
  History,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  Send,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  ROLE_LABELS,
  type AiChatMessage,
  type AiConversation,
  type BankTransaction,
  type FinancialTransaction,
  type InventoryProduct,
  type Invoice,
  type ReconciliationRecord,
  type SavedReport,
  type StockMovement,
  type StockMovementReason,
  type UserRole,
} from '../types/erp';
import {
  appendAiMessage,
  createAiConversation,
  deleteAiConversation,
  recordAiAuditEvent,
  recordStockMovement,
  saveCompanyReport,
  subscribeAiConversations,
  subscribeAiMessages,
} from '../services/erpService';
import { uploadCompanyFile } from '../services/storageService';
import {
  exportToCSV,
  formatBRL,
  formatDateBR,
  formatNumberBR,
  formatTimestampBR,
  sanitizeCsvCell,
  todayISO,
} from '../utils/formatters';
import { authorizedJsonFetch } from '../lib/apiClient';

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface StockMovementPreview {
  productId: string;
  productSku: string;
  productName: string;
  unidade: string;
  tipo: 'entrada' | 'saida';
  motivo: StockMovementReason;
  quantidade: number;
  saldoAnterior: number;
  saldoPosterior: number;
  estoqueInsuficiente: boolean;
  permissionBlocked: boolean;
  permissionReason: string;
  observacoes: string;
}

interface ReportPreview {
  reportType: 'estoque' | 'financeiro' | 'notas_fiscais' | 'conciliacao' | 'movimentacoes' | 'geral';
  title: string;
  periodoInicio: string;
  periodoFim: string;
  preferredFormat: 'excel' | 'csv' | 'summary';
  totalRegistros: number;
  valorResumo: number;
  resumoTexto: string;
}

interface PendingActionState {
  actionType: 'stock_movement_preview' | 'report_preview';
  stockPreview?: StockMovementPreview | null;
  reportPreview?: ReportPreview | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  responsavel?: string;
  documentoReferencia?: string;
  busy?: boolean;
}

interface AiChatApiResponse {
  reply?: string;
  actionType?: 'none' | 'stock_movement_preview' | 'report_preview';
  stockPreview?: StockMovementPreview | null;
  reportPreview?: ReportPreview | null;
  error?: string;
}

export interface AiAssistantModuleProps {
  user: User;
  companyId: string;
  companyName: string;
  userRole: UserRole;
  hasFinanceAccess: boolean;
  hasInventoryAccess: boolean;
  canWriteInventory: boolean;
  canSaveReports: boolean;
  financials: FinancialTransaction[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  reconciliations: ReconciliationRecord[];
  inventory: InventoryProduct[];
  stockMovements: StockMovement[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

function renderFormattedText(text: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, lineIdx) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <React.Fragment key={lineIdx}>
        {parts.map((part, partIdx) => {
          if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            return (
              <strong key={partIdx} className="font-semibold">
                {part.slice(2, -2)}
              </strong>
            );
          }
          return <React.Fragment key={partIdx}>{part}</React.Fragment>;
        })}
        {lineIdx < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}

function buildCsvBlob(headers: string[], rows: (string | number)[][]): Blob {
  const csvContent =
    '\uFEFF' +
    [
      headers.map((h) => sanitizeCsvCell(h)).join(';'),
      ...rows.map((r) => r.map((c) => sanitizeCsvCell(c)).join(';')),
    ].join('\r\n');
  return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
}

export const AiAssistantModule: React.FC<AiAssistantModuleProps> = ({
  user,
  companyId,
  companyName,
  userRole,
  hasFinanceAccess,
  hasInventoryAccess,
  canWriteInventory,
  canSaveReports,
  financials,
  invoices,
  bankTransactions,
  reconciliations,
  inventory,
  stockMovements,
  onNotify,
}) => {
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Estado local para pré-visualizações interativas atreladas ao ID da mensagem
  const [pendingActions, setPendingActions] = useState<Record<string, PendingActionState>>({});

  // Detectar suporte a Web Speech API no navegador/dispositivo
  useEffect(() => {
    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    setSpeechSupported(Boolean(win.SpeechRecognition || win.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  // Listener em tempo real das conversas da empresa para o usuário conectado
  useEffect(() => {
    setActiveConvId(null);
    setMessages([]);
    setPendingActions({});
    if (!user || !companyId) return;

    const unsub = subscribeAiConversations(
      user,
      companyId,
      (list) => {
        setConversations(list);
        setActiveConvId((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      },
      (err) => {
        setErrorMsg(err.message);
      }
    );
    return () => unsub();
  }, [user, companyId]);

  // Listener em tempo real das mensagens da conversa selecionada
  useEffect(() => {
    if (!user || !companyId || !activeConvId) {
      setMessages([]);
      setLoadingMessages(false);
      return;
    }

    setLoadingMessages(true);
    const unsub = subscribeAiMessages(
      user,
      companyId,
      activeConvId,
      (msgs) => {
        setMessages(msgs);
        setLoadingMessages(false);
      },
      (err) => {
        setLoadingMessages(false);
        setErrorMsg(err.message);
      }
    );
    return () => unsub();
  }, [user, companyId, activeConvId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  // Sugestões de comandos por perfil conectado
  const suggestedPrompts = useMemo(() => {
    const items: string[] = [];
    if (hasInventoryAccess) {
      items.push('Quantos metros de tubo de cobre de 3/8 temos?');
      items.push('Quais materiais estão abaixo do estoque mínimo?');
      if (canWriteInventory) {
        items.push('Retire 15 unidades de capacitor de 30 microfarads.');
      }
    }
    if (hasFinanceAccess) {
      items.push('Quanto recebemos neste mês?');
      items.push('Quais clientes estão com notas pendentes de recebimento?');
      items.push('Mostre os recebimentos que ainda não foram relacionados a uma nota.');
      items.push('Explique as divergências da conciliação bancária.');
    }
    items.push(
      hasFinanceAccess
        ? 'Gere um relatório geral financeiro, fiscal e de estoque.'
        : 'Gere um relatório completo da posição atual de estoque.'
    );
    return items;
  }, [hasInventoryAccess, canWriteInventory, hasFinanceAccess]);

  // Contexto real completo do Firebase respeitando estritamente o RBAC
  const companyContext = useMemo(() => {
    const today = todayISO();
    const currentMonth = today.slice(0, 7);
    const [curYear, curMon] = currentMonth.split('-');

    const round2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

    const baseContext: Record<string, unknown> = {
      empresa: companyName || 'Gestão Inteligente Empresarial',
      dataAtualISO: today,
    };

    if (hasInventoryAccess) {
      const sortedMovements = [...stockMovements]
        .sort((a, b) => b.dataMovimentacao.localeCompare(a.dataMovimentacao))
        .slice(0, 80);

      baseContext.inventorySummary = {
        totalProdutos: inventory.length,
        valorTotalCusto: round2(
          inventory.reduce((s, p) => s + p.quantidade * p.custoUnitario, 0)
        ),
        totalAbaixoMinimo: inventory.filter((p) => p.quantidade <= p.estoqueMinimo).length,
      };
      baseContext.products = inventory.slice(0, 400).map((p) => ({
        id: p.id,
        sku: p.sku,
        nome: p.nome,
        categoria: p.categoria,
        unidade: p.unidade,
        quantidade: p.quantidade,
        estoqueMinimo: p.estoqueMinimo,
        custoUnitario: p.custoUnitario,
        precoVenda: p.precoVenda,
        localizacao: p.localizacao ?? '',
      }));
      baseContext.recentMovements = sortedMovements.map((m) => ({
        productSku: m.productSku,
        productName: m.productName,
        tipo: m.tipo,
        motivo: m.motivo,
        quantidade: m.quantidade,
        saldoAnterior: m.saldoAnterior,
        saldoAtual: m.saldoAtual,
        dataMovimentacao: m.dataMovimentacao,
        responsavel: m.responsavel,
        documentoReferencia: m.documentoReferencia ?? '',
      }));
    }

    if (hasFinanceAccess) {
      const receitasAtivas = financials.filter((f) => f.tipo === 'receita' && f.status !== 'cancelado');
      const despesasAtivas = financials.filter((f) => f.tipo === 'despesa' && f.status !== 'cancelado');

      const totalRecebimentosPagosGeral = round2(
        receitasAtivas.filter((r) => r.status === 'pago').reduce((s, r) => s + r.valor, 0)
      );
      const totalRecebimentosPagosMesAtual = round2(
        receitasAtivas
          .filter(
            (r) =>
              r.status === 'pago' &&
              (r.dataPagamento || r.dataVencimento || '').startsWith(currentMonth)
          )
          .reduce((s, r) => s + r.valor, 0)
      );
      const totalDespesasGeral = round2(despesasAtivas.reduce((s, d) => s + d.valor, 0));
      const totalDespesasMesAtual = round2(
        despesasAtivas
          .filter((d) => (d.dataPagamento || d.dataVencimento || '').startsWith(currentMonth))
          .reduce((s, d) => s + d.valor, 0)
      );

      const bankCredits = bankTransactions.filter((b) => b.tipo === 'credito');
      const totalRecebimentosBancariosMesAtual = round2(
        bankCredits
          .filter((b) => b.dataMovimento.startsWith(currentMonth))
          .reduce((s, b) => s + b.valor, 0)
      );

      const nfsAtivas = invoices.filter((i) => i.statusRecebimento !== 'cancelada');
      const nfsPendentes = nfsAtivas.filter(
        (i) => i.statusRecebimento === 'pendente' || i.statusRecebimento === 'parcial'
      );
      const nfsParciais = nfsAtivas.filter((i) => i.statusRecebimento === 'parcial');

      const semNf = bankCredits.filter(
        (b) => b.statusConciliacao === 'sem_nf_localizada' || b.statusConciliacao === 'nao_conciliado'
      );

      const monthlyMap = new Map<
        string,
        { mes: string; mesLabel: string; recebimentosPagos: number; despesas: number; creditosBancarios: number }
      >();
      for (const r of receitasAtivas) {
        if (r.status !== 'pago') continue;
        const mKey = (r.dataPagamento || r.dataVencimento || '').slice(0, 7);
        if (!mKey) continue;
        const [y, m] = mKey.split('-');
        const cur = monthlyMap.get(mKey) ?? {
          mes: mKey,
          mesLabel: y && m ? `${m}/${y}` : mKey,
          recebimentosPagos: 0,
          despesas: 0,
          creditosBancarios: 0,
        };
        cur.recebimentosPagos = round2(cur.recebimentosPagos + r.valor);
        monthlyMap.set(mKey, cur);
      }
      for (const d of despesasAtivas) {
        const mKey = (d.dataPagamento || d.dataVencimento || '').slice(0, 7);
        if (!mKey) continue;
        const [y, m] = mKey.split('-');
        const cur = monthlyMap.get(mKey) ?? {
          mes: mKey,
          mesLabel: y && m ? `${m}/${y}` : mKey,
          recebimentosPagos: 0,
          despesas: 0,
          creditosBancarios: 0,
        };
        cur.despesas = round2(cur.despesas + d.valor);
        monthlyMap.set(mKey, cur);
      }
      for (const b of bankCredits) {
        const mKey = (b.dataMovimento || '').slice(0, 7);
        if (!mKey) continue;
        const [y, m] = mKey.split('-');
        const cur = monthlyMap.get(mKey) ?? {
          mes: mKey,
          mesLabel: y && m ? `${m}/${y}` : mKey,
          recebimentosPagos: 0,
          despesas: 0,
          creditosBancarios: 0,
        };
        cur.creditosBancarios = round2(cur.creditosBancarios + b.valor);
        monthlyMap.set(mKey, cur);
      }

      baseContext.financialSummary = {
        mesAtual: currentMonth,
        mesAtualLabel: `${curMon}/${curYear}`,
        totalLancamentos: financials.length,
        totalRecebimentosPagosMesAtual,
        totalRecebimentosBancariosMesAtual,
        totalDespesasMesAtual,
        totalRecebimentosPagosGeral,
        totalDespesasGeral,
        totalNotasEmitidas: nfsAtivas.length,
        totalNotasPendentes: nfsPendentes.length,
        totalNotasParciais: nfsParciais.length,
        valorPendenteNotas: round2(
          nfsPendentes.reduce((s, n) => s + Math.max(0, n.valor - n.valorRecebido), 0)
        ),
        totalRecebimentosSemNf: semNf.length,
        valorRecebimentosSemNf: round2(
          semNf.reduce((s, b) => s + Math.max(0, b.valor - (b.valorConciliado || 0)), 0)
        ),
        monthlyBreakdown: Array.from(monthlyMap.values())
          .sort((a, b) => b.mes.localeCompare(a.mes))
          .slice(0, 12),
      };

      baseContext.pendingInvoices = nfsPendentes.slice(0, 200).map((n) => ({
        id: n.id,
        numero: n.numero,
        serie: n.serie,
        clienteNome: n.clienteNome,
        clienteDocumento: n.clienteDocumento ?? '',
        dataEmissao: n.dataEmissao,
        dataVencimento: n.dataVencimento ?? '',
        valor: n.valor,
        valorRecebido: n.valorRecebido,
        saldoPendente: round2(Math.max(0, n.valor - n.valorRecebido)),
        statusRecebimento: n.statusRecebimento,
      }));

      baseContext.unmatchedBankCredits = semNf.slice(0, 150).map((b) => ({
        id: b.id,
        dataMovimento: b.dataMovimento,
        banco: b.banco,
        descricao: b.descricao,
        nomePagador: b.nomePagador ?? '',
        cpfCnpjPagador: b.cpfCnpjPagador ?? '',
        valor: b.valor,
        valorConciliado: b.valorConciliado ?? 0,
        valorDisponivel: round2(Math.max(0, b.valor - (b.valorConciliado || 0))),
        statusConciliacao: b.statusConciliacao,
      }));

      baseContext.recentBankCredits = [...bankCredits]
        .sort((a, b) => b.dataMovimento.localeCompare(a.dataMovimento))
        .slice(0, 60)
        .map((b) => ({
          id: b.id,
          dataMovimento: b.dataMovimento,
          banco: b.banco,
          descricao: b.descricao,
          nomePagador: b.nomePagador ?? '',
          valor: b.valor,
          valorConciliado: b.valorConciliado ?? 0,
          valorDisponivel: round2(Math.max(0, b.valor - (b.valorConciliado || 0))),
          statusConciliacao: b.statusConciliacao,
          invoiceNumber: b.invoiceNumber ?? '',
        }));

      baseContext.reconciliations = reconciliations.slice(0, 100).map((r) => ({
        bankDescricao: r.bankDescricao,
        bankValor: r.bankValor,
        bankData: r.bankData,
        invoiceNumber: r.invoiceNumber ?? '',
        tipo: r.tipo,
        valorConciliado: r.valorConciliado,
        diferencaValor: r.diferencaValor ?? 0,
        confianca: r.confianca ?? '',
        justificativa: r.justificativa ?? '',
      }));
    }

    return baseContext;
  }, [
    companyName,
    hasInventoryAccess,
    hasFinanceAccess,
    inventory,
    stockMovements,
    financials,
    invoices,
    bankTransactions,
    reconciliations,
  ]);

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const RecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      onNotify(
        'info',
        'Seu navegador não suporta reconhecimento de voz nativo. Utilize o campo de texto abaixo.'
      );
      return;
    }

    try {
      const rec = new RecognitionCtor();
      rec.lang = 'pt-BR';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() ?? '';
        if (transcript) {
          setInput(transcript);
          void sendMessage(transcript);
        }
      };
      rec.onerror = (ev) => {
        setListening(false);
        if (ev.error !== 'aborted') {
          onNotify('error', `Não foi possível capturar áudio do microfone (${ev.error}).`);
        }
      };
      rec.onend = () => {
        setListening(false);
      };
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
      onNotify('error', 'Erro ao iniciar captura de voz no navegador.');
    }
  };

  const handleStartNewConversation = () => {
    setActiveConvId(null);
    setMessages([]);
    setPendingActions({});
    setErrorMsg(null);
  };

  const handleDeleteConversation = async (convId: string) => {
    try {
      await deleteAiConversation(user, companyId, convId);
      if (activeConvId === convId) {
        setActiveConvId(null);
        setMessages([]);
        setPendingActions({});
      }
      onNotify('info', 'Conversa removida do histórico.');
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao excluir conversa.');
    }
  };

  const sendMessage = async (promptText?: string) => {
    const text = (promptText ?? input).trim();
    if (!text || sending) return;

    setErrorMsg(null);
    if (!promptText) setInput('');
    setSending(true);

    try {
      // Garantir conversa ativa no Firestore
      let convId = activeConvId;
      let baseCount = messages.length;
      if (!convId) {
        const title = text.slice(0, 72) + (text.length > 72 ? '...' : '');
        convId = await createAiConversation(user, companyId, title);
        setActiveConvId(convId);
        baseCount = 0;
      }

      const historySnapshot = messages.slice(-10).map((m) => ({
        role: m.role,
        text: m.text,
      }));

      await appendAiMessage(user, companyId, convId, {
        role: 'user',
        text,
        actionType: 'none',
        newTitle: baseCount === 0 ? text.slice(0, 72) : undefined,
        nextMessageCount: baseCount + 1,
      });

      const response = await authorizedJsonFetch('/api/ai/chat', {
        message: text,
        history: historySnapshot,
        permissions: {
          role: userRole,
          canReadFinance: hasFinanceAccess,
          canReadInventory: hasInventoryAccess,
          canWriteInventory,
          canSaveReports,
        },
        companyContext,
      });

      const data = (await response.json()) as AiChatApiResponse;
      if (!response.ok || !data.reply) {
        throw new Error(data.error || 'Falha ao obter resposta do Google Gemini.');
      }

      const actionType = data.actionType ?? 'none';
      let actionSummary = '';
      if (actionType === 'stock_movement_preview' && data.stockPreview) {
        actionSummary = `Prévia: ${data.stockPreview.tipo === 'entrada' ? 'Entrada' : 'Saída'} de ${data.stockPreview.quantidade} ${data.stockPreview.unidade} (${data.stockPreview.productName})`;
      } else if (actionType === 'report_preview' && data.reportPreview) {
        actionSummary = `Prévia de relatório: ${data.reportPreview.title}`;
      }

      const modelMsgId = await appendAiMessage(user, companyId, convId, {
        role: 'model',
        text: data.reply,
        actionType,
        actionSummary,
        nextMessageCount: baseCount + 2,
      });

      if (
        (actionType === 'stock_movement_preview' && data.stockPreview) ||
        (actionType === 'report_preview' && data.reportPreview)
      ) {
        setPendingActions((prev) => ({
          ...prev,
          [modelMsgId]: {
            actionType,
            stockPreview: data.stockPreview ?? null,
            reportPreview: data.reportPreview ?? null,
            status: 'pending',
            responsavel: user.displayName || user.email || '',
            documentoReferencia: '',
          },
        }));
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao comunicar com o Assistente de IA.');
    } finally {
      setSending(false);
    }
  };

  const handleConfirmStockMovement = async (msgId: string) => {
    const action = pendingActions[msgId];
    if (!action?.stockPreview || action.busy || action.status !== 'pending') return;

    const preview = action.stockPreview;
    if (preview.permissionBlocked || !canWriteInventory) {
      onNotify('error', 'Seu perfil não possui permissão para alterar o estoque.');
      return;
    }
    if (preview.estoqueInsuficiente) {
      onNotify('error', 'Operação bloqueada: saldo insuficiente em estoque.');
      return;
    }
    const respName = (action.responsavel ?? '').trim();
    if (!respName) {
      onNotify('error', 'Informe o nome do responsável pela movimentação antes de confirmar.');
      return;
    }

    setPendingActions((prev) => ({
      ...prev,
      [msgId]: { ...prev[msgId], busy: true },
    }));

    try {
      await recordStockMovement(user, companyId, {
        productId: preview.productId,
        tipo: preview.tipo,
        motivo: preview.motivo,
        quantidade: preview.quantidade,
        responsavel: respName,
        documentoReferencia: (action.documentoReferencia ?? '').trim(),
        dataMovimentacao: todayISO(),
        observacoes: `[Assistente de IA] ${preview.observacoes}`.slice(
          0,
          FIELD_LIMITS.observacoesMovimento
        ),
        idempotencyKey: `ai_${msgId}`,
      });

      setPendingActions((prev) => ({
        ...prev,
        [msgId]: { ...prev[msgId], status: 'confirmed', busy: false },
      }));

      if (activeConvId) {
        const confirmText = `Movimentação efetivada com sucesso: ${
          preview.tipo === 'entrada' ? 'Entrada' : 'Saída'
        } de ${formatNumberBR(preview.quantidade, 2)} ${preview.unidade} de "${preview.productName}" (SKU ${preview.productSku}). Saldo atualizado: ${formatNumberBR(preview.saldoAnterior, 2)} → ${formatNumberBR(preview.saldoPosterior, 2)} ${preview.unidade}. Operação registrada no histórico de auditoria.`;
        await appendAiMessage(user, companyId, activeConvId, {
          role: 'model',
          text: confirmText,
          actionType: 'stock_movement_confirmed',
          actionSummary: `${preview.tipo === 'entrada' ? '+' : '-'}${preview.quantidade} ${preview.unidade} ${preview.productSku}`,
          nextMessageCount: messages.length + 1,
        });
      }

      onNotify(
        'success',
        `Movimentação efetivada: ${preview.productName} (${preview.tipo === 'entrada' ? '+' : '-'}${preview.quantidade} ${preview.unidade}).`
      );
    } catch (err: unknown) {
      setPendingActions((prev) => ({
        ...prev,
        [msgId]: { ...prev[msgId], busy: false },
      }));
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Erro ao efetivar movimentação de estoque.'
      );
    }
  };

  // Montar linhas reais filtradas para download ou gravação de relatório
  const buildReportExportData = (preview: ReportPreview) => {
    const start = preview.periodoInicio;
    const end = preview.periodoFim;
    const inPeriod = (iso?: string) => {
      if (!iso) return !start && !end;
      if (start && iso < start) return false;
      if (end && iso > end) return false;
      return true;
    };

    const sheets: Array<{ name: string; headers: string[]; rows: (string | number)[][] }> = [];

    if ((preview.reportType === 'estoque' || preview.reportType === 'geral') && hasInventoryAccess) {
      sheets.push({
        name: 'Estoque Atual',
        headers: ['SKU', 'Produto', 'Categoria', 'Unidade', 'Saldo Atual', 'Estoque Mínimo', 'Custo Unitário (R$)', 'Valor Total (R$)', 'Localização'],
        rows: inventory.map((p) => [
          p.sku,
          p.nome,
          p.categoria,
          p.unidade,
          p.quantidade,
          p.estoqueMinimo,
          p.custoUnitario,
          Math.round(p.quantidade * p.custoUnitario * 100) / 100,
          p.localizacao ?? '',
        ]),
      });
    }

    if (preview.reportType === 'movimentacoes' && hasInventoryAccess) {
      const movs = stockMovements.filter((m) => inPeriod(m.dataMovimentacao));
      sheets.push({
        name: 'Movimentações',
        headers: ['Data', 'SKU', 'Produto', 'Tipo', 'Motivo', 'Quantidade', 'Saldo Anterior', 'Saldo Posterior', 'Responsável', 'Referência'],
        rows: movs.map((m) => [
          formatDateBR(m.dataMovimentacao),
          m.productSku,
          m.productName,
          m.tipo === 'entrada' ? 'Entrada' : 'Saída',
          m.motivo,
          m.quantidade,
          m.saldoAnterior,
          m.saldoAtual,
          m.responsavel,
          m.documentoReferencia ?? '',
        ]),
      });
    }

    if ((preview.reportType === 'financeiro' || preview.reportType === 'geral') && hasFinanceAccess) {
      const finRows = financials.filter((f) => inPeriod(f.dataPagamento || f.dataVencimento));
      sheets.push({
        name: 'Financeiro',
        headers: ['Vencimento', 'Pagamento', 'Tipo', 'Categoria', 'Descrição', 'Contraparte', 'Status', 'Valor (R$)'],
        rows: finRows.map((f) => [
          formatDateBR(f.dataVencimento),
          formatDateBR(f.dataPagamento),
          f.tipo === 'receita' ? 'Recebimento' : 'Despesa',
          f.categoria,
          f.descricao,
          f.contraparte,
          f.status,
          f.valor,
        ]),
      });
    }

    if ((preview.reportType === 'notas_fiscais' || preview.reportType === 'geral') && hasFinanceAccess) {
      const invRows = invoices.filter((i) => inPeriod(i.dataEmissao));
      sheets.push({
        name: 'Notas Fiscais',
        headers: ['Emissão', 'Número', 'Série', 'Cliente', 'CPF/CNPJ', 'Status', 'Valor Total (R$)', 'Recebido (R$)', 'Saldo Aberto (R$)'],
        rows: invRows.map((i) => [
          formatDateBR(i.dataEmissao),
          i.numero,
          i.serie,
          i.clienteNome,
          i.clienteDocumento ?? '',
          i.statusRecebimento,
          i.valor,
          i.valorRecebido,
          Math.max(0, Math.round((i.valor - i.valorRecebido) * 100) / 100),
        ]),
      });
    }

    if ((preview.reportType === 'conciliacao' || preview.reportType === 'geral') && hasFinanceAccess) {
      const bankRows = bankTransactions.filter((b) => inPeriod(b.dataMovimento));
      sheets.push({
        name: 'Extrato e Conciliação',
        headers: ['Data', 'Banco', 'Pagador', 'Descrição', 'Tipo', 'Status Conciliação', 'NF Vinculada', 'Valor (R$)'],
        rows: bankRows.map((b) => [
          formatDateBR(b.dataMovimento),
          b.banco,
          b.nomePagador ?? '',
          b.descricao,
          b.tipo === 'credito' ? 'Crédito' : 'Débito',
          b.statusConciliacao,
          b.invoiceNumber ?? '',
          b.valor,
        ]),
      });
    }

    if (sheets.length === 0) {
      sheets.push({
        name: 'Resumo',
        headers: ['Informação'],
        rows: [['Sem registros disponíveis para os filtros selecionados.']],
      });
    }

    return sheets;
  };

  const handleDownloadReportExcel = async (msgId: string) => {
    const action = pendingActions[msgId];
    if (!action?.reportPreview) return;
    const sheets = buildReportExportData(action.reportPreview);
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    const fileSlug = action.reportPreview.reportType;
    XLSX.writeFile(wb, `relatorio_ia_${fileSlug}_${todayISO()}.xlsx`);

    if (userRole !== 'CONSULTA') {
      try {
        await recordAiAuditEvent(
          user,
          companyId,
          'criar',
          `Exportou relatório Excel via IA: ${action.reportPreview.title}`
        );
      } catch {
        // Não bloqueia download
      }
    }
    onNotify('success', 'Planilha Excel (.xlsx) gerada e baixada com dados reais.');
  };

  const handleDownloadReportCsv = async (msgId: string) => {
    const action = pendingActions[msgId];
    if (!action?.reportPreview) return;
    const sheets = buildReportExportData(action.reportPreview);
    const first = sheets[0];
    exportToCSV(`relatorio_ia_${action.reportPreview.reportType}_${todayISO()}`, first.headers, first.rows);

    if (userRole !== 'CONSULTA') {
      try {
        await recordAiAuditEvent(
          user,
          companyId,
          'criar',
          `Exportou relatório CSV via IA: ${action.reportPreview.title}`
        );
      } catch {
        // Não bloqueia download
      }
    }
    onNotify('success', 'Arquivo CSV gerado e baixado com dados reais.');
  };

  const handleSaveReportToFirebase = async (msgId: string) => {
    const action = pendingActions[msgId];
    if (!action?.reportPreview || action.busy || !canSaveReports) return;

    const preview = action.reportPreview;
    setPendingActions((prev) => ({
      ...prev,
      [msgId]: { ...prev[msgId], busy: true },
    }));

    try {
      const sheets = buildReportExportData(preview);
      const first = sheets[0];
      const csvBlob = buildCsvBlob(first.headers, first.rows);
      const fileName = `relatorio_ia_${preview.reportType}_${Date.now()}.csv`;
      let storagePath = '';
      let downloadUrl = '';

      try {
        const csvFile = new File([csvBlob], fileName, { type: 'text/csv' });
        const uploaded = await uploadCompanyFile(user, companyId, 'relatorios', csvFile);
        storagePath = uploaded.storagePath;
        downloadUrl = uploaded.downloadUrl;
      } catch {
        // Storage opcional caso plano não esteja ativo
      }

      const firestoreReportType: SavedReport['tipo'] =
        preview.reportType === 'movimentacoes' ? 'estoque' : preview.reportType;

      await saveCompanyReport(user, companyId, {
        titulo: preview.title,
        tipo: firestoreReportType,
        periodoInicio: preview.periodoInicio || undefined,
        periodoFim: preview.periodoFim || undefined,
        totalRegistros: first.rows.length,
        valorResumo: preview.valorResumo,
        fileName,
        storagePath,
        downloadUrl,
      });

      setPendingActions((prev) => ({
        ...prev,
        [msgId]: { ...prev[msgId], status: 'confirmed', busy: false },
      }));

      if (activeConvId) {
        await appendAiMessage(user, companyId, activeConvId, {
          role: 'model',
          text: `Relatório "${preview.title}" salvo no módulo de Relatórios (${first.rows.length} registros) e registrado no histórico de auditoria.`,
          actionType: 'report_saved',
          actionSummary: preview.title,
          nextMessageCount: messages.length + 1,
        });
      }

      onNotify('success', 'Relatório salvo com sucesso no histórico da empresa.');
    } catch (err: unknown) {
      setPendingActions((prev) => ({
        ...prev,
        [msgId]: { ...prev[msgId], busy: false },
      }));
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar relatório.');
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignora erro de clipboard
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 w-full min-w-0 h-[calc(100vh-11rem)] min-h-[540px]">
      {/* Barra Lateral: Histórico de Conversas */}
      {sidebarOpen && (
        <aside className="w-full lg:w-72 shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col max-h-64 lg:max-h-full overflow-hidden">
          <div className="p-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <History className="w-4 h-4 text-[#0B1F3A] shrink-0" />
              <span className="text-xs font-semibold text-slate-900 truncate">
                Histórico de Conversas
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartNewConversation}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-[#0B1F3A] hover:bg-blue-900 rounded-lg cursor-pointer shrink-0"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              Nova
            </button>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {conversations.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 text-center">
                Nenhuma conversa salva ainda. Envie uma pergunta para iniciar o histórico.
              </div>
            ) : (
              conversations.map((conv) => {
                const isActive = conv.id === activeConvId;
                return (
                  <div
                    key={conv.id}
                    className={`group flex items-start justify-between gap-2 p-3 cursor-pointer transition-colors ${
                      isActive ? 'bg-blue-50/80 border-l-2 border-l-blue-700' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => setActiveConvId(conv.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-xs font-medium truncate ${
                          isActive ? 'text-blue-950' : 'text-slate-800'
                        }`}
                      >
                        {conv.title}
                      </p>
                      {conv.lastMessagePreview && (
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">
                          {conv.lastMessagePreview}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-400 mt-1">
                        {formatTimestampBR(conv.updatedAt)} · {conv.messageCount} msg
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteConversation(conv.id);
                      }}
                      title="Excluir conversa"
                      aria-label="Excluir conversa"
                      className="p-1 text-slate-400 hover:text-red-600 rounded opacity-70 group-hover:opacity-100 cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Escopo RBAC e Contexto Conectado */}
          <div className="p-3.5 border-t border-slate-200 bg-slate-50/70 space-y-1.5 text-[11px] text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">Perfil Conectado</span>
              <span className="font-semibold text-[#0B1F3A]">{ROLE_LABELS[userRole]}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Produtos em Estoque</span>
              <span className="font-mono font-semibold text-slate-900">{inventory.length}</span>
            </div>
            {hasFinanceAccess && (
              <div className="flex items-center justify-between gap-2">
                <span>NFs / Extratos</span>
                <span className="font-mono font-semibold text-slate-900">
                  {invoices.length} / {bankTransactions.length}
                </span>
              </div>
            )}
            <p className="text-[10px] text-slate-500 pt-1">
              {canWriteInventory
                ? 'Movimentações de estoque exigem confirmação prévia.'
                : 'Modo consulta: alterações no banco bloqueadas para seu perfil.'}
            </p>
          </div>
        </aside>
      )}

      {/* Área Principal do Chat */}
      <div className="flex-1 bg-white border border-slate-200 rounded-xl flex flex-col min-w-0 min-h-0 overflow-hidden">
        {/* Cabeçalho */}
        <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? 'Ocultar histórico' : 'Mostrar histórico'}
              className="p-2 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer shrink-0"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="w-4 h-4" />
              ) : (
                <PanelLeftOpen className="w-4 h-4" />
              )}
            </button>
            <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] text-white flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-semibold text-slate-900 truncate">
                Assistente Inteligente de IA
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Consultas em tempo real, movimentações com prévia e relatórios · {companyName}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleStartNewConversation}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer shrink-0"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Nova Conversa</span>
          </button>
        </div>

        {/* Lista de Mensagens */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-4 bg-slate-50/40">
          {loadingMessages ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-500 gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
              Carregando histórico da conversa...
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto py-4">
              <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-700 flex items-center justify-center mb-3">
                <Bot className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                Como posso auxiliar a gestão da {companyName} hoje?
              </h3>
              <p className="text-xs sm:text-sm text-slate-500 mt-1.5 max-w-xl leading-relaxed">
                Consulto saldos reais do Firebase, identifico notas pendentes ou recebimentos sem nota, explico divergências da conciliação, gero relatórios e preparo movimentações de estoque com confirmação prévia.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-6 w-full text-left">
                {suggestedPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendMessage(prompt)}
                    className="p-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-blue-500 hover:text-blue-900 transition-colors cursor-pointer break-words"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const actionState = pendingActions[msg.id];
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col min-w-0 ${
                    msg.role === 'user' ? 'items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`max-w-[94%] sm:max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed break-words ${
                      msg.role === 'user'
                        ? 'bg-[#0B1F3A] text-white'
                        : 'bg-white border border-slate-200 text-slate-800'
                    }`}
                  >
                    <div className="break-words">{renderFormattedText(msg.text)}</div>

                    {msg.role === 'model' && (
                      <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between gap-3">
                        <span className="text-[10px] text-slate-400">
                          {formatTimestampBR(msg.createdAt)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopy(msg.id, msg.text)}
                          className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
                        >
                          {copiedId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-600" />
                              Copiado
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copiar
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Card de Prévia: Movimentação de Estoque */}
                  {actionState?.actionType === 'stock_movement_preview' &&
                    actionState.stockPreview && (
                      <div className="mt-2 max-w-[94%] sm:max-w-[85%] w-full bg-white border border-blue-200 rounded-xl p-4 space-y-3 shadow-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[#0B1F3A]">
                            Prévia de Movimentação de Estoque
                          </span>
                          <span className="text-[11px] font-mono text-slate-500">
                            SKU: {actionState.stockPreview.productSku}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 rounded-lg p-3 border border-slate-100">
                          <div className="col-span-2 sm:col-span-1">
                            <span className="text-slate-500 block">Produto</span>
                            <strong className="text-slate-900">
                              {actionState.stockPreview.productName}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Operação</span>
                            <strong
                              className={
                                actionState.stockPreview.tipo === 'entrada'
                                  ? 'text-emerald-700'
                                  : 'text-blue-700'
                              }
                            >
                              {actionState.stockPreview.tipo === 'entrada'
                                ? 'Entrada (+)'
                                : 'Saída (-)'}
                            </strong>
                            <span className="block text-[11px] text-slate-500">
                              {actionState.stockPreview.motivo}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Quantidade</span>
                            <strong className="font-mono text-slate-900">
                              {formatNumberBR(actionState.stockPreview.quantidade, 2)}{' '}
                              {actionState.stockPreview.unidade}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500 block">Saldo Anterior → Novo</span>
                            <div className="font-mono">
                              <span className="text-slate-600">
                                {formatNumberBR(actionState.stockPreview.saldoAnterior, 2)}
                              </span>
                              {' → '}
                              <strong
                                className={
                                  actionState.stockPreview.estoqueInsuficiente
                                    ? 'text-red-700'
                                    : 'text-emerald-700'
                                }
                              >
                                {formatNumberBR(actionState.stockPreview.saldoPosterior, 2)}{' '}
                                {actionState.stockPreview.unidade}
                              </strong>
                            </div>
                          </div>
                        </div>

                        {actionState.stockPreview.permissionBlocked ? (
                          <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg p-3 flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4 shrink-0 text-amber-700" />
                            <span>{actionState.stockPreview.permissionReason}</span>
                          </div>
                        ) : actionState.stockPreview.estoqueInsuficiente ? (
                          <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg p-3 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>
                              Saldo insuficiente em estoque. Não é permitido efetivar saldo negativo.
                            </span>
                          </div>
                        ) : actionState.status === 'confirmed' ? (
                          <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg p-3 flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
                            <span>
                              Movimentação gravada no Firestore e sincronizada com o estoque.
                            </span>
                          </div>
                        ) : actionState.status === 'cancelled' ? (
                          <div className="text-xs text-slate-500 italic">
                            Operação cancelada pelo usuário antes da gravação.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-end pt-1">
                            <div>
                              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                                Responsável *
                              </label>
                              <input
                                type="text"
                                maxLength={FIELD_LIMITS.responsavel}
                                value={actionState.responsavel ?? ''}
                                onChange={(e) =>
                                  setPendingActions((prev) => ({
                                    ...prev,
                                    [msg.id]: { ...prev[msg.id], responsavel: e.target.value },
                                  }))
                                }
                                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                                OS / NF Referência (opcional)
                              </label>
                              <input
                                type="text"
                                maxLength={FIELD_LIMITS.documentoReferencia}
                                value={actionState.documentoReferencia ?? ''}
                                onChange={(e) =>
                                  setPendingActions((prev) => ({
                                    ...prev,
                                    [msg.id]: {
                                      ...prev[msg.id],
                                      documentoReferencia: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="Ex.: OS-412"
                                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                disabled={actionState.busy}
                                onClick={() =>
                                  setPendingActions((prev) => ({
                                    ...prev,
                                    [msg.id]: { ...prev[msg.id], status: 'cancelled' },
                                  }))
                                }
                                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                                Cancelar
                              </button>
                              <button
                                type="button"
                                disabled={actionState.busy}
                                onClick={() => void handleConfirmStockMovement(msg.id)}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 cursor-pointer"
                              >
                                {actionState.busy && (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                )}
                                {actionState.busy ? 'Gravando...' : 'Confirmar Operação'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  {/* Card de Prévia: Relatório Solicitado */}
                  {actionState?.actionType === 'report_preview' && actionState.reportPreview && (
                    <div className="mt-2 max-w-[94%] sm:max-w-[85%] w-full bg-white border border-blue-200 rounded-xl p-4 space-y-3 shadow-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#0B1F3A]">
                          Prévia de Relatório: {actionState.reportPreview.title}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {actionState.reportPreview.periodoInicio &&
                          actionState.reportPreview.periodoFim
                            ? `${formatDateBR(actionState.reportPreview.periodoInicio)} a ${formatDateBR(actionState.reportPreview.periodoFim)}`
                            : 'Todo o histórico cadastrado'}
                        </span>
                      </div>

                      <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 text-xs text-slate-700 space-y-1">
                        <p>{actionState.reportPreview.resumoTexto}</p>
                        <p className="text-[11px] text-slate-500">
                          Registros reais incluídos: {actionState.reportPreview.totalRegistros} ·
                          Valor resumo: {formatBRL(actionState.reportPreview.valorResumo)}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDownloadReportCsv(msg.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          Baixar CSV
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDownloadReportExcel(msg.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" />
                          Baixar Excel (.xlsx)
                        </button>
                        {canSaveReports && actionState.status === 'pending' && (
                          <button
                            type="button"
                            disabled={actionState.busy}
                            onClick={() => void handleSaveReportToFirebase(msg.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 cursor-pointer"
                          >
                            {actionState.busy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5" />
                            )}
                            Salvar em Relatórios
                          </button>
                        )}
                      </div>

                      {actionState.status === 'confirmed' && (
                        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg p-2.5 flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
                          <span>Relatório arquivado no histórico oficial da empresa.</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs sm:text-sm text-slate-600 inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-700 shrink-0" />
                Consultando dados reais do Firebase...
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 text-xs text-red-800 break-words">
              <strong>Não foi possível concluir a solicitação:</strong> {errorMsg}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Barra de Entrada por Texto e Voz */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
          className="p-3 sm:p-4 border-t border-slate-200 bg-white flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
        >
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pergunte sobre estoque, movimentações, recebimentos, notas fiscais ou relatórios..."
              className="w-full min-w-0 flex-1 px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              disabled={sending}
            />
            {speechSupported && (
              <button
                type="button"
                onClick={toggleVoice}
                disabled={sending}
                title={listening ? 'Parar captura de voz' : 'Falar comando (pt-BR)'}
                aria-label={listening ? 'Parar captura de voz' : 'Ativar microfone'}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-lg border cursor-pointer transition-colors shrink-0 ${
                  listening
                    ? 'bg-red-600 text-white border-red-600 animate-pulse'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                <span className="hidden md:inline">{listening ? 'Ouvindo...' : 'Voz'}</span>
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-700 text-white text-sm font-medium rounded-lg hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
};
