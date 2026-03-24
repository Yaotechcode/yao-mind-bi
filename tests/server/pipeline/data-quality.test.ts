import { describe, it, expect } from 'vitest';
import { buildDataQualityReport } from '../../../src/server/pipeline/data-quality.js';
import type { JoinResult, AggregateResult } from '../../../src/shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedMatter,
  EnrichedInvoice,
} from '../../../src/shared/types/enriched.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJoinResult(overrides: Partial<JoinResult> = {}): JoinResult {
  return {
    timeEntries: [],
    matters: [],
    feeEarners: [],
    invoices: [],
    clients: [],
    disbursements: [],
    tasks: [],
    departments: [],
    joinStats: {
      timeEntries: { total: 0, matched: 0, orphaned: 0, orphanedValue: 0, lawyerResolved: 0, lawyerUnresolved: 0 },
      matters: { total: 0, closedMattersMerged: 0, clientResolved: 0, clientUnresolved: 0 },
      invoices: { total: 0, matterResolved: 0, matterUnresolved: 0 },
      disbursements: { total: 0, matterResolved: 0, matterUnresolved: 0 },
    },
    ...overrides,
  };
}

function makeAggregateResult(overrides: Partial<Omit<AggregateResult, 'dataQuality'>> = {}): Omit<AggregateResult, 'dataQuality'> {
  return {
    feeEarners: [],
    matters: [],
    clients: [],
    departments: [],
    firm: {
      feeEarnerCount: 0,
      activeFeeEarnerCount: 0,
      salariedFeeEarnerCount: 0,
      feeShareFeeEarnerCount: 0,
      matterCount: 0,
      activeMatterCount: 0,
      inProgressMatterCount: 0,
      completedMatterCount: 0,
      otherMatterCount: 0,
      totalWipHours: 0,
      totalChargeableHours: 0,
      totalWipValue: 0,
      totalWriteOffValue: 0,
      totalInvoicedRevenue: 0,
      totalOutstanding: 0,
      totalPaid: 0,
      orphanedWip: {
        orphanedWipEntryCount: 0,
        orphanedWipHours: 0,
        orphanedWipValue: 0,
        orphanedWipPercent: 0,
        orphanedWipNote: '',
      },
    },
    ...overrides,
  };
}

