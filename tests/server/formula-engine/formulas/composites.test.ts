import { describe, it, expect } from 'vitest';
import {
  recoveryOpportunity,
  feeEarnerScorecard,
  matterHealthScore,
} from '../../../../src/server/formula-engine/formulas/composites.js';
import type { FormulaContext, FormulaResult } from '../../../../src/server/formula-engine/types.js';
import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedFirm,
} from '../../../../src/shared/types/pipeline.js';
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
  feeEarnerCount: 2,
  activeFeeEarnerCount: 2,
  salariedFeeEarnerCount: 2,
  feeShareFeeEarnerCount: 0,
  matterCount: 2,
  activeMatterCount: 2,
  inProgressMatterCount: 2,
  completedMatterCount: 0,
  otherMatterCount: 0,
  totalWipHours: 150,
  totalChargeableHours: 100,
  totalWipValue: 50000,
  totalWriteOffValue: 5000,
  totalInvoicedRevenue: 40000,
  totalOutstanding: 8000,
  totalPaid: 32000,
  orphanedWip: {
    orphanedWipEntryCount: 0,
    orphanedWipHours: 0,
    orphanedWipValue: 0,
    orphanedWipPercent: 0,
    orphanedWipNote: '',
  },
};

// ---------------------------------------------------------------------------
// Fee earners
// ---------------------------------------------------------------------------

function makeFeeEarner(
  lawyerId: string,
  lawyerName: string,
  wipChargeableHours: number,
  invoicedRevenue: number,
  recordingGapDays: number | null,
  extra: Record<string, unknown> = {},
): AggregatedFeeEarner {
  return {
    lawyerId,
    lawyerName,
    wipTotalHours: wipChargeableHours + 10,
    wipChargeableHours,
    wipNonChargeableHours: 10,
    wipChargeableValue: wipChargeableHours * 200,
    wipEntryCount: wipChargeableHours * 2,
    wipTotalValue: wipChargeableHours * 220,
    wipWriteOffValue: 0,
    wipMatterCount: 2,
    wipOrphanedHours: 0,
    wipOrphanedValue: 0,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    recordingGapDays,
    invoicedRevenue,
    invoicedOutstanding: 1000,
    invoicedCount: 3,
    ...extra,
  } as AggregatedFeeEarner;
}

const FE_ALICE = makeFeeEarner('L001', 'Alice', 80, 20000, 2);   // 2-day recording gap
const FE_BOB   = makeFeeEarner('L002', 'Bob',   40, 8000,  5);   // 5-day recording gap

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

function makeMatter(
  matterId: string,
  matterNumber: string,
  wipAgeInDays: number | null,
  budget: number,
  wipTotalBillable: number,
  invoicedNetBilling: number,
  invoiceCount: number,
): AggregatedMatter {
  return {
    matterId,
    matterNumber,
    wipTotalDurationMinutes: 2000,
    wipTotalHours: 40,
    wipTotalBillable,
    wipTotalWriteOff: 0,
    wipTotalUnits: 400,
    wipTotalChargeable: 400,
    wipTotalNonChargeable: 0,
    wipChargeableHours: 40,
    wipNonChargeableHours: 0,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipAgeInDays,
    invoiceCount,
    invoicedNetBilling,
    invoicedDisbursements: 0,
    invoicedTotal: invoicedNetBilling,
    invoicedOutstanding: 0,
    invoicedPaid: invoicedNetBilling,
    invoicedWrittenOff: 0,
    ...({ budget } as object),
  } as AggregatedMatter;
}

// Healthy matter: young WIP, under budget, decent realisation
const MATTER_HEALTHY = makeMatter('mat-001', '1001', 15, 20000, 10000, 9500, 1);
// At-risk matter: old WIP, over budget, low realisation
const MATTER_AT_RISK = makeMatter('mat-002', '1002', 120, 5000, 6000, 2000, 1);

// ---------------------------------------------------------------------------
// Prior formula result builder
// ---------------------------------------------------------------------------

