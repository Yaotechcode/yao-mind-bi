# Dashboard Data Aggregation API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 6 dashboard data aggregation functions + a single Netlify Function handler that returns pre-shaped payloads for each dashboard view.

**Architecture:** A shared `loadDashboardData` internal helper loads all MongoDB and Supabase data in parallel once per request. Each dashboard function filters and transforms the in-memory data into its typed payload. RAG statuses are read directly from `kpisDoc.kpis.ragAssignments` — never recalculated. All functions handle missing data gracefully (null KPI doc, no invoices uploaded, etc.).

**Tech Stack:** TypeScript strict, Vitest, Netlify Functions, MongoDB (enriched entities + calculated KPIs), Supabase (firm config via `getFirmConfig`).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types/dashboard-payloads.ts` | Create | TypeScript contracts for all 6 payload shapes |
| `src/server/services/dashboard-service.ts` | Create | 6 data aggregation functions + shared loader |
| `src/server/functions/dashboard.ts` | Create | Netlify handler routing to service functions |
| `tests/server/services/dashboard-service.test.ts` | Create | Service tests (TDD) |
| `tests/server/functions/dashboard.test.ts` | Create | Handler routing + auth tests |

---

## Data Architecture Reference

All data comes from three sources loaded in parallel:

```typescript
// kpisDoc.kpis shape (all cast from Record<string, unknown>):
kpisDoc.kpis['aggregate'].feeEarners  → AggregatedFeeEarner[]
kpisDoc.kpis['aggregate'].matters     → AggregatedMatter[]
kpisDoc.kpis['aggregate'].clients     → AggregatedClient[]
kpisDoc.kpis['aggregate'].departments → AggregatedDepartment[]
kpisDoc.kpis['aggregate'].firm        → AggregatedFirm
kpisDoc.kpis['aggregate'].dataQuality → { overallScore, entityIssues, knownGaps }
kpisDoc.kpis['formulaResults']        → Record<formulaId, FormulaResult>
kpisDoc.kpis['ragAssignments']        → Record<formulaId, Record<entityId, RagAssignment>>
kpisDoc.kpis['snippetResults']        → Record<snippetId, Record<entityId, SnippetResult>>

// Enriched entities (via getLatestEnrichedEntities):
timeEntryDoc.records  → EnrichedTimeEntry[]  (has lawyerName, lawyerGrade, lawyerPayModel, date, durationHours, isChargeable, recordedValue, ageInDays)
invoiceDoc.records    → EnrichedInvoice[]    (has invoiceDate, clientName, matterNumber, isOverdue, daysOutstanding, ageBand — all as dynamic fields)
disbursementDoc.records → EnrichedDisbursement[] (has firmExposure, ageInDays, matterNumber — dynamic fields)
matterDoc.records     → EnrichedMatter[]     (has clientName, responsibleLawyer, caseType, department, budget, status — dynamic fields)
```

**RAG lookup pattern:**
```typescript
const ragStatus = ragAssignments?.['F-TU-01']?.[entityId]?.status ?? RagStatus.NEUTRAL;
```

**Formula IDs used by dashboards:**
- `F-TU-01` — Chargeable Utilisation Rate (per fee earner)
- `F-RB-01` — Realisation Rate (per fee earner)
- `F-RB-02` — Effective Hourly Rate (per fee earner)
- `F-WL-01` — WIP Age (per matter)
- `F-WL-02` — Write-Off Analysis (per fee earner)
- `F-WL-04` — Lock-Up Days (per matter/firm)
- `F-PR-02` — Fee Earner Profitability (per fee earner)
- `F-CS-02` — Fee Earner Composite Scorecard (per fee earner)
- `F-DM-01` — Aged Debtors (per invoice/client)
- `SN-004`  — Employment Cost Annual (snippet, per fee earner)

---

## Task 1: TypeScript Payload Types

**Files:**
- Create: `src/shared/types/dashboard-payloads.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/shared/types/dashboard-payloads.ts
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
```

- [ ] **Step 2: Type-check**
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**
```bash
git add src/shared/types/dashboard-payloads.ts
git commit -m "feat: dashboard payload TypeScript types"
```

---

## Task 2: Service Skeleton + Shared Data Loader

**Files:**
- Create: `src/server/services/dashboard-service.ts`

- [ ] **Step 1: Write failing skeleton test**

Create `tests/server/services/dashboard-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getLatestCalculatedKpis: vi.fn(),
  getLatestEnrichedEntities: vi.fn(),
}));

vi.mock('../../../src/server/services/config-service.js', () => ({
  getFirmConfig: vi.fn(),
}));

import { getFirmOverviewData } from '../../../src/server/services/dashboard-service.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';
import * as configService from '../../../src/server/services/config-service.js';

const FIRM_ID = 'firm-test';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeFirmConfig() {
  return {
    firmId: FIRM_ID, firmName: 'Test Firm', ragThresholds: [],
    formulas: [], snippets: [], feeEarnerOverrides: [],
    weeklyTargetHours: 37.5, workingDaysPerWeek: 5,
  };
}

function makeFeeEarner(overrides = {}) {
  return {
    lawyerId: 'l-1', lawyerName: 'Alice',
    wipTotalHours: 120, wipChargeableHours: 90, wipNonChargeableHours: 30,
    wipChargeableValue: 9000, wipTotalValue: 12000, wipWriteOffValue: 500,
    wipMatterCount: 5, wipOrphanedHours: 10, wipOrphanedValue: 800,
    wipOldestEntryDate: null, wipNewestEntryDate: null, wipEntryCount: 50,
    recordingGapDays: 2, invoicedRevenue: 8000, invoicedOutstanding: 1500, invoicedCount: 3,
    ...overrides,
  };
}

function makeMatter(overrides = {}) {
  return {
    matterId: 'm-1', matterNumber: '10001',
    wipTotalHours: 20, wipTotalBillable: 2000, wipTotalWriteOff: 100,
    wipChargeableHours: 18, wipNonChargeableHours: 2,
    wipAgeInDays: 45,
    invoiceCount: 1, invoicedNetBilling: 1800, invoicedDisbursements: 50,
    invoicedTotal: 1850, invoicedOutstanding: 300, invoicedPaid: 1550, invoicedWrittenOff: 0,
    ...overrides,
  };
}

function makeKpisDoc(overrides: Record<string, unknown> = {}) {
  return {
    firm_id: FIRM_ID,
    calculated_at: new Date('2024-06-01T12:00:00.000Z'),
    config_version: '2024-01-01',
    data_version: '2024-06-01',
    kpis: {
      aggregate: {
        feeEarners: [makeFeeEarner()],
        matters: [makeMatter()],
        clients: [{ contactId: 'c-1', displayName: 'Acme Corp', clientName: 'Acme Corp', matterCount: 1, activeMatterCount: 1, closedMatterCount: 0, totalWipValue: 2000, totalInvoiced: 1800, totalOutstanding: 300, totalPaid: 1550, oldestMatterDate: null }],
        departments: [{ name: 'Property', feeEarnerCount: 1, activeFeeEarnerCount: 1, activeMatterCount: 1, totalMatterCount: 1, wipTotalHours: 20, wipChargeableHours: 18, wipChargeableValue: 2000, invoicedRevenue: 1800, invoicedOutstanding: 300 }],
        firm: { feeEarnerCount: 1, activeFeeEarnerCount: 1, salariedFeeEarnerCount: 1, feeShareFeeEarnerCount: 0, matterCount: 1, activeMatterCount: 1, inProgressMatterCount: 1, completedMatterCount: 0, otherMatterCount: 0, totalWipHours: 120, totalChargeableHours: 90, totalWipValue: 12000, totalWriteOffValue: 500, totalInvoicedRevenue: 8000, totalOutstanding: 1500, totalPaid: 6500, orphanedWip: { orphanedWipEntryCount: 5, orphanedWipHours: 10, orphanedWipValue: 800, orphanedWipPercent: 6.7, orphanedWipNote: '' } },
        dataQuality: { overallScore: 90, entityIssues: [], knownGaps: [] },
      },
      formulaResults: {
        'F-TU-01': { formulaId: 'F-TU-01', formulaName: 'Utilisation', variantUsed: null, resultType: 'percentage', entityResults: { 'l-1': { entityId: 'l-1', entityName: 'Alice', value: 75.5, formattedValue: '75.5%', nullReason: null } }, summary: { mean: 75.5, median: 75.5, min: 75.5, max: 75.5, total: 75.5, count: 1, nullCount: 0 }, computedAt: '2024-06-01T12:00:00.000Z', metadata: { executionTimeMs: 5, inputsUsed: [], nullReasons: [], warnings: [] } },
      },
      ragAssignments: {
        'F-TU-01': { 'l-1': { status: 'green', value: 75.5, thresholdUsed: 'default', boundaries: { green: { min: 70 }, amber: { min: 50, max: 70 }, red: { max: 50 } }, distanceToNext: 4.5 } },
      },
      snippetResults: {},
      calculationMetadata: { calculatedAt: '2024-06-01T12:00:00.000Z', totalExecutionTimeMs: 50 },
      ...overrides,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(configService.getFirmConfig).mockResolvedValue(makeFirmConfig() as never);
  vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);
});

