/**
 * PeriodSelector — Dropdown for selecting time period.
 */

export interface PeriodSelectorProps {
  value: string;
  onChange: (period: string) => void;
}

const periods = [
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
  { key: 'last_4_weeks', label: 'Last 4 Weeks' },
  { key: 'this_month', label: 'This Month' },
  { key: 'this_quarter', label: 'This Quarter' },
  { key: 'ytd', label: 'Year to Date' },
];

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <select
      className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring appearance-none pr-7"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {periods.map((p) => (
        <option key={p.key} value={p.key}>{p.label}</option>
      ))}
    </select>
  );
}
