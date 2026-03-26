/**
 * PipelineChart — Visual flow diagram: boxes connected by arrows.
 * Custom HTML/CSS component (not a Recharts chart).
 */

import { ArrowRight } from 'lucide-react';

export interface PipelineStageDatum {
  label: string;
  value: number;
  subLabel: string;
}

export interface PipelineChartProps {
  stages: PipelineStageDatum[];
}

function currencyFmt(v: number) {
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function PipelineChart({ stages }: PipelineChartProps) {
  return (
    <div className="flex items-center gap-0 overflow-x-auto py-2">
      {stages.map((stage, i) => (
        <div key={i} className="flex items-center shrink-0">
          <div className="flex flex-col items-center bg-card border border-border rounded-lg px-5 py-4 min-w-[130px] shadow-card">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              {stage.label}
            </span>
            <span className="text-lg font-bold text-foreground">
              {currencyFmt(stage.value)}
            </span>
            <span className="text-[10px] text-muted-foreground mt-1">
              {stage.subLabel}
            </span>
          </div>
          {i < stages.length - 1 && (
            <ArrowRight className="h-5 w-5 text-icon-main mx-2 shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}