function makeMatter(overrides: Partial<EnrichedMatter> = {}): EnrichedMatter {
  return {
    hasClosedMatterData: false,
    _clientResolved: true,
    isActive: true,
    isClosed: false,
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<EnrichedInvoice> = {}): EnrichedInvoice {
  return {
    isOverdue: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. MISSING_DATE_PAID gap detected
// ---------------------------------------------------------------------------

describe('buildDataQualityReport — MISSING_DATE_PAID', () => {
  it('detects gap when invoicesJson present but no record has datePaid', () => {
    const inv = makeInvoice({ invoiceNumber: 'INV-001', total: 1000 });
    // No datePaid field
    const jr = makeJoinResult({ invoices: [inv] });
    const ar = makeAggregateResult();

    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson', 'invoicesJson']);

    const gap = report.knownGaps.find(g => g.gapId === 'MISSING_DATE_PAID');
    expect(gap).toBeDefined();
  });

  it('does NOT detect gap when invoicesJson absent', () => {
    const jr = makeJoinResult();
    const ar = makeAggregateResult();

    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson']);

    const gap = report.knownGaps.find(g => g.gapId === 'MISSING_DATE_PAID');
    expect(gap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. ORPHANED_WIP gap detected when percent > 5%
// ---------------------------------------------------------------------------

describe('buildDataQualityReport — ORPHANED_WIP', () => {
  it('detects gap when orphanedWipPercent > 5', () => {
    const ar = makeAggregateResult({
      firm: {
        ...makeAggregateResult().firm,
        orphanedWip: {
          orphanedWipEntryCount: 10,
          orphanedWipHours: 5,
          orphanedWipValue: 1000,
          orphanedWipPercent: 10,
          orphanedWipNote: '',
        },
      },
    });

    const jr = makeJoinResult();
    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson']);

    const gap = report.knownGaps.find(g => g.gapId === 'ORPHANED_WIP');
    expect(gap).toBeDefined();
  });

  it('does NOT detect gap when orphanedWipPercent <= 5', () => {
    const ar = makeAggregateResult({
      firm: {
        ...makeAggregateResult().firm,
        orphanedWip: {
          orphanedWipEntryCount: 2,
          orphanedWipHours: 1,
          orphanedWipValue: 100,
          orphanedWipPercent: 3,
          orphanedWipNote: '',
        },
      },
    });

    const jr = makeJoinResult();
    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson']);

    const gap = report.knownGaps.find(g => g.gapId === 'ORPHANED_WIP');
    expect(gap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Overall score < 70 when fee earner file missing
// ---------------------------------------------------------------------------

describe('buildDataQualityReport — overall score', () => {
  it('produces overallScore < 70 when feeEarner file missing', () => {
    const jr = makeJoinResult();
    const ar = makeAggregateResult();

    // No feeEarner in available types
    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson']);

    expect(report.overallScore).toBeLessThan(70);
  });

  it('produces higher score when all critical files present', () => {
    const jr = makeJoinResult();
    const ar = makeAggregateResult();

    const report = buildDataQualityReport(jr, ar, ['feeEarner', 'wipJson', 'fullMattersJson', 'invoicesJson']);

    expect(report.overallScore).toBeGreaterThanOrEqual(70);
  });
});

// ---------------------------------------------------------------------------
// 5. Recommendations ordered by priority
// ---------------------------------------------------------------------------

describe('buildDataQualityReport — recommendations ordering', () => {
  it('recommendations are ordered by priority ascending', () => {
    const jr = makeJoinResult();
    const ar = makeAggregateResult();

    // Missing fee earner and wip will generate priority-1 recs; missing closed matters = priority 3
    const report = buildDataQualityReport(jr, ar, ['fullMattersJson']);

    if (report.recommendations.length >= 2) {
      for (let i = 0; i < report.recommendations.length - 1; i++) {
        expect(report.recommendations[i].priority).toBeLessThanOrEqual(report.recommendations[i + 1].priority);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Discrepancy detected for matter with hasMajorDiscrepancy
// ---------------------------------------------------------------------------

describe('buildDataQualityReport — discrepancies', () => {
  it('includes discrepancy entry for matter with hasMajorDiscrepancy: true', () => {
    const jr = makeJoinResult();
    const ar = makeAggregateResult({
      matters: [
        {
          matterId: 'm-001',
          matterNumber: '1001',
          wipTotalDurationMinutes: 600,
          wipTotalHours: 10,
          wipTotalBillable: 10000,
          wipTotalWriteOff: 0,
          wipTotalUnits: 100,
          wipTotalChargeable: 10000,
          wipTotalNonChargeable: 0,
          wipChargeableHours: 10,
          wipNonChargeableHours: 0,
          wipOldestEntryDate: null,
          wipNewestEntryDate: null,
          wipAgeInDays: null,
          invoiceCount: 1,
          invoicedNetBilling: 8000,
          invoicedDisbursements: 0,
          invoicedTotal: 8000,
          invoicedOutstanding: 0,
          invoicedPaid: 8000,
          invoicedWrittenOff: 0,
          discrepancy: {
            billingDifference: 2000,
            billingDifferencePercent: 20,
            hasMajorDiscrepancy: true,
          },
        },
      ],
    });

    const report = buildDataQualityReport(jr, ar, ['wipJson', 'fullMattersJson', 'invoicesJson']);

    expect(report.discrepancies.length).toBeGreaterThan(0);
    const disc = report.discrepancies.find(d => d.entityId === 'm-001');
    expect(disc).toBeDefined();
    expect(disc!.type).toBe('wip_vs_invoice');
  });
});