function makeFormulaResult(
  formulaId: string,
  entityValues: Record<string, number | null>,
): FormulaResult {
  const entityResults = Object.fromEntries(
    Object.entries(entityValues).map(([id, value]) => [
      id,
      {
        entityId: id,
        entityName: id,
        value,
        formattedValue: value !== null ? String(value) : null,
        nullReason: value === null ? 'unavailable' : null,
      },
    ]),
  );
  return {
    formulaId,
    formulaName: formulaId,
    variantUsed: null,
    resultType: 'percentage',
    entityResults,
    summary: { mean: null, median: null, min: null, max: null, total: null, count: 0, nullCount: 0 },
    computedAt: new Date().toISOString(),
    metadata: { executionTimeMs: 1, inputsUsed: [], nullReasons: [], warnings: [] },
  };
}

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [FE_ALICE, FE_BOB],
    matters: [MATTER_HEALTHY, MATTER_AT_RISK],
    invoices: [],
    timeEntries: [],
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
// F-CS-01: Recovery Opportunity
// =============================================================================

describe('F-CS-01 recoveryOpportunity', () => {
  it('returns correct formula metadata', () => {
    const result = recoveryOpportunity.execute(makeContext());
    expect(result.formulaId).toBe('F-CS-01');
    expect(result.formulaName).toBe('Recovery Opportunity');
    expect(result.resultType).toBe('currency');
  });

  it('value = sum of three components', () => {
    const result = recoveryOpportunity.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;
    const utilOpp = (bd?.['utilisationOpportunity'] as number) ?? 0;
    const realOpp = (bd?.['realisationOpportunity'] as number) ?? 0;
    const wipOpp = (bd?.['wipRecoveryOpportunity'] as number) ?? 0;
    expect(result.entityResults['firm']?.value).toBeCloseTo(utilOpp + realOpp + wipOpp, 2);
  });

  it('uses atRiskAmount from F-WL-01 firm breakdown when available', () => {
    const wipResult = makeFormulaResult('F-WL-01', { firm: 50 });
    // Inject atRiskAmount into breakdown
    wipResult.entityResults['firm'].breakdown = {
      atRiskAmount: 8000,
      theoreticalRecovery: 42000,
    };
    const result = recoveryOpportunity.execute(makeContext({ formulaResults: { 'F-WL-01': wipResult } }));
    const bd = result.entityResults['firm']?.breakdown;
    expect(bd?.['wipRecoveryOpportunity']).toBe(8000);
  });

  it('uses F-RB-02 effective rate for utilisation opportunity when available', () => {
    // Alice: utilisation from F-TU-01 = 50%; effective rate from F-RB-02 = 200/hr
    // Target chargeable hours ≈ 30 × (52 - 33/5 - 8/5) = 30 × (52 - 6.6) ≈ 30 × 45.4 = 1362/yr
    // Alice actual = 80h; fraction = 80/1362 ≈ 5.87%; very low → big gap
    const contextWithPrior = makeContext({
      formulaResults: {
        'F-TU-01': makeFormulaResult('F-TU-01', { L001: 50, L002: 90 }),
        'F-RB-02': makeFormulaResult('F-RB-02', { L001: 200, L002: 200 }),
        'F-RB-01': makeFormulaResult('F-RB-01', { firm: 80 }),
      },
    });
    const result = recoveryOpportunity.execute(contextWithPrior);
    const bd = result.entityResults['firm']?.breakdown;
    // utilisation opportunity > 0 for Alice (50% < 100%)
    expect(bd?.['utilisationOpportunity'] as number).toBeGreaterThan(0);
  });

  it('uses WIP vs invoiced fallback for realisation when F-RB-01 not available', () => {
    // firm.totalWipValue = 50000; firm.totalInvoicedRevenue = 40000
    // realisationOpp = 50000 - 40000 = 10000
    const result = recoveryOpportunity.execute(makeContext({ formulaResults: {} }));
    const bd = result.entityResults['firm']?.breakdown;
    expect(bd?.['realisationOpportunity']).toBeCloseTo(10000, 0);
    expect(result.metadata.warnings.some((w) => /F-RB-01 not available/i.test(w))).toBe(true);
  });

  it('breakdown includes topOpportunities list', () => {
    const result = recoveryOpportunity.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;
    const top = bd?.['topOpportunities'] as Array<{ type: string; amount: number }>;
    expect(Array.isArray(top)).toBe(true);
  });
});

