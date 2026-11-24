import React, { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Send,
  X,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type InventoryProduct,
  type StockMovementReason,
} from '../../types/erp';
import { recordStockMovement } from '../../services/erpService';
import { formatNumberBR, todayISO } from '../../utils/formatters';
import { authorizedJsonFetch } from '../../lib/apiClient';

interface StockAiAssistantPanelProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  products: InventoryProduct[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

interface AiPreviewOperation {
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
  observacoes: string;
}

interface LowStockSummaryItem {
  id: string;
  sku: string;
  nome: string;
  unidade: string;
  quantidade: number;
  estoqueMinimo: number;
}

interface AiCommandApiResponse {
  intent: 'movimentar' | 'consultar_produto' | 'listar_abaixo_minimo' | 'nao_identificado';
  answer: string;
  preview: AiPreviewOperation | null;
  lowStockItems: LowStockSummaryItem[];
  error?: string;
}

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

const EXAMPLE_COMMANDS = [
  'Retire 20 porcas de 3/8 do estoque',
  'Adicione 50 metros de tubo de cobre de 1/4',
  'Retire 3 rolos de fita isolante',
  'Quantas unidades de capacitor de 35 microfarads temos?',
  'Quais materiais estão abaixo do estoque mínimo?',
  'Quanto de tubo de cobre temos disponível?',
];

export const StockAiAssistantPanel: React.FC<StockAiAssistantPanelProps> = ({
  user,
  companyId,
  canEdit,
  products,
  onNotify,
}) => {
  const [commandText, setCommandText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const [result, setResult] = useState<AiCommandApiResponse | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [committedKey, setCommittedKey] = useState('');
  const [committing, setCommitting] = useState(false);
  const [responsavel, setResponsavel] = useState(user.displayName || user.email || '');
  const [documentoReferencia, setDocumentoReferencia] = useState('');

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
        'Seu navegador não suporta reconhecimento de voz nativo. Digite o comando no campo ao lado.'
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
          setCommandText(transcript);
          void analyzeCommand(transcript);
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

  const analyzeCommand = async (rawText?: string) => {
    const text = (rawText ?? commandText).trim();
    if (!text || analyzing) return;

    setAnalyzing(true);
    setResult(null);
    setCommittedKey('');
    try {
      const resp = await authorizedJsonFetch('/api/ai/inventory-command', {
        commandText: text,
        products: products.map((p) => ({
          id: p.id,
          sku: p.sku,
          nome: p.nome,
          categoria: p.categoria,
          unidade: p.unidade,
          quantidade: p.quantidade,
          estoqueMinimo: p.estoqueMinimo,
          localizacao: p.localizacao ?? '',
        })),
      });

      const data = (await resp.json()) as AiCommandApiResponse;
      if (!resp.ok) {
        throw new Error(data.error || 'Falha ao consultar assistente de estoque.');
      }

      setResult(data);
      if (data.preview) {
        setPreviewKey(`ai_${data.preview.productId}_${Date.now().toString(36)}`);
      }
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Erro ao interpretar comando de estoque.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleConfirmOperation = async () => {
    if (!result?.preview || !canEdit || committing) return;
    if (result.preview.estoqueInsuficiente) {
      onNotify('error', 'Operação bloqueada: não é permitido deixar o estoque negativo.');
      return;
    }
    if (committedKey === previewKey) {
      onNotify('info', 'Esta movimentação já foi efetivada.');
      return;
    }
    if (!responsavel.trim()) {
      onNotify('error', 'Informe o nome do responsável antes de efetivar.');
      return;
    }

    setCommitting(true);
    try {
      await recordStockMovement(user, companyId, {
        productId: result.preview.productId,
        tipo: result.preview.tipo,
        motivo: result.preview.motivo,
        quantidade: result.preview.quantidade,
        responsavel: responsavel.trim(),
        documentoReferencia: documentoReferencia.trim(),
        dataMovimentacao: todayISO(),
        observacoes: result.preview.observacoes,
        idempotencyKey: previewKey,
      });

      setCommittedKey(previewKey);
      onNotify(
        'success',
        `Movimentação confirmada: ${result.preview.productName} (${result.preview.tipo === 'entrada' ? '+' : '-'}${result.preview.quantidade} ${result.preview.unidade}).`
      );
    } catch (err: unknown) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Erro ao confirmar movimentação de estoque.'
      );
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-[#0B1F3A] text-white flex items-center justify-center shrink-0">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Assistente de Estoque por Texto e Voz
            </h3>
            <p className="text-xs text-slate-500">
              A IA interpreta o comando e localiza o produto; o servidor calcula os saldos e solicita confirmação antes de gravar.
            </p>
          </div>
        </div>
        {!canEdit && (
          <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg self-start">
            Consultas liberadas (movimentação requer perfil Estoque/Admin)
          </span>
        )}
      </div>

      {/* Formulário de comando */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void analyzeCommand();
        }}
        className="flex flex-col sm:flex-row gap-2.5"
      >
        <div className="flex-1 flex items-center gap-2">
          <input
            type="text"
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            placeholder='Ex.: "Retire 20 porcas de 3/8 do estoque" ou "Quais materiais estão abaixo do estoque mínimo?"'
            className="flex-1 px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <button
            type="button"
            onClick={toggleVoice}
            title={speechSupported ? 'Comando por voz (pt-BR)' : 'Voz não suportada neste navegador'}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium rounded-lg border cursor-pointer transition-colors shrink-0 ${
              listening
                ? 'bg-red-600 text-white border-red-600 animate-pulse'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span className="hidden md:inline">{listening ? 'Ouvindo...' : 'Voz'}</span>
          </button>
        </div>

        <button
          type="submit"
          disabled={analyzing || !commandText.trim()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg disabled:opacity-50 cursor-pointer shrink-0"
        >
          {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {analyzing ? 'Interpretando...' : 'Interpretar Comando'}
        </button>
      </form>

      {/* Sugestões rápidas */}
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLE_COMMANDS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setCommandText(example);
              void analyzeCommand(example);
            }}
            className="text-[11px] text-slate-700 bg-slate-100 hover:bg-blue-50 hover:text-blue-800 border border-slate-200 rounded-md px-2.5 py-1 transition-colors cursor-pointer"
          >
            {example}
          </button>
        ))}
      </div>

      {/* Resultado da Interpretação */}
      {result && (
        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-slate-800 leading-relaxed">{result.answer}</p>
            <button
              type="button"
              onClick={() => setResult(null)}
              aria-label="Fechar prévia"
              className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Card de Prévia de Movimentação */}
          {result.intent === 'movimentar' && result.preview && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div className="col-span-2 sm:col-span-2">
                  <span className="text-slate-500 block">Produto</span>
                  <strong className="text-slate-900">{result.preview.productName}</strong>
                  <span className="block font-mono text-[11px] text-slate-500">
                    SKU: {result.preview.productSku}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">Operação</span>
                  <strong
                    className={
                      result.preview.tipo === 'entrada' ? 'text-emerald-700' : 'text-blue-700'
                    }
                  >
                    {result.preview.tipo === 'entrada' ? 'Entrada (+)' : 'Saída (-)'}
                  </strong>
                  <span className="block text-[11px] text-slate-500">{result.preview.motivo}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Quantidade</span>
                  <strong className="font-mono text-slate-900">
                    {formatNumberBR(result.preview.quantidade, 2)} {result.preview.unidade}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500 block">Saldo Anterior → Posterior</span>
                  <div className="font-mono">
                    <span className="text-slate-600">
                      {formatNumberBR(result.preview.saldoAnterior, 2)}
                    </span>
                    {' → '}
                    <strong
                      className={
                        result.preview.estoqueInsuficiente ? 'text-red-700' : 'text-emerald-700'
                      }
                    >
                      {formatNumberBR(result.preview.saldoPosterior, 2)} {result.preview.unidade}
                    </strong>
                  </div>
                </div>
              </div>

              {result.preview.estoqueInsuficiente ? (
                <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg p-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>
                    Estoque negativo bloqueado. Ajuste a quantidade solicitada ou registre uma entrada antes de retirar.
                  </span>
                </div>
              ) : committedKey === previewKey ? (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg p-3 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-700" />
                  <span>
                    Movimentação efetivada com sucesso em transação atômica e sincronizada em tempo real.
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-2 border-t border-slate-100">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Responsável / Técnico *
                    </label>
                    <input
                      type="text"
                      maxLength={FIELD_LIMITS.responsavel}
                      value={responsavel}
                      onChange={(e) => setResponsavel(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      OS / NF de Referência (opcional)
                    </label>
                    <input
                      type="text"
                      maxLength={FIELD_LIMITS.documentoReferencia}
                      value={documentoReferencia}
                      onChange={(e) => setDocumentoReferencia(e.target.value)}
                      placeholder="Ex.: OS-215"
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setResult(null)}
                      className="px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                    >
                      Descartar
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit || committing}
                      onClick={() => void handleConfirmOperation()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 cursor-pointer"
                    >
                      {committing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {committing ? 'Efetivando...' : 'Confirmar Operação'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Lista de Itens Abaixo do Mínimo */}
          {result.intent === 'listar_abaixo_minimo' && result.lowStockItems.length > 0 && (
            <div className="bg-white border border-amber-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-amber-50/70 text-amber-950 border-b border-amber-200">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Código</th>
                    <th className="text-left font-medium px-3 py-2">Produto</th>
                    <th className="text-right font-medium px-3 py-2">Saldo Atual</th>
                    <th className="text-right font-medium px-3 py-2">Estoque Mínimo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.lowStockItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2 font-mono text-slate-600">{item.sku}</td>
                      <td className="px-3 py-2 font-medium text-slate-900">{item.nome}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-red-700">
                        {formatNumberBR(item.quantidade, 2)} {item.unidade}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {formatNumberBR(item.estoqueMinimo, 2)} {item.unidade}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
