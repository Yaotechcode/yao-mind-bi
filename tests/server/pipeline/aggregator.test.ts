import { describe, it, expect } from 'vitest';
import { aggregate } from '../../../src/server/pipeline/aggregator.js';
import type { JoinResult } from '../../../src/shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedMatter,
  EnrichedFeeEarner,
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

function makeTimeEntry(overrides: Partial<EnrichedTimeEntry> = {}): EnrichedTimeEntry {
  return {
    hasMatchedMatter: true,
    _lawyerResolved: true,
    ...overrides,
  };
}

function makeMatter(overrides: Partial<EnrichedMatter> = {}): EnrichedMatter {
  return {
    hasClosedMatterData: false,
    _clientResolved: false,
    isActive: true,
    isClosed: false,
    ...overrides,
  };
}

function makeFeeEarner(overrides: Partial<EnrichedFeeEarner> = {}): EnrichedFeeEarner {
  return {
    lawyerId: 'fe-001',
    lawyerName: 'Test Lawyer',
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
// 1. Fee earner aggregation — chargeable hours
// ---------------------------------------------------------------------------

describe('aggregate — fee earner chargeable hours', () => {
  it('correctly splits chargeable vs non-chargeable hours', () => {
    const feeEarner = makeFeeEarner({ lawyerId: 'fe-001' });
    const te1 = makeTimeEntry({ lawyerId: 'fe-001', durationHours: 1, isChargeable: true, hasMatchedMatter: true, billableValue: 100 });
    const te2 = makeTimeEntry({ lawyerId: 'fe-001', durationHours: 2, isChargeable: false, hasMatchedMatter: true, billableValue: 0 });

    const jr = makeJoinResult({ feeEarners: [feeEarner], timeEntries: [te1, te2] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    const fe = result.feeEarners.find(f => f.lawyerId === 'fe-001');
    expect(fe).toBeDefined();
    expect(fe!.wipChargeableHours).toBe(1);
    expect(fe!.wipNonChargeableHours).toBe(2);
    expect(fe!.wipTotalHours).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Matter aggregation — dual source of truth discrepancy flagged
// ---------------------------------------------------------------------------

describe('aggregate — matter discrepancy flagged', () => {
  it('flags hasMajorDiscrepancy when WIP vs invoice differ by >10%', () => {
    const matter = makeMatter({
      matterId: 'm-001',
      matterNumber: '1001',
    });
    // WIP entry with billableValue = 10000
    const te = makeTimeEntry({
      matterId: 'm-001',
      matterNumber: '1001',
      hasMatchedMatter: true,
      billableValue: 10000,
      durationHours: 10,
      isChargeable: true,
    });
    // Invoice with subtotal = 8000
    const inv = makeInvoice({
      matterNumber: '1001',
      matterId: 'm-001',
      subtotal: 8000,
      total: 8000,
      outstanding: 0,
      paid: 8000,
    });

    const jr = makeJoinResult({ matters: [matter], timeEntries: [te], invoices: [inv] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    const m = result.matters.find(m => m.matterId === 'm-001');
    expect(m).toBeDefined();
    expect(m!.wipTotalBillable).toBe(10000);
    expect(m!.invoicedNetBilling).toBe(8000);
    expect(m!.discrepancy).toBeDefined();
    expect(m!.discrepancy!.billingDifference).toBe(2000);
    expect(m!.discrepancy!.hasMajorDiscrepancy).toBe(true);
  });

  it('does not flag discrepancy when WIP vs invoice differ by <=10%', () => {
    const matter = makeMatter({ matterId: 'm-002', matterNumber: '1002' });
    const te = makeTimeEntry({
      matterId: 'm-002',
      matterNumber: '1002',
      hasMatchedMatter: true,
      billableValue: 10000,
      durationHours: 10,
      isChargeable: true,
    });
    const inv = makeInvoice({
      matterNumber: '1002',
      matterId: 'm-002',
      subtotal: 9500,
      total: 9500,
      outstanding: 0,
      paid: 9500,
    });

    const jr = makeJoinResult({ matters: [matter], timeEntries: [te], invoices: [inv] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    const m = result.matters.find(m => m.matterId === 'm-002');
    expect(m?.discrepancy?.hasMajorDiscrepancy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Orphaned WIP included in firm totals
// ---------------------------------------------------------------------------

describe('aggregate — orphaned WIP in firm totals', () => {
  it('includes orphaned WIP in totalWipValue and orphanedWip summary', () => {
    const te1 = makeTimeEntry({
      billableValue: 500,
      durationHours: 1,
      isChargeable: true,
      hasMatchedMatter: true,
      lawyerId: 'fe-001',
    });
    const te2 = makeTimeEntry({
      billableValue: 400,
      durationHours: 0.8,
      isChargeable: true,
      hasMatchedMatter: false,
      lawyerId: 'fe-001',
    });

    const jr = makeJoinResult({ timeEntries: [te1, te2] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    expect(result.firm.orphanedWip.orphanedWipValue).toBe(400);
    expect(result.firm.orphanedWip.orphanedWipHours).toBeCloseTo(0.8, 5);
    expect(result.firm.totalWipValue).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// 4. recordingGapDays calculation
// ---------------------------------------------------------------------------

describe('aggregate — recordingGapDays', () => {
  it('calculates gap days from last entry date to today', () => {
    const today = new Date('2024-03-01');
    const lastDate = new Date('2024-02-20');

    const feeEarner = makeFeeEarner({ lawyerId: 'fe-001' });
    const te = makeTimeEntry({
      lawyerId: 'fe-001',
      hasMatchedMatter: true,
      durationHours: 1,
      isChargeable: true,
      date: lastDate,
    });

    const jr = makeJoinResult({ feeEarners: [feeEarner], timeEntries: [te] });
    const result = aggregate(jr, today, []);

    const fe = result.feeEarners.find(f => f.lawyerId === 'fe-001');
    expect(fe).toBeDefined();
    // 2024-02-20 → 2024-03-01 = 10 calendar days (2024 is a leap year: Feb has 29 days)
    expect(fe!.recordingGapDays).toBe(10);
  });

  it('returns null when fee earner has no entries', () => {
    const feeEarner = makeFeeEarner({ lawyerId: 'fe-002' });
    const jr = makeJoinResult({ feeEarners: [feeEarner], timeEntries: [] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    const fe = result.feeEarners.find(f => f.lawyerId === 'fe-002');
    expect(fe).toBeDefined();
    expect(fe!.recordingGapDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Firm aggregation — matter counts correct
// ---------------------------------------------------------------------------

describe('aggregate — firm matter counts', () => {
  it('counts active and closed matters correctly', () => {
    const m1 = makeMatter({ matterId: 'm-001', isActive: true, isClosed: false });
    const m2 = makeMatter({ matterId: 'm-002', isActive: true, isClosed: false });
    const m3 = makeMatter({ matterId: 'm-003', isActive: false, isClosed: true });

    const jr = makeJoinResult({ matters: [m1, m2, m3] });
    const result = aggregate(jr, new Date('2024-03-01'), []);

    expect(result.firm.activeMatterCount).toBe(2);
    expect(result.firm.matterCount).toBe(3);
    expect(result.firm.completedMatterCount).toBe(1);
  });
});
