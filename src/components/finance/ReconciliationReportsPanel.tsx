import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FilterX,
  Info,
  Link2,
} from 'lucide-react';
import type { BankTransaction, ReconciliationRecord } from '../../types/erp';
import { formatBRL, formatDateBR } from '../../utils/formatters';
import {
  exportReconciliationExcelWorkbook,
  getInvoiceOpenAmount,
  type ReconciliationDiagnosticsResult,
  type ReconciliationFilters,
  type ReconciliationReportKey,
} from '../../utils/reconciliationEngine';

interface ReconciliationReportsPanelProps {
  companyName: string;
  canEdit: boolean;
  filters: ReconciliationFilters;
  onChangeFilters: (next: ReconciliationFilters) => void;
  onResetFilters: () => void;
  diagnostics: ReconciliationDiagnosticsResult;
  reconciliations: ReconciliationRecord[];
  bankOptions: string[];
  onQuickLinkCredit: (tx: BankTransaction) => void;
}

const REPORT_TABS: { key: ReconciliationReportKey; label: string }[] = [
  { key: 'notas_totalmente_recebidas', label: 'Notas Totalmente Recebidas' },
  { key: 'notas_parcialmente_recebidas', label: 'Notas Parcialmente Recebidas' },
  { key: 'notas_sem_recebimento', label: 'Notas Sem Recebimento' },
  { key: 'recebimentos_sem_nf', label: 'Recebimentos Sem NF' },
  { key: 'conciliacoes_pendentes', label: 'Conciliações Pendentes' },
  { key: 'divergencias_valores', label: 'Divergências de Valores' },
  { key: 'possiveis_duplicidades', label: 'Possíveis Duplicidades' },
];

