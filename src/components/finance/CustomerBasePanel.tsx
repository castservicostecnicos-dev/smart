import React, { useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  Edit3,
  History,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import {
  FIELD_LIMITS,
  type BankTransaction,
  type Customer,
  type CustomerPersonType,
  type FinancialTransaction,
  type Invoice,
} from '../../types/erp';
import { createCustomer, deleteCustomer, updateCustomer } from '../../services/erpService';
import {
  digitsOnly,
  formatCpfCnpj,
  isValidCpfOrCnpjDigits,
  normalizeTextKey,
} from '../../utils/financeDocuments';
import { formatBRL, formatDateBR } from '../../utils/formatters';
import { ConfirmDialog, EmptyState, Modal } from '../ui/CommonUI';

interface CustomerBasePanelProps {
  user: User;
  companyId: string;
  canEdit: boolean;
  customers: Customer[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  financials: FinancialTransaction[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

interface CustomerStats {
  invoices: Invoice[];
  bankCredits: BankTransaction[];
  financialReceitas: FinancialTransaction[];
  totalFaturado: number;
  totalRecebido: number;
  totalEmAberto: number;
}

export const CustomerBasePanel: React.FC<CustomerBasePanelProps> = ({
  user,
  companyId,
  canEdit,
  customers,
  invoices,
  bankTransactions,
  financials,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [filterTipo, setFilterTipo] = useState<'todos' | CustomerPersonType>('todos');

  const [formOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [form, setForm] = useState({
    nome: '',
    documento: '',
    email: '',
    telefone: '',
    observacoes: '',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);

  // Calcula histórico estritamente por ID vinculado ou CPF/CNPJ exato (nunca por nome semelhante)
  const customerStatsMap = useMemo(() => {
    const map = new Map<string, CustomerStats>();

    for (const c of customers) {
      const cClean = digitsOnly(c.documentoLimpo || c.documento);
      const hasValidDoc = cClean.length === 11 || cClean.length === 14;

      const linkedInvoices = invoices.filter((inv) => {
        if (inv.customerId && inv.customerId === c.id) return true;
        if (hasValidDoc && digitsOnly(inv.clienteDocumento) === cClean) return true;
        return false;
      });
      const linkedInvIds = new Set(linkedInvoices.map((i) => i.id));

      const linkedBankCredits = bankTransactions.filter((b) => {
        if (b.tipo !== 'credito') return false;
        if (b.customerId && b.customerId === c.id) return true;
        if (hasValidDoc && digitsOnly(b.cpfCnpjPagador) === cClean) return true;
        if (b.invoiceId && linkedInvIds.has(b.invoiceId)) return true;
        return false;
      });

      const linkedFinancials = financials.filter((f) => {
        if (f.tipo !== 'receita') return false;
        if (f.customerId && f.customerId === c.id) return true;
        if (hasValidDoc && digitsOnly(f.clienteDocumento) === cClean) return true;
        if (f.invoiceId && linkedInvIds.has(f.invoiceId)) return true;
        return false;
      });

      const validInvs = linkedInvoices.filter((i) => i.statusRecebimento !== 'cancelada');
      const totalFaturado = validInvs.reduce((s, i) => s + i.valor, 0);
      const recebidoNfs = validInvs.reduce((s, i) => s + i.valorRecebido, 0);
      const recebidoAvulsoFin = linkedFinancials
        .filter((f) => f.status === 'pago' && (!f.invoiceId || !linkedInvIds.has(f.invoiceId)))
        .reduce((s, f) => s + f.valor, 0);
      const totalRecebido = Math.round((recebidoNfs + recebidoAvulsoFin) * 100) / 100;
      const totalEmAberto = Math.max(0, Math.round((totalFaturado - recebidoNfs) * 100) / 100);

      map.set(c.id, {
        invoices: linkedInvoices.sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao)),
        bankCredits: linkedBankCredits.sort((a, b) => b.dataMovimento.localeCompare(a.dataMovimento)),
        financialReceitas: linkedFinancials.sort((a, b) =>
          b.dataVencimento.localeCompare(a.dataVencimento)
        ),
        totalFaturado,
        totalRecebido,
        totalEmAberto,
      });
    }
    return map;
  }, [customers, invoices, bankTransactions, financials]);

  // Detecta homônimos mantidos separados (mesmo nome normalizado, CPFs/CNPJs distintos ou ausentes)
  const homonymGroupsCount = useMemo(() => {
    const byName = new Map<string, number>();
    for (const c of customers) {
      const k = normalizeTextKey(c.nome);
      if (!k) continue;
      byName.set(k, (byName.get(k) ?? 0) + 1);
    }
    let groups = 0;
    for (const count of byName.values()) {
      if (count > 1) groups += 1;
    }
    return groups;
  }, [customers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = digitsOnly(search);
    return customers
      .filter((c) => {
        if (filterTipo !== 'todos' && c.tipoPessoa !== filterTipo) return false;
        if (q) {
          const hay = `${c.nome} ${c.documento ?? ''} ${c.email ?? ''} ${c.telefone ?? ''}`.toLowerCase();
          const docMatches = qDigits.length >= 3 && (c.documentoLimpo ?? '').includes(qDigits);
          if (!hay.includes(q) && !docMatches) return false;
        }
        return true;
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [customers, search, filterTipo]);

  const openCreate = () => {
    if (!canEdit) return;
    setEditingCustomer(null);
    setForm({ nome: '', documento: '', email: '', telefone: '', observacoes: '' });
    setFormErrors({});
    setFormOpen(true);
  };

  const openEdit = (c: Customer) => {
    if (!canEdit) return;
    setEditingCustomer(c);
    setForm({
      nome: c.nome,
      documento: c.documento ?? '',
      email: c.email ?? '',
      telefone: c.telefone ?? '',
      observacoes: c.observacoes ?? '',
    });
    setFormErrors({});
    setFormOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.nome.trim()) errs.nome = 'Informe o nome ou razão social do cliente.';
    const cleanDigits = digitsOnly(form.documento);
    if (form.documento.trim() && !isValidCpfOrCnpjDigits(cleanDigits)) {
      errs.documento =
        'CPF (11 dígitos) ou CNPJ (14 dígitos) inválido. Corrija os dígitos ou deixe em branco.';
    }
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !validate() || saving) return;
    setSaving(true);
    try {
      if (editingCustomer) {
        await updateCustomer(user, companyId, editingCustomer.id, form);
        onNotify('success', `Cadastro do cliente "${form.nome}" atualizado.`);
      } else {
        await createCustomer(user, companyId, form);
        onNotify('success', `Cliente "${form.nome}" cadastrado na base.`);
      }
      setFormOpen(false);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao salvar cadastro de cliente.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!canEdit || !deleteTarget || saving) return;
    setSaving(true);
    try {
      await deleteCustomer(user, companyId, deleteTarget.id, deleteTarget.nome);
      onNotify('success', `Cliente "${deleteTarget.nome}" excluído da base.`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      onNotify('error', err instanceof Error ? err.message : 'Erro ao excluir cliente.');
    } finally {
      setSaving(false);
    }
  };

  const historyStats = historyCustomer ? customerStatsMap.get(historyCustomer.id) : undefined;

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-3 text-xs text-blue-950">
        <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold">
            Identificação estrita de clientes por CPF/CNPJ
          </p>
          <p className="text-blue-900 leading-relaxed">
            O sistema nunca presume que duas pessoas ou empresas são iguais apenas porque possuem nomes semelhantes. Vínculos automáticos entre notas fiscais de saída, extratos bancários e histórico de recebimentos ocorrem exclusivamente quando há CPF ou CNPJ exato coincidente.
          </p>
        </div>
      </div>

      {homonymGroupsCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-amber-950">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>
            Existem <strong>{homonymGroupsCount}</strong> grupo(s) de clientes com nomes semelhantes ou idênticos mantidos separados propositalmente por possuírem CPF/CNPJ distintos ou não informados.
          </span>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente por nome, CPF, CNPJ ou e-mail..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <select
            value={filterTipo}
            onChange={(e) => setFilterTipo(e.target.value as 'todos' | CustomerPersonType)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todos">Todos os perfis ({customers.length})</option>
            <option value="PJ">Pessoa Jurídica (CNPJ)</option>
            <option value="PF">Pessoa Física (CPF)</option>
            <option value="NAO_IDENTIFICADO">Sem CPF/CNPJ</option>
          </select>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Novo Cliente
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="w-6 h-6" />}
          title={
            customers.length === 0
              ? 'Nenhum cliente cadastrado na base'
              : 'Nenhum cliente encontrado'
          }
          description={
            customers.length === 0
              ? 'Cadastre clientes com CPF/CNPJ ou importe notas fiscais de saída com CPF/CNPJ para construir automaticamente o histórico de recebimentos por cliente.'
              : 'Ajuste os termos de busca ou filtro de perfil.'
          }
          actionLabel={canEdit && customers.length === 0 ? 'Cadastrar Primeiro Cliente' : undefined}
          onAction={canEdit && customers.length === 0 ? openCreate : undefined}
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-5 py-3">Cliente</th>
                  <th className="text-left font-medium px-4 py-3">CPF / CNPJ</th>
                  <th className="text-left font-medium px-4 py-3">Contato</th>
                  <th className="text-right font-medium px-4 py-3">NFs Saída</th>
                  <th className="text-right font-medium px-4 py-3">Total Recebido</th>
                  <th className="text-right font-medium px-5 py-3">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((c) => {
                  const st = customerStatsMap.get(c.id);
                  return (
                    <tr key={c.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{c.nome}</p>
                        <p className="text-xs text-slate-500">
                          {c.tipoPessoa === 'PJ'
                            ? 'Pessoa Jurídica'
                            : c.tipoPessoa === 'PF'
                              ? 'Pessoa Física'
                              : 'Sem CPF/CNPJ — vínculo manual apenas'}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {c.documento ? (
                          <span className="text-slate-800">{c.documento}</span>
                        ) : (
                          <span className="text-amber-700 font-sans font-medium">
                            Não informado
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <p>{c.email || '—'}</p>
                        {c.telefone && <p className="font-mono text-slate-500">{c.telefone}</p>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                        {st?.invoices.length ?? 0} · {formatBRL(st?.totalFaturado ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-emerald-700 whitespace-nowrap">
                        {formatBRL(st?.totalRecebido ?? 0)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setHistoryCustomer(c)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-pointer"
                          >
                            <History className="w-3.5 h-3.5" />
                            Histórico
                          </button>
                          {canEdit && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(c)}
                                title="Editar cliente"
                                className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(c)}
                                title="Excluir cliente"
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

      {/* Modal Cadastro / Edição de Cliente */}
      <Modal
        open={formOpen}
        title={editingCustomer ? 'Editar Cliente' : 'Cadastrar Cliente'}
        subtitle="Clientes com CPF/CNPJ válido são identificados de forma única para notas fiscais e conciliações."
        onClose={() => setFormOpen(false)}
        maxWidth="max-w-lg"
      >
        <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Nome / Razão Social *
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.clienteNome}
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Ex.: Refrigeração Central Ltda ou João da Silva"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            {formErrors.nome && <p className="text-xs text-red-600 mt-1">{formErrors.nome}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              CPF ou CNPJ (Recomendado para identificação unívoca)
            </label>
            <input
              type="text"
              maxLength={FIELD_LIMITS.clienteDocumento}
              value={form.documento}
              onChange={(e) => setForm({ ...form, documento: e.target.value })}
              onBlur={() => {
                const d = digitsOnly(form.documento);
                if (d.length === 11 || d.length === 14) {
                  setForm((prev) => ({ ...prev, documento: formatCpfCnpj(d) }));
                }
              }}
              placeholder="000.000.000-00 ou 00.000.000/0001-00"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
            />
            {formErrors.documento && (
              <p className="text-xs text-red-600 mt-1">{formErrors.documento}</p>
            )}
            {!form.documento.trim() && (
              <p className="text-[11px] text-amber-700 mt-1">
                Sem CPF/CNPJ, este cliente não será associado automaticamente a lançamentos futuros por semelhança de nome.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">E-mail</label>
              <input
                type="email"
                maxLength={FIELD_LIMITS.userEmail}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Telefone</label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.telefone}
                value={form.telefone}
                onChange={(e) => setForm({ ...form, telefone: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Observações</label>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.observacoes}
              value={form.observacoes}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Salvando...' : editingCustomer ? 'Salvar Alterações' : 'Cadastrar Cliente'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Histórico de Recebimentos do Cliente */}
      <Modal
        open={Boolean(historyCustomer)}
        title={`Histórico de Recebimentos — ${historyCustomer?.nome ?? ''}`}
        subtitle={
          historyCustomer?.documento
            ? `CPF/CNPJ: ${historyCustomer.documento}`
            : 'Cliente sem CPF/CNPJ informado (apenas registros vinculados diretamente)'
        }
        onClose={() => setHistoryCustomer(null)}
        maxWidth="max-w-4xl"
      >
        {historyCustomer && historyStats && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <p className="text-[11px] text-slate-500">Faturado em NFs de Saída</p>
                <p className="text-base font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                  {formatBRL(historyStats.totalFaturado)}
                </p>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3.5">
                <p className="text-[11px] text-emerald-700">Total Recebido</p>
                <p className="text-base font-semibold text-emerald-800 font-mono tabular-nums mt-0.5">
                  {formatBRL(historyStats.totalRecebido)}
                </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5">
                <p className="text-[11px] text-amber-800">Saldo em Aberto</p>
                <p className="text-base font-semibold text-amber-900 font-mono tabular-nums mt-0.5">
                  {formatBRL(historyStats.totalEmAberto)}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
                Notas Fiscais de Saída ({historyStats.invoices.length})
              </h4>
              {historyStats.invoices.length === 0 ? (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  Nenhuma nota fiscal de saída vinculada a este cliente.
                </p>
              ) : (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Emissão</th>
                        <th className="px-3 py-2 text-left">Nota</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-right">Valor</th>
                        <th className="px-3 py-2 text-right">Recebido</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historyStats.invoices.map((inv) => (
                        <tr key={inv.id}>
                          <td className="px-3 py-2 font-mono">{formatDateBR(inv.dataEmissao)}</td>
                          <td className="px-3 py-2 font-mono font-medium">
                            {inv.tipo} {inv.numero}
                          </td>
                          <td className="px-3 py-2 capitalize">{inv.statusRecebimento}</td>
                          <td className="px-3 py-2 text-right font-mono">{formatBRL(inv.valor)}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700">
                            {formatBRL(inv.valorRecebido)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
                Créditos Bancários Identificados ({historyStats.bankCredits.length})
              </h4>
              {historyStats.bankCredits.length === 0 ? (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  Nenhum recebimento em extrato bancário vinculado a este cliente até o momento.
                </p>
              ) : (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Data</th>
                        <th className="px-3 py-2 text-left">Banco / Histórico</th>
                        <th className="px-3 py-2 text-left">NF Vinculada</th>
                        <th className="px-3 py-2 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historyStats.bankCredits.map((b) => (
                        <tr key={b.id}>
                          <td className="px-3 py-2 font-mono">{formatDateBR(b.dataMovimento)}</td>
                          <td className="px-3 py-2">
                            {b.descricao}
                            <span className="block text-[11px] text-slate-500">{b.banco}</span>
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {b.invoiceNumber ? `NF ${b.invoiceNumber}` : 'Sem NF'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold">
                            {formatBRL(b.valor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
                Lançamentos Financeiros de Receita ({historyStats.financialReceitas.length})
              </h4>
              {historyStats.financialReceitas.length === 0 ? (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  Nenhum lançamento financeiro de receita vinculado a este cliente.
                </p>
              ) : (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Vencimento</th>
                        <th className="px-3 py-2 text-left">Descrição</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historyStats.financialReceitas.map((f) => (
                        <tr key={f.id}>
                          <td className="px-3 py-2 font-mono">{formatDateBR(f.dataVencimento)}</td>
                          <td className="px-3 py-2">{f.descricao}</td>
                          <td className="px-3 py-2 capitalize">{f.status}</td>
                          <td className="px-3 py-2 text-right font-mono">{formatBRL(f.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Excluir cliente"
        message={`Confirma a remoção do cliente "${deleteTarget?.nome}"? Notas fiscais e extratos já gravados permanecem preservados no histórico.`}
        confirmLabel="Excluir"
        danger
        loading={saving}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};
