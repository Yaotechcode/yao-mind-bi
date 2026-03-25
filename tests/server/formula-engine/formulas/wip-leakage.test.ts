import { describe, it, expect } from 'vitest';
import {
  wipAge,
  writeOffAnalysis,
  disbursementRecovery,
  lockUpDays,
} from '../../../../src/server/formula-engine/formulas/wip-leakage.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type {
  AggregatedMatter,
  AggregatedFirm,
  AggregatedFeeEarner,
} from '../../../../src/shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedInvoice,
  EnrichedDisbursement,
} from '../../../../src/shared/types/enriched.js';
import type { FirmConfig } from '../../../../src/shared/types/index.js';

// =============================================================================
// Shared test fixtures
// =============================================================================

const FIRM_CONFIG: FirmConfig = {
  firmId: 'firm-001',
  firmName: 'Test Firm',
  jurisdiction: 'England & Wales',
  currency: 'GBP',
  financialYearStartMonth: 4,
  weekStartDay: 1,
  timezone: 'Europe/London',
  workingDaysPerWeek: 5,
  weeklyTargetHours: 37.5,
  chargeableWeeklyTarget: 30,
  annualLeaveEntitlement: 25,
  bankHolidaysPerYear: 8,
  costRateMethod: 'fully_loaded',
  defaultFeeSharePercent: 30,
  defaultFirmRetainPercent: 70,
  utilisationApproach: 'assume_fulltime',
  entityDefinitions: {},
  columnMappingTemplates: [],
  customFields: [],
  ragThresholds: [],
  formulas: [],
  snippets: [],
  feeEarnerOverrides: [],
  schemaVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FIRM_AGG: AggregatedFirm = {
  feeEarnerCount: 2,
  activeFeeEarnerCount: 2,
  salariedFeeEarnerCount: 2,
  feeShareFeeEarnerCount: 0,
  matterCount: 3,
  activeMatterCount: 3,
  inProgressMatterCount: 3,
  completedMatterCount: 0,
  otherMatterCount: 0,
  totalWipHours: 150,
  totalChargeableHours: 120,
  totalWipValue: 60000,
  totalWriteOffValue: 4000,
  totalInvoicedRevenue: 40000,
  totalOutstanding: 15000,
  totalPaid: 25000,
  orphanedWip: {
    orphanedWipEntryCount: 5,
    orphanedWipHours: 8,
    orphanedWipValue: 3000,
    orphanedWipPercent: 5,
    orphanedWipNote: 'test',
  },
};

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

const MATTER_A: AggregatedMatter = {
  matterId: 'mat-A',
  matterNumber: '1001',
  wipTotalHours: 60,
  wipChargeableHours: 50,
  wipNonChargeableHours: 10,
  wipTotalBillable: 15000,
  wipTotalWriteOff: 1000,
  wipAgeInDays: null,
  invoiceCount: 1,
  invoicedNetBilling: 12000,
  invoicedDisbursements: 500,
  invoicedTotal: 12500,
  invoicedOutstanding: 3000,
  invoicedPaid: 9500,
  invoicedWrittenOff: 0,
};

const MATTER_B: AggregatedMatter = {
  matterId: 'mat-B',
  matterNumber: '1002',
  wipTotalHours: 50,
  wipChargeableHours: 45,
  wipNonChargeableHours: 5,
  wipTotalBillable: 10000,
  wipTotalWriteOff: 3000,
  wipAgeInDays: null,
  invoiceCount: 0,
  invoicedNetBilling: 0,
  invoicedDisbursements: 200,
  invoicedTotal: 0,
  invoicedOutstanding: 0,
  invoicedPaid: 0,
  invoicedWrittenOff: 0,
};

/** Matter with no WIP — should produce 0-day velocity. */
const MATTER_EMPTY: AggregatedMatter = {
  matterId: 'mat-C',
  matterNumber: '1003',
  wipTotalHours: 0,
  wipChargeableHours: 0,
  wipNonChargeableHours: 0,
  wipTotalBillable: 0,
  wipTotalWriteOff: 0,
  wipAgeInDays: null,
  invoiceCount: 0,
  invoicedNetBilling: 0,
  invoicedDisbursements: 0,
  invoicedTotal: 0,
  invoicedOutstanding: 0,
  invoicedPaid: 0,
  invoicedWrittenOff: 0,
};

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

function makeEntry(
  matterId: string,
  ageInDays: number,
  billableValue: number,
  writeOffValue = 0,
  extra: Partial<EnrichedTimeEntry> = {},
): EnrichedTimeEntry {
  return {
    entityType: 'timeEntry',
    matterId,
    hasMatchedMatter: true,
    ageInDays,
    isChargeable: billableValue > 0,
    durationHours: billableValue / 250,
    lawyerId: 'L001',
    ...({ billableValue, writeOffValue } as object),
    ...extra,
  } as EnrichedTimeEntry;
}

function makeOrphanEntry(ageInDays: number, billableValue: number): EnrichedTimeEntry {
  return {
    entityType: 'timeEntry',
    matterId: undefined,
    hasMatchedMatter: false,
    ageInDays,
    isChargeable: true,
    lawyerId: 'L001',
    ...({ billableValue, writeOffValue: 0 } as object),
  } as EnrichedTimeEntry;
}

/**
 * MATTER_A entries:
 *   age=10, value=5000  → 0-30 band  (high value)
 *   age=90, value=3000  → 61-90 band (medium value)
 *   age=200, value=2000 → 180+ band  (low value)
 *
 * oldest_entry = 200
 * average_entry = (10 + 90 + 200) / 3 = 100
 * weighted_average = (10×5000 + 90×3000 + 200×2000) / (5000+3000+2000)
 *                  = (50000 + 270000 + 400000) / 10000 = 72
 */
const ENTRIES_A = [
  makeEntry('mat-A', 10,  5000),
  makeEntry('mat-A', 90,  3000),
  makeEntry('mat-A', 200, 2000),
];

/**
 * MATTER_B entries:
 *   age=30,  value=4000, writeOff=1000
 *   age=60,  value=6000, writeOff=2000
 */
const ENTRIES_B = [
  makeEntry('mat-B', 30, 4000, 1000, { lawyerId: 'L002' }),
  makeEntry('mat-B', 60, 6000, 2000, { lawyerId: 'L002' }),
];

/** Orphaned entries — no matched matter. */
const ORPHANED_ENTRIES = [
  makeOrphanEntry(15, 1000),
  makeOrphanEntry(45, 500),
];

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

function makeInvoice(
  matterId: string,
  outstanding: number,
  daysOutstanding: number | null,
  extra: Partial<EnrichedInvoice> = {},
): EnrichedInvoice {
  return {
    entityType: 'invoice',
    matterId,
    isOverdue: outstanding > 0,
    daysOutstanding,
    ageBand: daysOutstanding != null && daysOutstanding <= 30 ? '0-30' : '31-60',
    ...({ outstanding, subtotal: outstanding, paid: 0 } as object),
    ...extra,
  } as EnrichedInvoice;
}

/** Unpaid invoice: outstanding=5000, daysOutstanding=45 */
const INVOICE_UNPAID_1 = makeInvoice('mat-A', 5000, 45);
/** Unpaid invoice: outstanding=2000, daysOutstanding=15 */
const INVOICE_UNPAID_2 = makeInvoice('mat-B', 2000, 15);
/** Fully paid invoice: outstanding=0 */
const INVOICE_PAID = makeInvoice('mat-A', 0, null, { isOverdue: false });

// ---------------------------------------------------------------------------
// Disbursements
// ---------------------------------------------------------------------------

function makeDisbursement(
  matterId: string,
  subtotal: number,
  firmExposure: number,
): EnrichedDisbursement {
  return {
    entityType: 'disbursement',
    matterId,
    firmExposure,
    ...({ subtotal } as object),
  } as EnrichedDisbursement;
}

/** MATTER_A: 2 disbursements, partial recovery. */
const DISB_A1 = makeDisbursement('mat-A', 400, 100);  // 300 recovered
const DISB_A2 = makeDisbursement('mat-A', 200, 50);   // 150 recovered

/** MATTER_B: 1 disbursement, fully outstanding. */
const DISB_B1 = makeDisbursement('mat-B', 300, 300);  // nothing recovered

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [] as AggregatedFeeEarner[],
    matters: [MATTER_A, MATTER_B, MATTER_EMPTY],
    invoices: [INVOICE_UNPAID_1, INVOICE_UNPAID_2, INVOICE_PAID],
    timeEntries: [...ENTRIES_A, ...ENTRIES_B, ...ORPHANED_ENTRIES],
    disbursements: [DISB_A1, DISB_A2, DISB_B1],
    departments: [],
    clients: [],
    firm: FIRM_AGG,
    firmConfig: FIRM_CONFIG,
    feeEarnerOverrides: {},
    snippetResults: {},
    formulaResults: {},
    referenceDate: new Date('2025-01-09T00:00:00.000Z'),
    ...overrides,
  };
}

