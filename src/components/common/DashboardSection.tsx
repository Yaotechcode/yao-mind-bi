/**
 * DashboardSection — Titled section with optional collapse and action slot.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DashboardSectionProps {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  action?: React.ReactNode;
}

export function DashboardSection({
  title,
  children,
  collapsible = false,
  defaultCollapsed = false,
  action,
}: DashboardSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 text-[15px] font-semibold text-foreground',
            collapsible && 'cursor-pointer hover:text-primary',
            !collapsible && 'cursor-default',
          )}
          onClick={collapsible ? () => setCollapsed(!collapsed) : undefined}
          disabled={!collapsible}
        >
          {collapsible && (
            collapsed
              ? <ChevronRight className="h-4 w-4" />
              : <ChevronDown className="h-4 w-4" />
          )}
          {title}
        </button>
        {action && <div>{action}</div>}
      </div>
      {(!collapsible || !collapsed) && <div>{children}</div>}
    </section>
  );
}
