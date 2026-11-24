import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Layers, Split } from 'lucide-react';
import type { BankTransaction, Invoice } from '../../types/erp';
import { formatBRL, formatDateBR } from '../../utils/formatters';
import { getBankTxAvailableAmount, getInvoiceOpenAmount } from '../../utils/reconciliationEngine';
import { Modal } from '../ui/CommonUI';

interface SplitCreditModalProps {
  open: boolean;
  bankTx: BankTransaction | null;
  invoices: Invoice[];
  saving: boolean;
  onClose: () => void;
  onConfirm: (
    allocations: Array<{ invoice: Invoice; allocatedAmount: number }>,
    createFinancialReceipt: boolean,
    justificativa: string
  ) => Promise<void>;
}

export const SplitCreditAcrossInvoicesModal: React.FC<SplitCreditModalProps> = ({
  open,
  bankTx,
  invoices,
  saving,
  onClose,
  onConfirm,
}) => {
  const [allocMap, setAllocMap] = useState<Record<string, string>>({});
  const [createFinReceipt, setCreateFinReceipt] = useState(true);
  const [justificativa, setJustificativa] = useState('');
  const [searchInv, setSearchInv] = useState('');

  const available = bankTx ? getBankTxAvailableAmount(bankTx) || bankTx.valor : 0;

  useEffect(() => {
    if (open) {
      setAllocMap({});
      setCreateFinReceipt(true);
      setJustificativa('');
      setSearchInv('');
    }
  }, [open, bankTx?.id]);

  const openInvoices = useMemo(() => {
    const q = searchInv.trim().toLowerCase();
    return invoices
      .filter((inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida')
      .filter((inv) => {
        if (!q) return true;
        return `${inv.numero} ${inv.clienteNome} ${inv.clienteDocumento ?? ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => a.dataEmissao.localeCompare(b.dataEmissao));
  }, [invoices, searchInv]);

  const parsedAllocations = useMemo(() => {
    const list: Array<{ invoice: Invoice; allocatedAmount: number }> = [];
    for (const inv of invoices) {
      const raw = Number(allocMap[inv.id] || 0);
      if (Number.isFinite(raw) && raw > 0) {
        list.push({ invoice: inv, allocatedAmount: Math.round(raw * 100) / 100 });
      }
    }
    return list;
  }, [allocMap, invoices]);

  const totalAllocated = Math.round(parsedAllocations.reduce((s, a) => s + a.allocatedAmount, 0) * 100) / 100;
  const remainingCredit = Math.round((available - totalAllocated) * 100) / 100;
  const exceedsCredit = totalAllocated > available + 0.01;

  const autoFillInvoice = (inv: Invoice) => {
    const invOpen = getInvoiceOpenAmount(inv) || inv.valor;
    const currentThis = Number(allocMap[inv.id] || 0);
    const availForThis = Math.max(0, Math.round((remainingCredit + currentThis) * 100) / 100);
    const fill = Math.min(invOpen, availForThis);
    if (fill > 0) {
      setAllocMap((prev) => ({ ...prev, [inv.id]: fill.toFixed(2) }));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dividir Recebimento entre Notas Fiscais"
      subtitle={
        bankTx
          ? `${formatDateBR(bankTx.dataMovimento)} · ${bankTx.descricao} · Disponível: ${formatBRL(available)}`
          : undefined
      }
      maxWidth="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
          <div>
            <span className="text-slate-500 block">Crédito disponível</span>
            <span className="font-mono tabular-nums font-semibold text-slate-900 text-sm">
              {formatBRL(available)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Total distribuído ({parsedAllocations.length} NFs)</span>
            <span
              className={`font-mono tabular-nums font-semibold text-sm ${
                exceedsCredit ? 'text-red-700' : 'text-blue-700'
              }`}
            >
              {formatBRL(totalAllocated)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Saldo restante do crédito</span>
            <span
              className={`font-mono tabular-nums font-semibold text-sm ${
                remainingCredit < -0.01 ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {formatBRL(remainingCredit)}
            </span>
          </div>
        </div>

        <input
          type="text"
          value={searchInv}
          onChange={(e) => setSearchInv(e.target.value)}
          placeholder="Filtrar notas fiscais por número, cliente ou CPF/CNPJ..."
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
        />

        {openInvoices.length === 0 ? (
          <p className="text-sm text-slate-500 py-4 text-center">
            Nenhuma nota fiscal de saída em aberto encontrada para alocação.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {openInvoices.map((inv) => {
              const invOpen = getInvoiceOpenAmount(inv) || inv.valor;
              const currentVal = allocMap[inv.id] ?? '';
              return (
                <div key={inv.id} className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">
                      {inv.tipo} {inv.numero} — {inv.clienteNome}
                    </p>
                    <p className="text-xs text-slate-500 font-mono tabular-nums">
                      Emissão {formatDateBR(inv.dataEmissao)} · Total {formatBRL(inv.valor)} · Em aberto {formatBRL(invOpen)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => autoFillInvoice(inv)}
                      className="px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer"
                    >
                      Usar aberto
                    </button>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={currentVal}
                      onChange={(e) => setAllocMap((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                      className="w-28 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg font-mono tabular-nums text-right"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Justificativa / Observação da divisão (opcional)
          </label>
          <input
            type="text"
            maxLength={300}
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Ex.: Pagamento único referente às notas de instalação + equipamento"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={createFinReceipt}
            onChange={(e) => setCreateFinReceipt(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Gerar também lançamentos de recebimento liquidado no módulo Financeiro para cada nota alocada.
          </span>
        </label>

        <div className="flex justify-end gap-3 pt-3 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || parsedAllocations.length === 0 || exceedsCredit}
            onClick={() => void onConfirm(parsedAllocations, createFinReceipt, justificativa)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
          >
            <Split className="w-4 h-4" />
            {saving ? 'Salvando divisão...' : `Confirmar Divisão (${parsedAllocations.length} NFs)`}
          </button>
        </div>
      </div>
    </Modal>
  );
};

interface GroupCreditsModalProps {
  open: boolean;
  bankCredits: BankTransaction[];
  invoices: Invoice[];
  preselectedCreditIds?: string[];
  preselectedInvoiceId?: string;
  saving: boolean;
  onClose: () => void;
  onConfirm: (
    selectedTxs: BankTransaction[],
    invoice: Invoice,
    createFinancialReceipt: boolean,
    justificativa: string
  ) => Promise<void>;
}

export const GroupCreditsToInvoiceModal: React.FC<GroupCreditsModalProps> = ({
  open,
  bankCredits,
  invoices,
  preselectedCreditIds = [],
  preselectedInvoiceId = '',
  saving,
  onClose,
  onConfirm,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [createFinReceipt, setCreateFinReceipt] = useState(true);
  const [justificativa, setJustificativa] = useState('');

  useEffect(() => {
    if (open) {
      setSelectedIds(preselectedCreditIds);
      setInvoiceId(preselectedInvoiceId);
      setCreateFinReceipt(true);
      setJustificativa('');
    }
  }, [open, preselectedCreditIds, preselectedInvoiceId]);

  const availableCredits = useMemo(
    () =>
      bankCredits.filter(
        (tx) => tx.tipo === 'credito' && (getBankTxAvailableAmount(tx) > 0.01 || tx.statusConciliacao !== 'conciliado_nf')
      ),
    [bankCredits]
  );

  const openInvoices = useMemo(
    () =>
      invoices
        .filter((inv) => inv.statusRecebimento !== 'cancelada' && inv.statusRecebimento !== 'recebida')
        .sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao)),
    [invoices]
  );

  const selectedTxs = useMemo(
    () => availableCredits.filter((tx) => selectedIds.includes(tx.id)),
    [availableCredits, selectedIds]
  );

  const selectedInvoice = useMemo(
    () => openInvoices.find((inv) => inv.id === invoiceId) ?? null,
    [openInvoices, invoiceId]
  );

  const totalSelectedAmount = Math.round(
    selectedTxs.reduce((s, tx) => s + (getBankTxAvailableAmount(tx) || tx.valor), 0) * 100
  ) / 100;
  const invOpenAmount = selectedInvoice ? getInvoiceOpenAmount(selectedInvoice) || selectedInvoice.valor : 0;
  const difference = selectedInvoice ? Math.round((totalSelectedAmount - invOpenAmount) * 100) / 100 : 0;

  const toggleId = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Relacionar Vários Recebimentos a uma Mesma Nota Fiscal"
      subtitle="Utilize esta opção para vincular parcelas ou múltiplos depósitos referentes a uma única NF de saída."
      maxWidth="max-w-3xl"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">1. Selecione a Nota Fiscal de Saída *</label>
          <select
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="">Escolha a nota fiscal...</option>
            {openInvoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.tipo} {inv.numero} — {inv.clienteNome} (Em aberto: {formatBRL(getInvoiceOpenAmount(inv) || inv.valor)})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            2. Marque os Recebimentos Bancários (Parcelas) *
          </label>
          <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
            {availableCredits.length === 0 ? (
              <p className="text-sm text-slate-500 p-4 text-center">Nenhum crédito bancário em aberto disponível.</p>
            ) : (
              availableCredits.map((tx) => {
                const checked = selectedIds.includes(tx.id);
                const avail = getBankTxAvailableAmount(tx) || tx.valor;
                return (
                  <label
                    key={tx.id}
                    className={`flex items-center justify-between gap-3 p-3 cursor-pointer ${
                      checked ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleId(tx.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{tx.descricao}</p>
                        <p className="text-xs text-slate-500">
                          {formatDateBR(tx.dataMovimento)} · {tx.banco}
                          {tx.nomePagador ? ` · ${tx.nomePagador}` : ''}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-mono tabular-nums font-semibold text-emerald-700 shrink-0">
                      {formatBRL(avail)}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
          <div>
            <span className="text-slate-500 block">Soma selecionada ({selectedTxs.length} créd.)</span>
            <span className="font-mono tabular-nums font-semibold text-blue-700 text-sm">
              {formatBRL(totalSelectedAmount)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Saldo aberto da NF</span>
            <span className="font-mono tabular-nums font-semibold text-slate-900 text-sm">
              {formatBRL(invOpenAmount)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Diferença após vínculo</span>
            <span
              className={`font-mono tabular-nums font-semibold text-sm ${
                Math.abs(difference) <= 0.05 ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {difference > 0 ? `+${formatBRL(difference)}` : formatBRL(difference)}
            </span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Observação / Justificativa (opcional)</label>
          <input
            type="text"
            maxLength={300}
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Ex.: Recebimento parcelado em 2x via PIX/TED"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={createFinReceipt}
            onChange={(e) => setCreateFinReceipt(e.target.checked)}
            className="mt-0.5"
          />
          <span>Lançar cada parcela conciliada como receita liquidada no módulo Financeiro.</span>
        </label>

        <div className="flex justify-end gap-3 pt-3 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || selectedTxs.length === 0 || !selectedInvoice}
            onClick={() => {
              if (selectedInvoice) {
                void onConfirm(selectedTxs, selectedInvoice, createFinReceipt, justificativa);
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
          >
            <Layers className="w-4 h-4" />
            {saving ? 'Vinculando parcelas...' : 'Confirmar Parcelamento na NF'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
