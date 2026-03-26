/**
 * StandardSettings — Firm profile, working time, cost calculation, fee share, revenue attribution, RAG thresholds.
 */

import { useState, useCallback } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/useConfig';
import { DashboardSection } from '@/components/common/DashboardSection';
import { Button } from '@/components/ui/button';
import { AlertCard } from '@/components/common/AlertCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SavedIndicator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-success text-[11px] font-medium animate-pulse">
      <Check className="h-3 w-3" /> Saved
    </span>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-standard-background last:border-b-0">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  prefix,
  className,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  className?: string;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      <input
        type="number"
        className={cn(
          'h-8 w-20 rounded-input border border-input bg-background px-2 text-xs text-foreground text-right focus:ring-2 focus:ring-ring',
          className,
        )}
        value={value ?? ''}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function RadioOption({
  id,
  label,
  description,
  checked,
  onChange,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
  children?: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
        checked ? 'border-primary bg-accent/30' : 'border-border bg-card hover:bg-standard-background',
      )}
    >
      <input type="radio" id={id} checked={checked} onChange={onChange} className="mt-0.5 accent-[hsl(var(--primary))]" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        {children}
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// RAG Thresholds section
// ---------------------------------------------------------------------------

const DEFAULT_RAG_METRICS = [
  { key: 'utilisation', label: 'Utilisation %', green: 85, amber: 70, red: 0 },
  { key: 'realisation', label: 'Realisation %', green: 90, amber: 75, red: 0 },
  { key: 'lockup', label: 'Lock-up Days', green: 0, amber: 90, red: 150 },
  { key: 'writeOff', label: 'Write-off Rate %', green: 0, amber: 5, red: 10 },
  { key: 'recording', label: 'Recording Gap Days', green: 0, amber: 3, red: 7 },
  { key: 'wipAge', label: 'WIP Age (days)', green: 0, amber: 60, red: 90 },
  { key: 'debtorDays', label: 'Debtor Days', green: 0, amber: 60, red: 90 },
];