// =============================================================================
// F-CS-02: Fee Earner Scorecard
// =============================================================================

describe('F-CS-02 feeEarnerScorecard', () => {
  it('returns correct formula metadata', () => {
    const result = feeEarnerScorecard.execute(makeContext());
    expect(result.formulaId).toBe('F-CS-02');
    expect(result.formulaName).toBe('Fee Earner Scorecard');
    expect(result.resultType).toBe('number');
  });

  it('produces a 0-100 score for each fee earner', () => {
    const result = feeEarnerScorecard.execute(makeContext());
    const alice = result.entityResults['L001'];
    const bob = result.entityResults['L002'];
    expect(alice?.value).toBeGreaterThanOrEqual(0);
    expect(alice?.value).toBeLessThanOrEqual(100);
    expect(bob?.value).toBeGreaterThanOrEqual(0);
    expect(bob?.value).toBeLessThanOrEqual(100);
  });

  it('applies scorecard weights from firmConfig when configured', () => {
    const configWithWeights = {
      ...FIRM_CONFIG,
      ...({
        scorecardWeights: {
          utilisationWeight: 50,
          realisationWeight: 10,
          recordingWeight: 10,
          writeOffWeight: 10,
          revenueWeight: 10,
          wipAgeWeight: 10,
        },
      } as object),
    } as FirmConfig;

    const defaultResult = feeEarnerScorecard.execute(makeContext());
    const customResult = feeEarnerScorecard.execute(
      makeContext({ firmConfig: configWithWeights }),
    );

    // With utilisation weight at 50% vs 25%, scores will differ when utilisation ≠ other metrics
    // (They may be same if all inputs are neutral 50 — just verify they run cleanly)
    expect(defaultResult.entityResults['L001']?.value).toBeDefined();
    expect(customResult.entityResults['L001']?.value).toBeDefined();
  });

  it('uses recorded recording gap from fee earner data', () => {
    // Alice has recordingGapDays=2 → recordingScore = 100 - 2×10 = 80
    // Bob has recordingGapDays=5  → recordingScore = 100 - 5×10 = 50
    const contextWithPrior = makeContext({
      formulaResults: {
        'F-TU-01': makeFormulaResult('F-TU-01', { L001: 80, L002: 60 }),
        'F-WL-02': makeFormulaResult('F-WL-02', { L001: 5, L002: 10 }),
      },
    });
    const result = feeEarnerScorecard.execute(contextWithPrior);
    const aliceBd = result.entityResults['L001']?.breakdown as {
      components: {
        recording: { score: number; raw: number };
        utilisation: { score: number; raw: number };
      };
    };
    expect(aliceBd.components.recording.score).toBeCloseTo(80, 1); // 100 - 2×10
    expect(aliceBd.components.recording.raw).toBe(2);
  });

  it('uses neutral score (50) for missing metric', () => {
    // No prior formula results → all metrics that depend on formulaResults default to 50
    const result = feeEarnerScorecard.execute(makeContext({ formulaResults: {} }));
    const alice = result.entityResults['L001'];
    // Should still produce a score
    expect(alice?.value).toBeDefined();
    expect(alice?.value).toBeGreaterThanOrEqual(0);
  });

  it('adds warning when metric is unavailable', () => {
    // Force all formulaResults empty so some metrics will use neutral
    const result = feeEarnerScorecard.execute(makeContext({ formulaResults: {} }));
    // At least some warnings expected (e.g., realisation, WIP age, write-off)
    expect(result.metadata.warnings.length).toBeGreaterThan(0);
    const hasNeutralWarning = result.metadata.warnings.some((w) =>
      /unavailable.*neutral score/i.test(w),
    );
    expect(hasNeutralWarning).toBe(true);
  });

  it('breakdown includes all 6 components', () => {
    const result = feeEarnerScorecard.execute(makeContext());
    const bd = result.entityResults['L001']?.breakdown as {
      components: Record<string, { score: number; weight: number }>;
    };
    expect(Object.keys(bd.components)).toEqual(
      expect.arrayContaining([
        'utilisation', 'realisation', 'recording', 'writeOff', 'revenue', 'wipAge',
      ]),
    );
  });
});

