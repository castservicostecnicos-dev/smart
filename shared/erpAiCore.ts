export interface FirebaseJwtPayload {
  aud?: string;
  iss?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
}

export interface VerifiedFirebaseClaims {
  uid: string;
  email: string;
  emailVerified: true;
}

export function validateFirebasePayloadClaims(
  payload: FirebaseJwtPayload,
  expectedProjectId: string
): VerifiedFirebaseClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== expectedProjectId) {
    throw new Error('Token emitido para outro projeto Firebase.');
  }
  if (payload.iss !== `https://securetoken.google.com/${expectedProjectId}`) {
    throw new Error('Emissor do token inválido.');
  }
  if (!payload.sub || payload.sub.length > 128) {
    throw new Error('Identificador do usuário ausente no token.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 30) {
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Data de emissão do token inválida.');
  }
  if (payload.email_verified !== true) {
    throw new Error('E-mail do usuário ainda não foi verificado no Firebase.');
  }

  return {
    uid: payload.sub,
    email: String(payload.email || ''),
    emailVerified: true,
  };
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function formatIsoToBrServer(iso?: string): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function formatBrlServer(val: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number.isFinite(val) ? val : 0);
}

export function sanitizeBase64Pdf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(/^data:application\/pdf;base64,/i, '').replace(/\s+/g, '');
  if (!stripped || stripped.length > 14_500_000) return '';
  if (!/^[A-Za-z0-9+/=]+$/.test(stripped)) return '';
  return stripped;
}

export function normalizeServerIsoDate(raw: string | undefined): string {
  const clean = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(clean);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return '';
}

export interface SchemaTokens<TSchemaType = unknown> {
  OBJECT: TSchemaType;
  STRING: TSchemaType;
  NUMBER: TSchemaType;
  ARRAY: TSchemaType;
  BOOLEAN: TSchemaType;
}

export interface AiCallSpec {
  contents: unknown;
  systemInstruction: string;
  responseSchema: unknown;
}

export type AiGenerateJsonFn = (spec: AiCallSpec) => Promise<string>;

export interface HttpCoreResult {
  status: number;
  body: Record<string, unknown>;
}

export function mapGeminiErrorToHttp(error: unknown, fallback: string): { status: number; error: string } {
  const errMsg = error instanceof Error ? error.message : fallback;
  if (errMsg.includes('GEMINI_API_KEY')) {
    return {
      status: 503,
      error: 'Chave da API Gemini não configurada no servidor.',
    };
  }
  if (errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED') || errMsg.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      error: 'Chave da API Gemini inválida ou sem permissão no servidor.',
    };
  }
  if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      error: 'Limite de requisições da API Gemini atingido temporariamente. Tente novamente em instantes.',
    };
  }
  if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE')) {
    return {
      status: 503,
      error: 'Serviço Gemini temporariamente sobrecarregado. Tente novamente em alguns segundos.',
    };
  }
  return { status: 500, error: errMsg };
}

export interface ChatHistoryItem {
  role: 'user' | 'model';
  text: string;
}

export interface AiAssistantPermissions {
  role: 'ADMINISTRADOR' | 'FINANCEIRO' | 'ESTOQUE' | 'CONSULTA';
  canReadFinance: boolean;
  canReadInventory: boolean;
  canWriteInventory: boolean;
  canSaveReports: boolean;
}

export interface AiAssistantProductItem {
  id: string;
  sku: string;
  nome: string;
  categoria?: string;
  unidade: string;
  quantidade: number;
  estoqueMinimo: number;
  custoUnitario?: number;
  precoVenda?: number;
  localizacao?: string;
}

export interface AiAssistantMovementItem {
  productSku: string;
  productName: string;
  tipo: 'entrada' | 'saida';
  motivo: string;
  quantidade: number;
  saldoAnterior: number;
  saldoAtual: number;
  dataMovimentacao: string;
  responsavel: string;
  documentoReferencia?: string;
}

export interface AiAssistantInvoiceItem {
  id: string;
  numero: string;
  serie?: string;
  clienteNome: string;
  clienteDocumento?: string;
  dataEmissao: string;
  dataVencimento?: string;
  valor: number;
  valorRecebido: number;
  saldoPendente: number;
  statusRecebimento: string;
}

export interface AiAssistantBankCreditItem {
  id: string;
  dataMovimento: string;
  banco: string;
  descricao: string;
  nomePagador?: string;
  cpfCnpjPagador?: string;
  valor: number;
  valorConciliado?: number;
  valorDisponivel: number;
  statusConciliacao: string;
  invoiceNumber?: string;
}

export interface AiAssistantReconciliationItem {
  bankDescricao: string;
  bankValor: number;
  bankData: string;
  invoiceNumber?: string;
  tipo: string;
  valorConciliado: number;
  diferencaValor?: number;
  confianca?: string;
  justificativa?: string;
}

export interface AiAssistantCompanyContext {
  empresa?: string;
  dataAtualISO?: string;
  inventorySummary?: {
    totalProdutos?: number;
    valorTotalCusto?: number;
    totalAbaixoMinimo?: number;
  };
  products?: AiAssistantProductItem[];
  recentMovements?: AiAssistantMovementItem[];
  financialSummary?: {
    mesAtual?: string;
    mesAtualLabel?: string;
    totalRecebimentosPagosMesAtual?: number;
    totalRecebimentosBancariosMesAtual?: number;
    totalDespesasMesAtual?: number;
    totalRecebimentosPagosGeral?: number;
    totalDespesasGeral?: number;
    totalNotasEmitidas?: number;
    totalNotasPendentes?: number;
    totalNotasParciais?: number;
    valorPendenteNotas?: number;
    totalRecebimentosSemNf?: number;
    valorRecebimentosSemNf?: number;
    monthlyBreakdown?: Array<{
      mes: string;
      mesLabel: string;
      recebimentosPagos: number;
      despesas: number;
      creditosBancarios: number;
    }>;
  };
  pendingInvoices?: AiAssistantInvoiceItem[];
  unmatchedBankCredits?: AiAssistantBankCreditItem[];
  recentBankCredits?: AiAssistantBankCreditItem[];
  reconciliations?: AiAssistantReconciliationItem[];
  [key: string]: unknown;
}

export interface AiChatRequestBody {
  message?: string;
  history?: ChatHistoryItem[];
  permissions?: Partial<AiAssistantPermissions>;
  companyContext?: AiAssistantCompanyContext;
}

