/**
 * WipDashboardPage — Dashboard 3: Work in Progress & Leakage.
 * Route: /wip
 */

import { useState, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Upload, Info } from 'lucide-react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { exportPdf, exportCsv } from '@/lib/api-client';
import type { WipPayload, WipGroupRow } from '@/shared/types/dashboard-payloads';

import {
  KpiCard,
  RagBadge,
  ToggleControl,
  FilterBar,
  GroupBySelector,
  DashboardSection,
  SortableTable,
  EmptyState,
  ExportButton,
  DashboardSkeleton,
} from '@/components/common';
import type { ColumnDef, FilterDef } from '@/components/common';

import { WipAgeBandChart, StackedBarChart, DonutChart } from '@/components/charts';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtCurrency = (v: unknown) =>
  v != null ? `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—';

const fmtHours = (v: unknown) =>
  v != null ? Number(v).toFixed(1) : '—';

const fmtDays = (v: unknown) =>
  v != null ? `${Number(v).toFixed(0)}d` : '—';

const fmtRate = (v: unknown) =>
  v != null ? `£${Number(v).toFixed(0)}/hr` : '—';

// ---------------------------------------------------------------------------
// Column sets per groupBy
// ---------------------------------------------------------------------------

const columnsByGroup: Record<string, ColumnDef[]> = {
  matter: [
    { key: 'groupLabel', header: 'Matter #', minWidth: 120 },
    { key: 'clientName', header: 'Client', minWidth: 120, sortable: false },
    { key: 'lawyerName', header: 'Lawyer', minWidth: 110, sortable: false },
    { key: 'entryCount', header: 'Entries', align: 'right' },
    { key: 'totalValue', header: 'Total Value', align: 'right', render: fmtCurrency },
    { key: 'avgAge', header: 'Avg Age', align: 'right', render: fmtDays },
    {
      key: 'ragStatus', header: 'RAG', align: 'center',
      render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
    },
  ],
  feeEarner: [
    { key: 'groupLabel', header: 'Name', minWidth: 140 },
    { key: 'department', header: 'Department', minWidth: 110, sortable: false },
    { key: 'matterCount', header: 'Matters', align: 'right', sortable: false },
    { key: 'totalHours', header: 'Total Hours', align: 'right', render: fmtHours },
    { key: 'totalValue', header: 'Total Value', align: 'right', render: fmtCurrency },
    { key: 'avgAge', header: 'Avg Age', align: 'right', render: fmtDays },
  ],
  client: [
    { key: 'groupLabel', header: 'Client', minWidth: 140 },
    { key: 'matterCount', header: 'Matters', align: 'right', sortable: false },
    { key: 'totalValue', header: 'Total Value', align: 'right', render: fmtCurrency },
    { key: 'avgAge', header: 'Avg Age', align: 'right', render: fmtDays },
    { key: 'oldestEntry', header: 'Oldest Entry', align: 'right', render: fmtDays, sortable: false },
  ],
};

// Entry detail columns (expanded row)
const entryColumns: ColumnDef[] = [
  { key: 'date', header: 'Date', minWidth: 90 },
  { key: 'lawyerName', header: 'Lawyer', minWidth: 110 },
  { key: 'hours', header: 'Hours', align: 'right', render: fmtHours },
  { key: 'rate', header: 'Rate', align: 'right', render: fmtRate },
  { key: 'value', header: 'Value', align: 'right', render: fmtCurrency },
  { key: 'age', header: 'Age', align: 'right', render: fmtDays },
  {
    key: 'doNotBill', header: 'DNB', align: 'center',
    render: (v) => v ? <span className="text-error text-xs font-semibold">DNB</span> : null,
  },
];

// Disbursement columns
const disbColumns: ColumnDef[] = [
  { key: 'matterNumber', header: 'Matter #', minWidth: 100 },
  { key: 'clientName', header: 'Client', minWidth: 130 },
  { key: 'value', header: 'Value', align: 'right', render: fmtCurrency },
  { key: 'age', header: 'Age (days)', align: 'right' },
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function WipDashboardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [filterValues, setFilterValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    const band = searchParams.get('ageBand');
    if (band) init.ageBand = band;
    return init;
  });
  const [grossNet, setGrossNet] = useState('gross');
  const [groupBy, setGroupBy] = useState('matter');
  const [page, setPage] = useState(0);

  const apiFilters = useMemo(() => {
    const f: Record<string, string | undefined> = {};
    if (filterValues.department) f.department = filterValues.department as string;
    if (filterValues.feeEarner) f.feeEarner = filterValues.feeEarner as string;
    if (filterValues.caseType) f.caseType = filterValues.caseType as string;
    if (filterValues.minValue) f.minValue = String(filterValues.minValue);
    if (filterValues.ageBand) f.ageBand = filterValues.ageBand as string;
    f.groupBy = groupBy;
    f.offset = String(page * 25);
    f.limit = '25';
    return f;
  }, [filterValues, groupBy, page]);

  const { data, isLoading } = useDashboardData('wip-leakage', apiFilters);

  const filterDefs: FilterDef[] = useMemo(() => [
    { key: 'department', label: 'Department', type: 'select', options: data?.filters.departments ?? [] },
    { key: 'feeEarner', label: 'Fee Earner', type: 'select', options: data?.filters.feeEarners ?? [] },
    { key: 'caseType', label: 'Case Type', type: 'select', options: data?.filters.caseTypes ?? [] },
    { key: 'minValue', label: 'Min Value', type: 'number' },
  ], [data?.filters]);

  // Charts data
  const ageBandData = useMemo(
    () => (data?.ageBands ?? []).map((b) => ({
      band: b.band, value: b.value, count: b.count, colour: b.colour,
    })),
    [data?.ageBands],
  );

  const deptStackData = useMemo(
    () => (data?.byDepartment ?? []).map((d) => ({
      name: d.name,
      segments: [{ key: 'wip', value: d.value, colour: 'hsl(193 98% 35%)' }],
    })),
    [data?.byDepartment],
  );

  const writeOffFeeEarnerData = useMemo(
    () => (data?.writeOffAnalysis?.byFeeEarner ?? []).map((d) => ({
      name: d.name,
      segments: [{ key: 'writeOff', value: d.value, colour: 'hsl(349 72% 63%)' }],
    })),
    [data?.writeOffAnalysis],
  );

  const writeOffCaseTypeData = useMemo(
    () => (data?.writeOffAnalysis?.byCaseType ?? []).map((d) => ({
      name: d.name, value: d.value, colour: 'hsl(349 72% 63%)',
    })),
    [data?.writeOffAnalysis],
  );

  // Export handlers
  const handleExportPdf = async () => {
    const blob = await exportPdf('wip-leakage', apiFilters);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wip-leakage.pdf'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleMainCsvExport = () => {
    if (!data) return;
    const cols = (columnsByGroup[groupBy] ?? columnsByGroup.matter).map((c) => c.key);
    exportCsv(data.entries as unknown as Record<string, unknown>[], cols, `wip-${groupBy}.csv`);
  };

  const handleDisbCsvExport = () => {
    if (!data?.disbursementExposure) return;
    exportCsv(
      data.disbursementExposure.byMatter as unknown as Record<string, unknown>[],
      ['matterNumber', 'clientName', 'value', 'age'],
      'disbursement-exposure.csv',
    );
  };

  // Loading
  if (isLoading) return <DashboardSkeleton />;

  // Empty state
  if (!data?.headlines) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Upload className="h-10 w-10" />}
          title="Upload your Yao data to view Work in Progress"
          message="Import WIP data to see age analysis, leakage risks, and write-off trends."
          action={{ label: 'Go to Data Management', onClick: () => navigate('/data') }}
        />
      </div>
    );
  }

  const d = data as WipPayload;
  const headlines = d.headlines;
  const wipValue = grossNet === 'net' ? headlines.totalUnbilledWip.netValue : headlines.totalUnbilledWip.grossValue;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-foreground leading-9">Work in Progress</h1>
        <ExportButton onExportPdf={handleExportPdf} />
      </div>

      {/* Filters */}
      <FilterBar filters={filterDefs} values={filterValues} onChange={setFilterValues} />

      {/* Headlines */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Total Unbilled WIP */}
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Unbilled WIP
            </span>
            <ToggleControl
              options={[
                { key: 'gross', label: 'Gross' },
                { key: 'net', label: 'Net' },
              ]}
              value={grossNet}
              onChange={setGrossNet}
            />
          </div>
          <p className="text-3xl font-bold text-foreground">{fmtCurrency(wipValue)}</p>
        </div>

        {/* At Risk */}
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            At Risk (&gt;90 days)
          </span>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-3xl font-bold text-foreground">{fmtCurrency(headlines.atRisk.value)}</p>
            <RagBadge
              status={headlines.atRisk.ragStatus as 'green' | 'amber' | 'red' | 'neutral'}
              label={`${headlines.atRisk.percentage.toFixed(1)}%`}
            />
          </div>
        </div>

        {/* Estimated Leakage */}
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Estimated Leakage
            </span>
            <span title={`Based on ${headlines.estimatedLeakage.methodology}`}>
              <Info className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          </div>
          <p className="text-3xl font-bold text-foreground mt-1">{fmtCurrency(headlines.estimatedLeakage.value)}</p>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DashboardSection title="WIP Age Bands">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <WipAgeBandChart
              data={ageBandData}
              onBandClick={(band) => setFilterValues((prev) => ({ ...prev, ageBand: band }))}
            />
          </div>
        </DashboardSection>

        <DashboardSection title="WIP by Department">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <StackedBarChart
              data={deptStackData}
              horizontal
              labels={{ wip: 'WIP Value' }}
            />
          </div>
        </DashboardSection>
      </div>

      {/* Group by selector + main table */}
      <DashboardSection
        title="WIP Entries"
        action={
          <div className="flex items-center gap-2">
            <GroupBySelector
              options={[
                { key: 'matter', label: 'By Matter' },
                { key: 'feeEarner', label: 'By Fee Earner' },
                { key: 'client', label: 'By Client' },
              ]}
              value={groupBy}
              onChange={(v) => { setGroupBy(v); setPage(0); }}
            />
            <ExportButton onExportCsv={handleMainCsvExport} />
          </div>
        }
      >
        <SortableTable
          columns={columnsByGroup[groupBy] ?? columnsByGroup.matter}
          data={d.entries as unknown as Record<string, unknown>[]}
          defaultSort={{ key: 'totalValue', direction: 'desc' }}
          expandable
          renderExpanded={(row) => {
            const group = row as unknown as WipGroupRow;
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border">
                      {entryColumns.map((col) => (
                        <th
                          key={col.key}
                          className={`px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider text-left ${col.align === 'right' ? 'text-right' : ''} ${col.align === 'center' ? 'text-center' : ''}`}
                        >
                          {col.header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.details.map((entry, idx) => (
                      <tr key={idx} className="border-b border-standard-background">
                        {entryColumns.map((col) => (
                          <td
                            key={col.key}
                            className={`px-2 py-1 text-foreground ${col.align === 'right' ? 'text-right' : ''} ${col.align === 'center' ? 'text-center' : ''}`}
                          >
                            {col.render
                              ? col.render((entry as Record<string, unknown>)[col.key], entry as unknown as Record<string, unknown>, idx)
                              : String((entry as Record<string, unknown>)[col.key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
          pagination={{
            page,
            pageSize: 25,
            total: d.pagination.totalCount,
            onPageChange: setPage,
          }}
        />
      </DashboardSection>

      {/* Write-Off Analysis */}
      <DashboardSection title="Write-Off Analysis">
        <div className="bg-card rounded-lg border border-border shadow-card p-4 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-foreground font-medium">
              Total Write-Offs: <strong>{fmtCurrency(d.writeOffAnalysis.totalWriteOff)}</strong>
            </span>
            <span className="text-sm text-foreground">
              Write-Off Rate: <strong>{d.writeOffAnalysis.writeOffRate.toFixed(1)}%</strong>
            </span>
            <RagBadge status={d.writeOffAnalysis.ragStatus as 'green' | 'amber' | 'red' | 'neutral'} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                By Fee Earner
              </h4>
              <StackedBarChart
                data={writeOffFeeEarnerData}
                horizontal
                labels={{ writeOff: 'Write-Off' }}
              />
            </div>
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                By Case Type
              </h4>
              <DonutChart data={writeOffCaseTypeData} />
            </div>
          </div>
        </div>
      </DashboardSection>

      {/* Disbursement Exposure */}
      <DashboardSection title="Disbursement Exposure" collapsible defaultCollapsed>
        <div className="bg-card rounded-lg border border-border shadow-card p-4 space-y-3">
          <p className="text-sm text-foreground font-medium">
            Total Exposure: <strong>{fmtCurrency(d.disbursementExposure.totalExposure)}</strong>
          </p>
          <SortableTable
            columns={disbColumns}
            data={d.disbursementExposure.byMatter as unknown as Record<string, unknown>[]}
            defaultSort={{ key: 'value', direction: 'desc' }}
            exportFilename="disbursement-exposure"
          />
          <div className="flex justify-end">
            <ExportButton onExportCsv={handleDisbCsvExport} />
          </div>
        </div>
      </DashboardSection>
    </div>
  );
}
