import React, { useState } from 'react';
import { BarChart3, PieChart } from 'lucide-react';
import { formatBRL } from '../../utils/formatters';

export interface MonthlySeriesPoint {
  label: string;
  receitas: number;
  despesas: number;
}

export const MonthlyCashflowChart: React.FC<{
  data: MonthlySeriesPoint[];
}> = ({ data }) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const hasValues = data.some((d) => d.receitas > 0 || d.despesas > 0);
  if (!hasValues) {
    return (
      <div className="h-64 flex flex-col items-center justify-center text-center px-4">
        <BarChart3 className="w-8 h-8 text-slate-300 mb-2" />
        <p className="text-sm font-medium text-slate-700">Sem movimentações financeiras para exibir</p>
        <p className="text-xs text-slate-500 mt-1">
          Cadastre recebimentos ou despesas no módulo Financeiro para visualizar o comparativo mensal.
        </p>
      </div>
    );
  }

  const maxVal = Math.max(
    1,
    ...data.map((d) => Math.max(d.receitas, d.despesas))
  );

  const width = 560;
  const height = 220;
  const padLeft = 16;
  const padRight = 16;
  const padTop = 18;
  const padBottom = 34;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const groupW = chartW / Math.max(1, data.length);
  const barW = Math.min(24, groupW * 0.32);

  return (
    <div className="relative w-full min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-blue-700 inline-block" />
            Recebimentos
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-slate-400 inline-block" />
            Despesas
          </span>
        </div>
        {hoveredIdx !== null && data[hoveredIdx] && (
          <div className="text-xs font-mono tabular-nums text-slate-700">
            {data[hoveredIdx].label}:{' '}
            <span className="text-blue-700 font-semibold">
              {formatBRL(data[hoveredIdx].receitas)}
            </span>{' '}
            / <span className="text-slate-600">{formatBRL(data[hoveredIdx].despesas)}</span>
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full max-w-full h-56 overflow-hidden"
        role="img"
        aria-label="Gráfico financeiro de recebimentos e despesas"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const y = padTop + chartH * (1 - step);
          return (
            <line
              key={step}
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke="#E2E8F0"
              strokeWidth="1"
              strokeDasharray={step === 0 ? undefined : '3 3'}
            />
          );
        })}

        {data.map((point, idx) => {
          const centerX = padLeft + groupW * idx + groupW / 2;
          const recH = (point.receitas / maxVal) * chartH;
          const despH = (point.despesas / maxVal) * chartH;

          return (
            <g
              key={point.label}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="cursor-pointer"
            >
              <rect
                x={centerX - barW - 2}
                y={padTop + chartH - recH}
                width={barW}
                height={Math.max(2, recH)}
                rx="3"
                fill={hoveredIdx === idx ? '#1D4ED8' : '#0B1F3A'}
              />
              <rect
                x={centerX + 2}
                y={padTop + chartH - despH}
                width={barW}
                height={Math.max(2, despH)}
                rx="3"
                fill={hoveredIdx === idx ? '#64748B' : '#94A3B8'}
              />
              <text
                x={centerX}
                y={height - 10}
                textAnchor="middle"
                className="fill-slate-500 text-[11px]"
              >
                {point.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export interface CategorySlice {
  label: string;
  value: number;
  count: number;
}

const SLICE_COLORS = [
  '#0B1F3A',
  '#1D4ED8',
  '#3B82F6',
  '#60A5FA',
  '#475569',
  '#94A3B8',
  '#0284C7',
];

export const CategoryValueChart: React.FC<{
  data: CategorySlice[];
  emptyTitle?: string;
  emptySubtitle?: string;
}> = ({
  data,
  emptyTitle = 'Nenhum item em estoque cadastrado',
  emptySubtitle = 'Cadastre equipamentos e materiais para visualizar a composição patrimonial do estoque.',
}) => {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  if (data.length === 0 || total <= 0) {
    return (
      <div className="h-64 flex flex-col items-center justify-center text-center px-4">
        <PieChart className="w-8 h-8 text-slate-300 mb-2" />
        <p className="text-sm font-medium text-slate-700">{emptyTitle}</p>
        <p className="text-xs text-slate-500 mt-1">{emptySubtitle}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3.5 py-2">
      {data.slice(0, 6).map((item, idx) => {
        const pct = Math.round((item.value / total) * 1000) / 10;
        const color = SLICE_COLORS[idx % SLICE_COLORS.length];
        return (
          <div key={item.label} className="space-y-1.5 min-w-0">
            <div className="flex items-start justify-between gap-3 text-xs">
              <span className="font-medium text-slate-700 break-words min-w-0 flex-1">{item.label}</span>
              <span className="font-mono tabular-nums text-slate-600 shrink-0">
                {formatBRL(item.value)} ({pct.toFixed(1)}%)
              </span>
            </div>
            <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(2, pct)}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