export async function executeAiChat(
  body: AiChatRequestBody,
  T: SchemaTokens,
  generateJson: AiGenerateJsonFn
): Promise<HttpCoreResult> {
  const userMessage = typeof body?.message === 'string' ? body.message.trim().slice(0, 4000) : '';
  if (!userMessage) {
    return { status: 400, body: { error: 'A mensagem não pode estar vazia.' } };
  }

  const rawContext = body.companyContext ?? {};
  const role: AiAssistantPermissions['role'] =
    body.permissions?.role === 'ADMINISTRADOR' ||
    body.permissions?.role === 'FINANCEIRO' ||
    body.permissions?.role === 'ESTOQUE' ||
    body.permissions?.role === 'CONSULTA'
      ? body.permissions.role
      : 'CONSULTA';

  const canReadFinance =
    body.permissions?.canReadFinance !== undefined
      ? Boolean(body.permissions.canReadFinance)
      : Boolean(rawContext.financialSummary || rawContext.resumoFinanceiro);
  const canReadInventory =
    body.permissions?.canReadInventory !== undefined ? Boolean(body.permissions.canReadInventory) : true;
  const canWriteInventory =
    body.permissions?.canWriteInventory !== undefined
      ? Boolean(body.permissions.canWriteInventory)
      : role === 'ADMINISTRADOR' || role === 'ESTOQUE';
  const canSaveReports =
    body.permissions?.canSaveReports !== undefined ? Boolean(body.permissions.canSaveReports) : role !== 'CONSULTA';

  const productsList =
    canReadInventory && Array.isArray(rawContext.products) ? rawContext.products.slice(0, 400) : [];
  const movementsList =
    canReadInventory && Array.isArray(rawContext.recentMovements) ? rawContext.recentMovements.slice(0, 80) : [];

  const pendingInvoicesList =
    canReadFinance && Array.isArray(rawContext.pendingInvoices) ? rawContext.pendingInvoices.slice(0, 200) : [];
  const unmatchedCreditsList =
    canReadFinance && Array.isArray(rawContext.unmatchedBankCredits)
      ? rawContext.unmatchedBankCredits.slice(0, 150)
      : [];
  const recentCreditsList =
    canReadFinance && Array.isArray(rawContext.recentBankCredits) ? rawContext.recentBankCredits.slice(0, 80) : [];
  const reconciliationsList =
    canReadFinance && Array.isArray(rawContext.reconciliations) ? rawContext.reconciliations.slice(0, 100) : [];

  const todayIso =
    typeof rawContext.dataAtualISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawContext.dataAtualISO)
      ? rawContext.dataAtualISO
      : new Date().toISOString().slice(0, 10);

  const sanitizedContext: Record<string, unknown> = {
    empresa: rawContext.empresa || 'Gestão Inteligente Empresarial',
    dataAtual: formatIsoToBrServer(todayIso),
    dataAtualISO: todayIso,
    perfilUsuario: {
      role,
      podeLerFinanceiro: canReadFinance,
      podeLerEstoque: canReadInventory,
      podeMovimentarEstoque: canWriteInventory,
      podeSalvarRelatorios: canSaveReports,
    },
  };

  if (canReadInventory) {
    sanitizedContext.estoque = {
      resumo: rawContext.inventorySummary ?? {
        totalProdutos: productsList.length,
        totalAbaixoMinimo: productsList.filter((p) => Number(p.quantidade) <= Number(p.estoqueMinimo)).length,
      },
      produtos: productsList,
      movimentacoesRecentes: movementsList,
    };
  }

  if (canReadFinance) {
    sanitizedContext.financeiroEFiscal = {
      resumo: rawContext.financialSummary ?? null,
      notasFiscaisPendentesOuParciais: pendingInvoicesList,
      recebimentosBancariosSemNota: unmatchedCreditsList,
      recebimentosBancariosRecentes: recentCreditsList,
      conciliacoesEDivergencias: reconciliationsList,
    };
  }

  const systemInstruction = [
    'Você é o Assistente Inteligente Empresarial (HVAC-R: ar-condicionado, climatização e refrigeração).',
    'Responda SEMPRE em Português do Brasil, de forma objetiva, clara e profissional.',
    'Formate valores monetários em Reais (R$ 1.234,56) e datas no formato DD/MM/AAAA.',
    'REGRAS INVIOLÁVEIS DE SEGURANÇA E CONFIABILIDADE:',
    '1. NUNCA invente, estime ou presuma saldos, quantidades, valores, notas fiscais, clientes ou movimentações. Use EXCLUSIVAMENTE os dados reais presentes no JSON [DADOS REAIS DO FIREBASE].',
    '2. Se não houver registros ou o produto não existir no catálogo, informe exatamente isso com transparência.',
    `3. Respeite o perfil conectado (${role}): podeLerFinanceiro=${canReadFinance}, podeLerEstoque=${canReadInventory}, podeMovimentarEstoque=${canWriteInventory}. Se o usuário pedir dados financeiros sem ter podeLerFinanceiro=true, recuse informando a restrição de perfil.`,
    '4. Para entradas ou saídas de estoque (ex.: "Retire 15 unidades de capacitor de 30 microfarads"), defina actionType="stock_movement_preview", preencha stockMovement com o productId EXATO do catálogo e a quantidade numérica correta (sem confundir bitola/medida como 3/8 ou 1/4 com quantidade). Explique na resposta que a prévia foi preparada para conferência e confirmação antes de gravar no Firebase.',
    '5. Para pedidos de geração/exportação de relatórios (ex.: "Gere um relatório...", "Resuma e gere planilha..."), defina actionType="report_preview" e preencha reportRequest.',
    '6. Para consultas simples (saldos, notas pendentes, recebimentos sem NF, faturamento do mês, divergências de conciliação, histórico), defina actionType="none" e liste objetivamente os dados reais encontrados.',
  ].join('\n');

  const contextText = `\n\n[DADOS REAIS DO FIREBASE]\n${JSON.stringify(sanitizedContext)}`;
  const historyParts = Array.isArray(body.history)
    ? body.history.slice(-10).map((item) => ({
        role: item.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(item.text || '').slice(0, 4000) }],
      }))
    : [];

  const contents = [
    ...historyParts,
    {
      role: 'user',
      parts: [{ text: `${userMessage}${contextText}` }],
    },
  ];

  const responseSchema = {
    type: T.OBJECT,
    properties: {
      reply: {
        type: T.STRING,
        description: 'Resposta completa em Português do Brasil baseada estritamente nos dados reais fornecidos.',
      },
      actionType: {
        type: T.STRING,
        enum: ['none', 'stock_movement_preview', 'report_preview'],
      },
      stockMovement: {
        type: T.OBJECT,
        properties: {
          productId: { type: T.STRING },
          tipo: { type: T.STRING, enum: ['entrada', 'saida'] },
          motivo: {
            type: T.STRING,
            enum: [
              'Compra',
              'Entrada de material',
              'Retirada para instalação',
              'Uso em manutenção',
              'Venda',
              'Devolução',
              'Ajuste de inventário',
              'Perda ou avaria',
            ],
          },
          quantidade: { type: T.NUMBER },
          observacoes: { type: T.STRING },
        },
      },
      reportRequest: {
        type: T.OBJECT,
        properties: {
          reportType: {
            type: T.STRING,
            enum: ['estoque', 'financeiro', 'notas_fiscais', 'conciliacao', 'movimentacoes', 'geral'],
          },
          title: { type: T.STRING },
          periodoInicio: { type: T.STRING },
          periodoFim: { type: T.STRING },
          format: { type: T.STRING, enum: ['excel', 'csv', 'summary'] },
        },
      },
    },
    required: ['reply', 'actionType'],
  };

  const rawJson = (await generateJson({ contents, systemInstruction, responseSchema })).trim() || '{}';
  const parsed = JSON.parse(rawJson) as {
    reply?: string;
    actionType?: 'none' | 'stock_movement_preview' | 'report_preview';
    stockMovement?: {
      productId?: string;
      tipo?: 'entrada' | 'saida';
      motivo?: string;
      quantidade?: number;
      observacoes?: string;
    };
    reportRequest?: {
      reportType?: 'estoque' | 'financeiro' | 'notas_fiscais' | 'conciliacao' | 'movimentacoes' | 'geral';
      title?: string;
      periodoInicio?: string;
      periodoFim?: string;
      format?: 'excel' | 'csv' | 'summary';
    };
  };

  let replyText = (parsed.reply ?? '').trim();
  let actionType: 'none' | 'stock_movement_preview' | 'report_preview' =
    parsed.actionType === 'stock_movement_preview' || parsed.actionType === 'report_preview'
      ? parsed.actionType
      : 'none';

  let stockPreview: Record<string, unknown> | null = null;
  let reportPreview: Record<string, unknown> | null = null;

  if (actionType === 'stock_movement_preview' && parsed.stockMovement) {
    if (!canReadInventory) {
      actionType = 'none';
      replyText = `Seu perfil (${role}) não possui acesso ao módulo de Estoque para realizar esta operação.`;
    } else {
      const targetId = String(parsed.stockMovement.productId || '').trim();
      const matchedProduct = targetId
        ? productsList.find((p) => p.id === targetId || p.sku.toLowerCase() === targetId.toLowerCase())
        : undefined;
      const qty = round2(Number(parsed.stockMovement.quantidade || 0));

      if (!matchedProduct) {
        actionType = 'none';
        if (!replyText) {
          replyText =
            'Não localizei o produto exato no catálogo cadastrado do Firebase. Informe o nome completo ou o código SKU do item.';
        }
      } else if (!Number.isFinite(qty) || qty <= 0) {
        actionType = 'none';
        replyText = `Produto "${matchedProduct.nome}" localizado (saldo atual: ${matchedProduct.quantidade} ${matchedProduct.unidade}), mas a quantidade informada (${parsed.stockMovement.quantidade ?? 0}) é inválida.`;
      } else {
        const tipo: 'entrada' | 'saida' = parsed.stockMovement.tipo === 'entrada' ? 'entrada' : 'saida';
        const saldoAnterior = round2(Number(matchedProduct.quantidade) || 0);
        const saldoPosterior = tipo === 'entrada' ? round2(saldoAnterior + qty) : round2(saldoAnterior - qty);
        const estoqueInsuficiente = saldoPosterior < 0;
        const permissionBlocked = !canWriteInventory;
        const permissionReason = permissionBlocked
          ? `Seu perfil (${role}) possui acesso somente de leitura ao estoque. Apenas usuários Administrador ou Estoque podem efetivar movimentações.`
          : '';

        stockPreview = {
          productId: matchedProduct.id,
          productSku: matchedProduct.sku,
          productName: matchedProduct.nome,
          unidade: matchedProduct.unidade,
          tipo,
          motivo:
            parsed.stockMovement.motivo || (tipo === 'entrada' ? 'Entrada de material' : 'Retirada para instalação'),
          quantidade: qty,
          saldoAnterior,
          saldoPosterior,
          estoqueInsuficiente,
          permissionBlocked,
          permissionReason,
          observacoes: String(
            parsed.stockMovement.observacoes || `Solicitação via Assistente de IA: "${userMessage.slice(0, 120)}"`
          ).slice(0, 260),
        };

        if (!replyText) {
          replyText = permissionBlocked
            ? permissionReason
            : estoqueInsuficiente
              ? `Atenção: "${matchedProduct.nome}" possui apenas ${saldoAnterior} ${matchedProduct.unidade} em estoque. Não é possível retirar ${qty} ${matchedProduct.unidade}.`
              : `Prévia preparada para ${tipo === 'entrada' ? 'entrada' : 'saída'} de ${qty} ${matchedProduct.unidade} de "${matchedProduct.nome}". Confira os saldos abaixo e confirme para gravar no Firebase.`;
        }
      }
    }
  }

  if (actionType === 'report_preview' && parsed.reportRequest) {
    let reqType = parsed.reportRequest.reportType || 'geral';
    const isFinanceReport = reqType === 'financeiro' || reqType === 'notas_fiscais' || reqType === 'conciliacao';
    const isInventoryReport = reqType === 'estoque' || reqType === 'movimentacoes';

    if (isFinanceReport && !canReadFinance) {
      actionType = 'none';
      replyText = `Seu perfil (${role}) não possui permissão para acessar ou gerar relatórios financeiros, fiscais ou de conciliação bancária.`;
    } else if (isInventoryReport && !canReadInventory) {
      actionType = 'none';
      replyText = `Seu perfil (${role}) não possui permissão para acessar relatórios de estoque.`;
    } else {
      if (reqType === 'geral' && !canReadFinance) {
        reqType = 'estoque';
      }

      const inicio =
        typeof parsed.reportRequest.periodoInicio === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.reportRequest.periodoInicio)
          ? parsed.reportRequest.periodoInicio
          : '';
      const fim =
        typeof parsed.reportRequest.periodoFim === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.reportRequest.periodoFim)
          ? parsed.reportRequest.periodoFim
          : '';

      let totalRegistros = 0;
      let valorResumo = 0;
      let resumoTexto = '';

      if (reqType === 'estoque') {
        totalRegistros = productsList.length;
        valorResumo = round2(
          productsList.reduce((s, p) => s + (Number(p.quantidade) || 0) * (Number(p.custoUnitario) || 0), 0)
        );
        const lowCount = productsList.filter((p) => Number(p.quantidade) <= Number(p.estoqueMinimo)).length;
        resumoTexto = `${totalRegistros} produtos no estoque (${lowCount} abaixo/no mínimo) | Custo total: ${formatBrlServer(valorResumo)}`;
      } else if (reqType === 'movimentacoes') {
        const filteredMovs = movementsList.filter(
          (m) => (!inicio || m.dataMovimentacao >= inicio) && (!fim || m.dataMovimentacao <= fim)
        );
        totalRegistros = filteredMovs.length;
        valorResumo = round2(filteredMovs.reduce((s, m) => s + (Number(m.quantidade) || 0), 0));
        resumoTexto = `${totalRegistros} movimentações no recorte analisado`;
      } else if (reqType === 'notas_fiscais') {
        totalRegistros = pendingInvoicesList.length;
        valorResumo = round2(pendingInvoicesList.reduce((s, n) => s + (Number(n.saldoPendente) || 0), 0));
        resumoTexto = `${totalRegistros} notas fiscais pendentes/parciais | Saldo a receber: ${formatBrlServer(valorResumo)}`;
      } else if (reqType === 'conciliacao') {
        totalRegistros = unmatchedCreditsList.length + reconciliationsList.length;
        valorResumo = round2(unmatchedCreditsList.reduce((s, b) => s + (Number(b.valorDisponivel) || 0), 0));
        resumoTexto = `${unmatchedCreditsList.length} créditos sem NF vinculada (${formatBrlServer(valorResumo)}) e ${reconciliationsList.length} conciliações registradas`;
      } else if (reqType === 'financeiro') {
        const fin = rawContext.financialSummary;
        totalRegistros = (recentCreditsList.length || 0) + (pendingInvoicesList.length || 0);
        valorResumo = round2(fin?.totalRecebimentosPagosGeral ?? 0);
        resumoTexto = `Recebimentos confirmados: ${formatBrlServer(fin?.totalRecebimentosPagosGeral ?? 0)} | Despesas: ${formatBrlServer(fin?.totalDespesasGeral ?? 0)}`;
      } else {
        const fin = rawContext.financialSummary;
        totalRegistros = productsList.length + pendingInvoicesList.length + unmatchedCreditsList.length;
        valorResumo = round2(fin?.totalRecebimentosPagosGeral ?? 0);
        resumoTexto = `Visão consolidada com ${productsList.length} itens de estoque, ${pendingInvoicesList.length} NFs em aberto e ${unmatchedCreditsList.length} créditos sem NF`;
      }

      reportPreview = {
        reportType: reqType,
        title: String(parsed.reportRequest.title || `Relatório (${reqType})`).slice(0, 140),
        periodoInicio: inicio,
        periodoFim: fim,
        preferredFormat: parsed.reportRequest.format || 'excel',
        totalRegistros,
        valorResumo,
        resumoTexto,
      };
    }
  }

  if (!replyText) {
    return { status: 502, body: { error: 'O modelo não retornou conteúdo textual.' } };
  }

  return {
    status: 200,
    body: {
      reply: replyText,
      actionType,
      stockPreview,
      reportPreview,
      model: 'gemini-4-hydrogen',
    },
  };
}