describe('getFirmOverviewData', () => {
  it('returns a valid FirmOverviewPayload shape', async () => {
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.kpiCards).toBeDefined();
    expect(result.kpiCards.totalUnbilledWip).toBeDefined();
    expect(result.kpiCards.firmRealisation).toBeDefined();
    expect(result.kpiCards.firmUtilisation).toBeDefined();
    expect(result.kpiCards.combinedLockup).toBeDefined();
    expect(Array.isArray(result.wipAgeBands)).toBe(true);
    expect(Array.isArray(result.revenueTrend)).toBe(true);
    expect(Array.isArray(result.topLeakageRisks)).toBe(true);
    expect(result.utilisationSnapshot).toBeDefined();
    expect(Array.isArray(result.departmentSummary)).toBe(true);
    expect(result.dataQuality).toBeDefined();
  });

  it('sets lastCalculated from kpisDoc.calculated_at', async () => {
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.lastCalculated).toBe('2024-06-01T12:00:00.000Z');
  });

  it('sets totalUnbilledWip from aggregate.firm.totalWipValue', async () => {
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.kpiCards.totalUnbilledWip.value).toBe(12000);
  });

  it('reads utilisation RAG from ragAssignments', async () => {
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.utilisationSnapshot.green).toBeGreaterThanOrEqual(1);
  });

  it('returns null lastCalculated and empty data when no kpisDoc', async () => {
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(null);
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.lastCalculated).toBeNull();
    expect(result.kpiCards.totalUnbilledWip.value).toBe(0);
    expect(result.departmentSummary).toEqual([]);
  });

  it('enforces firm isolation — uses firmId in all MongoDB calls', async () => {
    await getFirmOverviewData('firm-xyz');
    expect(vi.mocked(mongoOps.getLatestCalculatedKpis)).toHaveBeenCalledWith('firm-xyz');
    expect(vi.mocked(mongoOps.getLatestEnrichedEntities)).toHaveBeenCalledWith('firm-xyz', expect.any(String));
    expect(vi.mocked(configService.getFirmConfig)).toHaveBeenCalledWith('firm-xyz');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
```bash
npx vitest run tests/server/services/dashboard-service.test.ts 2>&1 | head -20
```
Expected: FAIL — `getFirmOverviewData` not found.

- [ ] **Step 3: Create the service skeleton**

Create `src/server/services/dashboard-service.ts` with imports, the shared `loadDashboardData` helper, and stubs for all 6 functions:

```typescript
/**
 * dashboard-service.ts — Dashboard Data Aggregation Service
 *
 * One function per dashboard. Each function loads data in parallel,
 * applies filters in-memory, and returns a typed payload.
 *
 * RAG statuses come FROM calculated KPIs — never recalculated here.
 */

import type { AggregatedFeeEarner, AggregatedMatter, AggregatedClient, AggregatedDepartment, AggregatedFirm } from '../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '../../shared/types/enriched.js';
import type { FormulaResult } from '../formula-engine/types.js';
import type { RagAssignment } from '../formula-engine/rag-engine.js';
import type { SnippetResult } from '../formula-engine/types.js';
import type {
  FirmOverviewPayload, FeeEarnerPerformancePayload, WipPayload,
  BillingPayload, MatterPayload, ClientPayload,
} from '../../shared/types/dashboard-payloads.js';
import { RagStatus } from '../../shared/types/index.js';
import { getLatestCalculatedKpis, getLatestEnrichedEntities } from '../lib/mongodb-operations.js';
import { getFirmConfig } from './config-service.js';

// ---------------------------------------------------------------------------
// Filter / pagination types
// ---------------------------------------------------------------------------

export interface DashboardFilters {
  department?: string;
  grade?: string;
  payModel?: string;
  activeOnly?: boolean;
  feeEarner?: string;
  caseType?: string;
  status?: string;
  lawyer?: string;
  minValue?: number;
  minMatters?: number;
  minRevenue?: number;
  hasBudget?: boolean;
  period?: string;
  groupBy?: 'matter' | 'feeEarner' | 'client';
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Internal: loaded dashboard data
// ---------------------------------------------------------------------------

interface DashboardData {
  feeEarners: AggregatedFeeEarner[];
  matters: AggregatedMatter[];
  clients: AggregatedClient[];
  departments: AggregatedDepartment[];
  firm: AggregatedFirm;
  dataQuality: { overallScore: number; entityIssues: unknown[]; knownGaps: unknown[] };
  formulaResults: Record<string, FormulaResult>;
  ragAssignments: Record<string, Record<string, RagAssignment>>;
  snippetResults: Record<string, Record<string, SnippetResult>>;
  timeEntries: EnrichedTimeEntry[];
  invoices: EnrichedInvoice[];
  disbursements: EnrichedDisbursement[];
  enrichedMatters: Record<string, unknown>[];
  calculatedAt: string | null;
}

const EMPTY_FIRM: AggregatedFirm = {
  feeEarnerCount: 0, activeFeeEarnerCount: 0, salariedFeeEarnerCount: 0,
  feeShareFeeEarnerCount: 0, matterCount: 0, activeMatterCount: 0,
  inProgressMatterCount: 0, completedMatterCount: 0, otherMatterCount: 0,
  totalWipHours: 0, totalChargeableHours: 0, totalWipValue: 0,
  totalWriteOffValue: 0, totalInvoicedRevenue: 0, totalOutstanding: 0, totalPaid: 0,
  orphanedWip: { orphanedWipEntryCount: 0, orphanedWipHours: 0, orphanedWipValue: 0, orphanedWipPercent: 0, orphanedWipNote: '' },
};

async function loadDashboardData(firmId: string): Promise<DashboardData> {
  const [kpisDoc, timeEntryDoc, invoiceDoc, disbursementDoc, matterDoc] = await Promise.all([
    getLatestCalculatedKpis(firmId),
    getLatestEnrichedEntities(firmId, 'timeEntry'),
    getLatestEnrichedEntities(firmId, 'invoice'),
    getLatestEnrichedEntities(firmId, 'disbursement'),
    getLatestEnrichedEntities(firmId, 'matter'),
  ]);

  const agg = kpisDoc?.kpis?.['aggregate'] as Record<string, unknown> | undefined;
  const kpis = kpisDoc?.kpis as Record<string, unknown> | undefined;

  return {
    feeEarners:     (agg?.feeEarners as AggregatedFeeEarner[] | undefined) ?? [],
    matters:        (agg?.matters    as AggregatedMatter[]    | undefined) ?? [],
    clients:        (agg?.clients    as AggregatedClient[]    | undefined) ?? [],
    departments:    (agg?.departments as AggregatedDepartment[] | undefined) ?? [],
    firm:           (agg?.firm       as AggregatedFirm        | undefined) ?? EMPTY_FIRM,
    dataQuality:    (agg?.dataQuality as { overallScore: number; entityIssues: unknown[]; knownGaps: unknown[] } | undefined) ?? { overallScore: 0, entityIssues: [], knownGaps: [] },
    formulaResults: (kpis?.formulaResults as Record<string, FormulaResult> | undefined) ?? {},
    ragAssignments: (kpis?.ragAssignments as Record<string, Record<string, RagAssignment>> | undefined) ?? {},
    snippetResults: (kpis?.snippetResults as Record<string, Record<string, SnippetResult>> | undefined) ?? {},
    timeEntries:    ((timeEntryDoc?.records ?? []) as unknown as EnrichedTimeEntry[]),
    invoices:       ((invoiceDoc?.records    ?? []) as unknown as EnrichedInvoice[]),
    disbursements:  ((disbursementDoc?.records ?? []) as unknown as EnrichedDisbursement[]),
    enrichedMatters: (matterDoc?.records ?? []) as Record<string, unknown>[],
    calculatedAt:   kpisDoc?.calculated_at ? new Date(kpisDoc.calculated_at).toISOString() : null,
  };
}

/** Get RAG status from assignments, defaulting to NEUTRAL. */
function getRag(ragAssignments: Record<string, Record<string, RagAssignment>>, formulaId: string, entityId: string): string {
  return ragAssignments?.[formulaId]?.[entityId]?.status ?? RagStatus.NEUTRAL;
}

/** Paginate an array; returns { items, totalCount }. */
function paginate<T>(items: T[], limit = 50, offset = 0): { items: T[]; totalCount: number } {
  return { items: items.slice(offset, offset + limit), totalCount: items.length };
}

// ---------------------------------------------------------------------------
// WIP Age Band helper
// ---------------------------------------------------------------------------

const WIP_BANDS = [
  { band: '0–30 days',   min: 0,   max: 30,  colour: '#09B5B5', recoveryProb: 0.95 },
  { band: '31–60 days',  min: 31,  max: 60,  colour: '#4BC8C8', recoveryProb: 0.85 },
  { band: '61–90 days',  min: 61,  max: 90,  colour: '#E49060', recoveryProb: 0.70 },
  { band: '91–180 days', min: 91,  max: 180, colour: '#E4607B', recoveryProb: 0.50 },
  { band: '180+ days',   min: 181, max: null, colour: '#C04060', recoveryProb: 0.25 },
];

function classifyWipAge(ageInDays: number | null): typeof WIP_BANDS[0] {
  if (ageInDays === null) return WIP_BANDS[0];
  return WIP_BANDS.find(b => ageInDays >= b.min && (b.max === null || ageInDays <= b.max)) ?? WIP_BANDS[WIP_BANDS.length - 1];
}

/** Generate last N working days (Mon–Fri) as YYYY-MM-DD strings. */
function lastNWorkingDays(n: number): string[] {
  const days: string[] = [];
  const d = new Date();
  while (days.length < n) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.unshift(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

// ---------------------------------------------------------------------------
// 1. getFirmOverviewData
// ---------------------------------------------------------------------------

export async function getFirmOverviewData(firmId: string): Promise<FirmOverviewPayload> {
  const [data] = await Promise.all([
    loadDashboardData(firmId),
    getFirmConfig(firmId),  // loaded for potential custom metrics
  ]);

  const { feeEarners, matters, departments, firm, dataQuality, formulaResults, ragAssignments, invoices } = data;

  // KPI cards
  const utilisationResult = formulaResults['F-TU-01'];
  const utilisationValues = utilisationResult
    ? Object.values(utilisationResult.entityResults).map(e => e.value).filter((v): v is number => v !== null)
    : [];
  const avgUtilisation = utilisationValues.length > 0
    ? utilisationValues.reduce((s, v) => s + v, 0) / utilisationValues.length
    : null;

  const realisationResult = formulaResults['F-RB-01'];
  const realisationValues = realisationResult
    ? Object.values(realisationResult.entityResults).map(e => e.value).filter((v): v is number => v !== null)
    : [];
  const avgRealisation = realisationValues.length > 0
    ? realisationValues.reduce((s, v) => s + v, 0) / realisationValues.length
    : null;

  const lockupResult = formulaResults['F-WL-04'];
  const lockupFirmValue = lockupResult?.entityResults?.['firm']?.value ?? null;

  // WIP age bands
  const bandMap = new Map<string, { value: number; count: number }>(
    WIP_BANDS.map(b => [b.band, { value: 0, count: 0 }]),
  );
  for (const m of matters) {
    const band = classifyWipAge(m.wipAgeInDays ?? null);
    const entry = bandMap.get(band.band)!;
    entry.value += m.wipTotalBillable;
    entry.count += 1;
  }
  const wipAgeBands = WIP_BANDS.map(b => ({
    ...b, value: bandMap.get(b.band)?.value ?? 0, count: bandMap.get(b.band)?.count ?? 0,
  }));

  // Revenue trend from invoices grouped by month
  const trendMap = new Map<string, number>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = invRec['invoiceDate'] as string | undefined;
    if (!dateStr) continue;
    const period = dateStr.slice(0, 7); // YYYY-MM
    const total = (invRec['total'] as number | undefined) ?? 0;
    trendMap.set(period, (trendMap.get(period) ?? 0) + total);
  }
  const revenueTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([period, billed]) => ({ period, billed }));

  // Top leakage risks (top 10 by riskScore)
  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of data.enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  const leakageRisks = matters
    .filter(m => (m.wipTotalBillable ?? 0) > 0)
    .map(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      const wipAge = m.wipAgeInDays ?? 0;
      const wipValue = m.wipTotalBillable;
      const ragStatus = getRag(ragAssignments, 'F-WL-01', m.matterId ?? m.matterNumber ?? '');
      return {
        matterId: m.matterId ?? '',
        matterNumber: m.matterNumber ?? '',
        clientName: (em?.['clientName'] as string | undefined) ?? (em?.['displayName'] as string | undefined) ?? 'Unknown',
        lawyerName: (em?.['responsibleLawyer'] as string | undefined) ?? 'Unknown',
        wipValue,
        wipAge,
        ragStatus,
        riskScore: Math.round(wipAge * wipValue / 1000),
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);

  // Utilisation snapshot
  let green = 0, amber = 0, red = 0;
  const utilisationFeeEarners = feeEarners.map(fe => {
    const entityId = fe.lawyerId ?? fe.lawyerName ?? '';
    const rag = getRag(ragAssignments, 'F-TU-01', entityId);
    if (rag === RagStatus.GREEN) green++;
    else if (rag === RagStatus.AMBER) amber++;
    else if (rag === RagStatus.RED) red++;
    const val = formulaResults['F-TU-01']?.entityResults?.[entityId]?.value ?? null;
    return { name: fe.lawyerName ?? entityId, utilisation: val, ragStatus: rag };
  });

  // Department summary
  const departmentSummary = departments.map(dept => {
    const deptFeeEarners = feeEarners.filter(fe => {
      const em = data.enrichedMatters.find(m => (m['responsibleLawyer'] as string | undefined) === fe.lawyerName);
      return em?.['department'] === dept.name;
    });
    const utilisationVals = deptFeeEarners
      .map(fe => formulaResults['F-TU-01']?.entityResults?.[fe.lawyerId ?? fe.lawyerName ?? '']?.value)
      .filter((v): v is number => typeof v === 'number');
    const avgUtil = utilisationVals.length > 0
      ? utilisationVals.reduce((s, v) => s + v, 0) / utilisationVals.length
      : null;
    const ragStatus = avgUtil !== null
      ? getRag(ragAssignments, 'F-TU-01', deptFeeEarners[0]?.lawyerId ?? deptFeeEarners[0]?.lawyerName ?? '')
      : RagStatus.NEUTRAL;
    return {
      name: dept.name,
      wipValue: dept.wipChargeableValue,
      matterCount: dept.activeMatterCount,
      utilisation: avgUtil,
      ragStatus,
    };
  });

  const issueCount = (dataQuality.entityIssues as unknown[]).length + (dataQuality.knownGaps as unknown[]).length;

  return {
    kpiCards: {
      totalUnbilledWip: { value: firm.totalWipValue, ragStatus: RagStatus.NEUTRAL },
      firmRealisation: { value: avgRealisation, ragStatus: avgRealisation !== null ? getRag(ragAssignments, 'F-RB-01', 'firm') : RagStatus.NEUTRAL },
      firmUtilisation: { value: avgUtilisation, ragStatus: avgUtilisation !== null ? getRag(ragAssignments, 'F-TU-01', 'firm') : RagStatus.NEUTRAL },
      combinedLockup: { value: lockupFirmValue, ragStatus: lockupFirmValue !== null ? getRag(ragAssignments, 'F-WL-04', 'firm') : RagStatus.NEUTRAL },
    },
    wipAgeBands,
    revenueTrend,
    topLeakageRisks: leakageRisks,
    utilisationSnapshot: { green, amber, red, feeEarners: utilisationFeeEarners },
    departmentSummary,
    dataQuality: { issueCount, criticalCount: (dataQuality.entityIssues as unknown[]).length },
    lastCalculated: data.calculatedAt,
  };
}

// ---------------------------------------------------------------------------
// 2. getFeeEarnerPerformanceData
// ---------------------------------------------------------------------------

export async function getFeeEarnerPerformanceData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<FeeEarnerPerformancePayload> {
  const [data, firmConfig] = await Promise.all([loadDashboardData(firmId), getFirmConfig(firmId)]);
  const { feeEarners, formulaResults, ragAssignments, snippetResults, timeEntries } = data;
  const weeklyTarget = firmConfig.weeklyTargetHours ?? 37.5;

  // Build grade/payModel/department lookup from enriched time entries
  const feProfileMap = new Map<string, { grade: string; payModel: string; department: string }>();
  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    const name = (te.lawyerName ?? teRec['responsibleLawyer']) as string | undefined;
    if (!name || feProfileMap.has(name)) continue;
    feProfileMap.set(name, {
      grade: (te.lawyerGrade ?? 'Unknown') as string,
      payModel: (te.lawyerPayModel ?? 'Unknown') as string,
      department: (teRec['department'] as string | undefined) ?? 'Unknown',
    });
  }

  // Working days lookup for recording pattern
  const last20Days = lastNWorkingDays(20);
  const entryDatesByLawyer = new Map<string, Set<string>>();
  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    const name = (te.lawyerName ?? teRec['responsibleLawyer']) as string | undefined;
    const dateStr = teRec['date'] as string | undefined;
    if (!name || !dateStr) continue;
    if (!entryDatesByLawyer.has(name)) entryDatesByLawyer.set(name, new Set());
    entryDatesByLawyer.get(name)!.add(dateStr.slice(0, 10));
  }

  // Apply filters
  let filtered = feeEarners;
  if (filters.department) filtered = filtered.filter(fe => feProfileMap.get(fe.lawyerName ?? '')?.department === filters.department);
  if (filters.grade) filtered = filtered.filter(fe => feProfileMap.get(fe.lawyerName ?? '')?.grade === filters.grade);
  if (filters.payModel) filtered = filtered.filter(fe => feProfileMap.get(fe.lawyerName ?? '')?.payModel === filters.payModel);
  if (filters.activeOnly) filtered = filtered.filter(fe => (fe.recordingGapDays ?? 999) < 90);

  const { items: paged, totalCount } = paginate(filtered, filters.limit, filters.offset);

  const rows = paged.map(fe => {
    const entityId = fe.lawyerId ?? fe.lawyerName ?? '';
    const profile = feProfileMap.get(fe.lawyerName ?? '') ?? { grade: 'Unknown', payModel: 'Unknown', department: 'Unknown' };
    const utilisationVal = formulaResults['F-TU-01']?.entityResults?.[entityId]?.value ?? null;
    const scorecardVal = formulaResults['F-CS-02']?.entityResults?.[entityId]?.value ?? null;
    const effectiveRate = formulaResults['F-RB-02']?.entityResults?.[entityId]?.value ?? null;
    const writeOffRate = fe.wipTotalValue > 0 ? (fe.wipWriteOffValue / fe.wipTotalValue) * 100 : 0;
    const employmentCost = snippetResults?.['SN-004']?.[entityId]?.value ?? null;
    const profit = formulaResults['F-PR-02']?.entityResults?.[entityId]?.value ?? null;
    const revenueMultiple = profit !== null && employmentCost !== null && employmentCost > 0
      ? fe.invoicedRevenue / employmentCost : null;
    const entryDates = entryDatesByLawyer.get(fe.lawyerName ?? '') ?? new Set();
    const recordingPattern = last20Days.map(date => ({ date, hasEntries: entryDates.has(date) }));

    return {
      id: entityId,
      name: fe.lawyerName ?? entityId,
      department: profile.department,
      grade: profile.grade,
      payModel: profile.payModel,
      isActive: (fe.recordingGapDays ?? 999) < 90,
      chargeableHours: fe.wipChargeableHours,
      totalHours: fe.wipTotalHours,
      utilisation: utilisationVal,
      utilisationRag: getRag(ragAssignments, 'F-TU-01', entityId),
      wipValueRecorded: fe.wipTotalValue,
      billedRevenue: fe.invoicedRevenue,
      effectiveRate,
      writeOffRate,
      recordingGapDays: fe.recordingGapDays,
      matterCount: fe.wipMatterCount,
      scorecard: scorecardVal,
      scorecardRag: getRag(ragAssignments, 'F-CS-02', entityId),
      employmentCost,
      revenueMultiple,
      profit,
      recordingPattern,
    };
  });

  // Alerts: recording gap > 5 days
  const alerts = feeEarners
    .filter(fe => (fe.recordingGapDays ?? 0) > 5)
    .map(fe => ({
      feeEarnerId: fe.lawyerId ?? fe.lawyerName ?? '',
      name: fe.lawyerName ?? '',
      type: 'recording_gap',
      message: `No time entries for ${fe.recordingGapDays} days`,
    }));

  const allGrades = [...new Set(feeEarners.map(fe => feProfileMap.get(fe.lawyerName ?? '')?.grade ?? '').filter(Boolean))];
  const allDepts = [...new Set(feeEarners.map(fe => feProfileMap.get(fe.lawyerName ?? '')?.department ?? '').filter(Boolean))];
  const allPayModels = [...new Set(feeEarners.map(fe => feProfileMap.get(fe.lawyerName ?? '')?.payModel ?? '').filter(Boolean))];

  const utilisationTarget = (weeklyTarget / (weeklyTarget + 7.5)) * 100; // heuristic target

  return {
    alerts,
    feeEarners: rows,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    charts: {
      utilisationBars: rows.map(r => ({ name: r.name, value: r.utilisation, target: utilisationTarget, ragStatus: r.utilisationRag })),
      chargeableStack: rows.map(r => ({ name: r.name, chargeable: r.chargeableHours, nonChargeable: r.totalHours - r.chargeableHours })),
    },
    filters: { departments: allDepts, grades: allGrades, payModels: allPayModels },
  };
}

// ---------------------------------------------------------------------------
// 3. getWipData
// ---------------------------------------------------------------------------

export async function getWipData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<WipPayload> {
  const data = await loadDashboardData(firmId);
  const { matters, timeEntries, disbursements, formulaResults, ragAssignments, enrichedMatters } = data;

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Apply filters
  let filteredMatters = matters;
  if (filters.department) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['department'] === filters.department;
    });
  }
  if (filters.feeEarner) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['responsibleLawyer'] === filters.feeEarner;
    });
  }
  if (filters.caseType) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['caseType'] === filters.caseType;
    });
  }
  if (filters.minValue != null) {
    filteredMatters = filteredMatters.filter(m => m.wipTotalBillable >= (filters.minValue ?? 0));
  }

  // Age bands
  const bandAcc = new Map<string, { value: number; count: number }>(WIP_BANDS.map(b => [b.band, { value: 0, count: 0 }]));
  for (const m of filteredMatters) {
    const band = classifyWipAge(m.wipAgeInDays ?? null);
    const acc = bandAcc.get(band.band)!;
    acc.value += m.wipTotalBillable;
    acc.count += 1;
  }
  const ageBands = WIP_BANDS.map(b => ({
    ...b, value: bandAcc.get(b.band)?.value ?? 0, count: bandAcc.get(b.band)?.count ?? 0,
  }));

  // By department
  const deptMap = new Map<string, { value: number; count: number }>();
  for (const m of filteredMatters) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const dept = (em?.['department'] as string | undefined) ?? 'Unknown';
    const acc = deptMap.get(dept) ?? { value: 0, count: 0 };
    acc.value += m.wipTotalBillable;
    acc.count += 1;
    deptMap.set(dept, acc);
  }
  const byDepartment = [...deptMap.entries()].map(([name, { value, count }]) => ({ name, value, count }));

  // Write-off analysis
  const totalWipValue = filteredMatters.reduce((s, m) => s + m.wipTotalBillable, 0);
  const totalWriteOff = filteredMatters.reduce((s, m) => s + m.wipTotalWriteOff, 0);
  const writeOffRate = totalWipValue > 0 ? (totalWriteOff / totalWipValue) * 100 : 0;

  // Disbursement exposure
  const totalExposure = disbursements.reduce((s, d) => {
    const dr = d as unknown as Record<string, unknown>;
    return s + ((dr['firmExposure'] as number | undefined) ?? 0);
  }, 0);
  const disbByMatter = new Map<string, { value: number; age: number; clientName: string }>();
  for (const d of disbursements) {
    const dr = d as unknown as Record<string, unknown>;
    const mNum = (dr['matterNumber'] as string | undefined) ?? '';
    const exposure = (dr['firmExposure'] as number | undefined) ?? 0;
    const age = (d.ageInDays ?? 0) as number;
    const existing = disbByMatter.get(mNum) ?? { value: 0, age: 0, clientName: (dr['clientName'] as string | undefined) ?? 'Unknown' };
    disbByMatter.set(mNum, { value: existing.value + exposure, age: Math.max(existing.age, age), clientName: existing.clientName });
  }

  // Entries grouped
  const groupBy = filters.groupBy ?? 'matter';
  const groupMap = new Map<string, { label: string; value: number; hours: number; ageSum: number; count: number; entries: typeof timeEntries }>();

  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    let groupKey = '';
    let groupLabel = '';
    if (groupBy === 'feeEarner') {
      groupKey = (te.lawyerName ?? teRec['responsibleLawyer'] as string | undefined) ?? 'Unknown';
      groupLabel = groupKey;
    } else if (groupBy === 'client') {
      groupKey = (te.clientName ?? 'Unknown') as string;
      groupLabel = groupKey;
    } else {
      groupKey = (teRec['matterNumber'] as string | undefined) ?? (teRec['matterId'] as string | undefined) ?? 'Unknown';
      groupLabel = `Matter ${groupKey}`;
    }
    const existing = groupMap.get(groupKey) ?? { label: groupLabel, value: 0, hours: 0, ageSum: 0, count: 0, entries: [] };
    existing.value += (te.recordedValue ?? 0) as number;
    existing.hours += (te.durationHours ?? 0) as number;
    existing.ageSum += (te.ageInDays ?? 0) as number;
    existing.count += 1;
    existing.entries.push(te);
    groupMap.set(groupKey, existing);
  }

  const allGroups = [...groupMap.entries()].map(([key, g]) => ({
    groupKey: key,
    groupLabel: g.label,
    totalValue: g.value,
    totalHours: g.hours,
    avgAge: g.count > 0 ? g.ageSum / g.count : 0,
    entryCount: g.count,
    ragStatus: RagStatus.NEUTRAL,
    details: g.entries.slice(0, 20).map(te => {
      const teRec = te as unknown as Record<string, unknown>;
      return {
        entryId: (teRec['id'] as string | undefined) ?? '',
        date: (teRec['date'] as string | undefined) ?? '',
        lawyerName: (te.lawyerName ?? 'Unknown') as string,
        hours: (te.durationHours ?? 0) as number,
        value: (te.recordedValue ?? 0) as number,
        age: (te.ageInDays ?? 0) as number,
        rate: (teRec['rate'] as number | undefined) ?? 0,
        doNotBill: (teRec['doNotBill'] as boolean | undefined) ?? false,
      };
    }),
  }));

  const { items: pagedGroups, totalCount } = paginate(allGroups, filters.limit, filters.offset);

  const atRiskValue = ageBands.slice(2).reduce((s, b) => s + b.value, 0); // 61+ days
  const totalUnbilledWip = totalWipValue;
  const atRiskPct = totalUnbilledWip > 0 ? (atRiskValue / totalUnbilledWip) * 100 : 0;

  // Unique filter values
  const allDepts = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers = [...new Set(enrichedMatters.map(em => (em['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];
  const allCaseTypes = [...new Set(enrichedMatters.map(em => (em['caseType'] as string | undefined) ?? '').filter(Boolean))];

  return {
    headlines: {
      totalUnbilledWip: { value: totalUnbilledWip, grossValue: totalUnbilledWip + totalWriteOff, netValue: totalUnbilledWip },
      atRisk: { value: atRiskValue, percentage: atRiskPct, ragStatus: atRiskPct > 30 ? RagStatus.RED : atRiskPct > 15 ? RagStatus.AMBER : RagStatus.GREEN },
      estimatedLeakage: { value: Math.round(atRiskValue * 0.3), methodology: 'average-of-ages × 30% loss rate for 61+ day WIP' },
    },
    ageBands,
    byDepartment,
    entries: pagedGroups,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    writeOffAnalysis: {
      totalWriteOff,
      writeOffRate,
      ragStatus: writeOffRate > 10 ? RagStatus.RED : writeOffRate > 5 ? RagStatus.AMBER : RagStatus.GREEN,
      byFeeEarner: [],  // derived from formula results if F-WL-02 available
      byCaseType: [],
    },
    disbursementExposure: {
      totalExposure,
      byMatter: [...disbByMatter.entries()].map(([matterNumber, { value, age, clientName }]) => ({ matterNumber, clientName, value, age })),
    },
    filters: { departments: allDepts, feeEarners: allLawyers, caseTypes: allCaseTypes },
  };
}

// ---------------------------------------------------------------------------
// 4. getBillingCollectionsData
// ---------------------------------------------------------------------------

export async function getBillingCollectionsData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<BillingPayload> {
  const data = await loadDashboardData(firmId);
  const { firm, invoices, matters, ragAssignments, formulaResults } = data;

  // Apply filters
  let filteredInvoices = invoices;
  if (filters.department) {
    filteredInvoices = filteredInvoices.filter(inv => {
      const invRec = inv as unknown as Record<string, unknown>;
      return invRec['department'] === filters.department;
    });
  }
  if (filters.feeEarner) {
    filteredInvoices = filteredInvoices.filter(inv => {
      const invRec = inv as unknown as Record<string, unknown>;
      return invRec['responsibleLawyer'] === filters.feeEarner;
    });
  }

  // Invoice metrics
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currentPeriod = filteredInvoices.filter(inv => {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = invRec['invoiceDate'] as string | undefined;
    if (!dateStr) return false;
    return new Date(dateStr) >= periodStart;
  });
  const invoicedPeriodValue = currentPeriod.reduce((s, inv) => s + ((inv as unknown as Record<string, unknown>)['total'] as number ?? 0), 0);
  const collectedPeriodValue = currentPeriod.reduce((s, inv) => s + ((inv as unknown as Record<string, unknown>)['paid'] as number ?? 0), 0);

  // Aged debtors
  const DEBTOR_BANDS = [
    { band: '0–30 days',   colour: '#09B5B5', min: 0,   max: 30  },
    { band: '31–60 days',  colour: '#4BC8C8', min: 31,  max: 60  },
    { band: '61–90 days',  colour: '#E49060', min: 61,  max: 90  },
    { band: '91–120 days', colour: '#E4607B', min: 91,  max: 120 },
    { band: '120+ days',   colour: '#C04060', min: 121, max: null },
  ];
  const debtorBandMap = new Map<string, { value: number; count: number }>(DEBTOR_BANDS.map(b => [b.band, { value: 0, count: 0 }]));
  for (const inv of filteredInvoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const outstanding = (invRec['outstanding'] as number | undefined) ?? 0;
    if (outstanding <= 0) continue;
    const days = (inv.daysOutstanding ?? 0) as number;
    const band = DEBTOR_BANDS.find(b => days >= b.min && (b.max === null || days <= b.max)) ?? DEBTOR_BANDS[DEBTOR_BANDS.length - 1];
    const acc = debtorBandMap.get(band.band)!;
    acc.value += outstanding;
    acc.count += 1;
  }
  const agedDebtors = DEBTOR_BANDS.map(b => ({
    band: b.band, colour: b.colour,
    value: debtorBandMap.get(b.band)?.value ?? 0,
    count: debtorBandMap.get(b.band)?.count ?? 0,
  }));

  // Billing trend (group by month)
  const trendMap = new Map<string, { invoiced: number; collected: number; writeOff: number }>();
  for (const inv of filteredInvoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = invRec['invoiceDate'] as string | undefined;
    if (!dateStr) continue;
    const period = dateStr.slice(0, 7);
    const acc = trendMap.get(period) ?? { invoiced: 0, collected: 0, writeOff: 0 };
    acc.invoiced += (invRec['total'] as number | undefined) ?? 0;
    acc.collected += (invRec['paid'] as number | undefined) ?? 0;
    acc.writeOff += (invRec['writtenOff'] as number | undefined) ?? 0;
    trendMap.set(period, acc);
  }
  const billingTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([period, v]) => ({ period, ...v }));

  // Invoice rows
  const allInvoiceRows = filteredInvoices.map(inv => {
    const invRec = inv as unknown as Record<string, unknown>;
    const outstanding = (invRec['outstanding'] as number | undefined) ?? 0;
    const rag = outstanding > 0 && inv.isOverdue ? RagStatus.RED : outstanding > 0 ? RagStatus.AMBER : RagStatus.GREEN;
    return {
      invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null,
      clientName: (inv.clientName as string | undefined) ?? (invRec['clients'] as string | undefined) ?? 'Unknown',
      matterNumber: String((invRec['matterNumber'] as unknown) ?? ''),
      invoiceDate: (invRec['invoiceDate'] as string | undefined) ?? '',
      total: (invRec['total'] as number | undefined) ?? 0,
      outstanding,
      paid: (invRec['paid'] as number | undefined) ?? 0,
      daysOutstanding: inv.daysOutstanding ?? null,
      ageBand: inv.ageBand ?? null,
      ragStatus: rag,
      isOverdue: inv.isOverdue,
    };
  });

  const { items: pagedInvoices, totalCount } = paginate(allInvoiceRows, filters.limit, filters.offset);

  // Slow payers — only if any datePaid fields present
  const hasDatePaid = filteredInvoices.some(inv => !!(inv as unknown as Record<string, unknown>)['datePaid']);
  const slowPayers = hasDatePaid ? [] : null;

  // WIP pipeline
  const totalWipValue = firm.totalWipValue;
  const lockupDays = formulaResults['F-WL-04']?.entityResults?.['firm']?.value ?? null;
  const allDepts = [...new Set(filteredInvoices.map(inv => ((inv as unknown as Record<string, unknown>)['department'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers = [...new Set(filteredInvoices.map(inv => ((inv as unknown as Record<string, unknown>)['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];

  const collectionRate = invoicedPeriodValue > 0 ? (collectedPeriodValue / invoicedPeriodValue) * 100 : 0;

  return {
    headlines: {
      invoicedPeriod: { value: invoicedPeriodValue, count: currentPeriod.length },
      collectedPeriod: { value: collectedPeriodValue, rate: collectionRate },
      totalOutstanding: { value: firm.totalOutstanding },
    },
    pipeline: {
      wip: { value: totalWipValue, avgDays: lockupDays },
      invoiced: { value: firm.totalInvoicedRevenue, avgDaysToPayment: null },
      paid: { value: firm.totalPaid },
      writtenOff: { value: firm.totalWriteOffValue, rate: firm.totalWipValue > 0 ? (firm.totalWriteOffValue / firm.totalWipValue) * 100 : 0 },
      totalLockup: lockupDays ?? 0,
    },
    agedDebtors,
    billingTrend,
    invoices: pagedInvoices,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    slowPayers,
    filters: { departments: allDepts, feeEarners: allLawyers },
  };
}

// ---------------------------------------------------------------------------
// 5. getMatterAnalysisData
// ---------------------------------------------------------------------------

export async function getMatterAnalysisData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<MatterPayload> {
  const data = await loadDashboardData(firmId);
  const { matters, enrichedMatters, timeEntries, invoices, formulaResults, ragAssignments } = data;

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Apply filters
  let filtered = matters;
  if (filters.department) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['department'] === filters.department; });
  if (filters.caseType) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['caseType'] === filters.caseType; });
  if (filters.status) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['matterStatus'] === filters.status; });
  if (filters.lawyer) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['responsibleLawyer'] === filters.lawyer; });
  if (filters.hasBudget) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return (em?.['matterBudget'] as number | undefined ?? 0) > 0; });

  // Matters at risk
  const mattersAtRisk = filtered
    .filter(m => {
      const wipAge = m.wipAgeInDays ?? 0;
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      const budget = (em?.['matterBudget'] as number | undefined) ?? 0;
      const budgetBurn = budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
      const realisation = m.invoicedNetBilling > 0 && m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
      return wipAge > 60 || (budgetBurn !== null && budgetBurn > 100) || (realisation !== null && realisation < 70);
    })
    .map(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      const wipAge = m.wipAgeInDays ?? 0;
      const budget = (em?.['matterBudget'] as number | undefined) ?? 0;
      const budgetBurn = budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
      const realisation = m.invoicedNetBilling > 0 && m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
      let primaryIssue = `WIP age ${wipAge} days`;
      if (budgetBurn !== null && budgetBurn > 100) primaryIssue = `Budget ${Math.round(budgetBurn)}% consumed`;
      else if (realisation !== null && realisation < 70) primaryIssue = `Realisation ${Math.round(realisation)}%`;
      const ragStatus = getRag(ragAssignments, 'F-WL-01', m.matterId ?? m.matterNumber ?? '');
      return {
        matterId: m.matterId ?? '',
        matterNumber: m.matterNumber ?? '',
        clientName: (em?.['clientName'] as string | undefined) ?? 'Unknown',
        caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
        responsibleLawyer: (em?.['responsibleLawyer'] as string | undefined) ?? 'Unknown',
        supervisor: (em?.['responsibleSupervisor'] as string | undefined) ?? '',
        primaryIssue,
        ragStatus,
        wipValue: m.wipTotalBillable,
        wipAge,
      };
    })
    .slice(0, 20);

  // Build time entry index per matter
  const teByMatter = new Map<string, typeof timeEntries>();
  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    const key = (teRec['matterNumber'] as string | undefined) ?? (teRec['matterId'] as string | undefined) ?? '';
    if (!teByMatter.has(key)) teByMatter.set(key, []);
    teByMatter.get(key)!.push(te);
  }
  const invByMatter = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const key = String((invRec['matterNumber'] as unknown) ?? '');
    if (!invByMatter.has(key)) invByMatter.set(key, []);
    invByMatter.get(key)!.push(inv);
  }

  const { items: paged, totalCount } = paginate(filtered, filters.limit, filters.offset);

  const rows: MatterRow[] = paged.map(m => {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const budget = (em?.['matterBudget'] as number | undefined) ?? null;
    const budgetBurn = budget && budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
    const realisation = m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
    const profit = formulaResults['F-PR-01']?.entityResults?.[m.matterId ?? m.matterNumber ?? '']?.value ?? null;
    const healthScore = formulaResults['F-CS-03']?.entityResults?.[m.matterId ?? m.matterNumber ?? '']?.value ?? null;
    const matterKey = m.matterNumber ?? m.matterId ?? '';
    const matterTEs = teByMatter.get(matterKey) ?? [];
    const matterInvs = invByMatter.get(matterKey) ?? [];

    return {
      matterId: m.matterId ?? '',
      matterNumber: m.matterNumber ?? '',
      clientName: (em?.['clientName'] as string | undefined) ?? 'Unknown',
      caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
      department: (em?.['department'] as string | undefined) ?? 'Unknown',
      responsibleLawyer: (em?.['responsibleLawyer'] as string | undefined) ?? 'Unknown',
      supervisor: (em?.['responsibleSupervisor'] as string | undefined) ?? '',
      status: (em?.['matterStatus'] as string | undefined) ?? 'Unknown',
      budget,
      wipTotalBillable: m.wipTotalBillable,
      netBilling: m.invoicedNetBilling,
      unbilledBalance: m.wipTotalBillable - m.invoicedNetBilling,
      wipAge: m.wipAgeInDays,
      budgetBurn,
      budgetBurnRag: budgetBurn !== null ? (budgetBurn > 100 ? RagStatus.RED : budgetBurn > 80 ? RagStatus.AMBER : RagStatus.GREEN) : null,
      realisation,
      realisationRag: getRag(ragAssignments, 'F-RB-01', m.matterId ?? m.matterNumber ?? ''),
      healthScore,
      healthRag: getRag(ragAssignments, 'F-CS-03', m.matterId ?? m.matterNumber ?? ''),
      wipEntries: matterTEs.slice(0, 20).map(te => {
        const teRec = te as unknown as Record<string, unknown>;
        return { date: (teRec['date'] as string | undefined) ?? '', lawyerName: (te.lawyerName ?? 'Unknown') as string, hours: (te.durationHours ?? 0) as number, value: (te.recordedValue ?? 0) as number, rate: (teRec['rate'] as number | undefined) ?? 0 };
      }),
      invoices: matterInvs.slice(0, 10).map(inv => {
        const invRec = inv as unknown as Record<string, unknown>;
        return { invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null, date: (invRec['invoiceDate'] as string | undefined) ?? '', total: (invRec['total'] as number | undefined) ?? 0, outstanding: (invRec['outstanding'] as number | undefined) ?? 0, paid: (invRec['paid'] as number | undefined) ?? 0 };
      }),
      profitability: {
        revenue: m.invoicedNetBilling,
        revenueSource: m.invoicedNetBilling > 0 ? 'invoiced' : 'wip_billable',
        labourCost: 0,
        labourBreakdown: [],
        disbursementCost: m.invoicedDisbursements,
        overhead: null,
        profit: profit ?? (m.invoicedNetBilling - m.invoicedDisbursements),
        margin: m.invoicedNetBilling > 0 ? ((m.invoicedNetBilling - m.invoicedDisbursements) / m.invoicedNetBilling) * 100 : 0,
        discrepancy: m.discrepancy ? { yaoValue: m.invoicedNetBilling, derivedValue: m.wipTotalBillable, difference: m.discrepancy.billingDifference } : null,
      },
    };
  });

  // By case type
  const caseTypeMap = new Map<string, { count: number; totWip: number; realisations: number[]; ages: number[] }>();
  for (const m of filtered) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const ct = (em?.['caseType'] as string | undefined) ?? 'Unknown';
    const acc = caseTypeMap.get(ct) ?? { count: 0, totWip: 0, realisations: [], ages: [] };
    acc.count++;
    acc.totWip += m.wipTotalBillable;
    if (m.wipTotalBillable > 0 && m.invoicedNetBilling > 0) acc.realisations.push((m.invoicedNetBilling / m.wipTotalBillable) * 100);
    if (m.wipAgeInDays != null) acc.ages.push(m.wipAgeInDays);
    caseTypeMap.set(ct, acc);
  }
  const byCaseType = [...caseTypeMap.entries()].map(([name, v]) => ({
    name,
    count: v.count,
    avgRealisation: v.realisations.length > 0 ? v.realisations.reduce((s, x) => s + x, 0) / v.realisations.length : null,
    avgWipAge: v.ages.length > 0 ? v.ages.reduce((s, x) => s + x, 0) / v.ages.length : null,
    totalWip: v.totWip,
    ragStatus: RagStatus.NEUTRAL,
  }));

  // By department
  const deptMatterMap = new Map<string, { count: number; totalWip: number }>();
  for (const m of filtered) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const dept = (em?.['department'] as string | undefined) ?? 'Unknown';
    const acc = deptMatterMap.get(dept) ?? { count: 0, totalWip: 0 };
    acc.count++;
    acc.totalWip += m.wipTotalBillable;
    deptMatterMap.set(dept, acc);
  }
  const byDepartment = [...deptMatterMap.entries()].map(([name, v]) => ({ name, count: v.count, totalWip: v.totalWip, avgMargin: null }));

  const allDepts = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];
  const allCaseTypes = [...new Set(enrichedMatters.map(em => (em['caseType'] as string | undefined) ?? '').filter(Boolean))];
  const allStatuses = [...new Set(enrichedMatters.map(em => (em['matterStatus'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers = [...new Set(enrichedMatters.map(em => (em['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];

  return {
    mattersAtRisk,
    matters: rows,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    byCaseType,
    byDepartment,
    filters: { departments: allDepts, caseTypes: allCaseTypes, statuses: allStatuses, lawyers: allLawyers },
  };
}

// ---------------------------------------------------------------------------
// 6. getClientIntelligenceData
// ---------------------------------------------------------------------------

export async function getClientIntelligenceData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<ClientPayload> {
  const data = await loadDashboardData(firmId);
  const { clients, matters, enrichedMatters, invoices, formulaResults } = data;

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Index matters and invoices by client
  const mattersByClient = new Map<string, AggregatedMatter[]>();
  for (const m of matters) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const clientName = (em?.['clientName'] as string | undefined) ?? (em?.['displayName'] as string | undefined) ?? 'Unknown';
    if (!mattersByClient.has(clientName)) mattersByClient.set(clientName, []);
    mattersByClient.get(clientName)!.push(m);
  }
  const invoicesByClient = new Map<string, (typeof invoices)[0][]>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const clientName = (inv.clientName as string | undefined) ?? (invRec['clients'] as string | undefined) ?? 'Unknown';
    if (!invoicesByClient.has(clientName)) invoicesByClient.set(clientName, []);
    invoicesByClient.get(clientName)!.push(inv);
  }

  // Apply filters
  let filteredClients = clients;
  if (filters.minMatters != null) filteredClients = filteredClients.filter(c => c.matterCount >= (filters.minMatters ?? 0));
  if (filters.minRevenue != null) filteredClients = filteredClients.filter(c => c.totalInvoiced >= (filters.minRevenue ?? 0));
  if (filters.department) {
    filteredClients = filteredClients.filter(c => {
      const clientMatters = mattersByClient.get(c.clientName ?? c.displayName ?? '') ?? [];
      return clientMatters.some(m => {
        const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
        return em?.['department'] === filters.department;
      });
    });
  }

  const { items: paged, totalCount } = paginate(filteredClients, filters.limit, filters.offset);

  const rows: ClientRow[] = paged.map(c => {
    const clientName = c.clientName ?? c.displayName ?? 'Unknown';
    const clientMatters = mattersByClient.get(clientName) ?? [];
    const clientInvoices = invoicesByClient.get(clientName) ?? [];
    const profitResult = clientMatters.reduce((sum, m) => sum + (formulaResults['F-PR-01']?.entityResults?.[m.matterId ?? m.matterNumber ?? '']?.value ?? 0), 0);
    const totalRevenue = c.totalInvoiced;
    const depts = [...new Set(clientMatters.flatMap(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return [(em?.['department'] as string | undefined) ?? 'Unknown']; }))];

    return {
      clientName,
      contactId: c.contactId ?? null,
      matterCount: c.matterCount,
      departments: depts,
      totalRevenue,
      totalCost: null,
      grossMargin: null,
      marginPercent: null,
      marginRag: null,
      totalOutstanding: c.totalOutstanding,
      avgLockupDays: null,
      matters: clientMatters.slice(0, 10).map(m => {
        const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
        return {
          matterNumber: m.matterNumber ?? '',
          caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
          status: (em?.['matterStatus'] as string | undefined) ?? 'Unknown',
          netBilling: m.invoicedNetBilling,
          wipValue: m.wipTotalBillable,
          realisation: m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null,
        };
      }),
      feeEarners: [],
      invoices: clientInvoices.slice(0, 10).map(inv => {
        const invRec = inv as unknown as Record<string, unknown>;
        return { invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null, date: (invRec['invoiceDate'] as string | undefined) ?? '', total: (invRec['total'] as number | undefined) ?? 0, outstanding: (invRec['outstanding'] as number | undefined) ?? 0 };
      }),
    };
  });

  const sortedByRevenue = [...filteredClients].sort((a, b) => b.totalInvoiced - a.totalInvoiced);
  const sortedByOutstanding = [...filteredClients].sort((a, b) => b.totalOutstanding - a.totalOutstanding);

  const allDepts = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];

  return {
    headlines: {
      totalClients: filteredClients.length,
      topClient: sortedByRevenue[0] ? { name: sortedByRevenue[0].clientName ?? sortedByRevenue[0].displayName ?? 'Unknown', revenue: sortedByRevenue[0].totalInvoiced } : null,
      mostAtRisk: sortedByOutstanding[0]?.totalOutstanding > 0 ? { name: sortedByOutstanding[0].clientName ?? sortedByOutstanding[0].displayName ?? 'Unknown', outstanding: sortedByOutstanding[0].totalOutstanding, oldestDebt: 0 } : null,
    },
    clients: rows,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    topByRevenue: sortedByRevenue.slice(0, 10).map(c => ({ name: c.clientName ?? c.displayName ?? 'Unknown', value: c.totalInvoiced })),
    topByOutstanding: sortedByOutstanding.slice(0, 10).map(c => ({ name: c.clientName ?? c.displayName ?? 'Unknown', value: c.totalOutstanding })),
    filters: { departments: allDepts, minMattersOptions: [1, 2, 5, 10] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**
```bash
npx vitest run tests/server/services/dashboard-service.test.ts 2>&1 | tail -10
```
Expected: 5 tests pass.

- [ ] **Step 5: Type-check**
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**
```bash
git add src/server/services/dashboard-service.ts src/shared/types/dashboard-payloads.ts tests/server/services/dashboard-service.test.ts
git commit -m "feat: dashboard service skeleton with data loader and firm overview"
```

---

## Task 3: Expand Test Coverage — All 6 Functions

**Files:**
- Modify: `tests/server/services/dashboard-service.test.ts`

Add these test suites to the existing test file:

- [ ] **Step 1: Add tests for getFeeEarnerPerformanceData**

Append to `tests/server/services/dashboard-service.test.ts`:

```typescript
import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
} from '../../../src/server/services/dashboard-service.js';

// ── getFeeEarnerPerformanceData ────────────────────────────────────────────

describe('getFeeEarnerPerformanceData', () => {
  it('returns valid payload shape', async () => {
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(Array.isArray(result.feeEarners)).toBe(true);
    expect(Array.isArray(result.alerts)).toBe(true);
    expect(result.pagination).toBeDefined();
    expect(result.charts).toBeDefined();
    expect(result.filters).toBeDefined();
  });

  it('includes all fee earners when no filter', async () => {
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners).toHaveLength(1);
    expect(result.feeEarners[0].name).toBe('Alice');
  });

  it('filters by payModel', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'timeEntry') return { records: [{ lawyerName: 'Alice', lawyerPayModel: 'FeeShare', date: '2024-05-01', durationHours: 2, recordedValue: 200, ageInDays: 30 }], firm_id: FIRM_ID, entity_type: 'timeEntry', data_version: '1', source_uploads: [], record_count: 1 } as never;
      return null;
    });
    const salaried = await getFeeEarnerPerformanceData(FIRM_ID, { payModel: 'Salaried' });
    expect(salaried.feeEarners).toHaveLength(0);
    const feeShare = await getFeeEarnerPerformanceData(FIRM_ID, { payModel: 'FeeShare' });
    expect(feeShare.feeEarners).toHaveLength(1);
  });

  it('pagination returns subset and correct totalCount', async () => {
    // Add second fee earner
    const doc = makeKpisDoc();
    (doc.kpis.aggregate.feeEarners as ReturnType<typeof makeFeeEarner>[]).push(makeFeeEarner({ lawyerId: 'l-2', lawyerName: 'Bob' }));
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(doc as never);
    const result = await getFeeEarnerPerformanceData(FIRM_ID, { limit: 1, offset: 0 });
    expect(result.feeEarners).toHaveLength(1);
    expect(result.pagination.totalCount).toBe(2);
    expect(result.pagination.limit).toBe(1);
  });

  it('returns recording pattern for last 20 working days', async () => {
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners[0].recordingPattern).toHaveLength(20);
    expect(result.feeEarners[0].recordingPattern[0]).toHaveProperty('date');
    expect(result.feeEarners[0].recordingPattern[0]).toHaveProperty('hasEntries');
  });

  it('generates alert when recordingGapDays > 5', async () => {
    const doc = makeKpisDoc();
    (doc.kpis.aggregate.feeEarners as ReturnType<typeof makeFeeEarner>[])[0].recordingGapDays = 10;
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(doc as never);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.alerts.some(a => a.type === 'recording_gap')).toBe(true);
  });

  it('works when no time entry data uploaded (graceful null)', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners).toHaveLength(1);
    expect(result.feeEarners[0].grade).toBe('Unknown');
  });
});

