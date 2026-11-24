import React, { useMemo, useState } from 'react';
import { Download, History, Search } from 'lucide-react';
import type { AuditAction, AuditLog, AuditResult } from '../types/erp';
import { exportToCSV, formatTimestampBR } from '../utils/formatters';
import { EmptyState, SkeletonTable } from '../components/ui/CommonUI';

interface AuditLogsModuleProps {
  loading: boolean;
  logs: AuditLog[];
  onNotify: (type: 'success' | 'error' | 'info', text: string) => void;
}

const ACTION_LABELS: Record<AuditAction, string> = {
  criar: 'Criação',
  editar: 'Edição',
  excluir: 'Exclusão',
  importar: 'Importação',
  conciliar: 'Conciliação',
  movimentar: 'Movimentação',
  permissao: 'Permissões',
  configurar: 'Configuração',
  storage: 'Documentos (Storage)',
};

const RESULT_BADGES: Record<AuditResult, { label: string; className: string }> = {
  sucesso: {
    label: 'Sucesso',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  bloqueado: {
    label: 'Bloqueado',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  erro: {
    label: 'Erro',
    className: 'bg-rose-50 text-rose-700 border-rose-200',
  },
};

function toMillis(ts: unknown): number {
  if (!ts) return 0;
  if (ts instanceof Date) return ts.getTime();
  if (
    typeof ts === 'object' &&
    ts !== null &&
    'toMillis' in ts &&
    typeof (ts as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export const AuditLogsModule: React.FC<AuditLogsModuleProps> = ({
  loading,
  logs,
  onNotify,
}) => {
  const [search, setSearch] = useState('');
  const [filterModule, setFilterModule] = useState('todos');
  const [filterAction, setFilterAction] = useState<'todos' | AuditAction>('todos');
  const [filterResult, setFilterResult] = useState<'todos' | AuditResult>('todos');

  const modules = useMemo(() => {
    const set = new Set<string>();
    logs.forEach((l) => set.add(l.modulo));
    return Array.from(set).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs
      .filter((l) => {
        if (filterModule !== 'todos' && l.modulo !== filterModule) return false;
        if (filterAction !== 'todos' && l.acao !== filterAction) return false;
        const resVal: AuditResult = l.resultado ?? 'sucesso';
        if (filterResult !== 'todos' && resVal !== filterResult) return false;
        if (q) {
          const hay = `${l.userName} ${l.userEmail} ${l.modulo} ${l.resumo} ${l.origem ?? ''} ${l.dadosAnteriores ?? ''} ${l.dadosPosteriores ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  }, [logs, search, filterModule, filterAction, filterResult]);

  const handleExport = () => {
    if (filtered.length === 0) {
      onNotify('info', 'Nenhum registro para exportar.');
      return;
    }
    exportToCSV(
      'historico_auditoria',
      [
        'Data/Hora',
        'Usuário Responsável',
        'E-mail',
        'Módulo',
        'Operação',
        'Origem',
        'Resultado',
        'Dados Anteriores',
        'Dados Posteriores',
        'Resumo',
      ],
      filtered.map((l) => [
        formatTimestampBR(l.createdAt),
        l.userName,
        l.userEmail,
        l.modulo,
        ACTION_LABELS[l.acao] ?? l.acao,
        l.origem ?? 'Interface Web',
        RESULT_BADGES[l.resultado ?? 'sucesso'].label,
        l.dadosAnteriores ?? '—',
        l.dadosPosteriores ?? '—',
        l.resumo,
      ])
    );
    onNotify('success', 'Histórico de auditoria exportado em CSV.');
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar usuário, origem, dados ou ação..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <select
            value={filterModule}
            onChange={(e) => setFilterModule(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todos">Todos os módulos</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value as 'todos' | AuditAction)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todos">Todas as ações</option>
            {(Object.keys(ACTION_LABELS) as AuditAction[]).map((key) => (
              <option key={key} value={key}>
                {ACTION_LABELS[key]}
              </option>
            ))}
          </select>

          <select
            value={filterResult}
            onChange={(e) => setFilterResult(e.target.value as 'todos' | AuditResult)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            <option value="todos">Todos os resultados</option>
            <option value="sucesso">Sucesso</option>
            <option value="bloqueado">Bloqueado</option>
            <option value="erro">Erro</option>
          </select>
        </div>

        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="w-4 h-4" />
          Exportar CSV
        </button>
      </div>

      {loading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<History className="w-6 h-6" />}
          title="Nenhuma operação registrada no histórico"
          description="Todas as criações, edições, exclusões, importações, conciliações e movimentações de estoque são gravadas automaticamente com origem, resultado e dados anteriores/posteriores."
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Data / Hora</th>
                  <th className="text-left font-medium px-4 py-3">Usuário</th>
                  <th className="text-left font-medium px-4 py-3">Módulo / Origem</th>
                  <th className="text-left font-medium px-4 py-3">Operação / Resultado</th>
                  <th className="text-left font-medium px-4 py-3">Descrição e Dados (Antes → Depois)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((log) => {
                  const resBadge = RESULT_BADGES[log.resultado ?? 'sucesso'] ?? RESULT_BADGES.sucesso;
                  return (
                    <tr key={log.id} className="hover:bg-slate-50/70 align-top">
                      <td className="px-4 py-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatTimestampBR(log.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900 text-xs">{log.userName}</p>
                        <p className="text-[11px] text-slate-500">{log.userEmail}</p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-xs font-medium text-slate-800">{log.modulo}</p>
                        <p className="text-[11px] text-slate-500">{log.origem ?? 'Interface Web'}</p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <p className="text-xs font-semibold text-blue-700 mb-1">
                          {ACTION_LABELS[log.acao] ?? log.acao}
                        </p>
                        <span
                          className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded border ${resBadge.className}`}
                        >
                          {resBadge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-700 space-y-1 max-w-md">
                        <p className="font-medium text-slate-800">{log.resumo}</p>
                        {(log.dadosAnteriores || log.dadosPosteriores) && (
                          <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 space-y-0.5">
                            {log.dadosAnteriores && (
                              <p>
                                <span className="font-semibold text-slate-600">Antes:</span>{' '}
                                {log.dadosAnteriores}
                              </p>
                            )}
                            {log.dadosPosteriores && (
                              <p>
                                <span className="font-semibold text-slate-600">Depois:</span>{' '}
                                {log.dadosPosteriores}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
