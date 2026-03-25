import { describe, it, expect } from 'vitest';
import {
  budgetBurnRate,
  scopeCreepIndicator,
} from '../../../../src/server/formula-engine/formulas/budget.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type {
  AggregatedMatter,
  AggregatedFirm,
  AggregatedFeeEarner,
} from '../../../../src/shared/types/pipeline.js';
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
  feeEarnerCount: 1,
  activeFeeEarnerCount: 1,
  salariedFeeEarnerCount: 1,
  feeShareFeeEarnerCount: 0,
  matterCount: 3,
  activeMatterCount: 3,
  inProgressMatterCount: 3,
  completedMatterCount: 0,
  otherMatterCount: 0,
  totalWipHours: 200,
  totalChargeableHours: 160,
  totalWipValue: 60000,
  totalWriteOffValue: 0,
  totalInvoicedRevenue: 30000,
  totalOutstanding: 5000,
  totalPaid: 25000,
  orphanedWip: {
    orphanedWipEntryCount: 0,
    orphanedWipHours: 0,
    orphanedWipValue: 0,
    orphanedWipPercent: 0,
    orphanedWipNote: '',
  },
};

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

/**
 * MATTER_WITH_BUDGET: budget=20000, wipTotalBillable=10000 → 50% burn
 * invoicedNetBilling=6000, invoiceCount=1 → billingProgress = 6000/20000 = 30%
 * scopeCreep = 50% - 30% = 20%
 */
const MATTER_WITH_BUDGET: AggregatedMatter = {
  matterId: 'mat-001',
  matterNumber: '1001',
  wipTotalDurationMinutes: 4000,
  wipTotalHours: 100,
  wipTotalBillable: 10000,
  wipTotalWriteOff: 0,
  wipTotalUnits: 1000,
  wipTotalChargeable: 1000,
  wipTotalNonChargeable: 0,
  wipChargeableHours: 80,
  wipNonChargeableHours: 20,
  wipOldestEntryDate: null,
  wipNewestEntryDate: null,
  wipAgeInDays: 30,
  invoiceCount: 1,
  invoicedNetBilling: 6000,
  invoicedDisbursements: 0,
  invoicedTotal: 6000,
  invoicedOutstanding: 2000,
  invoicedPaid: 4000,
  invoicedWrittenOff: 0,
  ...({ budget: 20000 } as object),
} as AggregatedMatter;

/**
 * MATTER_OVER_BUDGET: budget=5000, wipTotalBillable=6000 → 120% burn (over budget)
 */
const MATTER_OVER_BUDGET: AggregatedMatter = {
  ...MATTER_WITH_BUDGET,
  matterId: 'mat-002',
  matterNumber: '1002',
  wipTotalBillable: 6000,
  invoicedNetBilling: 5500,
  invoiceCount: 2,
  ...({ budget: 5000 } as object),
} as AggregatedMatter;

/** MATTER_NO_BUDGET: no budget field → value = null */
const MATTER_NO_BUDGET: AggregatedMatter = {
  ...MATTER_WITH_BUDGET,
  matterId: 'mat-003',
  matterNumber: '1003',
  ...({ budget: null } as object),
} as AggregatedMatter;

// ---------------------------------------------------------------------------
// Time entries (for by_hours variant)
// ---------------------------------------------------------------------------

function makeEntry(matterId: string, durationHours: number, billableValue: number): EnrichedTimeEntry {
  return {
    entityType: 'timeEntry',
    matterId,
    hasMatchedMatter: true,
    durationHours,
    isChargeable: true,
    ...({ billableValue, writeOffValue: 0 } as object),
  } as EnrichedTimeEntry;
}

// 2 entries for mat-001, each 50h at £100/hr = £5000 each (total £10000 / 100h = £100/hr avg)
const ENTRIES_M1 = [
  makeEntry('mat-001', 50, 5000),
  makeEntry('mat-001', 50, 5000),
];

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [] as AggregatedFeeEarner[],
    matters: [MATTER_WITH_BUDGET, MATTER_OVER_BUDGET, MATTER_NO_BUDGET],
    invoices: [],
    timeEntries: ENTRIES_M1,
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
// F-BS-01: Budget Burn Rate
// =============================================================================

