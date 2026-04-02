/**
 * FirmOverviewPage — Dashboard 1: Firm Overview.
 * Default landing page after login.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { FirmOverviewPayload } from '@/shared/types/dashboard-payloads';
import { exportPdf, exportCsv } from '@/lib/api-client';

// Common components
import { KpiCard } from '@/components/common/KpiCard';
import { ToggleControl } from '@/components/common/ToggleControl';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { DashboardSection } from '@/components/common/DashboardSection';
import { SortableTable, type ColumnDef } from '@/components/common/SortableTable';
import { RagBadge } from '@/components/common/RagBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { ExportButton } from '@/components/common/ExportButton';
import { DashboardSkeleton } from '@/components/common/DashboardSkeleton';
import { DataQualityBanner } from '@/components/layout/DataQualityBanner';

// Charts
import { WipAgeBandChart } from '@/components/charts/WipAgeBandChart';
import { TrendLineChart } from '@/components/charts/TrendLineChart';

import { Upload } from 'lucide-react';

// ---------------------------------------------------------------------------
// Leakage table columns
// ---------------------------------------------------------------------------

type LeakageRow = FirmOverviewPayload['topLeakageRisks'][number];

const leakageColumns: ColumnDef[] = [
  {
    key: 'matterNumber',
    header: 'Matter #',
    minWidth: 100,
    render: (v) => (v && String(v).trim() !== '' ? String(v) : '—'),
  },
  { key: 'clientName', header: 'Client', minWidth: 140 },
  { key: 'lawyerName', header: 'Lawyer', minWidth: 120 },
  {
    key: 'wipValue',
    header: 'WIP Value',
    align: 'right',
    render: (v) => `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
  },
  {
    key: 'wipAge',
    header: 'Age (days)',
    align: 'right',
    render: (v) => `${v}`,
  },
  {
    key: 'ragStatus',
    header: 'RAG',
    align: 'center',
    render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
  },
];

// ---------------------------------------------------------------------------
// Department table columns
// ---------------------------------------------------------------------------

type DeptRow = FirmOverviewPayload['departmentSummary'][number];

const deptColumns: ColumnDef[] = [
  { key: 'name', header: 'Department', minWidth: 120 },
  {
    key: 'wipValue',
    header: 'WIP Value',
    align: 'right',
    render: (v) => `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
  },
  { key: 'matterCount', header: 'Matters', align: 'right' },
  {
    key: 'utilisation',
    header: 'Utilisation',
    align: 'right',
    render: (v) => (v != null ? `${Number(v).toFixed(1)}%` : '—'),
  },
  {
    key: 'ragStatus',
    header: 'RAG',
    align: 'center',
    render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
  },
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function FirmOverviewPage() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState('this_month');
  const [viewMode, setViewMode] = useState('gross');

  const { data, isLoading, error } = useDashboardData('firm-overview', { period });

  // Revenue trend chart lines
  const revenueTrendLines = useMemo(
    () => [
      { key: 'billed', colour: 'hsl(193 98% 35%)', type: 'bar' as const },
      { key: 'target', colour: 'hsl(180 88% 38%)', type: 'line' as const },
    ],
    [],
  );

  const revenueTrendData = useMemo(
    () =>
      data?.revenueTrend?.map((pt) => ({
        period: pt.period,
        values: { billed: pt.billed, target: pt.target ?? 0 },
      })) ?? [],
    [data],
  );

  // Loading state
  if (isLoading) return <DashboardSkeleton />;

  // Empty state
  if (!data?.kpiCards) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Upload className="h-10 w-10" />}
          title="Upload your Yao data to see the Firm Overview"
          message="Import your practice management data to generate KPIs and insights."
          action={{ label: 'Go to Data Management', onClick: () => navigate('/data') }}
        />
      </div>
    );
  }

  const d = data as FirmOverviewPayload;
  const kpi = d.kpiCards;

  const handleExportPdf = async () => {
    const blob = await exportPdf('firm-overview', { period });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'firm-overview.pdf';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLeakageCsvExport = () => {
    exportCsv(
      d.topLeakageRisks as unknown as Record<string, unknown>[],
      ['matterNumber', 'clientName', 'lawyerName', 'wipValue', 'wipAge', 'ragStatus'],
      'leakage-risks.csv',
    );
  };

  return (
    <div className="flex flex-col">
      {/* Data quality banner */}
      {d.dataQuality && (
        <DataQualityBanner
          issueCount={d.dataQuality.issueCount}
          criticalCount={d.dataQuality.criticalCount}
        />
      )}

      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold text-foreground leading-9">Firm Overview</h1>
          <div className="flex items-center gap-3">
            <ToggleControl
              options={[
                { key: 'gross', label: 'Gross' },
                { key: 'net', label: 'Net' },
              ]}
              value={viewMode}
              onChange={setViewMode}
            />
            <PeriodSelector value={period} onChange={setPeriod} />
            <ExportButton onExportPdf={handleExportPdf} />
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Total Unbilled WIP"
            value={kpi.totalUnbilledWip.value}
            format="currency"
            ragStatus={kpi.totalUnbilledWip.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
            trend={kpi.totalUnbilledWip.trend ? {
              direction: kpi.totalUnbilledWip.trend.direction,
              value: `£${Math.abs(kpi.totalUnbilledWip.trend.value).toLocaleString('en-GB')}`,
            } : undefined}
            onClick={() => navigate('/wip')}
          />
          <KpiCard
            title="Firm Realisation"
            value={kpi.firmRealisation.value}
            format="percent"
            ragStatus={kpi.firmRealisation.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
            trend={kpi.firmRealisation.trend ? {
              direction: kpi.firmRealisation.trend.direction,
              value: `${kpi.firmRealisation.trend.percentChange?.toFixed(1) ?? kpi.firmRealisation.trend.value}%`,
            } : undefined}
            onClick={() => navigate('/billing')}
          />
          <KpiCard
            title="Firm Utilisation"
            value={kpi.firmUtilisation.value}
            format="percent"
            ragStatus={kpi.firmUtilisation.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
            trend={kpi.firmUtilisation.trend ? {
              direction: kpi.firmUtilisation.trend.direction,
              value: `${kpi.firmUtilisation.trend.percentChange?.toFixed(1) ?? kpi.firmUtilisation.trend.value}%`,
            } : undefined}
            onClick={() => navigate('/fee-earners')}
          />
          <KpiCard
            title="Combined Lock-up"
            value={kpi.combinedLockup.value}
            format="days"
            ragStatus={kpi.combinedLockup.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
            trend={kpi.combinedLockup.trend ? {
              direction: kpi.combinedLockup.trend.direction,
              value: `${Math.abs(kpi.combinedLockup.trend.value)} days`,
            } : undefined}
            onClick={() => navigate('/billing')}
          />
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DashboardSection title="WIP Age Bands">
            <div className="bg-card rounded-lg border border-border shadow-card p-4">
              <WipAgeBandChart
                data={d.wipAgeBands}
                onBandClick={(band) => navigate(`/wip?ageBand=${encodeURIComponent(band)}`)}
              />
            </div>
          </DashboardSection>

          <DashboardSection title="Revenue Trend">
            <div className="bg-card rounded-lg border border-border shadow-card p-4">
              <TrendLineChart data={revenueTrendData} lines={revenueTrendLines} />
            </div>
          </DashboardSection>
        </div>

        {/* Leakage risks table */}
        <DashboardSection
          title="Top Leakage Risks"
          action={<ExportButton onExportCsv={handleLeakageCsvExport} />}
        >
          <SortableTable
            columns={leakageColumns}
            data={(d.topLeakageRisks ?? []) as unknown as Record<string, unknown>[]}
            defaultSort={{ key: 'wipValue', direction: 'desc' }}
            onRowClick={(row) => navigate(`/matters?matter=${(row as unknown as LeakageRow).matterId}`)}
            exportFilename="leakage-risks"
          />
        </DashboardSection>

        {/* Bottom two-column */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Utilisation snapshot */}
          <DashboardSection title="Utilisation Snapshot">
            <div className="bg-card rounded-lg border border-border shadow-card p-4 space-y-3">
              {/* Summary pills */}
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                  <span className="w-2.5 h-2.5 rounded-full bg-success" />
                  {d.utilisationSnapshot.green} on target
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
                  <span className="w-2.5 h-2.5 rounded-full bg-warning" />
                  {d.utilisationSnapshot.amber} watch
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-error">
                  <span className="w-2.5 h-2.5 rounded-full bg-error" />
                  {d.utilisationSnapshot.red} below
                </span>
              </div>

              {/* Fee earner list */}
              <ul className="divide-y divide-standard-background max-h-64 overflow-y-auto scrollbar-thin">
                {d.utilisationSnapshot.feeEarners.map((fe) => (
                  <li key={fe.name} className="flex items-center justify-between py-1.5">
                    <span className="text-xs text-foreground">{fe.name}</span>
                    <RagBadge
                      status={fe.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
                      label={fe.utilisation != null ? `${fe.utilisation.toFixed(0)}%` : '—'}
                    />
                  </li>
                ))}
              </ul>

              <button
                className="text-xs text-primary hover:underline font-medium"
                onClick={() => navigate('/fee-earners')}
              >
                View Details →
              </button>
            </div>
          </DashboardSection>

          {/* Department summary */}
          <DashboardSection title="Department Summary">
            <SortableTable
              columns={deptColumns}
              data={(d.departmentSummary ?? []) as unknown as Record<string, unknown>[]}
              defaultSort={{ key: 'wipValue', direction: 'desc' }}
              onRowClick={(row) => navigate(`/fee-earners?department=${encodeURIComponent((row as unknown as DeptRow).name)}`)}
            />
          </DashboardSection>
        </div>

        {/* Last calculated */}
        {d.lastCalculated && (
          <p className="text-[10px] text-muted-foreground text-right">
            Last calculated: {new Date(d.lastCalculated).toLocaleString('en-GB')}
          </p>
        )}
      </div>
    </div>
  );
}
