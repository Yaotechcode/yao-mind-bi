import { describe, it, expect } from 'vitest';
import {
  availableWorkingHours,
  employmentCostAnnual,
  firmRetainAmount,
  firmRetainAmountHelper,
  fullyLoadedCostRate,
  costRateByPayModel,
} from '../../../../src/server/formula-engine/snippets/built-in-snippets.js';
import { SnippetEngine } from '../../../../src/server/formula-engine/snippets/snippet-engine.js';
import { registerAllBuiltInSnippets } from '../../../../src/server/formula-engine/snippets/index.js';
import { getBuiltInSnippetDefinitions } from '../../../../src/shared/formulas/built-in-snippets.js';
import type { SnippetContext } from '../../../../src/server/formula-engine/types.js';
import type { AggregatedFeeEarner } from '../../../../src/shared/types/pipeline.js';
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
  defaultFeeSharePercent: 60,
  defaultFirmRetainPercent: 40,
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

// ---------------------------------------------------------------------------
// Fee earner helpers
// ---------------------------------------------------------------------------

function makeBaseFeeEarner(
  lawyerId: string,
  lawyerName: string,
): AggregatedFeeEarner {
  return {
    lawyerId,
    lawyerName,
    wipTotalHours: 100,
    wipChargeableHours: 80,
    wipNonChargeableHours: 20,
    wipChargeableValue: 40000,
    wipTotalValue: 44000,
    wipWriteOffValue: 2000,
    wipMatterCount: 5,
    wipOrphanedHours: 0,
    wipOrphanedValue: 0,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipEntryCount: 200,
    recordingGapDays: 2,
    invoicedRevenue: 35000,
    invoicedOutstanding: 5000,
    invoicedCount: 8,
  } as AggregatedFeeEarner;
}

/**
 * Salaried: salary £70k, NI £500/mo, pension £300/mo, variable £200/mo
 * totalAnnualCost = 70000 + (500+300+200)×12 = 70000 + 12000 = 82000
 * availableHours (defaults) = (52×5 - 25 - 8) × (37.5/5) = 227 × 7.5 = 1702.5
 * SN-001 = 82000 / 1702.5 ≈ 48.17
 * SN-004 = 82000
 * SN-005 fully_loaded ≈ 48.17
 * SN-005 direct = 70000 / 1702.5 ≈ 41.12
 */
const SALARIED_FE: AggregatedFeeEarner = {
  ...makeBaseFeeEarner('L001', 'Alice'),
  ...({
    payModel: 'Salaried',
    annualSalary: 70000,
    monthlyEmployerNI: 500,
    monthlyPension: 300,
    monthlyVariablePay: 200,
  } as object),
} as AggregatedFeeEarner;

/**
 * Fee share: billing rate £300/hr, 60% to fee earner, 40% to firm
 * SN-001 = null
 * SN-004 = null
 * SN-005 = 300 × 60/100 = 180 (cost to firm = earner's 60% share)
 * firmRetainAmountHelper(1000) = 1000 × 40/100 = 400
 */
const FEE_SHARE_FE: AggregatedFeeEarner = {
  ...makeBaseFeeEarner('L002', 'Bob'),
  ...({
    payModel: 'FeeShare',
    rate: 300,
    feeSharePercent: 60,
  } as object),
} as AggregatedFeeEarner;

/**
 * Salaried but no salary data → SN-001 and SN-004 return null.
 */
const NO_SALARY_FE: AggregatedFeeEarner = {
  ...makeBaseFeeEarner('L003', 'Carol'),
  ...({ payModel: 'Salaried' } as object),
} as AggregatedFeeEarner;

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeCtx(
  feeEarner: AggregatedFeeEarner,
  overrides: Partial<SnippetContext> = {},
): SnippetContext {
  return { feeEarner, firmConfig: FIRM_CONFIG, ...overrides };
}

// =============================================================================
// SN-002: Available Working Hours
// =============================================================================