// =============================================================================
// F-WL-01: WIP Age
// =============================================================================

describe('F-WL-01 wipAge', () => {
  it('returns correct formula metadata', () => {
    const result = wipAge.execute(makeContext());
    expect(result.formulaId).toBe('F-WL-01');
    expect(result.formulaName).toBe('WIP Age');
    expect(result.resultType).toBe('days');
  });

  describe('oldest_entry variant (default)', () => {
    it('returns max age for MATTER_A (ages: 10, 90, 200 → max=200)', () => {
      const result = wipAge.execute(makeContext());
      expect(result.variantUsed).toBe('oldest_entry');
      expect(result.entityResults['mat-A']?.value).toBe(200);
    });

    it('returns max age for MATTER_B (ages: 30, 60 → max=60)', () => {
      const result = wipAge.execute(makeContext());
      expect(result.entityResults['mat-B']?.value).toBe(60);
    });

    it('returns 0 for a matter with no WIP', () => {
      const result = wipAge.execute(makeContext());
      expect(result.entityResults['mat-C']?.value).toBe(0);
    });
  });

  describe('average_entry variant', () => {
    it('computes mean age for MATTER_A ((10+90+200)/3 ≈ 100)', () => {
      const result = wipAge.execute(makeContext(), 'average_entry');
      expect(result.entityResults['mat-A']?.value).toBeCloseTo(100, 1);
    });
  });

  describe('weighted_average variant', () => {
    it('higher-value entries carry more weight for MATTER_A', () => {
      const result = wipAge.execute(makeContext(), 'weighted_average');
      // (10×5000 + 90×3000 + 200×2000) / 10000 = (50000+270000+400000)/10000 = 72
      expect(result.entityResults['mat-A']?.value).toBeCloseTo(72, 1);
    });

    it('weighted average differs from simple average', () => {
      const result = wipAge.execute(makeContext(), 'weighted_average');
      const simpleResult = wipAge.execute(makeContext(), 'average_entry');
      // Simple average = 100; weighted = 72 (high-value entry pulls down since it's youngest)
      expect(result.entityResults['mat-A']?.value).not.toBeCloseTo(
        simpleResult.entityResults['mat-A']?.value ?? 0,
        0,
      );
    });
  });

  describe('age bands', () => {
    it('populates age bands correctly for MATTER_A', () => {
      const result = wipAge.execute(makeContext());
      const bands = result.entityResults['mat-A']?.breakdown?.['ageBands'] as Array<{
        band: string;
        entryCount: number;
        totalValue: number;
        percentOfTotal: number;
        recoveryProbability: number;
      }>;
      expect(bands).toBeDefined();

      const band030 = bands.find((b) => b.band === '0-30');
      const band6190 = bands.find((b) => b.band === '61-90');
      const band180plus = bands.find((b) => b.band === '180+');

      // Entry age=10 → 0-30 band, value=5000
      expect(band030?.entryCount).toBe(1);
      expect(band030?.totalValue).toBe(5000);

      // Entry age=90 → 61-90 band, value=3000
      expect(band6190?.entryCount).toBe(1);
      expect(band6190?.totalValue).toBe(3000);

      // Entry age=200 → 180+ band, value=2000
      expect(band180plus?.entryCount).toBe(1);
      expect(band180plus?.totalValue).toBe(2000);
    });

    it('percentOfTotal sums to ~100 for a matter with entries', () => {
      const result = wipAge.execute(makeContext());
      const bands = result.entityResults['mat-A']?.breakdown?.['ageBands'] as Array<{
        percentOfTotal: number;
      }>;
      const total = bands.reduce((s, b) => s + b.percentOfTotal, 0);
      expect(total).toBeCloseTo(100, 1);
    });

    it('attaches correct recovery probabilities', () => {
      const result = wipAge.execute(makeContext());
      const bands = result.entityResults['mat-A']?.breakdown?.['ageBands'] as Array<{
        band: string;
        recoveryProbability: number;
      }>;
      expect(bands.find((b) => b.band === '0-30')?.recoveryProbability).toBe(0.95);
      expect(bands.find((b) => b.band === '31-60')?.recoveryProbability).toBe(0.85);
      expect(bands.find((b) => b.band === '61-90')?.recoveryProbability).toBe(0.70);
      expect(bands.find((b) => b.band === '91-180')?.recoveryProbability).toBe(0.50);
      expect(bands.find((b) => b.band === '180+')?.recoveryProbability).toBe(0.25);
    });
  });

  describe('recovery probability calculation', () => {
    it('computes theoreticalRecovery for MATTER_A', () => {
      const result = wipAge.execute(makeContext());
      const bd = result.entityResults['mat-A']?.breakdown;
      // 5000×0.95 + 3000×0.70 + 2000×0.25 = 4750+2100+500 = 7350
      expect(bd?.['theoreticalRecovery']).toBeCloseTo(7350, 1);
    });

    it('computes atRiskAmount for MATTER_A', () => {
      const result = wipAge.execute(makeContext());
      const bd = result.entityResults['mat-A']?.breakdown;
      // totalWIP=10000, theoreticalRecovery=7350 → atRisk=2650
      expect(bd?.['atRiskAmount']).toBeCloseTo(2650, 1);
    });
  });

  describe('orphaned WIP', () => {
    it('tracks orphaned entries in firm-level breakdown', () => {
      const result = wipAge.execute(makeContext());
      const firmBd = result.entityResults['firm']?.breakdown;
      // 2 orphaned entries: value 1000+500=1500
      expect(firmBd?.['orphanedWipEntryCount']).toBe(2);
      expect(firmBd?.['orphanedWipValue']).toBe(1500);
    });

    it('orphaned entries not included in matter-level age calculations', () => {
      const result = wipAge.execute(makeContext());
      // orphaned entries have no matterId, should not appear in matter results
      // MATTER_A has exactly 3 entries (ages 10, 90, 200) — not affected by orphans
      expect(result.entityResults['mat-A']?.value).toBe(200); // max of 10, 90, 200
    });

    it('includes orphaned WIP in firm-level result even when no matched entries', () => {
      const orphanOnly = makeContext({ timeEntries: ORPHANED_ENTRIES });
      const result = wipAge.execute(orphanOnly);
      const firmBd = result.entityResults['firm']?.breakdown;
      expect(firmBd?.['orphanedWipValue']).toBe(1500);
    });
  });

  describe('firm-level aggregate', () => {
    it('firm oldest_entry = max across all matched entries (max=200)', () => {
      const result = wipAge.execute(makeContext());
      expect(result.entityResults['firm']?.value).toBe(200);
    });
  });
});