// ── getWipData ─────────────────────────────────────────────────────────────

describe('getWipData', () => {
  it('returns valid payload shape', async () => {
    const result = await getWipData(FIRM_ID);
    expect(result.headlines).toBeDefined();
    expect(result.ageBands).toHaveLength(5);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.writeOffAnalysis).toBeDefined();
    expect(result.disbursementExposure).toBeDefined();
  });

  it('reports totalUnbilledWip from matters', async () => {
    const result = await getWipData(FIRM_ID);
    expect(result.headlines.totalUnbilledWip.value).toBe(2000); // makeMatter wipTotalBillable
  });

  it('categorises matter into correct age band', async () => {
    const result = await getWipData(FIRM_ID);
    const band = result.ageBands.find(b => b.band === '31–60 days');
    expect(band!.count).toBe(1); // wipAgeInDays = 45
  });

  it('filters by minValue', async () => {
    const result = await getWipData(FIRM_ID, { minValue: 5000 });
    expect(result.entries).toHaveLength(0); // matter only has 2000
    expect(result.pagination.totalCount).toBe(0);
  });

  it('returns empty disbursement exposure when no disbursements', async () => {
    const result = await getWipData(FIRM_ID);
    expect(result.disbursementExposure.totalExposure).toBe(0);
  });
});

