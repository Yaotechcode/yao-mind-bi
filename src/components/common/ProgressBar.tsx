/**
 * ProgressBar — Horizontal bar with RAG-coloured fill.
 */

import { cn } from '@/lib/utils';

type RagStatus = 'green' | 'amber' | 'red' | 'neutral';

export interface ProgressBarProps {
  value: number;
  max: number;
  ragStatus: RagStatus;
  showLabel?: boolean;
}

const ragFillMap: Record<RagStatus, string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-error',
  neutral: 'bg-icon-main',
};

export function ProgressBar({ value, max, ragStatus, showLabel = false }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const isWide = pct > 25;

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2.5 bg-muted rounded-sm overflow-hidden relative">
        <div
          className={cn('h-full rounded-sm transition-all duration-300', ragFillMap[ragStatus])}
          style={{ width: `${pct}%` }}
        >
          {showLabel && isWide && (
            <span className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold text-card">
              {Math.round(pct)}%
            </span>
          )}
        </div>
      </div>
      {showLabel && !isWide && (
        <span className="text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
