/**
 * ToggleControl — Segmented control for switching between views.
 */

import { cn } from '@/lib/utils';

export interface ToggleOption {
  key: string;
  label: string;
}

export interface ToggleControlProps {
  options: ToggleOption[];
  value: string;
  onChange: (key: string) => void;
}

export function ToggleControl({ options, value, onChange }: ToggleControlProps) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted p-0.5" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.key}
          role="radio"
          aria-checked={value === opt.key}
          className={cn(
            'px-3 py-1.5 text-[11px] font-semibold rounded-sm transition-all',
            value === opt.key
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
