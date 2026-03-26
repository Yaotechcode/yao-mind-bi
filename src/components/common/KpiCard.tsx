/**
 * KpiCard — Dashboard KPI card with RAG status, trend, and formatted value.
 */

import { TrendingUp, TrendingDown, Minus, CheckCircle2, AlertTriangle, XCircle, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

type ValueFormat = 'currency' | 'percent' | 'days' | 'number' | 'ratio';
type RagStatus = 'green' | 'amber' | 'red' | 'neutral';

export interface KpiCardProps {
  title: string;
  value: number | null;
  format: ValueFormat;
  ragStatus: RagStatus;
  trend?: { direction: 'up' | 'down' | 'flat'; value: string };
  subtitle?: string;
  onClick?: () => void;
}

const ragBorderMap: Record<RagStatus, string> = {
  green: 'border-l-success',
  amber: 'border-l-warning',
  red: 'border-l-error',
  neutral: 'border-l-border',
};

const ragIconMap: Record<RagStatus, React.ReactNode> = {
  green: <CheckCircle2 className="h-4 w-4 text-success" aria-label="Status: good" />,
  amber: <AlertTriangle className="h-4 w-4 text-warning" aria-label="Status: needs attention" />,
  red: <XCircle className="h-4 w-4 text-error" aria-label="Status: critical" />,
  neutral: <Circle className="h-4 w-4 text-icon-main" aria-label="Status: neutral" />,
};

function formatValue(value: number | null, format: ValueFormat): string {
  if (value === null || value === undefined) return '—';
  switch (format) {
    case 'currency':
      return `£${value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'days':
      return `${Math.round(value)} days`;
    case 'ratio':
      return value.toFixed(2);
    case 'number':
    default:
      return value.toLocaleString('en-GB');
  }
}

export function KpiCard({ title, value, format, ragStatus, trend, subtitle, onClick }: KpiCardProps) {
  return (
    <div
      className={cn(
        'bg-card rounded-lg border border-border border-l-4 shadow-card p-4 transition-all',
        ragBorderMap[ragStatus],
        onClick && 'cursor-pointer hover:shadow-button hover:-translate-y-0.5',
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {ragIconMap[ragStatus]}
      </div>

      <p className="text-2xl font-bold text-foreground leading-9">
        {formatValue(value, format)}
      </p>

      {subtitle && (
        <p className="text-[11px] text-muted-foreground mt-1">{subtitle}</p>
      )}

      {trend && (
        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-border">
          {trend.direction === 'up' && <TrendingUp className="h-3.5 w-3.5 text-success" />}
          {trend.direction === 'down' && <TrendingDown className="h-3.5 w-3.5 text-error" />}
          {trend.direction === 'flat' && <Minus className="h-3.5 w-3.5 text-icon-main" />}
          <span className="text-[11px] text-muted-foreground">{trend.value}</span>
        </div>
      )}
    </div>
  );
}