// ── getBillingCollectionsData ──────────────────────────────────────────────

describe('getBillingCollectionsData', () => {
  it('returns valid payload shape', async () => {
    const result = await getBillingCollectionsData(FIRM_ID);
    expect(result.headlines).toBeDefined();
    expect(result.pipeline).toBeDefined();
    expect(result.agedDebtors).toHaveLength(5);
    expect(Array.isArray(result.invoices)).toBe(true);
    expect(Array.isArray(result.billingTrend)).toBe(true);
  });

  it('sets totalOutstanding from firm aggregate', async () => {
    const result = await getBillingCollectionsData(FIRM_ID);
    expect(result.headlines.totalOutstanding.value).toBe(1500); // firm.totalOutstanding
  });

  it('slowPayers is null when datePaid not in data', async () => {
    const result = await getBillingCollectionsData(FIRM_ID);
    expect(result.slowPayers).toBeNull();
  });

  it('works with no invoice data', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);
    const result = await getBillingCollectionsData(FIRM_ID);
    expect(result.invoices).toHaveLength(0);
    expect(result.agedDebtors.every(b => b.count === 0)).toBe(true);
  });
});

// ── getMatterAnalysisData ──────────────────────────────────────────────────

describe('getMatterAnalysisData', () => {
  it('returns valid payload shape', async () => {
    const result = await getMatterAnalysisData(FIRM_ID);
    expect(Array.isArray(result.matters)).toBe(true);
    expect(Array.isArray(result.mattersAtRisk)).toBe(true);
    expect(Array.isArray(result.byCaseType)).toBe(true);
    expect(result.pagination).toBeDefined();
  });

  it('includes matter profitability block', async () => {
    const result = await getMatterAnalysisData(FIRM_ID);
    expect(result.matters[0].profitability).toBeDefined();
    expect(result.matters[0].profitability.revenue).toBeDefined();
  });

  it('flags matters at risk when wipAge > 60', async () => {
    const doc = makeKpisDoc();
    (doc.kpis.aggregate.matters as ReturnType<typeof makeMatter>[])[0].wipAgeInDays = 75;
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(doc as never);
    const result = await getMatterAnalysisData(FIRM_ID);
    expect(result.mattersAtRisk).toHaveLength(1);
    expect(result.mattersAtRisk[0].primaryIssue).toContain('75');
  });

  it('filters by caseType', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'matter') return { records: [{ matterId: 'm-1', matterNumber: '10001', caseType: 'Conveyancing', department: 'Property', responsibleLawyer: 'Alice', matterStatus: 'Active' }], firm_id: FIRM_ID, entity_type: 'matter', data_version: '1', source_uploads: [], record_count: 1 } as never;
      return null;
    });
    const result = await getMatterAnalysisData(FIRM_ID, { caseType: 'Litigation' });
    expect(result.matters).toHaveLength(0);
    expect(result.pagination.totalCount).toBe(0);
  });
});

