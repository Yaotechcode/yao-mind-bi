/**
 * csv-export-service.ts — CSV generation for dashboard table exports.
 *
 * Uses papaparse unparse (server-safe; no DOM required).
 * Each dashboard type exports its primary data table as UTF-8 CSV.
 */

import Papa from 'papaparse';
import type { DashboardFilters } from './dashboard-service.js';
import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
} from './dashboard-service.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a CSV string for the given dashboard type.
 * Returns a UTF-8 CSV string ready to send as text/csv.
 */
export async function generateDashboardCsv(
  firmId: string,
  dashboardId: string,
  filters: Record<string, unknown>,
): Promise<{ csv: string; filename: string }> {
  const df = filters as DashboardFilters;

  switch (dashboardId) {
    case 'firm-overview':          return renderFirmOverviewCsv(firmId);
    case 'fee-earner-performance': return renderFeeEarnerCsv(firmId, df);
    case 'wip':                    return renderWipCsv(firmId, df);
    case 'billing':                return renderBillingCsv(firmId, df);
    case 'matters':                return renderMattersCsv(firmId, df);
    case 'clients':                return renderClientsCsv(firmId, df);
    default:
      return { csv: '', filename: `${dashboardId}.csv` };
  }
}

/**
 * Convert an array of plain objects to a CSV string using papaparse.
 */
export function generateTableCsv(
  data: Record<string, unknown>[],
  columns: { header: string; key: string }[],
  filename: string,
): string {
  const rows = data.map(row =>
    Object.fromEntries(columns.map(col => [col.header, row[col.key] ?? ''])),
  );
  return Papa.unparse(rows, { header: true });
}

// ---------------------------------------------------------------------------
// Formatting helpers (matches pdf-export-service for consistency)
// ---------------------------------------------------------------------------

function fmt(value: number | null | undefined): string {
  if (value == null) return '';
  return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(value: number | null | undefined): string {
  if (value == null) return '';
  return `${value.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 1. Firm Overview — export leakage risks + department summary
// ---------------------------------------------------------------------------

async function renderFirmOverviewCsv(firmId: string): Promise<{ csv: string; filename: string }> {
  const data = await getFirmOverviewData(firmId);

  const rows = data.topLeakageRisks.map(r => ({
    'Matter Number':   r.matterNumber,
    'Client':          r.clientName,
    'Responsible':     r.lawyerName,
    'WIP Value (£)':   fmt(r.wipValue),
    'WIP Age (days)':  r.wipAge,
    'Risk Score':      r.riskScore,
    'RAG':             r.ragStatus,
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'firm-overview-leakage-risks.csv',
  };
}

// ---------------------------------------------------------------------------
// 2. Fee Earner Performance
// ---------------------------------------------------------------------------

async function renderFeeEarnerCsv(firmId: string, filters: DashboardFilters): Promise<{ csv: string; filename: string }> {
  const data = await getFeeEarnerPerformanceData(firmId, filters);

  const rows = data.feeEarners.map(fe => ({
    'Name':                  fe.name,
    'Department':            fe.department,
    'Grade':                 fe.grade,
    'Pay Model':             fe.payModel,
    'Chargeable Hours':      fe.chargeableHours != null ? fe.chargeableHours.toFixed(1) : '',
    'Utilisation (%)':       fmtPct(fe.utilisation),
    'WIP Value (£)':         fmt(fe.wipValueRecorded),
    'Billed Revenue (£)':    fmt(fe.billedRevenue),
    'Effective Rate (£)':    fmt(fe.effectiveRate),
    'Write-Off Rate (%)':    fmtPct(fe.writeOffRate),
    'Recording Gap (days)':  fe.recordingGapDays ?? '',
    'Scorecard (%)':         fmtPct(fe.scorecard),
    'Utilisation RAG':       fe.utilisationRag,
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'fee-earner-performance.csv',
  };
}

// ---------------------------------------------------------------------------
// 3. WIP & Leakage
// ---------------------------------------------------------------------------

async function renderWipCsv(firmId: string, filters: DashboardFilters): Promise<{ csv: string; filename: string }> {
  const data = await getWipData(firmId, filters);

  const rows = data.entries.map(g => ({
    'Group':             g.groupLabel,
    'Total Value (£)':   fmt(g.totalValue),
    'Total Hours':       g.totalHours != null ? g.totalHours.toFixed(1) : '',
    'Average Age (days)':g.avgAge != null ? g.avgAge.toFixed(1) : '',
    'Entry Count':       g.entryCount,
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'wip-leakage.csv',
  };
}

// ---------------------------------------------------------------------------
// 4. Billing & Collections
// ---------------------------------------------------------------------------

async function renderBillingCsv(firmId: string, filters: DashboardFilters): Promise<{ csv: string; filename: string }> {
  const data = await getBillingCollectionsData(firmId, filters);

  const rows = data.invoices.map(inv => ({
    'Invoice Number':   inv.invoiceNumber ?? 'Draft',
    'Client':           inv.clientName,
    'Matter Number':    inv.matterNumber,
    'Invoice Date':     inv.invoiceDate.slice(0, 10),
    'Total (£)':        fmt(inv.total),
    'Outstanding (£)':  fmt(inv.outstanding),
    'Days Outstanding': inv.daysOutstanding ?? '',
    'RAG':              inv.ragStatus,
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'billing-collections.csv',
  };
}

// ---------------------------------------------------------------------------
// 5. Matter Analysis
// ---------------------------------------------------------------------------

async function renderMattersCsv(firmId: string, filters: DashboardFilters): Promise<{ csv: string; filename: string }> {
  const data = await getMatterAnalysisData(firmId, filters);

  const rows = data.matters.map(m => ({
    'Matter Number':      m.matterNumber,
    'Client':             m.clientName,
    'Case Type':          m.caseType,
    'Department':         m.department,
    'Responsible Lawyer': m.responsibleLawyer,
    'Status':             m.status,
    'WIP Billable (£)':    fmt(m.wipTotalBillable),
    'Net Billing (£)':     fmt(m.netBilling),
    'Unbilled Balance (£)':fmt(m.unbilledBalance),
    'WIP Age (days)':      m.wipAge ?? '',
    'Realisation (%)':     fmtPct(m.realisation),
    'Realisation RAG':     m.realisationRag,
    'Budget (£)':          m.budget != null ? fmt(m.budget) : '',
    'Budget Burn (%)':     m.budgetBurn != null ? fmtPct(m.budgetBurn) : '',
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'matter-analysis.csv',
  };
}

// ---------------------------------------------------------------------------
// 6. Client Intelligence
// ---------------------------------------------------------------------------

async function renderClientsCsv(firmId: string, filters: DashboardFilters): Promise<{ csv: string; filename: string }> {
  const data = await getClientIntelligenceData(firmId, filters);

  const rows = data.clients.map(c => ({
    'Client':              c.clientName,
    'Matter Count':        c.matterCount,
    'Departments':         c.departments.join('; '),
    'Total Revenue (£)':   fmt(c.totalRevenue),
    'Total Outstanding (£)':fmt(c.totalOutstanding),
  }));

  return {
    csv: Papa.unparse(rows, { header: true }),
    filename: 'client-intelligence.csv',
  };
}