// =============================================================================
// F-WL-02: Write-Off Analysis
// =============================================================================

describe('F-WL-02 writeOffAnalysis', () => {
  it('returns correct formula metadata', () => {
    const result = writeOffAnalysis.execute(makeContext());
    expect(result.formulaId).toBe('F-WL-02');
    expect(result.formulaName).toBe('Write-Off Analysis');
    expect(result.resultType).toBe('percentage');
  });

  it('computes correct write-off percentage at firm level', () => {
    const result = writeOffAnalysis.execute(makeContext());
    const firm = result.entityResults['firm'];
    expect(firm).toBeDefined();

    // All entries:
    // A1: billableValue=5000, writeOff=0 → recorded=5000
    // A2: billableValue=3000, writeOff=0 → recorded=3000
    // A3: billableValue=2000, writeOff=0 → recorded=2000
    // B1: billableValue=4000, writeOff=1000 → recorded=5000
    // B2: billableValue=6000, writeOff=2000 → recorded=8000
    // orphan1: billableValue=1000, writeOff=0 → recorded=1000
    // orphan2: billableValue=500, writeOff=0 → recorded=500
    // Total recorded = 5000+3000+2000+5000+8000+1000+500 = 24500
    // Total writeOff = 0+0+0+1000+2000+0+0 = 3000
    // Write-off % = 3000/24500 ≈ 12.24%
    expect(firm.value).toBeCloseTo(3000 / 24500 * 100, 1);
  });

  it('computes write-off % per fee earner', () => {
    const result = writeOffAnalysis.execute(makeContext());
    // L001: entries A1, A2, A3 + orphan1, orphan2
    //   recorded = 5000+3000+2000+1000+500 = 11500, writeOff=0
    const l001 = result.entityResults['L001'];
    expect(l001).toBeDefined();
    expect(l001.value).toBeCloseTo(0, 1);

    // L002: entries B1, B2
    //   recorded = 5000+8000 = 13000, writeOff=1000+2000=3000
    const l002 = result.entityResults['L002'];
    expect(l002).toBeDefined();
    expect(l002.value).toBeCloseTo(3000 / 13000 * 100, 1);
  });

  it('computes write-off % per matter', () => {
    const result = writeOffAnalysis.execute(makeContext());
    // mat-A entries: A1(5000,0), A2(3000,0), A3(2000,0)
    //   recorded=10000, writeOff=0 → 0%
    const matA = result.entityResults['mat-A'];
    expect(matA?.value).toBeCloseTo(0, 1);

    // mat-B entries: B1(4000,1000), B2(6000,2000)
    //   recorded=13000, writeOff=3000 → 23.08%
    const matB = result.entityResults['mat-B'];
    expect(matB?.value).toBeCloseTo(3000 / 13000 * 100, 1);
  });

  it('returns null for an entity with no recorded value', () => {
    const noEntries = makeContext({ timeEntries: [] });
    const result = writeOffAnalysis.execute(noEntries);
    expect(result.entityResults['firm']?.value).toBeNull();
    expect(result.entityResults['firm']?.nullReason).toMatch(/no recorded value/i);
  });

  it('includes totalBilledValue in breakdown', () => {
    const result = writeOffAnalysis.execute(makeContext());
    const bd = result.entityResults['L002']?.breakdown;
    expect(bd?.['totalRecordedValue']).toBe(13000);
    expect(bd?.['totalWriteOff']).toBe(3000);
    expect(bd?.['totalBilledValue']).toBe(10000);
  });
});

