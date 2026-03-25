import { describe, it, expect } from 'vitest';
import {
  realisationRate,
  effectiveHourlyRate,
  revenuePerFeeEarner,
  billingVelocity,
} from '../../../../src/server/formula-engine/formulas/revenue.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type { AggregatedFeeEarner, AggregatedMatter, AggregatedFirm } from '../../../../src/shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../../src/shared/types/enriched.js';
import type { FirmConfig } from '../../../../src/shared/types/index.js';

// =============================================================================
// Shared test data
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
  feeEarnerCount: 3,
  activeFeeEarnerCount: 3,
  salariedFeeEarnerCount: 2,
  feeShareFeeEarnerCount: 1,
  matterCount: 4,
  activeMatterCount: 3,
  inProgressMatterCount: 2,
  completedMatterCount: 1,
  otherMatterCount: 0,
  totalWipHours: 200,
  totalChargeableHours: 160,
  totalWipValue: 80000,
  totalWriteOffValue: 3000,
  totalInvoicedRevenue: 42000,
  totalOutstanding: 8000,
  totalPaid: 34000,
  orphanedWip: {
    orphanedWipEntryCount: 10,
    orphanedWipHours: 20,
    orphanedWipValue: 8000,
    orphanedWipPercent: 10,
    orphanedWipNote: 'test',
  },
};

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

/**
 * M-001: Time-billed matter, partially realised.
 * WIP=10000, Invoiced=8000, WriteOff=500, invoiceCount=2
 * Realisation = 8000/10000 = 80%
 */
const MATTER_TIME: AggregatedMatter = {
  matterId: 'mat-001',
  matterNumber: '1001',
  wipTotalHours: 100,
  wipChargeableHours: 80,
  wipNonChargeableHours: 20,
  wipTotalBillable: 10000,
  wipTotalWriteOff: 500,
  wipAgeInDays: 45,
  invoiceCount: 2,
  invoicedNetBilling: 8000,
  invoicedDisbursements: 0,
  invoicedTotal: 8000,
  invoicedOutstanding: 1500,
  invoicedPaid: 6500,
  invoicedWrittenOff: 0,
};

/**
 * M-002: Time-billed matter, no invoices yet (WIP unbilled).
 * WIP=5000, Invoiced=0, invoiceCount=0
 * Realisation = 0% (no invoices issued)
 */
const MATTER_UNBILLED: AggregatedMatter = {
  matterId: 'mat-002',
  matterNumber: '1002',
  wipTotalHours: 50,
  wipChargeableHours: 40,
  wipNonChargeableHours: 10,
  wipTotalBillable: 5000,
  wipTotalWriteOff: 0,
  wipAgeInDays: 30,
  invoiceCount: 0,
  invoicedNetBilling: 0,
  invoicedDisbursements: 0,
  invoicedTotal: 0,
  invoicedOutstanding: 0,
  invoicedPaid: 0,
  invoicedWrittenOff: 0,
};

/**
 * M-003: Fixed-fee matter — invoiced more than WIP recorded.
 * WIP=3000, Invoiced=5000, invoiceCount=1
 * Realisation = 5000/3000 = 166.7% (all_matters variant)
 * adjusted_fixed_fee variant → auto 100%
 * time_billed_only variant → skipped
 */
const MATTER_FIXED_FEE: AggregatedMatter = {
  matterId: 'mat-003',
  matterNumber: '1003',
  wipTotalHours: 30,
  wipChargeableHours: 28,
  wipNonChargeableHours: 2,
  wipTotalBillable: 3000,
  wipTotalWriteOff: 0,
  wipAgeInDays: null,
  invoiceCount: 1,
  invoicedNetBilling: 5000,
  invoicedDisbursements: 0,
  invoicedTotal: 5000,
  invoicedOutstanding: 0,
  invoicedPaid: 5000,
  invoicedWrittenOff: 0,
  // Dynamic field — not in typed interface
  ...({ isFixedFee: true } as object),
} as AggregatedMatter;

/**
 * M-004: No WIP at all — should be skipped entirely.
 */