describe('SN-002 availableWorkingHours', () => {
  it('returns correct snippetId', () => {
    const r = availableWorkingHours.execute(makeCtx(SALARIED_FE));
    expect(r.snippetId).toBe('SN-002');
  });

  it('computes correct hours with firm defaults: (52×5-25-8)×7.5 = 1702.5', () => {
    const r = availableWorkingHours.execute(makeCtx(SALARIED_FE));
    // totalWorkingDays = 52×5 - 25 - 8 = 227; dailyHours = 37.5/5 = 7.5
    expect(r.value).toBeCloseTo(1702.5, 2);
    expect(r.nullReason).toBeNull();
  });

  it('breakdown includes correct components', () => {
    const r = availableWorkingHours.execute(makeCtx(SALARIED_FE));
    const bd = r.breakdown as Record<string, unknown>;
    expect(bd['workingDaysPerWeek']).toBe(5);
    expect(bd['annualLeave']).toBe(25);
    expect(bd['bankHolidays']).toBe(8);
    expect(bd['targetWeeklyHours']).toBe(37.5);
    expect(bd['totalWorkingDays']).toBe(227);
    expect(bd['dailyHours']).toBe(7.5);
    expect(bd['availableHours']).toBeCloseTo(1702.5, 2);
  });

  it('uses firm defaults note in breakdown when no override', () => {
    const r = availableWorkingHours.execute(makeCtx(SALARIED_FE));
    expect((r.breakdown?.['sourceNote'] as string)).toContain('firm defaults');
  });

  it('applies fee earner override for workingDaysPerWeek=4', () => {
    // totalWorkingDays = (52×4) - 25 - 8 = 175; dailyHours = 37.5/4 = 9.375
    // availableHours = 175 × 9.375 = 1640.625
    const r = availableWorkingHours.execute(
      makeCtx(SALARIED_FE, { feeEarnerOverride: { workingDaysPerWeek: 4 } }),
    );
    expect(r.value).toBeCloseTo(1640.625, 2);
    expect((r.breakdown?.['sourceNote'] as string)).toContain('fee earner override');
  });

  it('produces a result for fee share earner too (SN-002 is not pay-model-gated)', () => {
    const r = availableWorkingHours.execute(makeCtx(FEE_SHARE_FE));
    expect(r.value).toBeCloseTo(1702.5, 2);
  });
});

// =============================================================================
// SN-004: Employment Cost (Annual)
// =============================================================================

describe('SN-004 employmentCostAnnual', () => {
  it('returns correct snippetId', () => {
    expect(employmentCostAnnual.execute(makeCtx(SALARIED_FE)).snippetId).toBe('SN-004');
  });

  it('computes 82000 for salaried: 70000 + (500+300+200)×12', () => {
    const r = employmentCostAnnual.execute(makeCtx(SALARIED_FE));
    expect(r.value).toBe(82000);
    expect(r.nullReason).toBeNull();
  });

  it('breakdown includes annualised components', () => {
    const bd = employmentCostAnnual.execute(makeCtx(SALARIED_FE)).breakdown as Record<string, unknown>;
    expect(bd['annualSalary']).toBe(70000);
    expect(bd['annualisedNI']).toBe(6000);
    expect(bd['annualisedPension']).toBe(3600);
    expect(bd['annualisedVariable']).toBe(2400);
    expect(bd['totalEmploymentCost']).toBe(82000);
  });

  it('returns null for fee share earner', () => {
    const r = employmentCostAnnual.execute(makeCtx(FEE_SHARE_FE));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/fee share/i);
  });

  it('returns null when salary data is missing', () => {
    const r = employmentCostAnnual.execute(makeCtx(NO_SALARY_FE));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/salary data not available/i);
  });

  it('treats missing NI/pension/variable as zero', () => {
    const noExtras: AggregatedFeeEarner = {
      ...makeBaseFeeEarner('L004', 'Dave'),
      ...({ payModel: 'Salaried', annualSalary: 50000 } as object),
    } as AggregatedFeeEarner;
    const r = employmentCostAnnual.execute(makeCtx(noExtras));
    expect(r.value).toBe(50000);
  });
});

// =============================================================================
// SN-001: Fully Loaded Cost Rate (via SnippetEngine for full chain)
// =============================================================================

