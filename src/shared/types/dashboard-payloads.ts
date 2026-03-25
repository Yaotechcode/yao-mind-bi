/**
 * dashboard-payloads.ts — Typed contracts for all 6 dashboard API responses.
 * These types are the source of truth shared between backend and frontend.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface RagValue {
  value: number | null;
  ragStatus: string;  // RagStatus enum value: 'green' | 'amber' | 'red' | 'neutral'
}

export interface Trend {
  direction: 'up' | 'down' | 'flat';
  value: number;  // absolute change
  percentChange?: number;
}

export interface KpiCardValue extends RagValue {
  trend?: Trend;
}

export interface PaginationMeta {
  totalCount: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// 1. Firm Overview
// ---------------------------------------------------------------------------

export interface WipAgeBand {
  band: string;           // e.g. '0–30 days'
  value: number;          // total WIP value in band
  count: number;          // number of matters in band
  colour: string;         // hex colour for chart
}

export interface RevenueTrendPoint {
  period: string;         // 'YYYY-MM'
  billed: number;
  target?: number;
}

export interface LeakageRisk {
  matterId: string;
  matterNumber: string;
  clientName: string;
  lawyerName: string;
  wipValue: number;
  wipAge: number;         // days
  ragStatus: string;
  riskScore: number;      // wipAge * wipValue / 1000
}

export interface UtilisationFeeEarner {
  name: string;
  utilisation: number | null;
  ragStatus: string;
}

export interface DepartmentSummaryRow {
  name: string;
  wipValue: number;
  matterCount: number;
  utilisation: number | null;
  ragStatus: string;
}

export interface FirmOverviewPayload {
  kpiCards: {
    totalUnbilledWip: KpiCardValue;
    firmRealisation: KpiCardValue;
    firmUtilisation: KpiCardValue;
    combinedLockup: KpiCardValue;
  };
  wipAgeBands: WipAgeBand[];
  revenueTrend: RevenueTrendPoint[];
  topLeakageRisks: LeakageRisk[];   // top 10 by riskScore
  utilisationSnapshot: {
    green: number;
    amber: number;
    red: number;
    feeEarners: UtilisationFeeEarner[];
  };
  departmentSummary: DepartmentSummaryRow[];
  dataQuality: { issueCount: number; criticalCount: number };
  lastCalculated: string | null;
}

// ---------------------------------------------------------------------------
// 2. Fee Earner Performance
// ---------------------------------------------------------------------------

export interface RecordingPatternDay {
  date: string;           // 'YYYY-MM-DD'
  hasEntries: boolean;
}

export interface FeeEarnerRow {
  id: string;
  name: string;
  department: string;
  grade: string;
  payModel: string;
  isActive: boolean;
  chargeableHours: number;
  totalHours: number;
  utilisation: number | null;
  utilisationRag: string;
  wipValueRecorded: number;
  billedRevenue: number;
  effectiveRate: number | null;
  writeOffRate: number;
  recordingGapDays: number | null;
  matterCount: number;
  scorecard: number | null;
  scorecardRag: string;
  // Profitability — present based on payModel
  employmentCost?: number | null;
  revenueMultiple?: number | null;
  profit?: number | null;
  firmRetainedRevenue?: number | null;
  firmOverheadCost?: number | null;
  firmProfit?: number | null;
  lawyerShare?: number | null;
  recordingPattern: RecordingPatternDay[];
}

export interface FeeEarnerPerformanceAlert {
  feeEarnerId: string;
  name: string;
  type: string;
  message: string;
}

export interface FeeEarnerPerformancePayload {
  alerts: FeeEarnerPerformanceAlert[];
  feeEarners: FeeEarnerRow[];
  pagination: PaginationMeta;
  charts: {
    utilisationBars: { name: string; value: number | null; target: number; ragStatus: string }[];
    chargeableStack: { name: string; chargeable: number; nonChargeable: number }[];
  };
  filters: {
    departments: string[];
    grades: string[];
    payModels: string[];
  };
}

// ---------------------------------------------------------------------------
// 3. WIP & Leakage
// ---------------------------------------------------------------------------

export interface WipAgeBandDetail {
  band: string;
  min: number;
  max: number | null;
  value: number;
  count: number;
  recoveryProb: number;   // 0–1 estimated recovery probability
  colour: string;
}

export interface WipEntryDetail {
  entryId: string;
  date: string;
  lawyerName: string;
  hours: number;
  value: number;
  age: number;
  rate: number;
  doNotBill: boolean;
}

export interface WipGroupRow {
  groupKey: string;
  groupLabel: string;
  totalValue: number;
  totalHours: number;
  avgAge: number;
  entryCount: number;
  ragStatus: string;
  details: WipEntryDetail[];
}

export interface WipPayload {
  headlines: {
    totalUnbilledWip: { value: number; grossValue: number; netValue: number };
    atRisk: { value: number; percentage: number; ragStatus: string };
    estimatedLeakage: { value: number; methodology: string };
  };
  ageBands: WipAgeBandDetail[];
  byDepartment: { name: string; value: number; count: number }[];
  entries: WipGroupRow[];
  pagination: PaginationMeta;
  writeOffAnalysis: {
    totalWriteOff: number;
    writeOffRate: number;
    ragStatus: string;
    byFeeEarner: { name: string; value: number }[];
    byCaseType: { name: string; value: number }[];
  };
  disbursementExposure: {
    totalExposure: number;
    byMatter: { matterNumber: string; clientName: string; value: number; age: number }[];
  };
  filters: { departments: string[]; feeEarners: string[]; caseTypes: string[] };
}

// ---------------------------------------------------------------------------
// 4. Billing & Collections
// ---------------------------------------------------------------------------

export interface AgedDebtorBand {
  band: string;
  value: number;
  count: number;
  colour: string;
}

export interface BillingTrendPoint {
  period: string;   // 'YYYY-MM'
  invoiced: number;
  collected: number;
  writeOff: number;
}

export interface InvoiceRow {
  invoiceNumber: string | null;
  clientName: string;
  matterNumber: string;
  invoiceDate: string;
  total: number;
  outstanding: number;
  paid: number;
  daysOutstanding: number | null;
  ageBand: string | null;
  ragStatus: string;
  isOverdue: boolean;
}

export interface SlowPayerRow {
  clientName: string;
  avgDaysToPay: number;
  invoiceCount: number;
  totalOutstanding: number;
  ragStatus: string;
}

export interface BillingPayload {
  headlines: {
    invoicedPeriod: { value: number; count: number };
    collectedPeriod: { value: number; rate: number };
    totalOutstanding: { value: number };
  };
  pipeline: {
    wip: { value: number; avgDays: number | null };
    invoiced: { value: number; avgDaysToPayment: number | null };
    paid: { value: number };
    writtenOff: { value: number; rate: number };
    totalLockup: number;
  };
  agedDebtors: AgedDebtorBand[];
  billingTrend: BillingTrendPoint[];
  invoices: InvoiceRow[];
  pagination: PaginationMeta;
  slowPayers: SlowPayerRow[] | null;  // null when datePaid not in data
  filters: { departments: string[]; feeEarners: string[] };
}

// ---------------------------------------------------------------------------
// 5. Matter Analysis
// ---------------------------------------------------------------------------

export interface MatterAtRisk {
  matterId: string;
  matterNumber: string;
  clientName: string;
  caseType: string;
  responsibleLawyer: string;
  supervisor: string;
  primaryIssue: string;
  ragStatus: string;
  wipValue: number;
  wipAge: number;
}

export interface MatterWipEntry {
  date: string;
  lawyerName: string;
  hours: number;
  value: number;
  rate: number;
}

export interface MatterInvoice {
  invoiceNumber: string | null;
  date: string;
  total: number;
  outstanding: number;
  paid: number;
}

export interface MatterLabourBreakdown {
  lawyerName: string;
  payModel: string;
  hours: number;
  cost: number;
}

export interface MatterProfitability {
  revenue: number;
  revenueSource: string;
  labourCost: number;
  labourBreakdown: MatterLabourBreakdown[];
  disbursementCost: number;
  overhead: number | null;
  profit: number;
  margin: number;
  discrepancy: { yaoValue: number; derivedValue: number; difference: number } | null;
}

export interface MatterRow {
  matterId: string;
  matterNumber: string;
  clientName: string;
  caseType: string;
  department: string;
  responsibleLawyer: string;
  supervisor: string;
  status: string;
  budget: number | null;
  wipTotalBillable: number;
  netBilling: number;
  unbilledBalance: number;
  wipAge: number | null;
  budgetBurn: number | null;
  budgetBurnRag: string | null;
  realisation: number | null;
  realisationRag: string;
  healthScore: number | null;
  healthRag: string;
  wipEntries: MatterWipEntry[];
  invoices: MatterInvoice[];
  profitability: MatterProfitability;
}

export interface MatterPayload {
  mattersAtRisk: MatterAtRisk[];
  matters: MatterRow[];
  pagination: PaginationMeta;
  byCaseType: {
    name: string; count: number; avgRealisation: number | null;
    avgWipAge: number | null; totalWip: number; ragStatus: string;
  }[];
  byDepartment: {
    name: string; count: number; totalWip: number; avgMargin: number | null;
  }[];
  filters: { departments: string[]; caseTypes: string[]; statuses: string[]; lawyers: string[] };
}

// ---------------------------------------------------------------------------
// 6. Client Intelligence
// ---------------------------------------------------------------------------

export interface ClientMatterSummary {
  matterNumber: string;
  caseType: string;
  status: string;
  netBilling: number;
  wipValue: number;
  realisation: number | null;
}

export interface ClientFeeEarnerSummary {
  name: string;
  hours: number;
  revenue: number;
}

export interface ClientInvoiceSummary {
  invoiceNumber: string | null;
  date: string;
  total: number;
  outstanding: number;
}

export interface ClientRow {
  clientName: string;
  contactId: string | null;
  matterCount: number;
  departments: string[];
  totalRevenue: number;
  totalCost: number | null;
  grossMargin: number | null;
  marginPercent: number | null;
  marginRag: string | null;
  totalOutstanding: number;
  avgLockupDays: number | null;
  matters: ClientMatterSummary[];
  feeEarners: ClientFeeEarnerSummary[];
  invoices: ClientInvoiceSummary[];
}

export interface ClientPayload {
  headlines: {
    totalClients: number;
    topClient: { name: string; revenue: number } | null;
    mostAtRisk: { name: string; outstanding: number; oldestDebt: number } | null;
  };
  clients: ClientRow[];
  pagination: PaginationMeta;
  topByRevenue: { name: string; value: number }[];
  topByOutstanding: { name: string; value: number }[];
  filters: { departments: string[]; minMattersOptions: number[] };
}
