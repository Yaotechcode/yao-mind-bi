import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getLatestCalculatedKpis: vi.fn(),
  getLatestEnrichedEntities: vi.fn(),
}));

vi.mock('../../../src/server/services/config-service.js', () => ({
  getFirmConfig: vi.fn(),
}));

vi.mock('../../../src/server/services/kpi-snapshot-service.js', () => ({
  getKpiSnapshots: vi.fn(),
}));

import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
} from '../../../src/server/services/dashboard-service.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';
import * as configService from '../../../src/server/services/config-service.js';
import * as kpiSnapshotService from '../../../src/server/services/kpi-snapshot-service.js';
import type { KpiSnapshotRow } from '../../../src/server/services/kpi-snapshot-service.js';

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
    discrepancy: null,
    ...overrides,
  };
}

function makeAggregate(overrides: Record<string, unknown> = {}) {
  return {
    feeEarners: [makeFeeEarner()],
    matters: [makeMatter()],
    clients: [{ contactId: 'c-1', displayName: 'Acme Corp', clientName: 'Acme Corp', matterCount: 1, activeMatterCount: 1, closedMatterCount: 0, totalWipValue: 2000, totalInvoiced: 1800, totalOutstanding: 300, totalPaid: 1550, oldestMatterDate: null }],
    departments: [{ name: 'Property', feeEarnerCount: 1, activeFeeEarnerCount: 1, activeMatterCount: 1, totalMatterCount: 1, wipTotalHours: 20, wipChargeableHours: 18, wipChargeableValue: 2000, invoicedRevenue: 1800, invoicedOutstanding: 300 }],
    firm: { feeEarnerCount: 1, activeFeeEarnerCount: 1, salariedFeeEarnerCount: 1, feeShareFeeEarnerCount: 0, matterCount: 1, activeMatterCount: 1, inProgressMatterCount: 1, completedMatterCount: 0, otherMatterCount: 0, totalWipHours: 120, totalChargeableHours: 90, totalWipValue: 12000, totalWriteOffValue: 500, totalInvoicedRevenue: 8000, totalOutstanding: 1500, totalPaid: 6500, orphanedWip: { orphanedWipEntryCount: 5, orphanedWipHours: 10, orphanedWipValue: 800, orphanedWipPercent: 6.7, orphanedWipNote: '' } },
    dataQuality: { overallScore: 90, entityIssues: [], knownGaps: [] },
    ...overrides,
  };
}

/** Builds the object returned by getLatestEnrichedEntities(firmId, 'calculatedKpis') */
function makeCalculatedKpisEntity(aggregateOverrides: Record<string, unknown> = {}) {
  return { aggregate: makeAggregate(aggregateOverrides) } as never;
}

/** A minimal KpiSnapshotRow for use in tests. */
function makeSnapshot(overrides: Partial<KpiSnapshotRow> = {}): KpiSnapshotRow {
  return {
    firm_id: FIRM_ID,
    pulled_at: '2024-06-01T12:00:00.000Z',
    entity_type: 'feeEarner',
    entity_id: 'l-1',
    entity_name: 'Alice',
    kpi_key: 'F-TU-01',
    kpi_value: 75.5,
    rag_status: 'green',
    period: 'current',
    display_value: '75.5%',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(configService.getFirmConfig).mockResolvedValue(makeFirmConfig() as never);
  vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
    if (entityType === 'calculatedKpis') return makeCalculatedKpisEntity();
    return null;
  });
  vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([]);
});