export interface InventoryItemSummary {
  id: string;
  sku: string;
  nome: string;
  categoria: string;
  unidade: string;
  quantidade: number;
  estoqueMinimo: number;
  localizacao?: string;
}

export interface InventoryCommandRequest {
  commandText?: string;
  products?: InventoryItemSummary[];
}

export async function executeInventoryCommand(
  body: InventoryCommandRequest,
  T: SchemaTokens,
  generateJson: AiGenerateJsonFn
): Promise<HttpCoreResult> {
  const commandText = typeof body?.commandText === 'string' ? body.commandText.trim().slice(0, 1000) : '';
  const products = Array.isArray(body?.products) ? body.products : [];

  if (!commandText) {
    return { status: 400, body: { error: 'Informe um comando de texto ou voz para interpretar.' } };
  }

  if (products.length === 0) {
    return {
      status: 200,
      body: {
        intent: 'nao_identificado',
        answer: 'Ainda não há produtos cadastrados no estoque desta empresa. Cadastre ou importe uma planilha primeiro.',
        preview: null,
        lowStockItems: [],
      },
    };
  }

  const catalogLines = products.slice(0, 250).map((p) => ({
    id: p.id,
    sku: p.sku,
    nome: p.nome,
    categoria: p.categoria,
    unidade: p.unidade,
    quantidade: p.quantidade,
    estoqueMinimo: p.estoqueMinimo,
    localizacao: p.localizacao || '',
  }));

  const prompt = [
    'Analise o comando de estoque abaixo (feito por texto ou transcrição de voz em Português do Brasil).',
    'Localize o produto correspondente EXCLUSIVAMENTE dentro do catálogo JSON fornecido (procure pelo nome, medida como 3/8 ou 1/4, SKU ou categoria).',
    'Classifique a intenção ("intent") em:',
    '- "movimentar": quando o usuário pede para retirar, baixar, usar, dar saída, adicionar, entrar, comprar ou devolver uma quantidade numérica de um produto.',
    '- "consultar_produto": quando o usuário pergunta quanto tem disponível, quantas unidades/metros/rolos/etc. existem de um produto específico.',
    '- "listar_abaixo_minimo": quando o usuário pergunta quais materiais estão abaixo do estoque mínimo, em falta ou precisando de reposição.',
    '- "nao_identificado": quando não for possível localizar o produto no catálogo ou o comando não for claro.',
    'Escolha o motivo mais adequado entre: "Compra", "Entrada de material", "Retirada para instalação", "Uso em manutenção", "Venda", "Devolução", "Ajuste de inventário", "Perda ou avaria".',
    'IMPORTANTE sobre "quantidade": extraia SEMPRE o número da quantidade solicitada na movimentação (ex.: em "Retire 20 porcas de 3/8", quantidade = 20 e NÃO 3/8; em "Adicione 50 metros de tubo de cobre de 1/4", quantidade = 50). Use 0 apenas quando intent não for "movimentar".',
    'NUNCA faça cálculos de saldo final por conta própria; apenas preencha os campos do schema JSON.',
    '',
    `COMANDO DO USUÁRIO: "${commandText}"`,
    '',
    `CATÁLOGO ATUAL DE PRODUTOS (${catalogLines.length} itens):`,
    JSON.stringify(catalogLines),
  ].join('\n');

  const responseSchema = {
    type: T.OBJECT,
    properties: {
      intent: {
        type: T.STRING,
        enum: ['movimentar', 'consultar_produto', 'listar_abaixo_minimo', 'nao_identificado'],
      },
      productId: { type: T.STRING },
      tipo: { type: T.STRING, enum: ['entrada', 'saida'] },
      motivo: {
        type: T.STRING,
        enum: [
          'Compra',
          'Entrada de material',
          'Retirada para instalação',
          'Uso em manutenção',
          'Venda',
          'Devolução',
          'Ajuste de inventário',
          'Perda ou avaria',
        ],
      },
      quantidade: { type: T.NUMBER },
      observacoes: { type: T.STRING },
      explanation: { type: T.STRING },
    },
    required: ['intent', 'productId', 'tipo', 'motivo', 'quantidade'],
  };

  const rawJson = (
    await generateJson({
      contents: prompt,
      systemInstruction:
        'Você é um interpretador preciso de comandos de almoxarifado HVAC-R em Português do Brasil. Retorne apenas JSON válido conforme o schema, extraindo corretamente a quantidade numérica da operação (diferenciando quantidade da medida/bitola do item).',
      responseSchema,
    })
  ).trim();

  const parsed = JSON.parse(rawJson || '{}') as {
    intent?: string;
    productId?: string;
    tipo?: 'entrada' | 'saida';
    motivo?: string;
    quantidade?: number;
    observacoes?: string;
    explanation?: string;
  };

  const matchedProduct = parsed.productId
    ? products.find((p) => p.id === parsed.productId || p.sku.toLowerCase() === parsed.productId?.toLowerCase())
    : undefined;

  if (parsed.intent === 'listar_abaixo_minimo') {
    const lowStockItems = products
      .filter((p) => Number(p.quantidade) <= Number(p.estoqueMinimo))
      .map((p) => ({
        id: p.id,
        sku: p.sku,
        nome: p.nome,
        unidade: p.unidade,
        quantidade: Number(p.quantidade) || 0,
        estoqueMinimo: Number(p.estoqueMinimo) || 0,
      }));

    return {
      status: 200,
      body: {
        intent: 'listar_abaixo_minimo',
        answer:
          lowStockItems.length === 0
            ? 'Nenhum material está abaixo ou igual ao estoque mínimo no momento.'
            : `Encontramos ${lowStockItems.length} ${lowStockItems.length === 1 ? 'material' : 'materiais'} abaixo ou no limite do estoque mínimo.`,
        preview: null,
        lowStockItems,
      },
    };
  }

  if (parsed.intent === 'consultar_produto' && matchedProduct) {
    const saldo = Number(matchedProduct.quantidade) || 0;
    const minimo = Number(matchedProduct.estoqueMinimo) || 0;
    const abaixo = saldo <= minimo;
    return {
      status: 200,
      body: {
        intent: 'consultar_produto',
        answer: `${matchedProduct.nome} (Código: ${matchedProduct.sku}) possui saldo atual de ${saldo} ${matchedProduct.unidade}. Estoque mínimo: ${minimo} ${matchedProduct.unidade}.${abaixo ? ' Atenção: item abaixo do estoque mínimo.' : ''}${matchedProduct.localizacao ? ` Localização: ${matchedProduct.localizacao}.` : ''}`,
        product: matchedProduct,
        preview: null,
        lowStockItems: [],
      },
    };
  }

  if (parsed.intent === 'movimentar' && matchedProduct) {
    const qty = round2(Number(parsed.quantidade || 0));
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        status: 200,
        body: {
          intent: 'nao_identificado',
          answer: `Produto "${matchedProduct.nome}" localizado, mas a quantidade informada não é válida (${parsed.quantidade ?? 0}).`,
          preview: null,
          lowStockItems: [],
        },
      };
    }

    const tipo: 'entrada' | 'saida' = parsed.tipo === 'entrada' ? 'entrada' : 'saida';
    const saldoAnterior = round2(Number(matchedProduct.quantidade) || 0);
    const saldoPosterior = tipo === 'entrada' ? round2(saldoAnterior + qty) : round2(saldoAnterior - qty);
    const estoqueInsuficiente = saldoPosterior < 0;
    const motivo = parsed.motivo || (tipo === 'entrada' ? 'Entrada de material' : 'Retirada para instalação');

    return {
      status: 200,
      body: {
        intent: 'movimentar',
        answer: estoqueInsuficiente
          ? `Operação bloqueada: saldo insuficiente para ${matchedProduct.nome}. Disponível: ${saldoAnterior} ${matchedProduct.unidade}; solicitado: ${qty} ${matchedProduct.unidade}.`
          : `Prévia gerada para ${matchedProduct.nome}. Confirme abaixo para efetivar a movimentação no Firebase.`,
        preview: {
          productId: matchedProduct.id,
          productSku: matchedProduct.sku,
          productName: matchedProduct.nome,
          unidade: matchedProduct.unidade,
          tipo,
          motivo,
          quantidade: qty,
          saldoAnterior,
          saldoPosterior,
          estoqueInsuficiente,
          observacoes: (parsed.observacoes || commandText).slice(0, 280),
        },
        lowStockItems: [],
      },
    };
  }

  return {
    status: 200,
    body: {
      intent: 'nao_identificado',
      answer:
        parsed.explanation ||
        'Não foi possível identificar um produto correspondente no catálogo atual. Verifique o nome ou código do item e tente novamente.',
      preview: null,
      lowStockItems: [],
    },
  };
}