const MATTER_NO_WIP: AggregatedMatter = {
  matterId: 'mat-004',
  matterNumber: '1004',
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
// Fee earners
// ---------------------------------------------------------------------------

function makeFeeEarner(
  lawyerId: string,
  lawyerName: string,
  extra: Partial<AggregatedFeeEarner> & Record<string, unknown>,
): AggregatedFeeEarner {
  return {
    lawyerId,
    lawyerName,
    wipTotalHours: 0,
    wipChargeableHours: 0,
    wipNonChargeableHours: 0,
    wipChargeableValue: 0,
    wipEntryCount: 0,
    wipTotalValue: 0,
    wipWriteOffValue: 0,
    wipOrphanedHours: 0,
    wipOrphanedValue: 0,
    invoicedRevenue: 0,
    invoicedOutstanding: 0,
    invoicedCount: 0,
    recordingGapDays: null,
    ...extra,
  } as AggregatedFeeEarner;
}

/** Alice: Salaried, £300/hr effective rate (24000 revenue / 80h chargeable). */
const FE_ALICE = makeFeeEarner('L001', 'Alice Partner', {
  wipChargeableHours: 80,
  invoicedRevenue: 24000,
  payModel: 'Salaried',
  rate: 250, // standard charge-out rate
});

/** Bob: FeeShare (30% to lawyer, 70% to firm), £300/hr effective rate. */
const FE_BOB = makeFeeEarner('L002', 'Bob Associate', {
  wipChargeableHours: 60,
  invoicedRevenue: 18000,
  payModel: 'FeeShare',
  feeSharePercent: 30,
  rate: 350, // standard charge-out rate
});

/** System account — must be excluded from all fee-earner formulas. */
const FE_SYSTEM = makeFeeEarner('L999', 'System Account', {
  wipChargeableHours: 100,
  invoicedRevenue: 50000,
  isSystemAccount: true,
});

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

function makeEntry(
  matterId: string,
  ageInDays: number,
  billable: number,
  extra: Partial<EnrichedTimeEntry> = {},
): EnrichedTimeEntry {
  return {
    entityType: 'timeEntry',
    matterId,
    hasMatchedMatter: true,
    ageInDays,
    isChargeable: true,
    durationHours: billable / 250,
    ...({ billable } as object),
    ...extra,
  } as EnrichedTimeEntry;
}

/**
 * Entries for M-001 (3 entries):  ages 30, 45, 60 → averageAge = 45
 * billable values 1000, 1000, 1000 → totalUnbilledValue = 3000
 */
const ENTRIES_M001 = [
  makeEntry('mat-001', 30, 1000),
  makeEntry('mat-001', 45, 1000),
  makeEntry('mat-001', 60, 1000),
];

/**
 * Entries for M-002 (2 entries): ages 20, 30 → averageAge = 25
 * billable values 2000, 2000 → totalUnbilledValue = 4000
 */
const ENTRIES_M002 = [
  makeEntry('mat-002', 20, 2000),
  makeEntry('mat-002', 30, 2000),
];

/**
 * Entry for M-003 (fixed-fee, 1 entry): age 15
 * billable 1500 → totalUnbilledValue = 1500
 */
const ENTRIES_M003 = [makeEntry('mat-003', 15, 1500)];

// ---------------------------------------------------------------------------
// Context builder helper
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<FormulaContext> = {},
): FormulaContext {
  return {
    feeEarners: [FE_ALICE, FE_BOB, FE_SYSTEM],
    matters: [MATTER_TIME, MATTER_UNBILLED, MATTER_FIXED_FEE, MATTER_NO_WIP],
    invoices: [],
    timeEntries: [...ENTRIES_M001, ...ENTRIES_M002, ...ENTRIES_M003],
    disbursements: [],
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
// F-RB-01: Realisation Rate
// =============================================================================

describe('F-RB-01 realisationRate', () => {
  it('returns correct formula metadata', () => {
    const result = realisationRate.execute(makeContext());
    expect(result.formulaId).toBe('F-RB-01');
    expect(result.formulaName).toBe('Realisation Rate');
    expect(result.resultType).toBe('percentage');
  });

  describe('time_billed_only variant (default)', () => {
    it('computes 80% for M-001 (8000 invoiced / 10000 WIP)', () => {
      const result = realisationRate.execute(makeContext());
      const r = result.entityResults['mat-001'];
      expect(r).toBeDefined();
      expect(r.value).toBeCloseTo(80, 1);
      expect(r.nullReason).toBeNull();
    });

    it('returns 0% for M-002 (no invoices issued yet)', () => {
      const result = realisationRate.execute(makeContext());
      const r = result.entityResults['mat-002'];
      expect(r).toBeDefined();
      expect(r.value).toBe(0);
    });

    it('excludes fixed-fee matters', () => {
      const result = realisationRate.execute(makeContext());
      expect(result.entityResults['mat-003']).toBeUndefined();
    });

    it('excludes zero-WIP matters', () => {
      const result = realisationRate.execute(makeContext());
      expect(result.entityResults['mat-004']).toBeUndefined();
    });

    it('includes breakdown fields', () => {
      const result = realisationRate.execute(makeContext());
      const bd = result.entityResults['mat-001']?.breakdown;
      expect(bd?.['recordedValue']).toBe(10000);
      expect(bd?.['billedValue']).toBe(8000);
      expect(bd?.['writeOffValue']).toBe(500);
      expect(bd?.['matterCount']).toBe(1);
    });
  });

  describe('all_matters variant', () => {
    it('includes fixed-fee matter with >100% realisation', () => {
      const result = realisationRate.execute(makeContext(), 'all_matters');
      const r = result.entityResults['mat-003'];
      expect(r).toBeDefined();
      expect(r.value).toBeCloseTo(166.7, 1);
    });

    it('still computes M-001 at 80%', () => {
      const result = realisationRate.execute(makeContext(), 'all_matters');
      expect(result.entityResults['mat-001']?.value).toBeCloseTo(80, 1);
    });
  });

  describe('adjusted_fixed_fee variant', () => {
    it('auto-sets fixed-fee matter to 100%', () => {
      const result = realisationRate.execute(makeContext(), 'adjusted_fixed_fee');
      const r = result.entityResults['mat-003'];
      expect(r).toBeDefined();
      expect(r.value).toBe(100);
      expect(r.breakdown?.['isFixedFee']).toBe(true);
    });

    it('still computes time-billed matters normally', () => {
      const result = realisationRate.execute(makeContext(), 'adjusted_fixed_fee');
      expect(result.entityResults['mat-001']?.value).toBeCloseTo(80, 1);
    });
  });

  it('surfaces discrepancy warning when hasMajorDiscrepancy is true', () => {
    const matterWithDiscrepancy: AggregatedMatter = {
      ...MATTER_TIME,
      matterId: 'mat-disc',
      matterNumber: '9001',
      discrepancy: {
        billingDifference: 3000,
        billingDifferencePercent: 30,
        hasMajorDiscrepancy: true,
      },
    };
    const result = realisationRate.execute(
      makeContext({ matters: [matterWithDiscrepancy] }),
    );
    expect(result.metadata.warnings.length).toBeGreaterThan(0);
    expect(result.metadata.warnings[0]).toMatch(/discrepancy/i);
  });

  it('uses variantUsed field correctly', () => {
    const r1 = realisationRate.execute(makeContext(), 'all_matters');
    expect(r1.variantUsed).toBe('all_matters');

    const r2 = realisationRate.execute(makeContext());
    expect(r2.variantUsed).toBe('time_billed_only');
  });
});

// =============================================================================
// F-RB-02: Effective Hourly Rate
// =============================================================================

describe('F-RB-02 effectiveHourlyRate', () => {
  it('returns correct formula metadata', () => {
    const result = effectiveHourlyRate.execute(makeContext());
    expect(result.formulaId).toBe('F-RB-02');
    expect(result.formulaName).toBe('Effective Hourly Rate');
    expect(result.resultType).toBe('currency');
  });

  it('computes £300/hr for Alice (24000 / 80h)', () => {
    const result = effectiveHourlyRate.execute(makeContext());
    const r = result.entityResults['L001'];
    expect(r).toBeDefined();
    expect(r.value).toBeCloseTo(300, 2);
    expect(r.nullReason).toBeNull();
  });

  it('computes £300/hr for Bob (18000 / 60h)', () => {
    const result = effectiveHourlyRate.execute(makeContext());
    const r = result.entityResults['L002'];
    expect(r).toBeDefined();
    expect(r.value).toBeCloseTo(300, 2);
  });

  it('excludes system accounts', () => {
    const result = effectiveHourlyRate.execute(makeContext());
    expect(result.entityResults['L999']).toBeUndefined();
  });

  it('returns null value when no chargeable hours', () => {
    const noHours = makeFeeEarner('L010', 'No Hours', {
      wipChargeableHours: 0,
      invoicedRevenue: 5000,
      payModel: 'Salaried',
    });
    const result = effectiveHourlyRate.execute(makeContext({ feeEarners: [noHours] }));
    const r = result.entityResults['L010'];
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/chargeable hours/i);
  });

  it('computes rateCapture when chargeOutRate provided via override', () => {
    // Alice has chargeOutRate=250 via dynamic field; effective=300 → 120%
    const result = effectiveHourlyRate.execute(makeContext());
    const r = result.entityResults['L001'];
    expect(r.additionalValues?.['rateCapture']).toBeCloseTo(120, 1);
    expect(r.additionalValues?.['chargeOutRate']).toBe(250);
  });

  it('returns effectiveRate 0 when revenue is 0 but hours exist', () => {
    const noRevenue = makeFeeEarner('L011', 'No Revenue', {
      wipChargeableHours: 40,
      invoicedRevenue: 0,
      payModel: 'Salaried',
    });
    const result = effectiveHourlyRate.execute(makeContext({ feeEarners: [noRevenue] }));
    const r = result.entityResults['L011'];
    expect(r.value).toBe(0);
    expect(r.nullReason).toBeNull();
  });

  it('includes breakdown with attributedRevenue and chargeableHours', () => {
    const result = effectiveHourlyRate.execute(makeContext());
    const bd = result.entityResults['L001']?.breakdown;
    expect(bd?.['attributedRevenue']).toBe(24000);
    expect(bd?.['chargeableHours']).toBe(80);
  });
});

// =============================================================================
// F-RB-03: Revenue per Fee Earner
// =============================================================================

describe('F-RB-03 revenuePerFeeEarner', () => {
  it('returns correct formula metadata', () => {
    const result = revenuePerFeeEarner.execute(makeContext());
    expect(result.formulaId).toBe('F-RB-03');
    expect(result.formulaName).toBe('Revenue per Fee Earner');
    expect(result.resultType).toBe('currency');
  });

  it('excludes system accounts', () => {
    const result = revenuePerFeeEarner.execute(makeContext());
    expect(result.entityResults['L999']).toBeUndefined();
  });

  describe('Salaried fee earner (Alice)', () => {
    it('value = gross billing (firm keeps all)', () => {
      const result = revenuePerFeeEarner.execute(makeContext());
      const r = result.entityResults['L001'];
      expect(r.value).toBe(24000);
      expect(r.breakdown?.['grossRevenue']).toBe(24000);
    });

    it('has no additionalValues for salaried', () => {
      const result = revenuePerFeeEarner.execute(makeContext());
      const r = result.entityResults['L001'];
      expect(r.additionalValues).toBeUndefined();
    });
  });

  describe('FeeShare fee earner (Bob, 30% lawyer / 70% firm)', () => {
    it('value = firm retain = 70% of gross billing', () => {
      const result = revenuePerFeeEarner.execute(makeContext());
      const r = result.entityResults['L002'];
      // 18000 * 0.70 = 12600
      expect(r.value).toBeCloseTo(12600, 2);
    });

    it('additionalValues includes lawyerPerspectiveRevenue and grossBilling', () => {
      const result = revenuePerFeeEarner.execute(makeContext());
      const r = result.entityResults['L002'];
      // 18000 * 0.30 = 5400
      expect(r.additionalValues?.['lawyerPerspectiveRevenue']).toBeCloseTo(5400, 2);
      expect(r.additionalValues?.['grossBilling']).toBe(18000);
    });

    it('breakdown includes all split values', () => {
      const result = revenuePerFeeEarner.execute(makeContext());
      const bd = result.entityResults['L002']?.breakdown;
      expect(bd?.['feeSharePercent']).toBe(30);
      expect(bd?.['firmRetainPercent']).toBe(70);
      expect(bd?.['grossBilling']).toBe(18000);
    });
  });

  it('warns when payModel not set and treats as Salaried', () => {
    const noPayModel = makeFeeEarner('L012', 'Unknown Model', {
      wipChargeableHours: 40,
      invoicedRevenue: 10000,
    });
    const result = revenuePerFeeEarner.execute(makeContext({ feeEarners: [noPayModel] }));
    const r = result.entityResults['L012'];
    expect(r.value).toBe(10000); // treated as salaried
    expect(result.metadata.warnings.length).toBeGreaterThan(0);
    expect(result.metadata.warnings[0]).toMatch(/payModel not set/i);
  });

  it('uses feeSharePercent from firmConfig defaults when override absent', () => {
    // FIRM_CONFIG has defaultFeeSharePercent=30, defaultFirmRetainPercent=70
    const result = revenuePerFeeEarner.execute(makeContext());
    // Bob's feeSharePercent=30 matches firm default
    const r = result.entityResults['L002'];
    expect(r.value).toBeCloseTo(12600, 2);
  });
});

// =============================================================================
// F-RB-04: Billing Velocity
// =============================================================================

describe('F-RB-04 billingVelocity', () => {
  it('returns correct formula metadata', () => {
    const result = billingVelocity.execute(makeContext());
    expect(result.formulaId).toBe('F-RB-04');
    expect(result.formulaName).toBe('Billing Velocity');
    expect(result.resultType).toBe('days');
  });

  describe('matter-level velocity from time entries', () => {
    it('computes averageAge=45 for M-001 (ages: 30, 45, 60)', () => {
      const result = billingVelocity.execute(makeContext());
      const r = result.entityResults['mat-001'];
      expect(r).toBeDefined();
      expect(r.value).toBeCloseTo(45, 1);
    });

    it('computes averageAge=25 for M-002 (ages: 20, 30)', () => {
      const result = billingVelocity.execute(makeContext());
      const r = result.entityResults['mat-002'];
      expect(r).toBeDefined();
      expect(r.value).toBeCloseTo(25, 1);
    });

    it('computes averageAge=15 for M-003 (single entry, age 15)', () => {
      const result = billingVelocity.execute(makeContext());
      const r = result.entityResults['mat-003'];
      expect(r).toBeDefined();
      expect(r.value).toBeCloseTo(15, 1);
    });

    it('breakdown includes unbilledEntryCount, totalUnbilledValue, averageAge, oldestEntry', () => {
      const result = billingVelocity.execute(makeContext());
      const bd = result.entityResults['mat-001']?.breakdown;
      expect(bd?.['unbilledEntryCount']).toBe(3);
      expect(bd?.['totalUnbilledValue']).toBe(3000); // 1000+1000+1000
      expect(bd?.['averageAge']).toBeCloseTo(45, 1);
      expect(bd?.['oldestEntry']).toBe(60);
    });
  });

  describe('firm-level weighted average velocity', () => {
    it('computes firm-level weighted velocity', () => {
      const result = billingVelocity.execute(makeContext());
      const firm = result.entityResults['firm'];
      expect(firm).toBeDefined();
      expect(firm.entityId).toBe('firm');

      // Weighted average:
      // M-001: age=45, weight=3000 → 135000
      // M-002: age=25, weight=4000 → 100000
      // M-003: age=15, weight=1500 → 22500
      // Total weight = 8500, total = 257500
      // Velocity = 257500 / 8500 ≈ 30.29
      expect(firm.value).toBeCloseTo(257500 / 8500, 1);
    });

    it('firm result uses "days" formatted value', () => {
      const result = billingVelocity.execute(makeContext());
      const firm = result.entityResults['firm'];
      expect(firm.formattedValue).toMatch(/days$/);
    });
  });

  it('falls back to wipAgeInDays when no time entries in context', () => {
    const result = billingVelocity.execute(makeContext({ timeEntries: [] }));
    // M-001 has wipAgeInDays=45
    const r = result.entityResults['mat-001'];
    expect(r).toBeDefined();
    expect(r.value).toBe(45);
  });

  it('skips matter when no entries and no wipAgeInDays and no WIP', () => {
    // M-004: wipTotalBillable=0, wipAgeInDays=null, no entries
    const result = billingVelocity.execute(makeContext({ timeEntries: [] }));
    expect(result.entityResults['mat-004']).toBeUndefined();
  });

  it('returns 0-day velocity for fully-billed matter (hasInvoices + wipTotalBillable=0)', () => {
    const fullyBilled: AggregatedMatter = {
      ...MATTER_TIME,
      matterId: 'mat-fb',
      matterNumber: '9002',
      wipTotalBillable: 0,
      invoiceCount: 3,
      wipAgeInDays: 60,
    };
    const result = billingVelocity.execute(
      makeContext({ matters: [fullyBilled], timeEntries: [] }),
    );
    const r = result.entityResults['mat-fb'];
    expect(r).toBeDefined();
    expect(r.value).toBe(0);
  });

  it('formattedValue shows "0 days" for zero velocity', () => {
    const fullyBilled: AggregatedMatter = {
      ...MATTER_TIME,
      matterId: 'mat-fb2',
      matterNumber: '9003',
      wipTotalBillable: 0,
      invoiceCount: 1,
      wipAgeInDays: 0,
    };
    const result = billingVelocity.execute(
      makeContext({ matters: [fullyBilled], timeEntries: [] }),
    );
    expect(result.entityResults['mat-fb2']?.formattedValue).toBe('0 days');
  });
});