// ── getClientIntelligenceData ──────────────────────────────────────────────

describe('getClientIntelligenceData', () => {
  it('returns valid payload shape', async () => {
    const result = await getClientIntelligenceData(FIRM_ID);
    expect(result.headlines).toBeDefined();
    expect(Array.isArray(result.clients)).toBe(true);
    expect(Array.isArray(result.topByRevenue)).toBe(true);
    expect(Array.isArray(result.topByOutstanding)).toBe(true);
    expect(result.pagination).toBeDefined();
  });

  it('headline.totalClients matches client count', async () => {
    const result = await getClientIntelligenceData(FIRM_ID);
    expect(result.headlines.totalClients).toBe(1);
  });

  it('topClient has name and revenue', async () => {
    const result = await getClientIntelligenceData(FIRM_ID);
    expect(result.headlines.topClient?.name).toBe('Acme Corp');
  });

  it('filters by minMatters', async () => {
    const result = await getClientIntelligenceData(FIRM_ID, { minMatters: 5 });
    expect(result.clients).toHaveLength(0); // Acme Corp has matterCount: 1
  });

  it('returns empty clients gracefully when no client aggregate', async () => {
    const doc = makeKpisDoc();
    doc.kpis.aggregate.clients = [];
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(doc as never);
    const result = await getClientIntelligenceData(FIRM_ID);
    expect(result.clients).toHaveLength(0);
    expect(result.headlines.topClient).toBeNull();
  });
});
```

- [ ] **Step 2: Run all service tests**
```bash
npx vitest run tests/server/services/dashboard-service.test.ts 2>&1 | tail -15
```
Expected: all pass.

- [ ] **Step 3: Commit**
```bash
git add tests/server/services/dashboard-service.test.ts src/server/services/dashboard-service.ts
git commit -m "feat: complete dashboard service — all 6 functions with tests"
```

---

## Task 4: Netlify Function Handler

**Files:**
- Create: `src/server/functions/dashboard.ts`
- Create: `tests/server/functions/dashboard.test.ts`

- [ ] **Step 1: Write the handler tests**

Create `tests/server/functions/dashboard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) { super(msg); }
  },
}));

