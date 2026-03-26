/**
 * RagBadge — Small pill showing RAG status with icon and optional label.
 */

import { Check, AlertTriangle, X, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

type RagStatus = 'green' | 'amber' | 'red' | 'neutral';

export interface RagBadgeProps {
  status: RagStatus;
  label?: string;
}

const config: Record<RagStatus, { bg: string; text: string; icon: React.ReactNode }> = {
  green: {
    bg: 'bg-success/10',
    text: 'text-success',
    icon: <Check className="h-3 w-3" />,
  },
  amber: {
    bg: 'bg-warning/10',
    text: 'text-warning',
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  red: {
    bg: 'bg-error/10',
    text: 'text-error',
    icon: <X className="h-3 w-3" />,
  },
  neutral: {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    icon: <Minus className="h-3 w-3" />,
  },
};

export function RagBadge({ status, label }: RagBadgeProps) {
  const c = config[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider',
        c.bg,
        c.text,
      )}
    >
      {c.icon}
      {label && <span>{label}</span>}
    </span>
  );
}