describe('SN-001 fullyLoadedCostRate', () => {
  it('returns null for fee share earner', () => {
    const r = fullyLoadedCostRate.execute(makeCtx(FEE_SHARE_FE));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/fee share/i);
  });

  it('returns null when salary data is missing', () => {
    const r = fullyLoadedCostRate.execute(makeCtx(NO_SALARY_FE));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/salary data not available/i);
  });

  it('returns null when SN-002 result is not available', () => {
    // No priorSnippetResults → availableHours unknown
    const r = fullyLoadedCostRate.execute(makeCtx(SALARIED_FE));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/available hours unknown/i);
  });

  it('computes correct rate when SN-002 is provided via priorSnippetResults', () => {
    // Inject SN-002 result (1702.5 hours) manually
    const r = fullyLoadedCostRate.execute(
      makeCtx(SALARIED_FE, {
        priorSnippetResults: {
          'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
        },
      }),
    );
    // 82000 / 1702.5 ≈ 48.17
    expect(r.value).toBeCloseTo(82000 / 1702.5, 2);
    expect(r.nullReason).toBeNull();
  });

  it('breakdown includes totalAnnualCost, availableHours, hourlyRate', () => {
    const r = fullyLoadedCostRate.execute(
      makeCtx(SALARIED_FE, {
        priorSnippetResults: {
          'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
        },
      }),
    );
    const bd = r.breakdown as Record<string, unknown>;
    expect(bd['totalAnnualCost']).toBe(82000);
    expect(bd['availableHours']).toBe(1702.5);
    expect(bd['hourlyRate']).toBeCloseTo(82000 / 1702.5, 2);
  });
});

// =============================================================================
// SN-005: Cost Rate by Pay Model (via SnippetEngine for full chain)
// =============================================================================

describe('SN-005 costRateByPayModel', () => {
  it('returns null when payModel not set', () => {
    const noPayModel = makeBaseFeeEarner('L099', 'Unknown') as AggregatedFeeEarner;
    const r = costRateByPayModel.execute(makeCtx(noPayModel));
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/pay model not set/i);
  });

  it('fee share: billingRate × feeSharePercent / 100 = 300 × 60% = 180', () => {
    const r = costRateByPayModel.execute(makeCtx(FEE_SHARE_FE));
    expect(r.value).toBeCloseTo(180, 2);
    expect((r.breakdown?.['method'] as string)).toBe('fee_share');
    expect(r.breakdown?.['feeSharePercent']).toBe(60);
  });

  it('salaried fully_loaded: matches SN-001 result', () => {
    const sn001Rate = 82000 / 1702.5;
    const r = costRateByPayModel.execute(
      makeCtx(SALARIED_FE, {
        priorSnippetResults: {
          'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
          'SN-001': { snippetId: 'SN-001', entityId: 'L001', value: sn001Rate, nullReason: null },
        },
      }),
    );
    expect(r.value).toBeCloseTo(sn001Rate, 4);
    expect(r.breakdown?.['method']).toBe('fully_loaded');
  });

  it('salaried direct: annualSalary / availableHours = 70000 / 1702.5', () => {
    const directConfig: FirmConfig = { ...FIRM_CONFIG, costRateMethod: 'direct' };
    const r = costRateByPayModel.execute(
      makeCtx(
        { ...SALARIED_FE } as AggregatedFeeEarner,
        {
          firmConfig: directConfig,
          priorSnippetResults: {
            'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
          },
        },
      ),
    );
    // 70000 / 1702.5 ≈ 41.12
    expect(r.value).toBeCloseTo(70000 / 1702.5, 2);
    expect(r.breakdown?.['method']).toBe('direct');
  });

  it('salaried direct is lower than fully_loaded (no NI/pension)', () => {
    const directConfig: FirmConfig = { ...FIRM_CONFIG, costRateMethod: 'direct' };
    const directR = costRateByPayModel.execute(
      makeCtx(SALARIED_FE, {
        firmConfig: directConfig,
        priorSnippetResults: {
          'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
        },
      }),
    );
    const sn001Rate = 82000 / 1702.5;
    const fullyLoadedR = costRateByPayModel.execute(
      makeCtx(SALARIED_FE, {
        priorSnippetResults: {
          'SN-002': { snippetId: 'SN-002', entityId: 'L001', value: 1702.5, nullReason: null },
          'SN-001': { snippetId: 'SN-001', entityId: 'L001', value: sn001Rate, nullReason: null },
        },
      }),
    );
    expect(directR.value!).toBeLessThan(fullyLoadedR.value!);
  });

  it('salaried returns null when no prior SN-001 result (fully_loaded)', () => {
    const r = costRateByPayModel.execute(makeCtx(SALARIED_FE));
    expect(r.value).toBeNull();
  });
});

// =============================================================================
// SN-003: Firm Retain Amount (modifier helper)
// =============================================================================

