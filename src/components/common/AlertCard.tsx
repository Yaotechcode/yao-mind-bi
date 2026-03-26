/**
 * AlertCard — Notification card with type-based styling and optional action.
 */

import { AlertTriangle, Info, XCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type AlertType = 'warning' | 'info' | 'error' | 'success';

export interface AlertCardProps {
  type: AlertType;
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}

const alertConfig: Record<AlertType, { border: string; icon: React.ReactNode }> = {
  warning: {
    border: 'border-l-warning',
    icon: <AlertTriangle className="h-4 w-4 text-warning shrink-0" />,
  },
  info: {
    border: 'border-l-primary',
    icon: <Info className="h-4 w-4 text-primary shrink-0" />,
  },
  error: {
    border: 'border-l-error',
    icon: <XCircle className="h-4 w-4 text-error shrink-0" />,
  },
  success: {
    border: 'border-l-success',
    icon: <CheckCircle2 className="h-4 w-4 text-success shrink-0" />,
  },
};

export function AlertCard({ type, title, message, action }: AlertCardProps) {
  const c = alertConfig[type];
  return (
    <div
      className={cn(
        'flex items-start gap-3 bg-card border border-border border-l-4 rounded-lg p-4 shadow-card',
        c.border,
      )}
    >
      {c.icon}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{message}</p>
      </div>
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick} className="shrink-0">
          {action.label}
        </Button>
      )}
    </div>
  );
}