// =============================================================================
// F-WL-03: Disbursement Recovery
// =============================================================================

describe('F-WL-03 disbursementRecovery', () => {
  it('returns correct formula metadata', () => {
    const result = disbursementRecovery.execute(makeContext());
    expect(result.formulaId).toBe('F-WL-03');
    expect(result.formulaName).toBe('Disbursement Recovery');
    expect(result.resultType).toBe('percentage');
  });

  it('computes recovery % for MATTER_A with partial recovery', () => {
    const result = disbursementRecovery.execute(makeContext());
    const r = result.entityResults['mat-A'];
    expect(r).toBeDefined();

    // DISB_A1: total=400, outstanding=100 → recovered=300
    // DISB_A2: total=200, outstanding=50  → recovered=150
    // Total: 600, outstanding=150, recovered=450
    // Recovery = 450/600 = 75%
    expect(r.value).toBeCloseTo(75, 1);
  });

  it('breakdown includes all disbursement components', () => {
    const result = disbursementRecovery.execute(makeContext());
    const bd = result.entityResults['mat-A']?.breakdown;
    expect(bd?.['totalDisbursements']).toBe(600);
    expect(bd?.['recoveredDisbursements']).toBe(450);
    expect(bd?.['outstandingDisbursements']).toBe(150);
    expect(bd?.['firmExposure']).toBe(150);
  });

  it('computes 0% recovery for MATTER_B (fully outstanding)', () => {
    const result = disbursementRecovery.execute(makeContext());
    const r = result.entityResults['mat-B'];
    expect(r).toBeDefined();
    // DISB_B1: total=300, outstanding=300 → recovered=0
    expect(r.value).toBeCloseTo(0, 1);
  });

  it('skips matters with no disbursements', () => {
    const result = disbursementRecovery.execute(makeContext());
    // MATTER_EMPTY has no disbursement records and invoicedDisbursements=0
    expect(result.entityResults['mat-C']).toBeUndefined();
  });

  it('computes firm-level aggregate correctly', () => {
    const result = disbursementRecovery.execute(makeContext());
    const firm = result.entityResults['firm'];
    expect(firm).toBeDefined();

    // mat-A: total=600, outstanding=150
    // mat-B: total=300, outstanding=300
    // firm:  total=900, outstanding=450 → recovered=450 → 50%
    expect(firm.value).toBeCloseTo(50, 1);
    expect(firm.breakdown?.['totalDisbursements']).toBe(900);
    expect(firm.breakdown?.['firmExposure']).toBe(450);
  });

  it('falls back to invoicedDisbursements when no disbursement records', () => {
    const result = disbursementRecovery.execute(makeContext({ disbursements: [] }));
    // MATTER_A.invoicedDisbursements=500, MATTER_B.invoicedDisbursements=200
    // Without records, outstanding assumed 0 → 100% recovery
    const matA = result.entityResults['mat-A'];
    expect(matA).toBeDefined();
    expect(matA.value).toBeCloseTo(100, 1);
  });
});

