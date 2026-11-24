import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  ArrowUpDown,
  CheckCircle2,
  Edit3,
  ExternalLink,
  FileText,
  FileUp,
  FilterX,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type Customer,
  type Invoice,
  type InvoiceReceiptStatus,
  type InvoiceType,
} from '../types/erp';
import {
  createInvoice,
  deleteInvoice,
  updateInvoice,
  type InvoiceInput,
} from '../services/erpService';
import { digitsOnly, formatCpfCnpj } from '../utils/financeDocuments';
import { formatBRL, formatDateBR, todayISO } from '../utils/formatters';
import { OutboundInvoiceImportModal } from '../components/finance/OutboundInvoiceImportModal';
import { ConfirmDialog, EmptyState, Modal, SkeletonTable } from '../components/ui/CommonUI';

interface InvoicesModuleProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  loading: boolean;
  invoices: Invoice[];
  customers?: Customer[];
  defaultSerie: string;
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const STATUS_MAP: Record<InvoiceReceiptStatus, { label: string; cls: string }> = {
  pendente: { label: 'Pendente de Recebimento', cls: 'text-amber-700' },
  parcial: { label: 'Recebida Parcialmente', cls: 'text-blue-700' },
  recebida: { label: 'Recebida', cls: 'text-emerald-700' },
  cancelada: { label: 'Cancelada', cls: 'text-slate-500' },
};

const ORIGIN_LABELS: Record<Invoice['origemImportacao'], string> = {
  xml: 'XML',
  excel: 'Excel',
  csv: 'CSV',
  pdf: 'PDF',
  manual: 'Manual',
};

