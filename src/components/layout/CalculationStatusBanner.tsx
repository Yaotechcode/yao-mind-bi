/**
 * CalculationStatusBanner — shows recalculation status at top of content area.
 */

import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCalculationStatus } from '@/hooks/useCalculationStatus';

export function CalculationStatusBanner() {
  const { status, isStale, triggerRecalculate, isRecalculating } = useCalculationStatus();

  if (!status) return null;

  // Currently recalculating
  if (status.inProgress || isRecalculating) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 bg-accent border-b border-border text-sm text-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-xs font-medium">Recalculating KPIs…</span>
      </div>
    );
  }

  // Stale — new data available
  if (isStale) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-accent border-b border-border">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-warning" />
          <span className="text-xs font-medium text-foreground">New data available — recalculate to update dashboards</span>
        </div>
        <Button size="sm" onClick={() => triggerRecalculate()}>
          Recalculate
        </Button>
      </div>
    );
  }

  return null;
}