// ── getFirmOverviewData ────────────────────────────────────────────────────

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

  it('sets lastCalculated from pulled_at in kpi_snapshots', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_type: 'feeEarner', pulled_at: '2024-06-01T12:00:00.000Z' }),
    ]);
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.lastCalculated).toBe('2024-06-01T12:00:00.000Z');
  });

  it('sets totalUnbilledWip from aggregate.firm.totalWipValue', async () => {
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.kpiCards.totalUnbilledWip.value).toBe(12000);
  });

  it('reads utilisation RAG from feeEarner kpi_snapshots', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_type: 'feeEarner', kpi_key: 'F-TU-01', rag_status: 'green' }),
    ]);
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.utilisationSnapshot.green).toBeGreaterThanOrEqual(1);
  });

  it('returns null lastCalculated and empty data when no kpisDoc', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);
    const result = await getFirmOverviewData(FIRM_ID);
    expect(result.lastCalculated).toBeNull();
    expect(result.kpiCards.totalUnbilledWip.value).toBe(0);
    expect(result.departmentSummary).toEqual([]);
  });

  it('enforces firm isolation — uses firmId in all calls', async () => {
    await getFirmOverviewData('firm-xyz');
    expect(vi.mocked(kpiSnapshotService.getKpiSnapshots)).toHaveBeenCalledWith('firm-xyz', expect.any(Object));
    expect(vi.mocked(mongoOps.getLatestEnrichedEntities)).toHaveBeenCalledWith('firm-xyz', expect.any(String));
  });
});

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
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_type: 'feeEarner', entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
    ]);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners).toHaveLength(1);
    expect(result.feeEarners[0].name).toBe('Alice');
  });

  it('filters by payModel — no-op until enrichment stores payModel in kpi_snapshots', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_type: 'feeEarner', entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
    ]);
    // payModel is not yet stored in kpi_snapshots, so all rows have payModel=null
    // and payModel filters return 0 results regardless of value
    const salaried = await getFeeEarnerPerformanceData(FIRM_ID, { payModel: 'Salaried' });
    expect(salaried.feeEarners).toHaveLength(0);
    const feeShare = await getFeeEarnerPerformanceData(FIRM_ID, { payModel: 'FeeShare' });
    expect(feeShare.feeEarners).toHaveLength(0);
  });

  it('pagination returns subset and correct totalCount', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
      makeSnapshot({ entity_id: 'l-2', entity_name: 'Bob', kpi_key: 'F-TU-01' }),
    ]);
    const result = await getFeeEarnerPerformanceData(FIRM_ID, { limit: 1, offset: 0 });
    expect(result.feeEarners).toHaveLength(1);
    expect(result.pagination.totalCount).toBe(2);
    expect(result.pagination.limit).toBe(1);
  });

  it('returns recording pattern for last 20 working days', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
    ]);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners[0].recordingPattern).toHaveLength(20);
    expect(result.feeEarners[0].recordingPattern[0]).toHaveProperty('date');
    expect(result.feeEarners[0].recordingPattern[0]).toHaveProperty('hasEntries');
  });

  it('generates alert when recordingGapDays > 5', async () => {
    // recordingGapDays now comes from F-TU-02 (Recording Consistency formula).
    // F-TU-01 row is required so l-1 passes the authoritative attorney ID filter.
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
      makeSnapshot({ entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-02', kpi_value: 10 }),
    ]);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.alerts.some(a => a.type === 'recording_gap')).toBe(true);
  });

  it('works exclusively from kpi_snapshots — grade/department/payModel default to null', async () => {
    vi.mocked(kpiSnapshotService.getKpiSnapshots).mockResolvedValue([
      makeSnapshot({ entity_id: 'l-1', entity_name: 'Alice', kpi_key: 'F-TU-01' }),
    ]);
    const result = await getFeeEarnerPerformanceData(FIRM_ID);
    expect(result.feeEarners).toHaveLength(1);
    // Attributes not yet in kpi_snapshots — all null until enrichment is extended
    expect(result.feeEarners[0].grade).toBeNull();
    expect(result.feeEarners[0].department).toBeNull();
    expect(result.feeEarners[0].payModel).toBeNull();
    expect(result.feeEarners[0].isActive).toBe(true);
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
    expect(result.pagination.totalCount).toBe(0); // matter only has 2000
  });

  it('returns empty disbursement exposure when no disbursements', async () => {
    const result = await getWipData(FIRM_ID);
    expect(result.disbursementExposure.totalExposure).toBe(0);
  });

  it('respects custom writeOffRate threshold from firm config', async () => {
    // Custom config: RED threshold starts at 15% instead of default 10%
    vi.mocked(configService.getFirmConfig).mockResolvedValue({
      ...makeFirmConfig(),
      ragThresholds: [{
        metricKey: 'writeOffRate',
        label: 'Write-off Rate',
        higherIsBetter: false,
        defaults: { green: { max: 8 }, amber: { min: 8, max: 15 }, red: { min: 15 } },
      }],
    } as never);
    // makeMatter wipTotalBillable: 2000, wipTotalWriteOff override to 12% → AMBER
    const agg = makeAggregate();
    (agg.matters as ReturnType<typeof makeMatter>[])[0].wipTotalWriteOff = 240;
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'calculatedKpis') return { aggregate: agg } as never;
      return null;
    });
    const result = await getWipData(FIRM_ID);
    // 12% is above amber min (8) but below red min (15) → AMBER, not RED
    expect(result.writeOffAnalysis.ragStatus).toBe('amber');
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
    const agg = makeAggregate();
    (agg.matters as ReturnType<typeof makeMatter>[])[0].wipAgeInDays = 75;
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'calculatedKpis') return { aggregate: agg } as never;
      return null;
    });
    const result = await getMatterAnalysisData(FIRM_ID);
    expect(result.mattersAtRisk).toHaveLength(1);
    expect(result.mattersAtRisk[0].primaryIssue).toContain('75');
  });

  it('filters by caseType', async () => {
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'matter') return { records: [{ matterId: 'm-1', matterNumber: '10001', caseType: 'Conveyancing', department: 'Property', responsibleLawyer: 'Alice', matterStatus: 'Active' }], firm_id: FIRM_ID, entity_type: 'matter', data_version: '1', source_uploads: [], record_count: 1 } as never;
      if (entityType === 'calculatedKpis') return makeCalculatedKpisEntity();
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
    const agg = makeAggregate({ clients: [] });
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockImplementation(async (_fid, entityType) => {
      if (entityType === 'calculatedKpis') return { aggregate: agg } as never;
      return null;
    });
    const result = await getClientIntelligenceData(FIRM_ID);
    expect(result.clients).toHaveLength(0);
    expect(result.headlines.topClient).toBeNull();
  });
});