describe('SN-003 firmRetainAmountHelper', () => {
  it('salaried: returns full amount (100% retained by firm)', () => {
    const result = firmRetainAmountHelper(1000, SALARIED_FE, FIRM_CONFIG);
    expect(result).toBe(1000);
  });

  it('fee share: returns firmRetainPercent% of amount (40% of 1000 = 400)', () => {
    // FIRM_CONFIG.defaultFirmRetainPercent = 40
    const result = firmRetainAmountHelper(1000, FEE_SHARE_FE, FIRM_CONFIG);
    expect(result).toBe(400);
  });

  it('uses firmLeadPercent on fee earner when set', () => {
    const customFE: AggregatedFeeEarner = {
      ...FEE_SHARE_FE,
      ...({ firmLeadPercent: 50 } as object),
    } as AggregatedFeeEarner;
    const result = firmRetainAmountHelper(1000, customFE, FIRM_CONFIG);
    expect(result).toBe(500); // 50% of 1000
  });

  it('returns null when payModel is missing', () => {
    const noModel = makeBaseFeeEarner('L099', 'Unknown') as AggregatedFeeEarner;
    const result = firmRetainAmountHelper(1000, noModel, FIRM_CONFIG);
    expect(result).toBeNull();
  });

  it('SN-003 batch execute is a no-op (returns null with note)', () => {
    const r = firmRetainAmount.execute(makeCtx(FEE_SHARE_FE));
    expect(r.snippetId).toBe('SN-003');
    expect(r.value).toBeNull();
    expect(r.nullReason).toMatch(/modifier/i);
  });
});

// =============================================================================
// SnippetEngine integration — full dependency chain
// =============================================================================

describe('SnippetEngine.executeAll — full dependency chain', () => {
  function buildEngine(): SnippetEngine {
    const engine = new SnippetEngine();
    registerAllBuiltInSnippets(engine);
    return engine;
  }

  it('SN-002 runs for all fee earners', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE, FEE_SHARE_FE],
      FIRM_CONFIG,
      {},
    );
    expect(result.results['SN-002']?.['L001']?.value).toBeCloseTo(1702.5, 2);
    expect(result.results['SN-002']?.['L002']?.value).toBeCloseTo(1702.5, 2);
  });

  it('SN-001 uses SN-002 result via dependency chain', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE],
      FIRM_CONFIG,
      {},
    );
    // 82000 / 1702.5 ≈ 48.17
    expect(result.results['SN-001']?.['L001']?.value).toBeCloseTo(82000 / 1702.5, 2);
  });

  it('SN-001 returns null for fee share earner even in full chain', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [FEE_SHARE_FE],
      FIRM_CONFIG,
      {},
    );
    expect(result.results['SN-001']?.['L002']?.value).toBeNull();
  });

  it('SN-005 salaried fully_loaded matches SN-001 result', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE],
      FIRM_CONFIG,
      {},
    );
    const sn001 = result.results['SN-001']?.['L001']?.value;
    const sn005 = result.results['SN-005']?.['L001']?.value;
    expect(sn005).not.toBeNull();
    expect(sn005).toBeCloseTo(sn001!, 4);
  });

  it('SN-005 fee share = 300 × 60% = 180', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [FEE_SHARE_FE],
      FIRM_CONFIG,
      {},
    );
    expect(result.results['SN-005']?.['L002']?.value).toBeCloseTo(180, 2);
  });

  it('SN-004 annual cost salaried = 82000', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE],
      FIRM_CONFIG,
      {},
    );
    expect(result.results['SN-004']?.['L001']?.value).toBe(82000);
  });

  it('applies fee earner override for SN-002 (4 days/week)', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE],
      FIRM_CONFIG,
      { L001: { workingDaysPerWeek: 4 } },
    );
    // (52×4 - 25 - 8) × (37.5/4) = 175 × 9.375 = 1640.625
    expect(result.results['SN-002']?.['L001']?.value).toBeCloseTo(1640.625, 2);
  });

  it('SN-001 salaried with 4-day override uses the overridden available hours', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE],
      FIRM_CONFIG,
      { L001: { workingDaysPerWeek: 4 } },
    );
    // 82000 / 1640.625 ≈ 49.98
    expect(result.results['SN-001']?.['L001']?.value).toBeCloseTo(82000 / 1640.625, 2);
  });

  it('no errors for normal inputs', () => {
    const engine = buildEngine();
    const result = engine.executeAll(
      getBuiltInSnippetDefinitions(),
      [SALARIED_FE, FEE_SHARE_FE, NO_SALARY_FE],
      FIRM_CONFIG,
      {},
    );
    expect(result.errors).toHaveLength(0);
  });
});
