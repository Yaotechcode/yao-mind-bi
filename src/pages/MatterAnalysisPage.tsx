/**
 * MatterAnalysisPage — Dashboard 5: Matter Analysis.
 * Route: /matters
 */

import { useState, useMemo, useCallback, useRef, Fragment } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { exportPdf, exportCsv } from '@/lib/api-client';
import type {
  MatterPayload,
  MatterRow,
  MatterAtRisk,
} from '@/shared/types/dashboard-payloads';

import {
  KpiCard,
  RagBadge,
  ProgressBar,
  AlertCard,
  FilterBar,
  DashboardSection,
  SortableTable,
  EmptyState,
  ExportButton,
  DashboardSkeleton,
} from '@/components/common';
import type { ColumnDef, FilterDef } from '@/components/common';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtCurrency = (v: unknown) =>
  v != null ? `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—';

const fmtPct = (v: unknown) =>
  v != null ? `${Number(v).toFixed(1)}%` : '—';

const fmtDays = (v: unknown) =>
  v != null ? `${Number(v).toFixed(0)}d` : '—';

const fmtNumber = (v: unknown) =>
  v != null ? Number(v).toFixed(1) : '—';

// ---------------------------------------------------------------------------
// Main table columns
// ---------------------------------------------------------------------------

const mainColumns: ColumnDef<MatterRow>[] = [
  { key: 'matterNumber', header: 'Matter#', sortable: true, minWidth: 90 },
  { key: 'clientName', header: 'Client', sortable: true, minWidth: 120 },
  { key: 'caseType', header: 'Case Type', sortable: true },
  { key: 'department', header: 'Department', sortable: true },
  { key: 'responsibleLawyer', header: 'Responsible Lawyer', sortable: true, minWidth: 130 },
  { key: 'status', header: 'Status', sortable: true },
  {
    key: 'budget',
    header: 'Budget',
    sortable: true,
    align: 'right',
    render: (v) => fmtCurrency(v),
  },
  {
    key: 'wipTotalBillable',
    header: 'WIP Value',
    sortable: true,
    align: 'right',
    render: (v) => fmtCurrency(v),
  },
  {
    key: 'netBilling',
    header: 'Net Billing',
    sortable: true,
    align: 'right',
    render: (v) => fmtCurrency(v),
  },
  {
    key: 'unbilledBalance',
    header: 'Unbilled Balance',
    sortable: true,
    align: 'right',
    render: (v) => fmtCurrency(v),
  },
  {
    key: 'budgetBurn',
    header: 'Budget Burn',
    sortable: true,
    align: 'center',
    minWidth: 120,
    render: (v, row) => {
      if (v == null || row.budget == null) return <span className="text-muted-foreground">—</span>;
      return (
        <ProgressBar
          value={Number(v)}
          max={100}
          ragStatus={(row.budgetBurnRag as 'green' | 'amber' | 'red') ?? 'neutral'}
          showLabel
        />
      );
    },
  },
  {
    key: 'wipAge',
    header: 'WIP Age',
    sortable: true,
    align: 'right',
    render: (v) => fmtDays(v),
  },
  {
    key: 'realisation',
    header: 'Realisation',
    sortable: true,
    align: 'center',
    render: (v, row) => (
      <span className="inline-flex items-center gap-1">
        {fmtPct(v)}
        <RagBadge status={row.realisationRag as 'green' | 'amber' | 'red' | 'neutral'} />
      </span>
    ),
  },
  {
    key: 'healthScore',
    header: 'Health',
    sortable: true,
    align: 'center',
    render: (v, row) => (
      <span className="inline-flex items-center gap-1">
        {v != null ? Number(v).toFixed(0) : '—'}
        <RagBadge status={row.healthRag as 'green' | 'amber' | 'red' | 'neutral'} />
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Expanded row detail
// ---------------------------------------------------------------------------

function MatterDetail({ matter }: { matter: MatterRow }) {
  const prof = matter.profitability;

  const wipCols: ColumnDef[] = [
    { key: 'date', header: 'Date', sortable: true },
    { key: 'lawyerName', header: 'Lawyer', sortable: true },
    { key: 'hours', header: 'Hours', align: 'right', render: (v) => fmtNumber(v) },
    { key: 'rate', header: 'Rate', align: 'right', render: (v) => fmtCurrency(v) },
    { key: 'value', header: 'Value', align: 'right', render: (v) => fmtCurrency(v) },
  ];

  const invoiceCols: ColumnDef[] = [
    { key: 'invoiceNumber', header: 'Invoice#', render: (v) => String(v ?? '—') },
    { key: 'date', header: 'Date' },
    { key: 'total', header: 'Total', align: 'right', render: (v) => fmtCurrency(v) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (v) => fmtCurrency(v) },
    { key: 'paid', header: 'Paid', align: 'right', render: (v) => fmtCurrency(v) },
  ];

  const labourCols: ColumnDef[] = [
    { key: 'lawyerName', header: 'Lawyer' },
    { key: 'payModel', header: 'Pay Model' },
    { key: 'hours', header: 'Hours', align: 'right', render: (v) => fmtNumber(v) },
    { key: 'cost', header: 'Cost', align: 'right', render: (v) => fmtCurrency(v) },
  ];

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          title="Budget Burn"
          value={matter.budgetBurn != null ? `${matter.budgetBurn.toFixed(0)}%` : '—'}
          ragStatus={(matter.budgetBurnRag as 'green' | 'amber' | 'red') ?? 'neutral'}
        />
        <KpiCard
          title="Realisation"
          value={fmtPct(matter.realisation)}
          ragStatus={matter.realisationRag as 'green' | 'amber' | 'red' | 'neutral'}
        />
        <KpiCard
          title="WIP Age"
          value={fmtDays(matter.wipAge)}
          ragStatus="neutral"
        />
        <KpiCard
          title="Margin"
          value={fmtPct(prof.margin)}
          ragStatus={prof.margin != null ? (prof.margin >= 30 ? 'green' : prof.margin >= 15 ? 'amber' : 'red') : 'neutral'}
        />
      </div>

      {/* Time entries */}
      <DashboardSection title="Time Entries">
        <p className="text-[11px] text-muted-foreground mb-1">Showing unbilled entries only</p>
        <SortableTable
          columns={wipCols}
          data={matter.wipEntries as unknown as Record<string, unknown>[]}
        />
      </DashboardSection>

      {/* Invoices */}
      <DashboardSection title="Invoices">
        <SortableTable
          columns={invoiceCols}
          data={matter.invoices as unknown as Record<string, unknown>[]}
        />
      </DashboardSection>

      {/* Profitability */}
      <DashboardSection title="Profitability Breakdown">
        <div className="space-y-2 text-[13px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Revenue ({prof.revenueSource})</span>
            <span className="font-semibold text-foreground">{fmtCurrency(prof.revenue)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Labour Cost</span>
            <span className="font-semibold text-foreground">{fmtCurrency(prof.labourCost)}</span>
          </div>

          {prof.labourBreakdown.length > 0 && (
            <div className="pl-4">
              <SortableTable
                columns={labourCols}
                data={prof.labourBreakdown as unknown as Record<string, unknown>[]}
              />
            </div>
          )}

          <div className="flex justify-between">
            <span className="text-muted-foreground">Disbursement Cost</span>
            <span className="font-semibold text-foreground">{fmtCurrency(prof.disbursementCost)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Overhead</span>
            <span className="font-semibold text-foreground">
              {prof.overhead != null ? fmtCurrency(prof.overhead) : 'Not configured'}
            </span>
          </div>

          <hr className="border-border" />

          <div className="flex justify-between font-semibold">
            <span className="text-foreground">Profit</span>
            <span className={prof.profit >= 0 ? 'text-success' : 'text-error'}>{fmtCurrency(prof.profit)}</span>
          </div>
          <div className="flex justify-between font-semibold">
            <span className="text-foreground">Margin</span>
            <span className="text-foreground">{fmtPct(prof.margin)}</span>
          </div>

          {prof.discrepancy && (
            <div className="mt-2">
              <AlertCard
                type="info"
                title="Billing Discrepancy"
                message={`Yao billing (${fmtCurrency(prof.discrepancy.yaoValue)}) differs from WIP-derived (${fmtCurrency(prof.discrepancy.derivedValue)}) by ${fmtCurrency(prof.discrepancy.difference)}. This is expected for matters with fixed fees or billed entries not in the WIP export.`}
              />
            </div>
          )}
        </div>
      </DashboardSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function MatterAnalysisPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tableRef = useRef<HTMLDivElement>(null);

  // Filters
  const [department, setDepartment] = useState('all');
  const [caseType, setCaseType] = useState('all');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [lawyer, setLawyer] = useState('all');
  const [hasBudget, setHasBudget] = useState('all');
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const apiFilters = useMemo(() => ({
    ...(department !== 'all' && { department }),
    ...(caseType !== 'all' && { caseType }),
    ...(statuses.length > 0 && { status: statuses.join(',') }),
    ...(lawyer !== 'all' && { lawyer }),
    ...(hasBudget !== 'all' && { hasBudget }),
    limit: pageSize,
    offset: page * pageSize,
  }), [department, caseType, statuses, lawyer, hasBudget, page]);

  const { data, isLoading, error } = useDashboardData('matters', apiFilters);

  // Filter definitions
  const filterDefs: FilterDef[] = useMemo(() => {
    if (!data) return [];
    const d = data as MatterPayload;
    return [
      {
        key: 'department',
        label: 'Department',
        type: 'select' as const,
        value: department,
        options: [{ value: 'all', label: 'All Departments' }, ...d.filters.departments.map((dep) => ({ value: dep, label: dep }))],
        onChange: (v: string) => { setDepartment(v); setPage(0); },
      },
      {
        key: 'caseType',
        label: 'Case Type',
        type: 'select' as const,
        value: caseType,
        options: [{ value: 'all', label: 'All Case Types' }, ...d.filters.caseTypes.map((ct) => ({ value: ct, label: ct }))],
        onChange: (v: string) => { setCaseType(v); setPage(0); },
      },
      {
        key: 'status',
        label: 'Status',
        type: 'select' as const,
        value: statuses[0] ?? 'all',
        options: [{ value: 'all', label: 'All Statuses' }, ...d.filters.statuses.map((s) => ({ value: s, label: s }))],
        onChange: (v: string) => { setStatuses(v === 'all' ? [] : [v]); setPage(0); },
      },
      {
        key: 'lawyer',
        label: 'Lawyer',
        type: 'select' as const,
        value: lawyer,
        options: [{ value: 'all', label: 'All Lawyers' }, ...d.filters.lawyers.map((l) => ({ value: l, label: l }))],
        onChange: (v: string) => { setLawyer(v); setPage(0); },
      },
      {
        key: 'hasBudget',
        label: 'Has Budget',
        type: 'select' as const,
        value: hasBudget,
        options: [
          { value: 'all', label: 'All' },
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        onChange: (v: string) => { setHasBudget(v); setPage(0); },
      },
    ];
  }, [data, department, caseType, statuses, lawyer, hasBudget]);

  // Client-side filtered data
  const filteredMatters = useMemo(() => {
    if (!data) return [];
    const d = data as MatterPayload;
    let matters = d.matters;
    if (department !== 'all') matters = matters.filter((m) => m.department === department);
    if (caseType !== 'all') matters = matters.filter((m) => m.caseType === caseType);
    if (statuses.length > 0) matters = matters.filter((m) => statuses.includes(m.status));
    if (lawyer !== 'all') matters = matters.filter((m) => m.responsibleLawyer === lawyer);
    if (hasBudget === 'yes') matters = matters.filter((m) => m.budget != null);
    if (hasBudget === 'no') matters = matters.filter((m) => m.budget == null);
    return matters;
  }, [data, department, caseType, statuses, lawyer, hasBudget]);

  // Scroll to matter in table
  const handleViewMatter = useCallback((matterNumber: string) => {
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // The table expansion is handled by the user clicking the row
  }, []);

  // Export handlers
  const handleExportCsv = () => {
    const keys = ['matterNumber', 'clientName', 'caseType', 'department', 'responsibleLawyer', 'status', 'budget', 'wipTotalBillable', 'netBilling', 'unbilledBalance', 'wipAge', 'realisation', 'healthScore'];
    exportCsv(filteredMatters as unknown as Record<string, unknown>[], keys, 'matter-analysis');
  };

  const handleExportPdf = () => exportPdf('matters', apiFilters);

  // Case type summary columns
  const caseTypeCols: ColumnDef[] = [
    { key: 'name', header: 'Type', sortable: true },
    { key: 'count', header: 'Count', sortable: true, align: 'right' },
    { key: 'avgRealisation', header: 'Avg Realisation', sortable: true, align: 'right', render: (v) => fmtPct(v) },
    { key: 'avgWipAge', header: 'Avg WIP Age', sortable: true, align: 'right', render: (v) => fmtDays(v) },
    { key: 'totalWip', header: 'Total WIP', sortable: true, align: 'right', render: (v) => fmtCurrency(v) },
    {
      key: 'ragStatus',
      header: 'RAG',
      align: 'center',
      render: (v) => <RagBadge status={v as 'green' | 'amber' | 'red' | 'neutral'} />,
    },
  ];

  // Department summary columns
  const deptCols: ColumnDef[] = [
    { key: 'name', header: 'Department', sortable: true },
    { key: 'count', header: 'Count', sortable: true, align: 'right' },
    { key: 'totalWip', header: 'Total WIP', sortable: true, align: 'right', render: (v) => fmtCurrency(v) },
    { key: 'avgMargin', header: 'Avg Margin', sortable: true, align: 'right', render: (v) => fmtPct(v) },
  ];

  // ── Loading ─────────────────────────────────────────────────────────────
  if (isLoading) return <DashboardSkeleton title="Matter Analysis" />;

  // ── Empty ───────────────────────────────────────────────────────────────
  if (!data || !(data as MatterPayload).matters?.length) {
    return (
      <EmptyState
        title="Upload your Yao data to see Matter Analysis"
        message="Once your data is processed, this dashboard shows matter health, profitability, and risk analysis."
        icon={<Upload className="h-10 w-10 text-icon-main" />}
        action={{ label: 'Go to Data Management', onClick: () => navigate('/data') }}
      />
    );
  }

  const d = data as MatterPayload;
  const atRiskCount = d.mattersAtRisk.length;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-[24px] font-bold leading-9 text-main-text">Matter Analysis</h1>
        <ExportButton onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
      </div>

      {/* Matters at risk */}
      {atRiskCount > 0 && (
        <DashboardSection
          title={`🔴 ${atRiskCount} matters need attention`}
          collapsible
          defaultCollapsed={atRiskCount > 5}
        >
          <div className="space-y-2">
            {d.mattersAtRisk.map((m) => (
              <AlertCard
                key={m.matterId}
                type="warning"
                title={`Matter ${m.matterNumber} — ${m.clientName} — ${m.caseType}`}
                message={`Issue: ${m.primaryIssue}`}
                subtitle={`Responsible: ${m.responsibleLawyer} → ${m.supervisor}`}
                action={{
                  label: 'View Detail →',
                  onClick: () => handleViewMatter(m.matterNumber),
                }}
              />
            ))}
          </div>
        </DashboardSection>
      )}

      {/* Filters */}
      <FilterBar filters={filterDefs} />

      {/* Main table */}
      <div ref={tableRef}>
        <SortableTable
          columns={mainColumns as ColumnDef<Record<string, unknown>>[]}
          data={filteredMatters as unknown as Record<string, unknown>[]}
          defaultSort={{ key: 'healthScore', direction: 'asc' }}
          expandable
          renderExpanded={(row) => (
            <MatterDetail matter={row as unknown as MatterRow} />
          )}
          pagination={{
            page,
            pageSize,
            total: filteredMatters.length,
            onPageChange: setPage,
          }}
          exportFilename="matter-analysis"
        />
      </div>

      {/* Summary tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DashboardSection title="By Case Type">
          <SortableTable
            columns={caseTypeCols}
            data={d.byCaseType as unknown as Record<string, unknown>[]}
            defaultSort={{ key: 'totalWip', direction: 'desc' }}
          />
        </DashboardSection>
        <DashboardSection title="By Department">
          <SortableTable
            columns={deptCols}
            data={d.byDepartment as unknown as Record<string, unknown>[]}
            defaultSort={{ key: 'totalWip', direction: 'desc' }}
          />
        </DashboardSection>
      </div>
    </div>
  );
}