export async function executeParsePdfStatement(
  body: { fileName?: string; pdfBase64?: string },
  T: SchemaTokens,
  generateJson: AiGenerateJsonFn
): Promise<HttpCoreResult> {
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim().slice(0, 180) : 'extrato.pdf';
  const base64 = sanitizeBase64Pdf(body?.pdfBase64);
  if (!base64) {
    return {
      status: 400,
      body: { error: 'Arquivo PDF inválido ou acima do limite suportado (máx. 10 MB).' },
    };
  }

  const prompt = [
    `Analise o documento PDF "${fileName}".`,
    'Objetivo: extrair EXCLUSIVAMENTE movimentações financeiras reais de um extrato bancário.',
    'Regras obrigatórias:',
    '1. Se o PDF não for um extrato bancário, estiver ilegível (imagem sem OCR legível), protegido ou sem lançamentos, defina extractable = false e explique objetivamente em reasonIfNotExtractable. NÃO invente ou simule transações.',
    '2. Para cada transação legível no extrato, extraia:',
    '   - dataMovimento no formato YYYY-MM-DD',
    '   - descricao completa do histórico/lançamento',
    '   - nomePagador (se houver nome de pessoa ou empresa pagadora/favorecida identificado na linha, senão string vazia)',
    '   - cpfCnpjPagador (CPF ou CNPJ se constar explicitamente na linha, senão string vazia)',
    '   - valor numérico positivo (ex.: 1500.50)',
    '   - tipo: "credito" para entradas/recebimentos/PIX recebido/TED recebida/depósitos, ou "debito" para saídas/pagamentos/tarifas',
    '   - fitId: identificador único bancário se constar na linha, ou string vazia',
    '   - documentoBancario: número do documento / NSU / código da operação se constar, senão string vazia',
    '3. Extraia também o nome do banco e número da conta se constarem no cabeçalho.',
  ].join('\n');

  const responseSchema = {
    type: T.OBJECT,
    properties: {
      extractable: { type: T.BOOLEAN },
      reasonIfNotExtractable: { type: T.STRING },
      banco: { type: T.STRING },
      conta: { type: T.STRING },
      transactions: {
        type: T.ARRAY,
        items: {
          type: T.OBJECT,
          properties: {
            dataMovimento: { type: T.STRING },
            descricao: { type: T.STRING },
            nomePagador: { type: T.STRING },
            cpfCnpjPagador: { type: T.STRING },
            valor: { type: T.NUMBER },
            tipo: { type: T.STRING, enum: ['credito', 'debito'] },
            fitId: { type: T.STRING },
            documentoBancario: { type: T.STRING },
          },
          required: ['dataMovimento', 'descricao', 'valor', 'tipo'],
        },
      },
    },
    required: ['extractable', 'reasonIfNotExtractable', 'banco', 'conta', 'transactions'],
  };

  const rawJson = (
    await generateJson({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: base64 } },
            { text: prompt },
          ],
        },
      ],
      systemInstruction:
        'Você é um extrator contábil rigoroso. Retorne apenas dados explicitamente presentes no PDF em JSON conforme o schema. Jamais invente lançamentos.',
      responseSchema,
    })
  ).trim();

  const parsed = JSON.parse(rawJson || '{}') as {
    extractable?: boolean;
    reasonIfNotExtractable?: string;
    banco?: string;
    conta?: string;
    transactions?: Array<{
      dataMovimento?: string;
      descricao?: string;
      nomePagador?: string;
      cpfCnpjPagador?: string;
      valor?: number;
      tipo?: 'credito' | 'debito';
      fitId?: string;
      documentoBancario?: string;
    }>;
  };

  if (!parsed.extractable) {
    return {
      status: 422,
      body: {
        error:
          parsed.reasonIfNotExtractable ||
          'Não foi possível extrair transações válidas deste PDF. Utilize OFX, CSV ou Excel exportado diretamente do banco.',
      },
    };
  }

  const cleanTxs = (parsed.transactions ?? [])
    .map((tx, index) => {
      const dataMovimento = normalizeServerIsoDate(tx.dataMovimento);
      const valor = round2(Math.abs(Number(tx.valor || 0)));
      const descricao = (tx.descricao || '').trim();
      if (!dataMovimento || !Number.isFinite(valor) || valor <= 0 || !descricao) {
        return null;
      }
      return {
        banco: (parsed.banco || 'Extrato PDF').trim().slice(0, 100),
        conta: (parsed.conta || '').trim().slice(0, 50),
        fitId: (tx.fitId || `pdf-${index + 1}-${dataMovimento}-${valor}`).trim().slice(0, 120),
        documentoBancario: (tx.documentoBancario || '').trim().slice(0, 80),
        nomePagador: (tx.nomePagador || '').trim().slice(0, 160),
        cpfCnpjPagador: (tx.cpfCnpjPagador || '').trim().slice(0, 24),
        tipo: tx.tipo === 'debito' ? ('debito' as const) : ('credito' as const),
        descricao: descricao.slice(0, 220),
        valor,
        dataMovimento,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (cleanTxs.length === 0) {
    return {
      status: 422,
      body: { error: 'Nenhuma movimentação financeira válida com data e valor foi localizada no PDF enviado.' },
    };
  }

  return {
    status: 200,
    body: {
      extractable: true,
      banco: (parsed.banco || 'Extrato PDF').trim(),
      conta: (parsed.conta || '').trim(),
      transactions: cleanTxs,
    },
  };
}

export async function executeParsePdfInvoice(
  body: { fileName?: string; pdfBase64?: string },
  T: SchemaTokens,
  generateJson: AiGenerateJsonFn
): Promise<HttpCoreResult> {
  const fileName = typeof body?.fileName === 'string' ? body.fileName.trim().slice(0, 180) : 'nota-fiscal.pdf';
  const base64 = sanitizeBase64Pdf(body?.pdfBase64);
  if (!base64) {
    return {
      status: 400,
      body: { error: 'Arquivo PDF inválido ou acima do limite suportado (máx. 10 MB).' },
    };
  }

  const prompt = [
    `Analise o documento PDF "${fileName}" referente a uma Nota Fiscal (DANFE de NF-e, NFS-e ou NFC-e).`,
    'Regras obrigatórias:',
    '1. Verifique se é uma Nota Fiscal de SAÍDA (venda/prestação de serviço emitida para um cliente). Se o documento indicar explicitamente "0 - ENTRADA" (NF de compra/entrada), defina isOutbound = false.',
    '2. Se o PDF não for uma nota fiscal ou não estiver legível, defina extractable = false e explique em reasonIfNotExtractable. NÃO invente campos.',
    '3. Extraia: numero, serie (padrão "1"), chaveAcesso (44 dígitos ou código de verificação se houver), tipo ("NF-e", "NFS-e" ou "NFC-e"), dataEmissao (YYYY-MM-DD), dataVencimento (YYYY-MM-DD se constar fatura/duplicata/vencimento, senão ""), clienteNome (destinatário/tomador), clienteDocumento (CPF ou CNPJ do cliente/tomador), valor (valor total numérico), itensResumo (resumo dos itens/equipamentos/serviços e informações complementares).',
  ].join('\n');

  const responseSchema = {
    type: T.OBJECT,
    properties: {
      extractable: { type: T.BOOLEAN },
      isOutbound: { type: T.BOOLEAN },
      reasonIfNotExtractable: { type: T.STRING },
      numero: { type: T.STRING },
      serie: { type: T.STRING },
      chaveAcesso: { type: T.STRING },
      tipo: { type: T.STRING, enum: ['NF-e', 'NFS-e', 'NFC-e'] },
      dataEmissao: { type: T.STRING },
      dataVencimento: { type: T.STRING },
      clienteNome: { type: T.STRING },
      clienteDocumento: { type: T.STRING },
      valor: { type: T.NUMBER },
      itensResumo: { type: T.STRING },
    },
    required: [
      'extractable',
      'isOutbound',
      'reasonIfNotExtractable',
      'numero',
      'serie',
      'tipo',
      'dataEmissao',
      'clienteNome',
      'valor',
    ],
  };

  const rawJson = (
    await generateJson({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: base64 } },
            { text: prompt },
          ],
        },
      ],
      systemInstruction:
        'Você é um extrator fiscal brasileiro rigoroso. Leia apenas o que consta explicitamente no PDF. Nunca fabrique dados.',
      responseSchema,
    })
  ).trim();

  const parsed = JSON.parse(rawJson || '{}') as {
    extractable?: boolean;
    isOutbound?: boolean;
    reasonIfNotExtractable?: string;
    numero?: string;
    serie?: string;
    chaveAcesso?: string;
    tipo?: 'NF-e' | 'NFS-e' | 'NFC-e';
    dataEmissao?: string;
    dataVencimento?: string;
    clienteNome?: string;
    clienteDocumento?: string;
    valor?: number;
    itensResumo?: string;
  };

  if (!parsed.extractable) {
    return {
      status: 422,
      body: {
        error:
          parsed.reasonIfNotExtractable ||
          'Não foi possível extrair os dados desta nota fiscal em PDF. Utilize o XML oficial ou planilha.',
      },
    };
  }

  if (parsed.isOutbound === false) {
    return {
      status: 422,
      body: {
        error:
          'Documento identificado como Nota Fiscal de ENTRADA (compra). Nesta etapa o sistema trabalha exclusivamente com Notas Fiscais de SAÍDA.',
      },
    };
  }

  const dataEmissao = normalizeServerIsoDate(parsed.dataEmissao);
  const dataVencimento = normalizeServerIsoDate(parsed.dataVencimento);
  const valor = round2(Number(parsed.valor || 0));
  const numero = (parsed.numero || '').trim();
  const clienteNome = (parsed.clienteNome || '').trim();

  if (!numero || !dataEmissao || !clienteNome || !Number.isFinite(valor) || valor <= 0) {
    return {
      status: 422,
      body: {
        error:
          'PDF lido, mas campos obrigatórios da nota de saída (número, emissão, cliente ou valor total) não foram localizados com segurança.',
      },
    };
  }

  return {
    status: 200,
    body: {
      extractable: true,
      invoice: {
        numero: numero.slice(0, 40),
        serie: (parsed.serie || '1').trim().slice(0, 10),
        chaveAcesso: (parsed.chaveAcesso || '').replace(/\s+/g, '').slice(0, 60),
        tipo: parsed.tipo === 'NFS-e' || parsed.tipo === 'NFC-e' ? parsed.tipo : 'NF-e',
        dataEmissao,
        dataVencimento,
        clienteNome: clienteNome.slice(0, 160),
        clienteDocumento: (parsed.clienteDocumento || '').trim().slice(0, 24),
        valor,
        itensResumo: (parsed.itensResumo || '').trim().slice(0, 600),
      },
    },
  };
}

