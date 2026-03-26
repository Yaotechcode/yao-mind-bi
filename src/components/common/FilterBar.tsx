/**
 * FilterBar — Horizontal bar of filter controls with clear-all.
 */

import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FilterDef {
  key: string;
  label: string;
  type: 'select' | 'multiselect' | 'daterange' | 'number';
  options?: string[];
}

export interface FilterBarProps {
  filters: FilterDef[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}

export function FilterBar({ filters, values, onChange }: FilterBarProps) {
  const activeCount = Object.values(values).filter(
    (v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  ).length;

  const clearAll = useCallback(() => {
    const empty: Record<string, unknown> = {};
    filters.forEach((f) => { empty[f.key] = undefined; });
    onChange(empty);
  }, [filters, onChange]);

  const updateFilter = (key: string, val: unknown) => {
    onChange({ ...values, [key]: val });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {filters.map((f) => (
        <div key={f.key} className="relative">
          {f.type === 'select' && f.options && (
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring appearance-none pr-7"
              value={(values[f.key] as string) ?? ''}
              onChange={(e) => updateFilter(f.key, e.target.value || undefined)}
            >
              <option value="">{f.label}</option>
              {f.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}

          {f.type === 'multiselect' && f.options && (
            <select
              multiple
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={(values[f.key] as string[]) ?? []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, (o) => o.value);
                updateFilter(f.key, selected.length > 0 ? selected : undefined);
              }}
            >
              {f.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          )}

          {f.type === 'number' && (
            <input
              type="number"
              placeholder={f.label}
              className="h-8 w-24 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={(values[f.key] as number) ?? ''}
              onChange={(e) => updateFilter(f.key, e.target.value ? Number(e.target.value) : undefined)}
            />
          )}
        </div>
      ))}

      {activeCount > 0 && (
        <Button variant="ghost" size="sm" onClick={clearAll} className="text-muted-foreground">
          <X className="h-3.5 w-3.5 mr-1" />
          Clear ({activeCount})
        </Button>
      )}
    </div>
  );
}