export const ReconciliationReportsPanel: React.FC<ReconciliationReportsPanelProps> = ({
  companyName,
  canEdit,
  filters,
  onChangeFilters,
  onResetFilters,
  diagnostics,
  reconciliations,
  bankOptions,
  onQuickLinkCredit,
}) => {
  const [activeReport, setActiveReport] = useState<ReconciliationReportKey>('notas_totalmente_recebidas');

  const countForTab = (key: ReconciliationReportKey): number => {
    switch (key) {
      case 'notas_totalmente_recebidas':
        return diagnostics.reports.notasTotalmenteRecebidas.length;
      case 'notas_parcialmente_recebidas':
        return diagnostics.reports.notasParcialmenteRecebidas.length;
      case 'notas_sem_recebimento':
        return diagnostics.reports.notasSemRecebimento.length;
      case 'recebimentos_sem_nf':
        return diagnostics.reports.recebimentosSemNf.length;
      case 'conciliacoes_pendentes':
        return diagnostics.reports.conciliacoesPendentes.length;
      case 'divergencias_valores':
        return diagnostics.reports.divergenciasValores.length;
      case 'possiveis_duplicidades':
        return diagnostics.reports.possiveisDuplicidades.length;
    }
  };

  const hasFilters = Boolean(
    filters.dataInicio ||
      filters.dataFim ||
      filters.clienteOuPagador ||
      filters.banco ||
      filters.valorMin ||
      filters.valorMax
  );

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <input
              type="text"
              value={filters.clienteOuPagador}
              onChange={(e) => onChangeFilters({ ...filters, clienteOuPagador: e.target.value })}
              placeholder="Filtrar por cliente, pagador, CPF/CNPJ ou nº NF..."
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg min-w-[230px] flex-1 max-w-sm"
            />
            <select
              value={filters.banco}
              onChange={(e) => onChangeFilters({ ...filters, banco: e.target.value })}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Todos os bancos</option>
              {bankOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <span>De:</span>
              <input
                type="date"
                value={filters.dataInicio}
                onChange={(e) => onChangeFilters({ ...filters, dataInicio: e.target.value })}
                className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <span>Até:</span>
              <input
                type="date"
                value={filters.dataFim}
                onChange={(e) => onChangeFilters({ ...filters, dataFim: e.target.value })}
                className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="number"
                min="0"
                step="0.01"
                value={filters.valorMin}
                onChange={(e) => onChangeFilters({ ...filters, valorMin: e.target.value })}
                placeholder="R$ mín"
                className="w-24 px-2.5 py-2 text-xs border border-slate-300 rounded-lg font-mono"
              />
              <span>–</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={filters.valorMax}
                onChange={(e) => onChangeFilters({ ...filters, valorMax: e.target.value })}
                placeholder="R$ máx"
                className="w-24 px-2.5 py-2 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            {hasFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
              >
                <FilterX className="w-3.5 h-3.5" />
                Limpar
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => exportReconciliationExcelWorkbook(diagnostics, reconciliations, companyName)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#0B1F3A] hover:bg-blue-900 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Exportar Relatórios (.xlsx)
          </button>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
          {REPORT_TABS.map((tab) => {
            const active = activeReport === tab.key;
            const count = countForTab(tab.key);
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveReport(tab.key)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-700 text-white border-blue-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono tabular-nums font-semibold ${
                    active ? 'text-blue-100' : 'text-slate-500'
                  }`}
                >
                  ({count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {activeReport === 'recebimentos_sem_nf' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-amber-950">
          <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <span>
            <strong>Regra de Pendência de Conferência:</strong> Um recebimento sem nota fiscal localizada nos documentos importados permanece como <strong>pendência de conferência</strong> e não comprova que não houve emissão de nota fiscal. Os documentos originais importados nunca são alterados.
          </span>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {(activeReport === 'notas_totalmente_recebidas' ||
          activeReport === 'notas_parcialmente_recebidas' ||
          activeReport === 'notas_sem_recebimento') && (() => {
          const list =
            activeReport === 'notas_totalmente_recebidas'
              ? diagnostics.reports.notasTotalmenteRecebidas
              : activeReport === 'notas_parcialmente_recebidas'
                ? diagnostics.reports.notasParcialmenteRecebidas
                : diagnostics.reports.notasSemRecebimento;
          if (list.length === 0) {
            return (
              <div className="p-8 text-center text-sm text-slate-500">
                Nenhuma nota fiscal enquadrada neste relatório para os filtros aplicados.
              </div>
            );
          }
          return (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Nota Fiscal</th>
                    <th className="text-left font-medium px-4 py-3">Emissão / Venc.</th>
                    <th className="text-left font-medium px-4 py-3">Cliente</th>
                    <th className="text-right font-medium px-4 py-3">Valor NF</th>
                    <th className="text-right font-medium px-4 py-3">Recebido</th>
                    <th className="text-right font-medium px-5 py-3">Em Aberto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((inv) => {
                    const linkedCredits = diagnostics.invoiceLinkedCreditCount.get(inv.id) ?? 0;
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50/70">
                        <td className="px-5 py-3 font-medium text-slate-900 whitespace-nowrap">
                          {inv.tipo} {inv.numero}
                          <span className="text-xs text-slate-500 ml-1.5">Série {inv.serie}</span>
                          {linkedCredits >= 2 && (
                            <span className="block text-[11px] text-blue-700 font-medium">
                              Pago em {linkedCredits} parcelas
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {formatDateBR(inv.dataEmissao)}
                          {inv.dataVencimento ? ` · Venc. ${formatDateBR(inv.dataVencimento)}` : ''}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-slate-900 font-medium block">{inv.clienteNome}</span>
                          {inv.clienteDocumento && (
                            <span className="text-xs text-slate-500 font-mono">{inv.clienteDocumento}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {formatBRL(inv.valor)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-700 font-medium">
                          {formatBRL(inv.valorRecebido)}
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums text-amber-700 font-medium">
                          {formatBRL(getInvoiceOpenAmount(inv))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()}

        {activeReport === 'recebimentos_sem_nf' && (
          diagnostics.reports.recebimentosSemNf.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nenhum recebimento bancário sem nota fiscal localizada nos filtros atuais.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Data</th>
                    <th className="text-left font-medium px-4 py-3">Banco / Histórico / Pagador</th>
                    <th className="text-left font-medium px-4 py-3">Classificação</th>
                    <th className="text-right font-medium px-4 py-3">Valor Crédito</th>
                    {canEdit && <th className="text-right font-medium px-5 py-3">Ação</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {diagnostics.reports.recebimentosSemNf.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatDateBR(tx.dataMovimento)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{tx.descricao}</p>
                        <p className="text-xs text-slate-500">
                          {tx.banco}
                          {tx.nomePagador ? ` · ${tx.nomePagador}` : ''}
                          {tx.cpfCnpjPagador ? ` (${tx.cpfCnpjPagador})` : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-red-700 font-medium">
                        Pendência de conferência (NF não localizada)
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-emerald-700">
                        {formatBRL(tx.valor)}
                      </td>
                      {canEdit && (
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => onQuickLinkCredit(tx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            Relacionar NF
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeReport === 'conciliacoes_pendentes' && (
          diagnostics.reports.conciliacoesPendentes.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nenhuma conciliação pendente de revisão humana no momento.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Recebimento</th>
                    <th className="text-left font-medium px-4 py-3">Diagnóstico / Motivo da Pendência</th>
                    <th className="text-right font-medium px-4 py-3">Saldo Aberto</th>
                    {canEdit && <th className="text-right font-medium px-5 py-3">Ação</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {diagnostics.reports.conciliacoesPendentes.map((item) => (
                    <tr key={item.bankTx.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{item.bankTx.descricao}</p>
                        <p className="text-xs text-slate-500">
                          {formatDateBR(item.bankTx.dataMovimento)} · {item.bankTx.banco}
                          {item.bankTx.nomePagador ? ` · ${item.bankTx.nomePagador}` : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-700">{item.requiresHumanReviewReason}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {formatBRL(item.availableAmount)}
                      </td>
                      {canEdit && (
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => onQuickLinkCredit(item.bankTx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            Revisar
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeReport === 'divergencias_valores' && (
          diagnostics.reports.divergenciasValores.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Nenhuma divergência de valores localizada nos filtros selecionados.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Documento / Origem</th>
                    <th className="text-left font-medium px-4 py-3">Cliente / Histórico</th>
                    <th className="text-right font-medium px-4 py-3">Esperado</th>
                    <th className="text-right font-medium px-4 py-3">Recebido</th>
                    <th className="text-right font-medium px-5 py-3">Diferença</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {diagnostics.reports.divergenciasValores.map((div) => (
                    <tr key={div.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="font-medium text-slate-900 block">{div.invoiceNumber}</span>
                        <span className="text-xs text-slate-500">
                          {div.origin} · {formatDateBR(div.date)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900 block">{div.clienteNome}</span>
                        <span className="text-xs text-slate-600">{div.detail}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                        {formatBRL(div.expectedAmount)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-900 font-medium">
                        {formatBRL(div.receivedAmount)}
                      </td>
                      <td
                        className={`px-5 py-3 text-right font-mono tabular-nums font-semibold ${
                          div.difference < 0 ? 'text-amber-700' : 'text-red-700'
                        }`}
                      >
                        {div.difference > 0 ? `+${formatBRL(div.difference)}` : formatBRL(div.difference)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeReport === 'possiveis_duplicidades' && (
          diagnostics.reports.possiveisDuplicidades.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center gap-2">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
              <span>Nenhuma possível duplicidade detectada em extratos ou notas fiscais.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">Tipo</th>
                    <th className="text-left font-medium px-4 py-3">Referência</th>
                    <th className="text-left font-medium px-4 py-3">Motivo do Alerta</th>
                    <th className="text-left font-medium px-4 py-3">Data</th>
                    <th className="text-right font-medium px-5 py-3">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {diagnostics.reports.possiveisDuplicidades.map((dup) => (
                    <tr key={`${dup.entityType}-${dup.id}`} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 text-xs font-semibold text-red-700 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          {dup.entityType}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900 block">{dup.referenceLabel}</span>
                        <span className="text-xs text-slate-500">{dup.partyName}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-700">{dup.reason}</td>
                      <td className="px-4 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatDateBR(dup.date)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {formatBRL(dup.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
};
