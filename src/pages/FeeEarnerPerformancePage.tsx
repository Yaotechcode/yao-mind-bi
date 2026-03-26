/**
 * FeeEarnerPerformancePage — Dashboard 2: Fee Earner Performance.
 * Route: /fee-earners
 */

import { useState, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { exportPdf, exportCsv } from '@/lib/api-client';
import type {
  FeeEarnerPerformancePayload,
  FeeEarnerRow,
} from '@/shared/types/dashboard-payloads';

// Common components
import {
  KpiCard,
  RagBadge,
  ToggleControl,
  FilterBar,
  DashboardSection,
  SortableTable,
  AlertCard,
  EmptyState,
  ExportButton,
  DashboardSkeleton,
} from '@/components/common';
import type { ColumnDef, FilterDef } from '@/components/common';

// Charts
import { UtilisationBarChart, StackedBarChart, RecordingHeatmap } from '@/components/charts';

// ---------------------------------------------------------------------------
// Currency / percentage formatters
// ---------------------------------------------------------------------------

const fmtCurrency = (v: unknown) =>
  v != null ? `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—';

const fmtPercent = (v: unknown) =>
  v != null ? `${Number(v).toFixed(1)}%` : '—';

const fmtHours = (v: unknown) =>
  v != null ? Number(v).toFixed(1) : '—';

const fmtRate = (v: unknown) =>
  v != null ? `£${Number(v).toFixed(0)}/hr` : '—';

const fmtScore = (v: unknown) =>
  v != null ? `${Number(v).toFixed(0)}/100` : '—';

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

const allColumns: ColumnDef[] = [
  { key: 'name', header: 'Name', minWidth: 140 },
  { key: 'department', header: 'Department', minWidth: 110 },
  { key: 'grade', header: 'Grade', minWidth: 80 },
  { key: 'payModel', header: 'Pay Model', minWidth: 90 },
  { key: 'chargeableHours', header: 'Chargeable Hrs', align: 'right', render: fmtHours },
  { key: 'totalHours', header: 'Total Hrs', align: 'right', render: fmtHours },
  {
    key: 'utilisation',
    header: 'Utilisation %',
    align: 'right',
    render: (v, row) => (
      <span className="inline-flex items-center gap-1.5">
        {fmtPercent(v)}
        <RagBadge status={(row as Record<string, unknown>).utilisationRag as 'green' | 'amber' | 'red' | 'neutral'} />
      </span>
    ),
  },
  { key: 'wipValueRecorded', header: 'WIP Value', align: 'right', render: fmtCurrency },
  { key: 'billedRevenue', header: 'Billed Revenue', align: 'right', render: fmtCurrency },
  { key: 'effectiveRate', header: 'Effective Rate', align: 'right', render: fmtRate },
  { key: 'writeOffRate', header: 'Write-Off %', align: 'right', render: fmtPercent },
  {
    key: 'scorecard',
    header: 'Scorecard',
    align: 'right',
    render: (v, row) => (
      <span className="inline-flex items-center gap-1.5">
        {fmtScore(v)}
        <RagBadge status={(row as Record<string, unknown>).scorecardRag as 'green' | 'amber' | 'red' | 'neutral'} />
      </span>
    ),
  },
];

const DEFAULT_VISIBLE = [
  'name', 'department', 'utilisation', 'grade',
  'chargeableHours', 'billedRevenue', 'effectiveRate',
];

// ---------------------------------------------------------------------------
// Expanded row detail
// ---------------------------------------------------------------------------

function ExpandedFeeEarner({ fe }: { fe: FeeEarnerRow }) {
  const navigate = useNavigate();
  const [feeShareView, setFeeShareView] = useState('firm');

  return (
    <div className="space-y-4">
      {/* KPI cards row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          title="Utilisation"
          value={fe.utilisation}
          format="percent"
          ragStatus={fe.utilisationRag as 'green' | 'amber' | 'red' | 'neutral'}
        />
        <KpiCard
          title="Effective Rate"
          value={fe.effectiveRate}
          format="currency"
          ragStatus="neutral"
        />
        <KpiCard
          title="Revenue"
          value={fe.billedRevenue}
          format="currency"
          ragStatus="neutral"
        />
        <KpiCard
          title="Write-Off Rate"
          value={fe.writeOffRate}
          format="percent"
          ragStatus="neutral"
        />
        <KpiCard
          title="Scorecard"
          value={fe.scorecard}
          format="number"
          ragStatus={fe.scorecardRag as 'green' | 'amber' | 'red' | 'neutral'}
          subtitle="/100"
        />
      </div>

      {/* Pay model section */}
      <div className="bg-muted/30 rounded-lg p-4">
        {fe.payModel === 'salaried' ? (
          <>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Salaried Profitability
            </h4>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground text-xs">Employment Cost</span>
                <p className="text-foreground font-medium">{fmtCurrency(fe.employmentCost)}</p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Revenue Multiple</span>
                <p className="text-foreground font-medium">
                  {fe.revenueMultiple != null ? `${fe.revenueMultiple.toFixed(1)}×` : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Profit Contribution</span>
                <p className="text-foreground font-medium">{fmtCurrency(fe.profit)}</p>
              </div>
            </div>
          </>
        ) : fe.payModel === 'fee_share' ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Fee Share Analysis
              </h4>
              <ToggleControl
                options={[
                  { key: 'firm', label: 'Firm View' },
                  { key: 'lawyer', label: 'Lawyer View' },
                ]}
                value={feeShareView}
                onChange={setFeeShareView}
              />
            </div>
            {feeShareView === 'firm' ? (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">Firm Retained Revenue</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.firmRetainedRevenue)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Firm Overhead Cost</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.firmOverheadCost)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Firm Profit</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.firmProfit)}</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">Gross Revenue</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.billedRevenue)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Lawyer Share (60%)</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.lawyerShare)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Firm Deduction (40%)</span>
                  <p className="text-foreground font-medium">{fmtCurrency(fe.firmRetainedRevenue)}</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Pay model: {fe.payModel}</p>
        )}
      </div>

      {/* Recording heatmap */}
      {fe.recordingPattern && fe.recordingPattern.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Recording Consistency
          </h4>
          <RecordingHeatmap data={fe.recordingPattern} label={fe.name} />
        </div>
      )}

      {/* Matters summary */}
      <div className="flex items-center gap-4 text-xs">
        <span className="text-foreground">
          <strong>{fe.matterCount}</strong> active matters
        </span>
        <button
          className="text-primary hover:underline font-medium"
          onClick={() => navigate(`/matters?lawyer=${encodeURIComponent(fe.name)}`)}
        >
          View matters →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function FeeEarnerPerformancePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Initialise filters from URL params
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    const dept = searchParams.get('department');
    if (dept) initial.department = dept;
    return initial;
  });

  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_VISIBLE);

  // Build API filters
  const apiFilters = useMemo(() => {
    const f: Record<string, string | boolean | undefined> = {};
    if (filterValues.department) f.department = filterValues.department as string;
    if (filterValues.grade) f.grade = filterValues.grade as string;
    if (filterValues.payModel) f.payModel = filterValues.payModel as string;
    f.activeOnly = filterValues.activeOnly !== false ? 'true' : 'false';
    return f;
  }, [filterValues]);

  const { data, isLoading } = useDashboardData('fee-earner-performance', apiFilters);

  // Filter defs from API response
  const filterDefs: FilterDef[] = useMemo(() => [
    { key: 'department', label: 'Department', type: 'select', options: data?.filters.departments ?? [] },
    { key: 'grade', label: 'Grade', type: 'select', options: data?.filters.grades ?? [] },
    { key: 'payModel', label: 'Pay Model', type: 'select', options: ['All', 'Salaried', 'Fee Share'] },
  ], [data?.filters]);

  const handleColToggle = useCallback((key: string) => {
    setVisibleCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  // Chargeable stacked bar data
  const chargeableStackData = useMemo(
    () =>
      (data?.charts.chargeableStack ?? []).map((d) => ({
        name: d.name,
        segments: [
          { key: 'chargeable', value: d.chargeable, colour: 'hsl(180 88% 38%)' },
          { key: 'nonChargeable', value: d.nonChargeable, colour: 'hsl(212 13% 69%)' },
        ],
      })),
    [data?.charts.chargeableStack],
  );

  // Export handlers
  const handleExportCsv = () => {
    if (!data) return;
    exportCsv(
      data.feeEarners as unknown as Record<string, unknown>[],
      visibleCols,
      'fee-earner-performance.csv',
    );
  };

  const handleExportPdf = async () => {
    const blob = await exportPdf('fee-earner-performance', apiFilters);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fee-earner-performance.pdf';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Loading
  if (isLoading) return <DashboardSkeleton />;

  // Empty state
  if (!data?.feeEarners || data.feeEarners.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Upload className="h-10 w-10" />}
          title="Upload your Yao data to view Fee Earner Performance"
          message="Import your practice management data to generate fee earner KPIs."
          action={{ label: 'Go to Data Management', onClick: () => navigate('/data') }}
        />
      </div>
    );
  }

  const d = data as FeeEarnerPerformancePayload;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-foreground leading-9">Fee Earner Performance</h1>
        <ExportButton onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
      </div>

      {/* Filters */}
      <FilterBar filters={filterDefs} values={filterValues} onChange={setFilterValues} />

      {/* Alerts */}
      {d.alerts.length > 0 && (
        <DashboardSection
          title={`Alerts (${d.alerts.length})`}
          collapsible
          defaultCollapsed={d.alerts.length > 3}
        >
          <div className="space-y-2">
            {d.alerts.map((alert) => (
              <AlertCard
                key={alert.feeEarnerId + alert.type}
                type={alert.type === 'recording_gap' ? 'warning' : 'info'}
                title={alert.name}
                message={alert.message}
              />
            ))}
          </div>
        </DashboardSection>
      )}

      {/* Main table */}
      <DashboardSection title="Fee Earners">
        <SortableTable
          columns={allColumns}
          data={d.feeEarners as unknown as Record<string, unknown>[]}
          defaultSort={{ key: 'utilisation', direction: 'asc' }}
          expandable
          renderExpanded={(row) => (
            <ExpandedFeeEarner fe={row as unknown as FeeEarnerRow} />
          )}
          columnVisibility={{
            visible: visibleCols,
            onToggle: handleColToggle,
          }}
          exportFilename="fee-earner-performance"
        />
      </DashboardSection>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DashboardSection title="Utilisation by Fee Earner">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <UtilisationBarChart data={d.charts.utilisationBars} />
          </div>
        </DashboardSection>

        <DashboardSection title="Chargeable vs Non-Chargeable">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <StackedBarChart
              data={chargeableStackData}
              labels={{ chargeable: 'Chargeable', nonChargeable: 'Non-Chargeable' }}
            />
          </div>
        </DashboardSection>
      </div>
    </div>
  );
}