// =============================================================================
// F-WL-04: Lock-Up Days
// =============================================================================

describe('F-WL-04 lockUpDays', () => {
  it('returns correct formula metadata', () => {
    const result = lockUpDays.execute(makeContext());
    expect(result.formulaId).toBe('F-WL-04');
    expect(result.formulaName).toBe('Lock-Up Days');
    expect(result.resultType).toBe('days');
  });

  it('computes WIP lock-up from average ageInDays of matched entries', () => {
    const result = lockUpDays.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;

    // Matched entries (5): ages 10, 90, 200 (mat-A) + 30, 60 (mat-B)
    // Average = (10+90+200+30+60) / 5 = 390/5 = 78
    expect(bd?.['wipLockUpDays']).toBeCloseTo(78, 1);
  });

  it('computes debtor lock-up from average daysOutstanding of unpaid invoices', () => {
    const result = lockUpDays.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;

    // Unpaid: INVOICE_UNPAID_1 (daysOutstanding=45), INVOICE_UNPAID_2 (daysOutstanding=15)
    // Average debtor days = (45 + 15) / 2 = 30
    expect(bd?.['debtorLockUpDays']).toBeCloseTo(30, 1);
  });

  it('total lock-up = WIP lock-up + debtor lock-up', () => {
    const result = lockUpDays.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;

    const wip = bd?.['wipLockUpDays'] as number;
    const debtor = bd?.['debtorLockUpDays'] as number;
    expect(bd?.['totalLockUpDays']).toBeCloseTo(wip + debtor, 2);
    expect(result.entityResults['firm']?.value).toBeCloseTo(wip + debtor, 2);
  });

  it('breakdown includes unpaidInvoiceCount and totalOutstanding', () => {
    const result = lockUpDays.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;
    expect(bd?.['unpaidInvoiceCount']).toBe(2);
    expect(bd?.['totalOutstanding']).toBe(7000); // 5000 + 2000
  });

  describe('from_payment_date variant', () => {
    it('falls back to from_due_date when datePaid not available', () => {
      const result = lockUpDays.execute(makeContext(), 'from_payment_date');
      // No datePaid on any invoice → should warn and fall back
      expect(result.metadata.warnings.length).toBeGreaterThan(0);
      expect(result.metadata.warnings[0]).toMatch(/datePaid field not available/i);
    });

    it('variant is recorded correctly even with fallback', () => {
      const result = lockUpDays.execute(makeContext(), 'from_payment_date');
      expect(result.variantUsed).toBe('from_payment_date');
    });
  });

  describe('from_invoice_date variant', () => {
    it('uses invoiceDate field for debtor aging when available', () => {
      // Create invoices with invoiceDate set
      const refDate = new Date('2025-01-09T00:00:00.000Z');
      const invWithDate = makeInvoice('mat-A', 5000, null, {
        ...({ invoiceDate: new Date('2024-12-10T00:00:00.000Z') } as object), // 30 days before
      } as Partial<EnrichedInvoice>);
      const result = lockUpDays.execute(
        makeContext({ invoices: [invWithDate] }),
        'from_invoice_date',
      );
      const bd = result.entityResults['firm']?.breakdown;
      // 30 days from invoice date
      expect(bd?.['debtorLockUpDays']).toBeCloseTo(30, 0);
    });
  });

  it('WIP lock-up is 0 when no time entries have age data', () => {
    const baseEntries = [...ENTRIES_A, ...ENTRIES_B, ...ORPHANED_ENTRIES];
    const noAged = makeContext({
      timeEntries: baseEntries.map((e) => ({ ...e, ageInDays: null })),
    });
    const result = lockUpDays.execute(noAged);
    expect(result.entityResults['firm']?.breakdown?.['wipLockUpDays']).toBe(0);
  });
});
