/**
 * DashboardPlaceholder — Generic placeholder for dashboard pages awaiting data.
 */

import { Upload } from 'lucide-react';

interface DashboardPlaceholderProps {
  title: string;
}

export function DashboardPlaceholder({ title }: DashboardPlaceholderProps) {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-foreground leading-9 mb-6">{title}</h1>
      <div className="flex flex-col items-center justify-center py-20 bg-card rounded-lg border border-border shadow-card">
        <Upload className="h-10 w-10 text-icon-main mb-4" />
        <p className="text-sm font-medium text-foreground mb-1">No data yet</p>
        <p className="text-xs text-muted-foreground">Upload data to view this dashboard</p>
      </div>
    </div>
  );
}