export interface ReconciliationBankInput {
  id: string;
  banco: string;
  dataMovimento: string;
  valor: number;
  valorDisponivel: number;
  descricao: string;
  nomePagador?: string;
  cpfCnpjPagador?: string;
  documentoBancario?: string;
  fitId?: string;
}

export interface ReconciliationInvoiceInput {
  id: string;
  numero: string;
  serie: string;
  tipo: string;
  dataEmissao: string;
  dataVencimento?: string;
  clienteNome: string;
  clienteDocumento?: string;
  valor: number;
  valorRecebido: number;
  valorEmAberto: number;
  itensResumo?: string;
}

export interface ReconciliationSuggestRequestBody {
  bankCredits?: ReconciliationBankInput[];
  openInvoices?: ReconciliationInvoiceInput[];
  rejectedPairs?: Array<{ bankTransactionId: string; invoiceId: string }>;
  toleranceDays?: number;
}

export async function executeReconciliationSuggest(
  body: ReconciliationSuggestRequestBody,
  T: SchemaTokens,
  generateJson: AiGenerateJsonFn
): Promise<HttpCoreResult> {
  const bankCredits = Array.isArray(body?.bankCredits) ? body.bankCredits.slice(0, 60) : [];
  const openInvoices = Array.isArray(body?.openInvoices) ? body.openInvoices.slice(0, 120) : [];
  const rejectedPairs = Array.isArray(body?.rejectedPairs) ? body.rejectedPairs : [];
  const toleranceDays = Number.isFinite(Number(body?.toleranceDays))
    ? Math.max(1, Math.min(90, Number(body.toleranceDays)))
    : 5;

  if (bankCredits.length === 0 || openInvoices.length === 0) {
    return {
      status: 400,
      body: {
        error: 'É necessário possuir créditos bancários pendentes e notas fiscais de saída em aberto para análise.',
      },
    };
  }

  const rejectedSet = new Set(rejectedPairs.map((p) => `${String(p.bankTransactionId)}::${String(p.invoiceId)}`));
  const bankMap = new Map(bankCredits.map((b) => [b.id, b]));
  const invoiceMap = new Map(openInvoices.map((inv) => [inv.id, inv]));

  const prompt = [
    'Você é um especialista contábil em conciliação bancária e fiscal no Brasil (empresa de ar-condicionado e refrigeração).',
    'Analise os créditos bancários em aberto e as notas fiscais de saída em aberto abaixo para sugerir possíveis correspondências.',
    '',
    'REGRAS INVIOLÁVEIS:',
    '1. NUNCA sugira correspondência baseando-se APENAS no valor monetário. Avalie em conjunto: CPF/CNPJ do pagador vs cliente, nome do pagador vs nome do cliente, número da NF ou documento citado no histórico bancário/FITID, proximidade de datas (tolerância configurada: ' +
      toleranceDays +
      ' dias) e itens/serviços da NF.',
    '2. NÃO repita pares já rejeitados manualmente pelo usuário (lista rejectedPairs abaixo).',
    '3. Identifique também cenários complexos:',
    '   - "unica": 1 recebimento corresponde a 1 nota fiscal;',
    '   - "parcela": recebimento cobre parte de 1 nota fiscal (parcela ou pagamento parcial);',
    '   - "agrupado": 1 recebimento único paga a soma de 2 ou mais notas fiscais do mesmo cliente (liste todos os invoiceIds no array);',
    '   - "revisao_incerta": há indícios parciais (ex.: nome semelhante sem CPF/CNPJ confirmado ou diferença de valor/data relevante) que exigem revisão humana.',
    '4. Se não houver nenhuma evidência razoável além de valor isolado, NÃO invente sugestão.',
    '5. Nunca confirme nada automaticamente — toda sugestão será revisada por um humano.',
    '6. Use EXCLUSIVAMENTE os IDs exatos presentes nos JSONs enviados.',
    '',
    `CRÉDITOS BANCÁRIOS (${bankCredits.length}):`,
    JSON.stringify(bankCredits),
    '',
    `NOTAS FISCAIS DE SAÍDA (${openInvoices.length}):`,
    JSON.stringify(openInvoices),
    '',
    `PARES REJEITADOS PELO USUÁRIO (${rejectedPairs.length}):`,
    JSON.stringify(rejectedPairs),
  ].join('\n');

  const responseSchema = {
    type: T.OBJECT,
    properties: {
      suggestions: {
        type: T.ARRAY,
        items: {
          type: T.OBJECT,
          properties: {
            bankTransactionId: { type: T.STRING },
            invoiceIds: {
              type: T.ARRAY,
              items: { type: T.STRING },
            },
            matchType: {
              type: T.STRING,
              enum: ['unica', 'parcela', 'agrupado', 'revisao_incerta'],
            },
            confidenceLevel: {
              type: T.STRING,
              enum: ['alta', 'media', 'baixa'],
            },
            confidenceScore: { type: T.NUMBER },
            justification: { type: T.STRING },
          },
          required: [
            'bankTransactionId',
            'invoiceIds',
            'matchType',
            'confidenceLevel',
            'confidenceScore',
            'justification',
          ],
        },
      },
    },
    required: ['suggestions'],
  };

  const rawJson = (
    await generateJson({
      contents: prompt,
      systemInstruction:
        'Retorne apenas JSON válido conforme o schema. Use Português do Brasil claro nas justificativas, citando objetivamente quais critérios coincidiram e quais divergiram.',
      responseSchema,
    })
  ).trim();

  const parsed = JSON.parse(rawJson || '{}') as {
    suggestions?: Array<{
      bankTransactionId?: string;
      invoiceIds?: string[];
      matchType?: 'unica' | 'parcela' | 'agrupado' | 'revisao_incerta';
      confidenceLevel?: 'alta' | 'media' | 'baixa';
      confidenceScore?: number;
      justification?: string;
    }>;
  };

  const validSuggestions = (parsed.suggestions ?? [])
    .map((s) => {
      const bankTx = s.bankTransactionId ? bankMap.get(s.bankTransactionId) : undefined;
      if (!bankTx) return null;

      const uniqueInvIds = Array.from(new Set((s.invoiceIds ?? []).filter(Boolean)));
      const matchedInvoices = uniqueInvIds
        .map((id) => invoiceMap.get(id))
        .filter((inv): inv is ReconciliationInvoiceInput => Boolean(inv))
        .filter((inv) => !rejectedSet.has(`${bankTx.id}::${inv.id}`));

      if (matchedInvoices.length === 0) return null;

      const invoiceTotal = round2(
        matchedInvoices.reduce((acc, inv) => acc + (inv.valorEmAberto > 0 ? inv.valorEmAberto : inv.valor), 0)
      );
      const receivedAmount = round2(bankTx.valorDisponivel > 0 ? bankTx.valorDisponivel : bankTx.valor);
      const differenceAmount = round2(receivedAmount - invoiceTotal);

      const confidenceLevel: 'alta' | 'media' | 'baixa' =
        s.confidenceLevel === 'alta' || s.confidenceLevel === 'media' ? s.confidenceLevel : 'baixa';
      let rawScore = Number(s.confidenceScore || 0);
      if (rawScore > 0 && rawScore <= 1) rawScore *= 100;
      else if (rawScore > 1 && rawScore <= 5) rawScore *= 20;
      else if (rawScore > 5 && rawScore <= 10) rawScore *= 10;
      if (!Number.isFinite(rawScore) || rawScore <= 0) {
        rawScore = confidenceLevel === 'alta' ? 88 : confidenceLevel === 'media' ? 62 : 35;
      }
      const confidenceScore = Math.max(5, Math.min(99, Math.round(rawScore)));

      return {
        bankTransactionId: bankTx.id,
        invoiceIds: matchedInvoices.map((i) => i.id),
        matchType:
          matchedInvoices.length > 1
            ? ('agrupado' as const)
            : s.matchType === 'parcela' || s.matchType === 'revisao_incerta'
              ? s.matchType
              : ('unica' as const),
        confidenceLevel,
        confidenceScore,
        invoiceTotal,
        receivedAmount,
        differenceAmount,
        justification: String(s.justification || 'Análise multicritério sugerida para revisão humana.').slice(0, 380),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    status: 200,
    body: {
      suggestions: validSuggestions,
      analyzedCredits: bankCredits.length,
      analyzedInvoices: openInvoices.length,
      model: 'gemini-4-hydrogen',
    },
  };
}