describe('F-BS-01 budgetBurnRate', () => {
  it('returns correct formula metadata', () => {
    const result = budgetBurnRate.execute(makeContext());
    expect(result.formulaId).toBe('F-BS-01');
    expect(result.formulaName).toBe('Budget Burn Rate');
    expect(result.resultType).toBe('percentage');
    expect(result.variantUsed).toBe('by_value');
  });

  describe('by_value variant (default)', () => {
    it('computes 50% burn for MATTER_WITH_BUDGET (10000/20000)', () => {
      const result = budgetBurnRate.execute(makeContext());
      const r = result.entityResults['mat-001'];
      expect(r.value).toBeCloseTo(50, 2);
      expect(r.nullReason).toBeNull();
    });

    it('computes 120% burn for MATTER_OVER_BUDGET (6000/5000)', () => {
      const result = budgetBurnRate.execute(makeContext());
      const r = result.entityResults['mat-002'];
      expect(r.value).toBeCloseTo(120, 2);
      expect(r.breakdown?.['isOverBudget']).toBe(true);
    });

    it('returns null for matter with no budget', () => {
      const result = budgetBurnRate.execute(makeContext());
      const r = result.entityResults['mat-003'];
      expect(r.value).toBeNull();
      expect(r.nullReason).toMatch(/no budget set/i);
    });

    it('breakdown includes budget, totalSpend, remaining', () => {
      const result = budgetBurnRate.execute(makeContext());
      const bd = result.entityResults['mat-001']?.breakdown;
      expect(bd?.['budget']).toBe(20000);
      expect(bd?.['totalSpend']).toBe(10000);
      expect(bd?.['remaining']).toBe(10000);
      expect(bd?.['isOverBudget']).toBe(false);
    });
  });

  describe('by_hours variant', () => {
    it('converts budget to hours using average rate and computes burn', () => {
      const result = budgetBurnRate.execute(makeContext(), 'by_hours');
      const r = result.entityResults['mat-001'];
      // avg rate = 10000 / 100h = £100/hr; budgetHours = 20000/100 = 200h
      // totalHours = 100h; burn = 100/200 = 50%
      expect(r.value).toBeCloseTo(50, 2);
      expect(r.breakdown?.['budgetHours']).toBeCloseTo(200, 1);
      expect(r.breakdown?.['totalHours']).toBe(100);
    });

    it('returns null when no rate data available', () => {
      // Matter with no time entries and no wipTotalBillable/hours to derive rate
      const noRateMatter: AggregatedMatter = {
        ...MATTER_WITH_BUDGET,
        matterId: 'mat-noRate',
        matterNumber: '9999',
        wipTotalHours: 0,
        wipTotalBillable: 0,
      };
      const result = budgetBurnRate.execute(
        makeContext({ matters: [noRateMatter], timeEntries: [] }),
        'by_hours',
      );
      expect(result.entityResults['mat-noRate']?.value).toBeNull();
    });

    it('by_hours variant records variantUsed', () => {
      const result = budgetBurnRate.execute(makeContext(), 'by_hours');
      expect(result.variantUsed).toBe('by_hours');
    });
  });
});

// =============================================================================
// F-BS-02: Scope Creep Indicator
// =============================================================================

describe('F-BS-02 scopeCreepIndicator', () => {
  it('returns correct formula metadata', () => {
    const result = scopeCreepIndicator.execute(makeContext());
    expect(result.formulaId).toBe('F-BS-02');
    expect(result.formulaName).toBe('Scope Creep Indicator');
    expect(result.resultType).toBe('percentage');
  });

  it('scope creep is positive when burned > billed (MATTER_WITH_BUDGET)', () => {
    const result = scopeCreepIndicator.execute(makeContext());
    const r = result.entityResults['mat-001'];
    expect(r).toBeDefined();
    // burnPercent = 10000/20000 = 50%; billingProgress = 6000/20000 = 30%
    // scopeCreep = 50 - 30 = 20
    expect(r.value).toBeCloseTo(20, 1);
  });

  it('breakdown includes budgetBurnPercent and billingProgressPercent', () => {
    const result = scopeCreepIndicator.execute(makeContext());
    const bd = result.entityResults['mat-001']?.breakdown;
    expect(bd?.['budgetBurnPercent']).toBeCloseTo(50, 1);
    expect(bd?.['billingProgressPercent']).toBeCloseTo(30, 1);
  });

  it('interpretation is "High scope creep risk" for creep > 20', () => {
    // burn = 120%, billing = 5500/5000 = 110% → creep = 10
    const result = scopeCreepIndicator.execute(makeContext());
    // mat-002: burn = 6000/5000 = 120%, billing = 5500/5000 = 110% → creep = 10
    const r = result.entityResults['mat-002'];
expect(r.breakdown?.['interpretation']).toBe('Moderate scope creep');
  });

  it('interpretation is "Moderate scope creep" when creep between 10-20', () => {
    const result = scopeCreepIndicator.execute(makeContext());
    const r = result.entityResults['mat-001'];
    // creep = 20 → 'High scope creep risk' (> 20 threshold is exclusive)
    expect(r.breakdown?.['interpretation']).toBe('High scope creep risk');
  });

  it('returns null for matter with no budget', () => {
    const result = scopeCreepIndicator.execute(makeContext());
    expect(result.entityResults['mat-003']?.value).toBeNull();
    expect(result.entityResults['mat-003']?.nullReason).toMatch(/no budget set/i);
  });

  it('uses F-BS-01 results when pre-computed in formulaResults', () => {
    const contextWithBurnResults = makeContext({
      formulaResults: {
        'F-BS-01': {
          formulaId: 'F-BS-01',
          formulaName: 'Budget Burn Rate',
          variantUsed: 'by_value',
          resultType: 'percentage',
          entityResults: {
            'mat-001': {
              entityId: 'mat-001',
              entityName: '1001',
              value: 75, // override: 75% burn rate
              formattedValue: '75.0%',
              nullReason: null,
            },
          },
          summary: { mean: 75, median: 75, min: 75, max: 75, total: 75, count: 1, nullCount: 0 },
          computedAt: new Date().toISOString(),
          metadata: { executionTimeMs: 1, inputsUsed: [], nullReasons: [], warnings: [] },
        },
      },
    });
    const result = scopeCreepIndicator.execute(contextWithBurnResults);
    const r = result.entityResults['mat-001'];
    // Should use the pre-computed burn = 75%; billing = 30% → creep = 45%
    expect(r.value).toBeCloseTo(45, 1);
  });
});