function RagThresholdTable({
  onSave,
}: {
  onSave: (key: string, values: { green: number; amber: number; red: number }) => void;
}) {
  const [thresholds, setThresholds] = useState(
    DEFAULT_RAG_METRICS.map((m) => ({ ...m })),
  );

  const update = (idx: number, field: 'green' | 'amber' | 'red', val: number) => {
    setThresholds((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: val };
      return next;
    });
    const row = thresholds[idx];
    onSave(row.key, { ...row, [field]: val });
  };

  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-standard-background">
            <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Metric</th>
            <th className="px-3 py-2 text-right text-[11px] font-semibold text-success uppercase tracking-wider">Green</th>
            <th className="px-3 py-2 text-right text-[11px] font-semibold text-warning uppercase tracking-wider">Amber</th>
            <th className="px-3 py-2 text-right text-[11px] font-semibold text-error uppercase tracking-wider">Red</th>
          </tr>
        </thead>
        <tbody>
          {thresholds.map((row, idx) => (
            <tr key={row.key} className="border-b border-standard-background">
              <td className="px-3 py-2 font-medium text-foreground">{row.label}</td>
              <td className="px-3 py-2 text-right">
                <input
                  type="number"
                  className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                  value={row.green}
                  onChange={(e) => update(idx, 'green', Number(e.target.value))}
                />
              </td>
              <td className="px-3 py-2 text-right">
                <input
                  type="number"
                  className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                  value={row.amber}
                  onChange={(e) => update(idx, 'amber', Number(e.target.value))}
                />
              </td>
              <td className="px-3 py-2 text-right">
                <input
                  type="number"
                  className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                  value={row.red}
                  onChange={(e) => update(idx, 'red', Number(e.target.value))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StandardSettings() {
  const { config, updateConfig } = useConfig();
  const [savedField, setSavedField] = useState<string | null>(null);
  const [needsRecalc, setNeedsRecalc] = useState(false);

  const save = useCallback(
    async (path: string, value: unknown, affectsFormulas = false) => {
      try {
        await updateConfig(path, value);
        setSavedField(path);
        if (affectsFormulas) setNeedsRecalc(true);
        setTimeout(() => setSavedField(null), 2000);
      } catch {
        toast.error('Failed to save setting');
      }
    },
    [updateConfig],
  );

  // Local state derived from config
  const firmName = config?.firmName ?? '';
  const currency = config?.currency ?? 'GBP';
  const fyStartMonth = config?.financialYearStartMonth ?? 4;
  const workingDays = config?.workingDaysPerWeek ?? 5;
  const dailyTarget = config?.dailyTargetHours ?? 7.5;
  const weeklyTarget = config?.weeklyTargetHours ?? (workingDays * dailyTarget);
  const chargeableTarget = config?.chargeableWeeklyTarget ?? 26.25;
  const annualLeave = config?.annualLeaveEntitlement ?? 25;
  const bankHolidays = config?.bankHolidaysPerYear ?? 8;
  const costMethod = config?.costRateMethod ?? 'fully_loaded';
  const feeSharePct = config?.defaultFeeSharePercent ?? 60;
  const showLawyerPerspective = config?.showLawyerPerspective ?? true;
  const utilisationApproach = config?.utilisationApproach ?? 'assume_fulltime';
  const revenueAttribution = config?.revenueAttribution ?? 'responsible_lawyer';

  const FY_OPTIONS = [
    { value: 1, label: 'January' },
    { value: 4, label: 'April (UK standard)' },
    { value: 7, label: 'July' },
    { value: 10, label: 'October' },
  ];

  return (
    <div className="space-y-6 max-w-3xl">
      {needsRecalc && (
        <AlertCard
          type="warning"
          title="Recalculation needed"
          message="Changes to these settings affect formula calculations. Run a recalculation to update your dashboards."
          action={{ label: 'Recalculate', onClick: () => setNeedsRecalc(false) }}
        />
      )}

      {/* 1. Firm Profile */}
      <DashboardSection title="Firm Profile">
        <SettingRow label="Firm Name">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="h-8 w-48 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={firmName}
              onChange={(e) => save('firmName', e.target.value)}
            />
            <SavedIndicator show={savedField === 'firmName'} />
          </div>
        </SettingRow>
        <SettingRow label="Financial Year End">
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={fyStartMonth}
              onChange={(e) => save('financialYearStartMonth', Number(e.target.value))}
            >
              {FY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <SavedIndicator show={savedField === 'financialYearStartMonth'} />
          </div>
        </SettingRow>
        <SettingRow label="Currency">
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={currency}
              onChange={(e) => save('currency', e.target.value)}
            >
              <option value="GBP">GBP (£)</option>
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
            </select>
            <SavedIndicator show={savedField === 'currency'} />
          </div>
        </SettingRow>
      </DashboardSection>

      {/* 2. Working Time Defaults */}
      <DashboardSection title="Working Time Defaults">
        <SettingRow label="Working days per week">
          <div className="flex items-center gap-2">
            <NumberInput value={workingDays} onChange={(v) => save('workingDaysPerWeek', v, true)} min={1} max={7} />
            <SavedIndicator show={savedField === 'workingDaysPerWeek'} />
          </div>
        </SettingRow>
        <SettingRow label="Daily target hours">
          <div className="flex items-center gap-2">
            <NumberInput value={dailyTarget} onChange={(v) => save('dailyTargetHours', v, true)} min={0} max={24} step={0.5} />
            <SavedIndicator show={savedField === 'dailyTargetHours'} />
          </div>
        </SettingRow>
        <SettingRow label="Weekly target hours" description={`Derived: ${workingDays} × ${dailyTarget} = ${weeklyTarget}`}>
          <div className="flex items-center gap-2">
            <NumberInput value={weeklyTarget} onChange={(v) => save('weeklyTargetHours', v, true)} min={0} step={0.5} />
            <SavedIndicator show={savedField === 'weeklyTargetHours'} />
          </div>
        </SettingRow>
        <SettingRow label="Chargeable weekly target">
          <div className="flex items-center gap-2">
            <NumberInput value={chargeableTarget} onChange={(v) => save('chargeableWeeklyTarget', v, true)} min={0} step={0.25} />
            <SavedIndicator show={savedField === 'chargeableWeeklyTarget'} />
          </div>
        </SettingRow>
        <SettingRow label="Annual leave entitlement" description="Days per year">
          <div className="flex items-center gap-2">
            <NumberInput value={annualLeave} onChange={(v) => save('annualLeaveEntitlement', v, true)} min={0} />
            <SavedIndicator show={savedField === 'annualLeaveEntitlement'} />
          </div>
        </SettingRow>
        <SettingRow label="Bank holidays per year">
          <div className="flex items-center gap-2">
            <NumberInput value={bankHolidays} onChange={(v) => save('bankHolidaysPerYear', v, true)} min={0} />
            <SavedIndicator show={savedField === 'bankHolidaysPerYear'} />
          </div>
        </SettingRow>
      </DashboardSection>

      {/* 3. Cost Calculation */}
      <DashboardSection title="Cost Calculation">
        <p className="text-xs text-muted-foreground mb-3">How should we calculate the cost of salaried fee earners?</p>
        <div className="space-y-2">
          <RadioOption
            id="cost-direct"
            label="Salary only"
            description="Annual salary ÷ available hours"
            checked={costMethod === 'direct'}
            onChange={() => save('costRateMethod', 'direct', true)}
          >
            <p className="text-[11px] text-muted-foreground mt-1 italic">Example: Nathaniel Colbran = £33.63/hr</p>
          </RadioOption>
          <RadioOption
            id="cost-loaded"
            label="Fully loaded (recommended)"
            description="Salary + NI + pension + variable ÷ available hours"
            checked={costMethod === 'fully_loaded'}
            onChange={() => save('costRateMethod', 'fully_loaded', true)}
          >
            <p className="text-[11px] text-muted-foreground mt-1 italic">Example: Nathaniel Colbran = £38.42/hr</p>
          </RadioOption>
          <RadioOption
            id="cost-market"
            label="Custom multiplier"
            description="Salary × multiplier ÷ available hours"
            checked={costMethod === 'market_rate'}
            onChange={() => save('costRateMethod', 'market_rate', true)}
          />
        </div>
      </DashboardSection>

      {/* 4. Fee Share Configuration */}
      <DashboardSection title="Fee Share Configuration">
        <SettingRow label="Default fee share %" description={`Firm retains: ${100 - feeSharePct}%`}>
          <div className="flex items-center gap-2">
            <NumberInput value={feeSharePct} onChange={(v) => save('defaultFeeSharePercent', v, true)} min={0} max={100} />
            <SavedIndicator show={savedField === 'defaultFeeSharePercent'} />
          </div>
        </SettingRow>
        <SettingRow label="Show lawyer income perspective">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showLawyerPerspective}
              onChange={(e) => save('showLawyerPerspective', e.target.checked)}
              className="accent-[hsl(var(--primary))]"
            />
            <SavedIndicator show={savedField === 'showLawyerPerspective'} />
          </div>
        </SettingRow>
        <SettingRow label="Utilisation tracking">
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
              value={utilisationApproach}
              onChange={(e) => save('utilisationApproach', e.target.value, true)}
            >
              <option value="assume_fulltime">Assume full-time</option>
              <option value="fte_adjusted">Individual targets</option>
            </select>
            <SavedIndicator show={savedField === 'utilisationApproach'} />
          </div>
        </SettingRow>
      </DashboardSection>

      {/* 5. Revenue Attribution */}
      <DashboardSection title="Revenue Attribution">
        <p className="text-xs text-muted-foreground mb-3">When a matter has multiple fee earners, how is revenue attributed?</p>
        <div className="space-y-2">
          <RadioOption
            id="rev-responsible"
            label="Responsible lawyer"
            description="100% to the matter's responsible lawyer"
            checked={revenueAttribution === 'responsible_lawyer'}
            onChange={() => save('revenueAttribution', 'responsible_lawyer', true)}
          />
          <RadioOption
            id="rev-billing"
            label="Proportional by hours"
            description="Split by hours recorded"
            checked={revenueAttribution === 'billing_lawyer'}
            onChange={() => save('revenueAttribution', 'billing_lawyer', true)}
          />
          <RadioOption
            id="rev-supervisor"
            label="Proportional by value"
            description="Split by billable value recorded"
            checked={revenueAttribution === 'supervisor'}
            onChange={() => save('revenueAttribution', 'supervisor', true)}
          />
        </div>
      </DashboardSection>

      {/* 6. RAG Thresholds */}
      <DashboardSection title="RAG Thresholds">
        <RagThresholdTable
          onSave={(key, values) => save(`ragThresholds.${key}`, values, true)}
        />
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              save('ragThresholds', '__reset_defaults__', true);
              toast.success('RAG thresholds reset to UK defaults');
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Reset to UK Law Firm Defaults
          </Button>
        </div>
      </DashboardSection>
    </div>
  );
}