export const InvoicesModule: React.FC<InvoicesModuleProps> = ({
  user,
  companyId,
  canEdit,
  loading,
  invoices,
  customers = [],
  defaultSerie,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [filterCliente, setFilterCliente] = useState('');
  const [filterDataInicio, setFilterDataInicio] = useState('');
  const [filterDataFim, setFilterDataFim] = useState('');
  const [filterValorMin, setFilterValorMin] = useState('');
  const [filterValorMax, setFilterValorMax] = useState('');
  const [filterStatus, setFilterStatus] = useState<'todos' | InvoiceReceiptStatus>('todos');
  const [filterTipo, setFilterTipo] = useState<'todos' | InvoiceType>('todos');
  const [sortBy, setSortBy] = useState<'data_desc' | 'data_asc' | 'valor_desc' | 'valor_asc'>('data_desc');

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InvoiceInput>({
    numero: '',
    serie: defaultSerie || '1',
    chaveAcesso: '',
    tipo: 'NF-e',
    tipoOperacao: 'saida',
    clienteNome: '',
    clienteDocumento: '',
    customerId: '',
    valor: 0,
    dataEmissao: todayISO(),
    dataVencimento: '',
    statusRecebimento: 'pendente',
    valorRecebido: 0,
    origemImportacao: 'manual',
    itensResumo: '',
    descricaoServicos: '',
    storagePath: '',
    downloadUrl: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Invoice | null>(null);

  const hasActiveFilters = Boolean(
    search ||
      filterCliente ||
      filterDataInicio ||
      filterDataFim ||
      filterValorMin ||
      filterValorMax ||
      filterStatus !== 'todos' ||
      filterTipo !== 'todos'
  );

  const clearFilters = () => {
    setSearch('');
    setFilterCliente('');
    setFilterDataInicio('');
    setFilterDataFim('');
    setFilterValorMin('');
    setFilterValorMax('');
    setFilterStatus('todos');
    setFilterTipo('todos');
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qc = filterCliente.trim().toLowerCase();
    const qcDigits = digitsOnly(filterCliente);
    const minVal = filterValorMin ? Number(filterValorMin) : null;
    const maxVal = filterValorMax ? Number(filterValorMax) : null;

    return invoices
      .filter((inv) => {
        if (filterStatus !== 'todos' && inv.statusRecebimento !== filterStatus) return false;
        if (filterTipo !== 'todos' && inv.tipo !== filterTipo) return false;
        if (filterDataInicio && inv.dataEmissao < filterDataInicio) return false;
        if (filterDataFim && inv.dataEmissao > filterDataFim) return false;
        if (minVal !== null && Number.isFinite(minVal) && inv.valor < minVal) return false;
        if (maxVal !== null && Number.isFinite(maxVal) && inv.valor > maxVal) return false;
        if (qc) {
          const clientHay = `${inv.clienteNome} ${inv.clienteDocumento ?? ''}`.toLowerCase();
          const docMatch = qcDigits.length >= 3 && digitsOnly(inv.clienteDocumento).includes(qcDigits);
          if (!clientHay.includes(qc) && !docMatch) return false;
        }
        if (q) {
          const hay = `${inv.numero} ${inv.clienteNome} ${inv.clienteDocumento ?? ''} ${inv.chaveAcesso ?? ''} ${inv.itensResumo ?? ''} ${inv.descricaoServicos ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'data_desc') return b.dataEmissao.localeCompare(a.dataEmissao);
        if (sortBy === 'data_asc') return a.dataEmissao.localeCompare(b.dataEmissao);
        if (sortBy === 'valor_desc') return b.valor - a.valor;
        return a.valor - b.valor;
      });
  }, [
    invoices,
    search,
    filterCliente,
    filterDataInicio,
    filterDataFim,
    filterValorMin,
    filterValorMax,
    filterStatus,
    filterTipo,
    sortBy,
  ]);

  const summary = useMemo(() => {
    const validas = invoices.filter((i) => i.statusRecebimento !== 'cancelada');
    const totalEmitido = validas.reduce((s, i) => s + i.valor, 0);
    const pendentes = validas.filter(
      (i) => i.statusRecebimento === 'pendente' || i.statusRecebimento === 'parcial'
    );
    const totalPendente = pendentes.reduce(
      (s, i) => s + Math.max(0, i.valor - i.valorRecebido),
      0
    );
    return {
      qtdEmitidas: validas.length,
      totalEmitido,
      qtdPendentes: pendentes.length,
      totalPendente,
    };
  }, [invoices]);

  const openCreate = () => {
    if (!canEdit) return;
    setEditingId(null);
    setForm({
      numero: '',
      serie: defaultSerie || '1',
      chaveAcesso: '',
      tipo: 'NF-e',
      tipoOperacao: 'saida',
      clienteNome: '',
      clienteDocumento: '',
      customerId: '',
      valor: 0,
      dataEmissao: todayISO(),
      dataVencimento: '',
      statusRecebimento: 'pendente',
      valorRecebido: 0,
      origemImportacao: 'manual',
      itensResumo: '',
      descricaoServicos: '',
      storagePath: '',
      downloadUrl: '',
    });
    setErrors({});
    setModalOpen(true);
  };

  const openEdit = (inv: Invoice) => {
    if (!canEdit) return;
    setEditingId(inv.id);
    setForm({
      numero: inv.numero,
      serie: inv.serie,
      chaveAcesso: inv.chaveAcesso ?? '',
      tipo: inv.tipo,
      tipoOperacao: 'saida',
      clienteNome: inv.clienteNome,
      clienteDocumento: inv.clienteDocumento ?? '',
      customerId: inv.customerId ?? '',
      valor: inv.valor,
      dataEmissao: inv.dataEmissao,
      dataVencimento: inv.dataVencimento ?? '',
      statusRecebimento: inv.statusRecebimento,
      valorRecebido: inv.valorRecebido,
      origemImportacao: inv.origemImportacao,
      itensResumo: inv.itensResumo ?? '',
      descricaoServicos: inv.descricaoServicos ?? '',
      storagePath: inv.storagePath ?? '',
      downloadUrl: inv.downloadUrl ?? '',
    });
    setErrors({});
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.numero.trim()) errs.numero = 'Informe o número da nota fiscal.';
    if (!form.clienteNome.trim()) errs.clienteNome = 'Informe o nome do cliente/tomador.';
    if (!Number.isFinite(form.valor) || form.valor <= 0) errs.valor = 'Informe um valor maior que R$ 0,00.';
    if (!form.dataEmissao) errs.dataEmissao = 'Informe a data de emissão.';
    if (form.valorRecebido < 0 || form.valorRecebido > form.valor) {
      errs.valorRecebido = 'O valor recebido não pode ser negativo ou maior que o total da NF.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !validate() || saving) return;

    setSaving(true);
    try {
      const normalizedStatus: InvoiceReceiptStatus =
        form.statusRecebimento === 'recebida' && form.valorRecebido === 0
          ? 'recebida'
          : form.statusRecebimento;
      const normalizedValorRecebido =
        normalizedStatus === 'recebida' && form.valorRecebido === 0
          ? form.valor
          : form.valorRecebido;

      const payload: InvoiceInput = {
        ...form,
        tipoOperacao: 'saida',
        clienteDocumento: form.clienteDocumento ? formatCpfCnpj(form.clienteDocumento) : '',
        itensResumo: form.itensResumo || form.descricaoServicos || '',
        descricaoServicos: (form.descricaoServicos || form.itensResumo || '').slice(
          0,
          FIELD_LIMITS.descricaoServicos
        ),
        statusRecebimento: normalizedStatus,
        valorRecebido: normalizedValorRecebido,
      };

      if (editingId) {
        await updateInvoice(user, companyId, editingId, payload);
        onNotify('success', `Nota fiscal de saída nº ${payload.numero} atualizada.`);
      } else {
        await createInvoice(user, companyId, payload);
        onNotify('success', `Nota fiscal de saída nº ${payload.numero} salva no Firestore.`);
      }
      setModalOpen(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar nota fiscal.');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkReceived = async (inv: Invoice) => {
    if (!canEdit) return;
    try {
      await updateInvoice(user, companyId, inv.id, {
        statusRecebimento: 'recebida',
        valorRecebido: inv.valor,
      });
      onNotify('success', `NF nº ${inv.numero} marcada como recebida.`);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao atualizar recebimento.');
    }
  };

  const handleDelete = async () => {
    if (!canEdit || !deleteTarget) return;
    setSaving(true);
    try {
      await deleteInvoice(user, companyId, deleteTarget.id, deleteTarget.numero);
      onNotify('success', `Nota fiscal nº ${deleteTarget.numero} excluída.`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao excluir nota fiscal.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-blue-950">
        <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          <strong>Exclusivo para Notas Fiscais de Saída:</strong> importe documentos existentes (XML NF-e/NFS-e/NFC-e, Excel, CSV ou PDF) para acompanhar faturamento e conferir recebimentos. O sistema não realiza emissão automática de notas fiscais.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Notas Fiscais de Saída</p>
          <p className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1.5">
            {summary.qtdEmitidas}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Valor Total Faturado</p>
          <p className="text-xl font-semibold text-blue-700 font-mono tabular-nums mt-1.5">
            {formatBRL(summary.totalEmitido)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Pendentes de Recebimento</p>
          <p className="text-xl font-semibold text-amber-700 font-mono tabular-nums mt-1.5">
            {summary.qtdPendentes} · {formatBRL(summary.totalPendente)}
          </p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nº NF, chave ou itens..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <input
              type="text"
              value={filterCliente}
              onChange={(e) => setFilterCliente(e.target.value)}
              placeholder="Filtrar cliente / CPF-CNPJ..."
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg min-w-[180px]"
            />

            <select
              value={filterTipo}
              onChange={(e) => setFilterTipo(e.target.value as 'todos' | InvoiceType)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="todos">NF-e, NFS-e e NFC-e</option>
              <option value="NF-e">NF-e (Equipamentos)</option>
              <option value="NFS-e">NFS-e (Serviços)</option>
              <option value="NFC-e">NFC-e (Consumidor)</option>
            </select>

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'todos' | InvoiceReceiptStatus)}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="todos">Todas as situações</option>
              <option value="pendente">Pendente</option>
              <option value="parcial">Parcial</option>
              <option value="recebida">Recebida</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </div>

          {canEdit && (
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setImportModalOpen(true)}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                <FileUp className="w-4 h-4" />
                Importar (XML / Excel / CSV / PDF)
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Nova Nota Manual
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <span>Emissão de:</span>
            <input
              type="date"
              value={filterDataInicio}
              onChange={(e) => setFilterDataInicio(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <span>até</span>
            <input
              type="date"
              value={filterDataFim}
              onChange={(e) => setFilterDataFim(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <span>Valor (R$):</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={filterValorMin}
              onChange={(e) => setFilterValorMin(e.target.value)}
              placeholder="Mín."
              className="w-24 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
            />
            <span>–</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={filterValorMax}
              onChange={(e) => setFilterValorMax(e.target.value)}
              placeholder="Máx."
              className="w-24 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <button
            type="button"
            onClick={() =>
              setSortBy((s) =>
                s === 'data_desc'
                  ? 'data_asc'
                  : s === 'data_asc'
                    ? 'valor_desc'
                    : s === 'valor_desc'
                      ? 'valor_asc'
                      : 'data_desc'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {sortBy === 'data_desc' && 'Emissão recente'}
            {sortBy === 'data_asc' && 'Emissão antiga'}
            {sortBy === 'valor_desc' && 'Maior valor'}
            {sortBy === 'valor_asc' && 'Menor valor'}
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg cursor-pointer"
            >
              <FilterX className="w-3.5 h-3.5" />
              Limpar filtros
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText className="w-6 h-6" />}
          title={
            invoices.length === 0
              ? 'Nenhuma nota fiscal de saída importada'
              : 'Nenhuma nota fiscal encontrada'
          }
          description={
            invoices.length === 0
              ? 'Importe XMLs (NF-e, NFS-e, NFC-e), planilhas Excel/CSV ou PDFs de notas de saída já emitidas para conferir os recebimentos.'
              : 'Ajuste os filtros de período, cliente, valor ou situação para localizar os documentos desejados.'
          }
          actionLabel={
            canEdit && invoices.length === 0 ? 'Importar Notas Fiscais de Saída' : undefined
          }
          onAction={
            canEdit && invoices.length === 0 ? () => setImportModalOpen(true) : undefined
          }
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-5 py-3">Emissão / Venc.</th>
                  <th className="text-left font-medium px-4 py-3">Número / Tipo</th>
                  <th className="text-left font-medium px-4 py-3">Cliente / Itens</th>
                  <th className="text-left font-medium px-4 py-3">Situação</th>
                  <th className="text-right font-medium px-4 py-3">Valor</th>
                  <th className="text-right font-medium px-4 py-3">Recebido</th>
                  <th className="text-right font-medium px-5 py-3">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((inv) => {
                  const st = STATUS_MAP[inv.statusRecebimento];
                  const detailText = inv.itensResumo || inv.descricaoServicos;
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        <p>{formatDateBR(inv.dataEmissao)}</p>
                        {inv.dataVencimento && (
                          <p className="text-[11px] text-slate-400">
                            Venc. {formatDateBR(inv.dataVencimento)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="font-mono font-semibold text-slate-900">
                          {inv.tipo} {inv.numero}
                        </p>
                        <p className="text-xs text-slate-500">
                          Série {inv.serie} · {ORIGIN_LABELS[inv.origemImportacao] ?? inv.origemImportacao}
                        </p>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="font-medium text-slate-900">{inv.clienteNome}</p>
                        {inv.clienteDocumento && (
                          <p className="text-xs font-mono text-slate-500">{inv.clienteDocumento}</p>
                        )}
                        {detailText && (
                          <p className="text-[11px] text-slate-500 truncate mt-0.5" title={detailText}>
                            {detailText}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">
                        <span className={st.cls}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {formatBRL(inv.valor)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatBRL(inv.valorRecebido)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {inv.downloadUrl && (
                            <a
                              href={inv.downloadUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Baixar arquivo original no Firebase Storage"
                              className="p-1.5 text-blue-700 hover:bg-blue-50 rounded-lg"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                          {canEdit &&
                            inv.statusRecebimento !== 'recebida' &&
                            inv.statusRecebimento !== 'cancelada' && (
                              <button
                                type="button"
                                onClick={() => void handleMarkReceived(inv)}
                                title="Confirmar recebimento integral"
                                className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-lg cursor-pointer"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(inv)}
                                title="Editar nota fiscal"
                                className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(inv)}
                                title="Excluir nota fiscal"
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <OutboundInvoiceImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        user={user}
        companyId={companyId}
        defaultSerie={defaultSerie}
        existingInvoices={invoices}
        customers={customers}
        onNotify={onNotify}
      />

      <Modal
        open={modalOpen}
        title={editingId ? 'Editar Nota Fiscal de Saída' : 'Cadastrar Nota Fiscal de Saída'}
        subtitle="Campos sincronizados com o controle de recebimentos e base de clientes."
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tipo *</label>
              <select
                value={form.tipo}
                onChange={(e) => setForm({ ...form, tipo: e.target.value as InvoiceType })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="NF-e">NF-e (Venda / Peças)</option>
                <option value="NFS-e">NFS-e (Instalação / Manutenção)</option>
                <option value="NFC-e">NFC-e (Consumidor)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Número da NF *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.numeroNf}
                value={form.numero}
                onChange={(e) => setForm({ ...form, numero: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
              {errors.numero && <p className="text-xs text-red-600 mt-1">{errors.numero}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Série *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.serieNf}
                value={form.serie}
                onChange={(e) => setForm({ ...form, serie: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>

          {customers.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Vincular Cliente Cadastrado (Opcional)
              </label>
              <select
                value={form.customerId ?? ''}
                onChange={(e) => {
                  const chosen = customers.find((c) => c.id === e.target.value);
                  if (chosen) {
                    setForm((prev) => ({
                      ...prev,
                      customerId: chosen.id,
                      clienteNome: chosen.nome,
                      clienteDocumento: chosen.documento ?? '',
                    }));
                  } else {
                    setForm((prev) => ({ ...prev, customerId: '' }));
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">-- Selecionar da Base de Clientes ou preencher manualmente --</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome} {c.documento ? `(${c.documento})` : '(Sem CPF/CNPJ)'}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Cliente / Tomador *</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.clienteNome}
                value={form.clienteNome}
                onChange={(e) => setForm({ ...form, clienteNome: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {errors.clienteNome && <p className="text-xs text-red-600 mt-1">{errors.clienteNome}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">CPF ou CNPJ do Cliente</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.clienteDocumento}
                value={form.clienteDocumento ?? ''}
                onChange={(e) => setForm({ ...form, clienteDocumento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Data de Emissão *</label>
              <input
                type="date"
                value={form.dataEmissao}
                onChange={(e) => setForm({ ...form, dataEmissao: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              {errors.dataEmissao && <p className="text-xs text-red-600 mt-1">{errors.dataEmissao}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Vencimento (Opcional)</label>
              <input
                type="date"
                value={form.dataVencimento ?? ''}
                onChange={(e) => setForm({ ...form, dataVencimento: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Valor Total (R$) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.valor || ''}
                onChange={(e) => setForm({ ...form, valor: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {errors.valor && <p className="text-xs text-red-600 mt-1">{errors.valor}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Situação de Recebimento</label>
              <select
                value={form.statusRecebimento}
                onChange={(e) => setForm({ ...form, statusRecebimento: e.target.value as InvoiceReceiptStatus })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="pendente">Pendente</option>
                <option value="parcial">Parcial</option>
                <option value="recebida">Recebida</option>
                <option value="cancelada">Cancelada</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Valor Recebido (R$)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.valorRecebido}
                onChange={(e) => setForm({ ...form, valorRecebido: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              {errors.valorRecebido && <p className="text-xs text-red-600 mt-1">{errors.valorRecebido}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Chave de Acesso</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.chaveAcesso}
                value={form.chaveAcesso ?? ''}
                onChange={(e) => setForm({ ...form, chaveAcesso: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Itens, Equipamentos, Serviços e Informações Adicionais
            </label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.itensResumo}
              value={form.itensResumo || form.descricaoServicos || ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  itensResumo: e.target.value,
                  descricaoServicos: e.target.value.slice(0, FIELD_LIMITS.descricaoServicos),
                })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : editingId ? 'Salvar Alterações' : 'Salvar Nota Fiscal'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir nota fiscal"
        message={`Confirma a exclusão da ${deleteTarget?.tipo} nº ${deleteTarget?.numero} (${deleteTarget?.clienteNome})?`}
        confirmLabel="Excluir"
        danger
        loading={saving}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
