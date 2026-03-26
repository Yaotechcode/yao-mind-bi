/**
 * GroupBySelector — Tab-style selector for switching table grouping.
 */

import { cn } from '@/lib/utils';

export interface GroupByOption {
  key: string;
  label: string;
}

export interface GroupBySelectorProps {
  options: GroupByOption[];
  value: string;
  onChange: (key: string) => void;
}

export function GroupBySelector({ options, value, onChange }: GroupBySelectorProps) {
  return (
    <div className="flex items-center gap-0 border-b border-border">
      {options.map((opt) => (
        <button
          key={opt.key}
          className={cn(
            'px-3 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px',
            value === opt.key
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