vi.mock('../../../src/server/services/dashboard-service.js', () => ({
  getFirmOverviewData: vi.fn(),
  getFeeEarnerPerformanceData: vi.fn(),
  getWipData: vi.fn(),
  getBillingCollectionsData: vi.fn(),
  getMatterAnalysisData: vi.fn(),
  getClientIntelligenceData: vi.fn(),
}));

import { handler } from '../../../src/server/functions/dashboard.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as svc from '../../../src/server/services/dashboard-service.js';

function makeEvent(path: string, qs: Record<string, string> = {}): HandlerEvent {
  return { httpMethod: 'GET', path, headers: { authorization: 'Bearer tok' }, body: null, queryStringParameters: qs, pathParameters: null, multiValueHeaders: {}, multiValueQueryStringParameters: null, isBase64Encoded: false, rawUrl: path, rawQuery: '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u-1', firmId: 'firm-1', role: 'user' });
  vi.mocked(svc.getFirmOverviewData).mockResolvedValue({ kpiCards: {}, wipAgeBands: [], revenueTrend: [], topLeakageRisks: [], utilisationSnapshot: { green: 0, amber: 0, red: 0, feeEarners: [] }, departmentSummary: [], dataQuality: { issueCount: 0, criticalCount: 0 }, lastCalculated: null } as never);
  vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({ alerts: [], feeEarners: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, charts: { utilisationBars: [], chargeableStack: [] }, filters: { departments: [], grades: [], payModels: [] } } as never);
  vi.mocked(svc.getWipData).mockResolvedValue({ headlines: {}, ageBands: [], byDepartment: [], entries: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, writeOffAnalysis: {}, disbursementExposure: { totalExposure: 0, byMatter: [] }, filters: { departments: [], feeEarners: [], caseTypes: [] } } as never);
  vi.mocked(svc.getBillingCollectionsData).mockResolvedValue({ headlines: {}, pipeline: {}, agedDebtors: [], billingTrend: [], invoices: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, slowPayers: null, filters: { departments: [], feeEarners: [] } } as never);
  vi.mocked(svc.getMatterAnalysisData).mockResolvedValue({ mattersAtRisk: [], matters: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, byCaseType: [], byDepartment: [], filters: { departments: [], caseTypes: [], statuses: [], lawyers: [] } } as never);
  vi.mocked(svc.getClientIntelligenceData).mockResolvedValue({ headlines: { totalClients: 0, topClient: null, mostAtRisk: null }, clients: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, topByRevenue: [], topByOutstanding: [], filters: { departments: [], minMattersOptions: [] } } as never);
});

