/**
 * BillingDashboardPage — Dashboard 4: Billing & Collections.
 * Route: /billing
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { exportPdf, exportCsv } from '@/lib/api-client';
import type { BillingPayload } from '@/shared/types/dashboard-payloads';

import {
  RagBadge,
  FilterBar,
  ToggleControl,
  DashboardSection,
  SortableTable,
  AlertCard,
  EmptyState,
  ExportButton,
  DashboardSkeleton,
} from '@/components/common';
import type { ColumnDef, FilterDef } from '@/components/common';

import { AgedDebtorChart, TrendLineChart, PipelineChart } from '@/components/charts';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtCurrency = (v: unknown) =>
  v != null ? `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—';

const fmtPercent = (v: unknown) =>
  v != null ? `${Number(v).toFixed(1)}%` : '—';

const fmtDate = (v: unknown) =>
  v != null ? new Date(String(v)).toLocaleDateString('en-GB') : '—';

// ---------------------------------------------------------------------------
// Invoice table columns
// ---------------------------------------------------------------------------

const invoiceColumns: ColumnDef[] = [
  { key: 'invoiceNumber', header: 'Invoice #', minWidth: 100, render: (v) => String(v ?? '—') },
  { key: 'clientName', header: 'Client', minWidth: 130 },
  { key: 'matterNumber', header: 'Matter #', minWidth: 90 },
  { key: 'invoiceDate', header: 'Date', minWidth: 90, render: fmtDate },
  { key: 'total', header: 'Total', align: 'right', render: fmtCurrency },
  { key: 'outstanding', header: 'Outstanding', align: 'right', render: fmtCurrency },
  { key: 'paid', header: 'Paid', align: 'right', render: fmtCurrency },
  { key: 'daysOutstanding', header: 'Days O/S', align: 'right', render: (v) => v != null ? String(v) : '—' },
  { key: 'ageBand', header: 'Age Band', render: (v) => String(v ?? '—') },
  {
    key: 'ragStatus', header: 'RAG', align: 'center',
    render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
  },
  {
    key: 'isOverdue', header: 'Overdue', align: 'center',
    render: (v) => v ? <span className="text-error text-xs font-semibold">Overdue</span> : null,
  },
];

// Slow payer columns
const slowPayerColumns: ColumnDef[] = [
  { key: 'clientName', header: 'Client', minWidth: 140 },
  { key: 'avgDaysToPay', header: 'Avg Days to Pay', align: 'right' },
  { key: 'invoiceCount', header: 'Invoices', align: 'right' },
  { key: 'totalOutstanding', header: 'Outstanding', align: 'right', render: fmtCurrency },
  {
    key: 'ragStatus', header: 'RAG', align: 'center',
    render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
  },
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function BillingDashboardPage() {
  const navigate = useNavigate();

  const [filterValues, setFilterValues] = useState<Record<string, unknown>>({});
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [page, setPage] = useState(0);

  const apiFilters = useMemo(() => {
    const f: Record<string, string | undefined> = {};
    if (filterValues.department) f.department = filterValues.department as string;
    if (filterValues.feeEarner) f.feeEarner = filterValues.feeEarner as string;
    if (filterValues.period) f.period = filterValues.period as string;
    f.offset = String(page * 25);
    f.limit = '25';
    return f;
  }, [filterValues, page]);

  const { data, isLoading } = useDashboardData('billing-collections', apiFilters);

  const filterDefs: FilterDef[] = useMemo(() => [
    { key: 'department', label: 'Department', type: 'select', options: data?.filters.departments ?? [] },
    { key: 'feeEarner', label: 'Fee Earner', type: 'select', options: data?.filters.feeEarners ?? [] },
    { key: 'period', label: 'Period', type: 'select', options: ['This Month', 'Last Month', 'This Quarter', 'YTD'] },
  ], [data?.filters]);

  // Pipeline stages
  const pipelineStages = useMemo(() => {
    if (!data?.pipeline) return [];
    const p = data.pipeline;
    return [
      { label: 'WIP', value: p.wip.value, subLabel: p.wip.avgDays != null ? `Avg ${p.wip.avgDays}d` : '' },
      { label: 'Invoiced', value: p.invoiced.value, subLabel: p.invoiced.avgDaysToPayment != null ? `Avg ${p.invoiced.avgDaysToPayment}d` : '' },
      { label: 'Paid', value: p.paid.value, subLabel: '' },
      { label: 'Written Off', value: p.writtenOff.value, subLabel: `${p.writtenOff.rate.toFixed(1)}%` },
    ];
  }, [data?.pipeline]);

  // Billing trend chart
  const trendData = useMemo(
    () => (data?.billingTrend ?? []).map((pt) => ({
      period: pt.period,
      values: { invoiced: pt.invoiced, collected: pt.collected, writeOff: pt.writeOff },
    })),
    [data?.billingTrend],
  );

  const trendLines = useMemo(() => [
    { key: 'invoiced', colour: 'hsl(193 98% 35%)', type: 'bar' as const },
    { key: 'collected', colour: 'hsl(180 88% 38%)', type: 'bar' as const },
    { key: 'writeOff', colour: 'hsl(349 72% 63%)', type: 'line' as const },
  ], []);

  // Filtered invoices
  const filteredInvoices = useMemo(() => {
    if (!data?.invoices) return [];
    switch (invoiceFilter) {
      case 'overdue': return data.invoices.filter((i) => i.isOverdue);
      case 'paid': return data.invoices.filter((i) => i.paid > 0 && i.outstanding === 0);
      case 'writtenOff': return data.invoices.filter((i) => i.ragStatus === 'red');
      default: return data.invoices;
    }
  }, [data?.invoices, invoiceFilter]);

  // Export handlers
  const handleExportPdf = async () => {
    const blob = await exportPdf('billing-collections', apiFilters);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'billing-collections.pdf'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleInvoiceCsvExport = () => {
    exportCsv(
      filteredInvoices as unknown as Record<string, unknown>[],
      invoiceColumns.map((c) => c.key),
      'invoices.csv',
    );
  };

  // Loading
  if (isLoading) return <DashboardSkeleton />;

  // Empty
  if (!data?.headlines) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Upload className="h-10 w-10" />}
          title="Upload your Yao data to view Billing & Collections"
          message="Import invoice and billing data to see pipeline, aged debtors, and collection trends."
          action={{ label: 'Go to Data Management', onClick: () => navigate('/data') }}
        />
      </div>
    );
  }

  const d = data as BillingPayload;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-foreground leading-9">Billing &amp; Collections</h1>
        <ExportButton onExportPdf={handleExportPdf} />
      </div>

      {/* Filters */}
      <FilterBar filters={filterDefs} values={filterValues} onChange={setFilterValues} />

      {/* Headlines */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Invoiced (period)</span>
          <p className="text-3xl font-bold text-foreground mt-1">{fmtCurrency(d.headlines.invoicedPeriod.value)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{d.headlines.invoicedPeriod.count} invoices</p>
        </div>
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Collected (period)</span>
          <p className="text-3xl font-bold text-foreground mt-1">{fmtCurrency(d.headlines.collectedPeriod.value)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Collection rate: {fmtPercent(d.headlines.collectedPeriod.rate)}</p>
        </div>
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Outstanding</span>
          <p className="text-3xl font-bold text-foreground mt-1">{fmtCurrency(d.headlines.totalOutstanding.value)}</p>
        </div>
      </div>

      {/* Pipeline */}
      <DashboardSection title="Billing Pipeline">
        <div className="bg-card rounded-lg border border-border shadow-card p-5">
          <PipelineChart stages={pipelineStages} />
          <p className="text-center text-xs text-muted-foreground mt-3">
            Total lock-up: <strong className="text-foreground">{d.pipeline.totalLockup} days</strong>
          </p>
        </div>
      </DashboardSection>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DashboardSection title="Aged Debtors">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <AgedDebtorChart
              bands={d.agedDebtors}
              onBandClick={(band) => setFilterValues((prev) => ({ ...prev, ageBand: band }))}
            />
          </div>
        </DashboardSection>

        <DashboardSection title="Billing Trend">
          <div className="bg-card rounded-lg border border-border shadow-card p-4">
            <TrendLineChart
              data={trendData}
              lines={trendLines}
            />
          </div>
        </DashboardSection>
      </div>

      {/* Invoice table */}
      <DashboardSection
        title="Invoices"
        action={<ExportButton onExportCsv={handleInvoiceCsvExport} />}
      >
        <div className="mb-2">
          <ToggleControl
            options={[
              { key: 'all', label: 'All' },
              { key: 'overdue', label: 'Overdue Only' },
              { key: 'paid', label: 'Paid' },
              { key: 'writtenOff', label: 'Written Off' },
            ]}
            value={invoiceFilter}
            onChange={(v) => { setInvoiceFilter(v); setPage(0); }}
          />
        </div>
        <SortableTable
          columns={invoiceColumns}
          data={filteredInvoices as unknown as Record<string, unknown>[]}
          defaultSort={{ key: 'daysOutstanding', direction: 'desc' }}
          pagination={{
            page,
            pageSize: 25,
            total: d.pagination.totalCount,
            onPageChange: setPage,
          }}
        />
      </DashboardSection>

      {/* Slow Payers */}
      {d.slowPayers != null ? (
        <DashboardSection title="Slow Payers">
          <SortableTable
            columns={slowPayerColumns}
            data={d.slowPayers as unknown as Record<string, unknown>[]}
            defaultSort={{ key: 'avgDaysToPay', direction: 'desc' }}
            exportFilename="slow-payers"
          />
        </DashboardSection>
      ) : (
        <DashboardSection title="Slow Payers">
          <AlertCard
            type="info"
            title="Payment date data not available"
            message="Add payment dates to your invoice export to enable debtor analysis."
            action={{ label: 'How to add this data →', onClick: () => navigate('/data') }}
          />
        </DashboardSection>
      )}
    </div>
  );
}