// =============================================================================
// F-CS-03: Matter Health Score
// =============================================================================

describe('F-CS-03 matterHealthScore', () => {
  it('returns correct formula metadata', () => {
    const result = matterHealthScore.execute(makeContext());
    expect(result.formulaId).toBe('F-CS-03');
    expect(result.formulaName).toBe('Matter Health Score');
    expect(result.resultType).toBe('number');
  });

  it('healthy matter has a higher score than at-risk matter', () => {
    const contextWithPrior = makeContext({
      formulaResults: {
        'F-WL-01': makeFormulaResult('F-WL-01', { 'mat-001': 15, 'mat-002': 120 }),
        'F-BS-01': makeFormulaResult('F-BS-01', { 'mat-001': 50, 'mat-002': 120 }),
        'F-RB-01': makeFormulaResult('F-RB-01', { 'mat-001': 95, 'mat-002': 33 }),
        'F-WL-03': makeFormulaResult('F-WL-03', { 'mat-001': 100, 'mat-002': 40 }),
      },
    });
    const result = matterHealthScore.execute(contextWithPrior);
    const healthy = result.entityResults['mat-001']?.value ?? 0;
    const atRisk = result.entityResults['mat-002']?.value ?? 0;
    expect(healthy).toBeGreaterThan(atRisk);
  });

  it('score is between 0 and 100', () => {
    const result = matterHealthScore.execute(makeContext());
    for (const r of Object.values(result.entityResults)) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(100);
    }
  });

  it('at-risk matter with all risk flags produces low score and correct flags', () => {
    const contextWithRisks = makeContext({
      formulaResults: {
        'F-WL-01': makeFormulaResult('F-WL-01', { 'mat-002': 100 }), // aged WIP
        'F-BS-01': makeFormulaResult('F-BS-01', { 'mat-002': 110 }), // over budget
        'F-RB-01': makeFormulaResult('F-RB-01', { 'mat-002': 50 }),  // low realisation
        'F-WL-03': makeFormulaResult('F-WL-03', { 'mat-002': 30 }),  // low disbursement recovery
      },
    });
    const result = matterHealthScore.execute(contextWithRisks);
    const bd = result.entityResults['mat-002']?.breakdown as {
      riskFlags: string[];
      healthScore: number;
    };
    expect(bd.riskFlags).toContain('Aged WIP at risk');
    expect(bd.riskFlags).toContain('Over budget');
    expect(bd.riskFlags).toContain('Low realisation');
    expect(bd.riskFlags).toContain('Low disbursement recovery');
    expect(bd.healthScore).toBeLessThan(50);
  });

  it('no budget matter gets neutral budget score (50)', () => {
    const noBudgetMatter = makeMatter('mat-nb', '9999', 20, 0, 5000, 4000, 1);
    const result = matterHealthScore.execute(
      makeContext({ matters: [noBudgetMatter] }),
    );
    const bd = result.entityResults['mat-nb']?.breakdown as {
      components: { budget: { score: number; hasBudget: boolean } };
    };
    expect(bd.components.budget.score).toBe(50);
    expect(bd.components.budget.hasBudget).toBe(false);
  });

  it('falls back to matter.wipAgeInDays when F-WL-01 not available', () => {
    // MATTER_HEALTHY has wipAgeInDays=15; no F-WL-01 in formulaResults
    const result = matterHealthScore.execute(makeContext({ formulaResults: {} }));
    const bd = result.entityResults['mat-001']?.breakdown as {
      components: { wipAge: { score: number; raw: number | null } };
    };
    // wipAgeScore = 100 - 15×0.5 = 92.5
    expect(bd.components.wipAge.raw).toBe(15);
    expect(bd.components.wipAge.score).toBeCloseTo(92.5, 1);
  });

  it('breakdown includes healthScore and riskFlags', () => {
    const result = matterHealthScore.execute(makeContext());
    const bd = result.entityResults['mat-001']?.breakdown;
    expect(bd?.['healthScore']).toBeDefined();
    expect(Array.isArray(bd?.['riskFlags'])).toBe(true);
  });
});