describe('dashboard handler routing', () => {
  it('GET /api/dashboard/firm-overview → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/firm-overview'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFirmOverviewData)).toHaveBeenCalledWith('firm-1');
  });

  it('GET /api/dashboard/fee-earner-performance → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/fee-earner-performance'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith('firm-1', expect.any(Object));
  });

  it('GET /api/dashboard/wip → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/wip'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getWipData)).toHaveBeenCalled();
  });

  it('GET /api/dashboard/billing → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/billing'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('GET /api/dashboard/matters → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/matters'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('GET /api/dashboard/clients → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/clients'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('returns 404 for unknown route', async () => {
    const res = await handler(makeEvent('/api/dashboard/unknown'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });

  it('returns 405 for non-GET', async () => {
    const event = { ...makeEvent('/api/dashboard/firm-overview'), httpMethod: 'POST' };
    const res = await handler(event, {} as never, () => {});
    expect(res?.statusCode).toBe(405);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(new (AuthError as never)('Unauthorised', 401));
    const res = await handler(makeEvent('/api/dashboard/firm-overview'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });

  it('passes query params as filters to service', async () => {
    const res = await handler(
      makeEvent('/api/dashboard/fee-earner-performance', { department: 'Property', limit: '10', offset: '0' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith(
      'firm-1',
      expect.objectContaining({ department: 'Property', limit: 10, offset: 0 }),
    );
  });

  it('firm isolation: passes firmId from auth to every service call', async () => {
    vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u', firmId: 'firm-99', role: 'user' });
    await handler(makeEvent('/api/dashboard/wip'), {} as never, () => {});
    expect(vi.mocked(svc.getWipData)).toHaveBeenCalledWith('firm-99', expect.any(Object));
  });
});
```

- [ ] **Step 2: Run handler tests to verify they fail**
```bash
npx vitest run tests/server/functions/dashboard.test.ts 2>&1 | head -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the handler**

Create `src/server/functions/dashboard.ts`:

```typescript
/**
 * dashboard.ts — Netlify Function
 *
 * Routes dashboard data requests to the dashboard service.
 *
 *   GET /api/dashboard/firm-overview         → getFirmOverviewData
 *   GET /api/dashboard/fee-earner-performance → getFeeEarnerPerformanceData
 *   GET /api/dashboard/wip                    → getWipData
 *   GET /api/dashboard/billing                → getBillingCollectionsData
 *   GET /api/dashboard/matters                → getMatterAnalysisData
 *   GET /api/dashboard/clients                → getClientIntelligenceData
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
  type DashboardFilters,
} from '../services/dashboard-service.js';

const BASE = '/api/dashboard';

function routeSegment(path: string): string {
  const clean = path.replace(/\/$/, '');
  return clean.startsWith(BASE) ? clean.slice(BASE.length + 1) : '';
}

function parseFilters(qs: Record<string, string> | null): DashboardFilters {
  if (!qs) return {};
  const filters: DashboardFilters = {};
  if (qs['department'])  filters.department  = qs['department'];
  if (qs['grade'])       filters.grade       = qs['grade'];
  if (qs['payModel'])    filters.payModel    = qs['payModel'];
  if (qs['activeOnly'])  filters.activeOnly  = qs['activeOnly'] === 'true';
  if (qs['feeEarner'])   filters.feeEarner   = qs['feeEarner'];
  if (qs['caseType'])    filters.caseType    = qs['caseType'];
  if (qs['status'])      filters.status      = qs['status'];
  if (qs['lawyer'])      filters.lawyer      = qs['lawyer'];
  if (qs['hasBudget'])   filters.hasBudget   = qs['hasBudget'] === 'true';
  if (qs['minValue'])    filters.minValue    = Number(qs['minValue']);
  if (qs['minMatters'])  filters.minMatters  = Number(qs['minMatters']);
  if (qs['minRevenue'])  filters.minRevenue  = Number(qs['minRevenue']);
  if (qs['groupBy'])     filters.groupBy     = qs['groupBy'] as DashboardFilters['groupBy'];
  if (qs['sortBy'])      filters.sortBy      = qs['sortBy'];
  if (qs['sortDir'])     filters.sortDir     = qs['sortDir'] as 'asc' | 'desc';
  if (qs['limit'])       filters.limit       = Number(qs['limit']);
  if (qs['offset'])      filters.offset      = Number(qs['offset']);
  return filters;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const segment = routeSegment(event.path ?? '');
    const filters = parseFilters(event.queryStringParameters);

    switch (segment) {
      case 'firm-overview':
        return successResponse(await getFirmOverviewData(firmId));

      case 'fee-earner-performance':
        return successResponse(await getFeeEarnerPerformanceData(firmId, filters));

      case 'wip':
        return successResponse(await getWipData(firmId, filters));

      case 'billing':
        return successResponse(await getBillingCollectionsData(firmId, filters));

      case 'matters':
        return successResponse(await getMatterAnalysisData(firmId, filters));

      case 'clients':
        return successResponse(await getClientIntelligenceData(firmId, filters));

      default:
        return errorResponse('Not found', 404);
    }

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[dashboard]', err);
    return errorResponse('Internal server error', 500);
  }
};
```

- [ ] **Step 4: Run handler tests**
```bash
npx vitest run tests/server/functions/dashboard.test.ts 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 5: Type-check**
```bash
npx tsc --noEmit
```
Expected: no errors.

---

## Task 5: Full Test Suite Verification + Commit

- [ ] **Step 1: Run entire test suite**
```bash
npx vitest run 2>&1 | tail -10
```
Expected: all tests pass (1020+ total).

- [ ] **Step 2: Verify each dashboard endpoint shape in tests**

The test suite should cover:
- ✅ Each function returns correct shaped payload
- ✅ Filters narrow results on every endpoint
- ✅ Pagination returns correct subset and totalCount
- ✅ RAG statuses present on all KPI values
- ✅ Null handling: no crashes when data missing
- ✅ Firm isolation: firmId always from auth

- [ ] **Step 3: Final commit + push**
```bash
git add src/shared/types/dashboard-payloads.ts \
        src/server/services/dashboard-service.ts \
        src/server/functions/dashboard.ts \
        tests/server/services/dashboard-service.test.ts \
        tests/server/functions/dashboard.test.ts
git commit -m "feat: dashboard data aggregation API with typed payloads"
git push
```

---

## Verification Checklist

After implementation, verify:

- [ ] `npx tsc --noEmit` — clean (no errors)
- [ ] `npx vitest run` — all tests pass
- [ ] `GET /api/dashboard/firm-overview` → returns `kpiCards`, `wipAgeBands`, `topLeakageRisks`
- [ ] `GET /api/dashboard/fee-earner-performance?department=X` → filtered results
- [ ] `GET /api/dashboard/wip?limit=10&offset=0` → paginated with `pagination.totalCount`
- [ ] `GET /api/dashboard/billing` → `slowPayers: null` (no datePaid in data)
- [ ] `GET /api/dashboard/matters?caseType=X` → filtered matters
- [ ] `GET /api/dashboard/clients?minMatters=2` → filtered clients
- [ ] Types importable from `src/shared/types/dashboard-payloads.ts`
- [ ] Firm isolation: all MongoDB calls include `firmId`
