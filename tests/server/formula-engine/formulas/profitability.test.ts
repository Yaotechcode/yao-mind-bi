import { describe, it, expect } from 'vitest';
import {
  matterProfitability,
  feeEarnerProfitability,
  departmentProfitability,
  clientProfitability,
  firmProfitability,
} from '../../../../src/server/formula-engine/formulas/profitability.js';
import type { FormulaContext, SnippetResult } from '../../../../src/server/formula-engine/types.js';
import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedFirm,
  AggregatedClient,
  AggregatedDepartment,
} from '../../../../src/shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedDisbursement } from '../../../../src/shared/types/enriched.js';
import type { FirmConfig } from '../../../../src/shared/types/index.js';

// =============================================================================
// Test data
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
  defaultFeeSharePercent: 40,   // 40% lawyer share by default
  defaultFirmRetainPercent: 60,
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
  matterCount: 3,
  activeMatterCount: 3,
  inProgressMatterCount: 3,
  completedMatterCount: 0,
  otherMatterCount: 0,
  totalWipHours: 170,
  totalChargeableHours: 140,
  totalWipValue: 60000,
  totalWriteOffValue: 0,
  totalInvoicedRevenue: 37000,   // 25000+6000+6000
  totalOutstanding: 5000,
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
  invoicedRevenue: number,
  extra: Record<string, unknown> = {},
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
    wipMatterCount: 0,
    wipOrphanedHours: 0,
    wipOrphanedValue: 0,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    recordingGapDays: null,
    invoicedRevenue,
    invoicedOutstanding: 0,
    invoicedCount: 0,
    ...extra,
  } as AggregatedFeeEarner;
}

/**
 * Alice (Salaried): £50/hr cost rate (SN-005), £60,000/yr employment cost (SN-004)
 * Revenue attributed: £25,000
 */
const FE_ALICE = makeFeeEarner('L001', 'Alice Salaried', 25000, {
  payModel: 'Salaried',
  department: 'Corporate',
});

/**
 * Bob (Salaried): £37.50/hr cost rate (SN-005), £45,000/yr (SN-004)
 * Revenue: £6,000
 */
const FE_BOB = makeFeeEarner('L002', 'Bob Salaried', 6000, {
  payModel: 'Salaried',
  department: 'Private Client',
});

/**
 * Charlie (FeeShare 60%): £150/hr cost rate (SN-005 = rate×feeShare = 250×0.60)
 * Revenue: £6,000 gross (lawyer gets 60%, firm keeps 40%)
 * feeSharePercent=60 means the lawyer takes 60%, firm retains 40%
 */
const FE_CHARLIE = makeFeeEarner('L003', 'Charlie FeeShare', 6000, {
  payModel: 'FeeShare',
  feeSharePercent: 60,
  department: 'Corporate',
});

// ---------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------

/**
 * MATTER_1 (Corporate, Acme Ltd): Alice + Charlie each 50h
 * Revenue = £25,000 (2 invoices)
 * Standard cost: Alice 50h×£50=2500, Charlie 50h×£150=7500 → total=10000
 * Profit = 25000 - 10000 = 15000, Margin = 60%
 */
const MATTER_1: AggregatedMatter = {
  matterId: 'mat-001',
  matterNumber: '1001',
  wipTotalDurationMinutes: 6000,
  wipTotalHours: 100,
  wipTotalBillable: 25000,
  wipTotalWriteOff: 0,
  wipTotalUnits: 1000,
  wipTotalChargeable: 1000,
  wipTotalNonChargeable: 0,
  wipChargeableHours: 100,
  wipNonChargeableHours: 0,
  wipOldestEntryDate: null,
  wipNewestEntryDate: null,
  wipAgeInDays: 30,
  invoiceCount: 2,
  invoicedNetBilling: 25000,
  invoicedDisbursements: 0,
  invoicedTotal: 25000,
  invoicedOutstanding: 3000,
  invoicedPaid: 22000,
  invoicedWrittenOff: 0,
  ...({ department: 'Corporate', clientName: 'Acme Ltd' } as object),
} as AggregatedMatter;

/**
 * MATTER_2 (Private Client, Jones Family): Bob 40h
 * Revenue = £6,000 (1 invoice)
 * Standard cost: Bob 40h×£37.50=1500
 * Profit = 6000 - 1500 = 4500, Margin = 75%
 */
const MATTER_2: AggregatedMatter = {
  matterId: 'mat-002',
  matterNumber: '1002',
  wipTotalDurationMinutes: 2400,
  wipTotalHours: 40,
  wipTotalBillable: 6000,
  wipTotalWriteOff: 0,
  wipTotalUnits: 400,
  wipTotalChargeable: 400,
  wipTotalNonChargeable: 0,
  wipChargeableHours: 40,
  wipNonChargeableHours: 0,
  wipOldestEntryDate: null,
  wipNewestEntryDate: null,
  wipAgeInDays: 20,
  invoiceCount: 1,
  invoicedNetBilling: 6000,
  invoicedDisbursements: 0,
  invoicedTotal: 6000,
  invoicedOutstanding: 0,
  invoicedPaid: 6000,
  invoicedWrittenOff: 0,
  ...({ department: 'Private Client', clientName: 'Jones Family' } as object),
} as AggregatedMatter;

/**
 * MATTER_3 (Corporate, Acme Ltd): Alice 30h, no invoices yet
 * Revenue = wipTotalBillable = £6,000 (invoiceCount=0)
 * Standard cost: Alice 30h×£50=1500
 * Profit = 6000 - 1500 = 4500, Margin = 75%
 */
const MATTER_3: AggregatedMatter = {
  matterId: 'mat-003',
  matterNumber: '1003',
  wipTotalDurationMinutes: 1800,
  wipTotalHours: 30,
  wipTotalBillable: 6000,
  wipTotalWriteOff: 0,
  wipTotalUnits: 300,
  wipTotalChargeable: 300,
  wipTotalNonChargeable: 0,
  wipChargeableHours: 30,
  wipNonChargeableHours: 0,
  wipOldestEntryDate: null,
  wipNewestEntryDate: null,
  wipAgeInDays: 15,
  invoiceCount: 0,
  invoicedNetBilling: 0,
  invoicedDisbursements: 0,
  invoicedTotal: 0,
  invoicedOutstanding: 0,
  invoicedPaid: 0,
  invoicedWrittenOff: 0,
  ...({ department: 'Corporate', clientName: 'Acme Ltd' } as object),
} as AggregatedMatter;

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

function makeEntry(
  matterId: string,
  lawyerId: string,
  lawyerName: string,
  durationHours: number,
): EnrichedTimeEntry {
  return {
    entityType: 'timeEntry',
    matterId,
    lawyerId,
    hasMatchedMatter: true,
    durationHours,
    isChargeable: true,
    ageInDays: 20,
    ...({ billableValue: durationHours * 250, writeOffValue: 0, lawyerName } as object),
  } as EnrichedTimeEntry;
}

// Matter 1: Alice (50h) + Charlie (50h)
const ENTRIES_M1_ALICE = makeEntry('mat-001', 'L001', 'Alice Salaried', 50);
const ENTRIES_M1_CHARLIE = makeEntry('mat-001', 'L003', 'Charlie FeeShare', 50);

// Matter 2: Bob (40h)
const ENTRIES_M2_BOB = makeEntry('mat-002', 'L002', 'Bob Salaried', 40);

// Matter 3: Alice (30h)
const ENTRIES_M3_ALICE = makeEntry('mat-003', 'L001', 'Alice Salaried', 30);

// ---------------------------------------------------------------------------
// Departments and clients
// ---------------------------------------------------------------------------

const DEPT_CORPORATE: AggregatedDepartment = {
  name: 'Corporate',
  departmentId: 'dept-corp',
  feeEarnerCount: 2,
  activeFeeEarnerCount: 2,
  activeMatterCount: 2,
  totalMatterCount: 2,
  wipTotalHours: 130,
  wipChargeableHours: 130,
  wipChargeableValue: 31000,
  // Corporate revenue = MATTER_1 (25000) + MATTER_3 (6000 WIP) = 31000
  invoicedRevenue: 31000,
  invoicedOutstanding: 3000,
};

const DEPT_PRIVATE_CLIENT: AggregatedDepartment = {
  name: 'Private Client',
  departmentId: 'dept-pc',
  feeEarnerCount: 1,
  activeFeeEarnerCount: 1,
  activeMatterCount: 1,
  totalMatterCount: 1,
  wipTotalHours: 40,
  wipChargeableHours: 40,
  wipChargeableValue: 6000,
  invoicedRevenue: 6000,
  invoicedOutstanding: 0,
};

const CLIENT_ACME: AggregatedClient = {
  contactId: 'client-001',
  displayName: 'Acme Ltd',
  clientName: 'Acme Ltd',
  matterCount: 2,
  activeMatterCount: 2,
  closedMatterCount: 0,
  totalWipValue: 31000,
  totalInvoiced: 25000, // only M1 has invoices; M3 is unbilled
  totalOutstanding: 3000,
  totalPaid: 22000,
  oldestMatterDate: null,
};

const CLIENT_JONES: AggregatedClient = {
  contactId: 'client-002',
  displayName: 'Jones Family',
  clientName: 'Jones Family',
  matterCount: 1,
  activeMatterCount: 1,
  closedMatterCount: 0,
  totalWipValue: 6000,
  totalInvoiced: 6000,
  totalOutstanding: 0,
  totalPaid: 6000,
  oldestMatterDate: null,
};

// ---------------------------------------------------------------------------
// Snippet results (SN-004 employment costs, SN-005 cost rates)
// ---------------------------------------------------------------------------

function makeSnippet(snippetId: string, entityId: string, value: number): SnippetResult {
  return { snippetId, entityId, value, nullReason: null };
}

const SNIPPET_RESULTS = {
  'SN-004': {
    L001: makeSnippet('SN-004', 'L001', 60000), // Alice: £60k/yr
    L002: makeSnippet('SN-004', 'L002', 45000), // Bob: £45k/yr
    // Charlie (FeeShare) has no SN-004 — no employment cost to firm
  },
  'SN-005': {
    L001: makeSnippet('SN-005', 'L001', 50),   // Alice: £50/hr cost rate
    L002: makeSnippet('SN-005', 'L002', 37.5), // Bob: £37.50/hr cost rate
    L003: makeSnippet('SN-005', 'L003', 150),  // Charlie: £250 rate × 60% = £150/hr
  },
};

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [FE_ALICE, FE_BOB, FE_CHARLIE],
    matters: [MATTER_1, MATTER_2, MATTER_3],
    invoices: [],
    timeEntries: [
      ENTRIES_M1_ALICE,
      ENTRIES_M1_CHARLIE,
      ENTRIES_M2_BOB,
      ENTRIES_M3_ALICE,
    ],
    disbursements: [],
    departments: [DEPT_CORPORATE, DEPT_PRIVATE_CLIENT],
    clients: [CLIENT_ACME, CLIENT_JONES],
    firm: FIRM_AGG,
    firmConfig: FIRM_CONFIG,
    feeEarnerOverrides: {
      // Charlie's explicit FeeShare config
      L003: { payModel: 'FeeShare', feeSharePercent: 60, firmRetainPercent: 40 },
    },
    snippetResults: SNIPPET_RESULTS,
    formulaResults: {},
    referenceDate: new Date('2025-01-09T00:00:00.000Z'),
    ...overrides,
  };
}

// =============================================================================
// F-PR-01: Matter Profitability
// =============================================================================

describe('F-PR-01 matterProfitability', () => {
  it('returns correct formula metadata', () => {
    const result = matterProfitability.execute(makeContext());
    expect(result.formulaId).toBe('F-PR-01');
    expect(result.formulaName).toBe('Matter Profitability');
    expect(result.resultType).toBe('currency');
    expect(result.variantUsed).toBe('standard');
  });

  describe('simple variant (hours × avg cost rate)', () => {
    it('uses firm-wide average cost rate', () => {
      const result = matterProfitability.execute(makeContext(), 'simple');
      // Avg cost rate = (50 + 37.5 + 150) / 3 ≈ 79.17/hr
      const avgRate = (50 + 37.5 + 150) / 3;
      const m1 = result.entityResults['mat-001'];
      // Revenue = 25000, hours = 100
      // Cost = 100 × 79.17 ≈ 7916.67
      expect(m1?.value).toBeCloseTo(25000 - 100 * avgRate, 1);
    });

    it('handles zero snippet results gracefully', () => {
      const result = matterProfitability.execute(
        makeContext({ snippetResults: {} }),
        'simple',
      );
      // No cost rates → avg = 0 → profit = revenue
      expect(result.entityResults['mat-001']?.value).toBe(25000);
    });
  });

  describe('standard variant (per-earner cost rates)', () => {
    it('computes correct profit for MATTER_1 (Alice + Charlie)', () => {
      const result = matterProfitability.execute(makeContext());
      const r = result.entityResults['mat-001'];
      expect(r).toBeDefined();
      // Alice: 50h × £50 = 2500; Charlie: 50h × £150 = 7500; total = 10000
      // Revenue = 25000; Profit = 15000
      expect(r.value).toBeCloseTo(15000, 2);
    });

    it('computes correct profit for MATTER_2 (Bob only)', () => {
      const result = matterProfitability.execute(makeContext());
      const r = result.entityResults['mat-002'];
      // Bob: 40h × £37.50 = 1500; Revenue = 6000; Profit = 4500
      expect(r.value).toBeCloseTo(4500, 2);
    });

    it('uses wipTotalBillable as revenue when no invoices (MATTER_3)', () => {
      const result = matterProfitability.execute(makeContext());
      const r = result.entityResults['mat-003'];
      // Alice: 30h × £50 = 1500; Revenue = 6000 (WIP); Profit = 4500
      expect(r.value).toBeCloseTo(4500, 2);
      expect(r.breakdown?.['revenue']).toBe(6000); // uses wipTotalBillable
    });

    it('margin is correct for MATTER_1 (60%)', () => {
      const result = matterProfitability.execute(makeContext());
      const r = result.entityResults['mat-001'];
      expect(r.additionalValues?.['margin']).toBeCloseTo(60, 1);
    });

    it('fee share lawyer hours costed at feeShare rate (SN-005)', () => {
      // Charlie's cost rate = £150/hr (250 × 60%) not a salary rate
      const result = matterProfitability.execute(makeContext());
      const m1 = result.entityResults['mat-001'];
      // Standard: Alice 2500 + Charlie 7500 = 10000 total labour
      expect(m1?.breakdown?.['labourCost']).toBeCloseTo(10000, 2);
    });

    it('returns null when revenue = 0 and cost = 0', () => {
      const emptyMatter: AggregatedMatter = {
        ...MATTER_3,
        matterId: 'mat-empty',
        matterNumber: '9999',
        wipTotalBillable: 0,
        invoicedNetBilling: 0,
        invoiceCount: 0,
        wipTotalHours: 0,
      };
      const result = matterProfitability.execute(
        makeContext({ matters: [emptyMatter], timeEntries: [] }),
      );
      expect(result.entityResults['mat-empty']?.value).toBeNull();
      expect(result.entityResults['mat-empty']?.nullReason).toMatch(/no financial data/i);
    });

    it('profit is negative when cost > revenue', () => {
      const highCostMatter: AggregatedMatter = {
        ...MATTER_2,
        matterId: 'mat-loss',
        matterNumber: '9998',
        invoicedNetBilling: 500, // very low revenue
        invoiceCount: 1,
        wipTotalHours: 40,
      };
      const lossEntry = makeEntry('mat-loss', 'L002', 'Bob Salaried', 40);
      const result = matterProfitability.execute(
        makeContext({ matters: [highCostMatter], timeEntries: [lossEntry] }),
      );
      // Bob: 40h × £37.5 = 1500 cost; revenue = 500; profit = -1000
      expect(result.entityResults['mat-loss']?.value).toBeCloseTo(-1000, 2);
    });
  });

  describe('full variant (standard + overhead)', () => {
    it('deducts overhead allocation from profit', () => {
      const configWithOverhead = {
        ...FIRM_CONFIG,
        ...({ overheadRatePerHour: 10 } as object),
      } as FirmConfig;
      const result = matterProfitability.execute(
        makeContext({ firmConfig: configWithOverhead }),
        'full',
      );
      const r = result.entityResults['mat-001'];
      // Standard profit = 15000; overhead = 100h × £10 = 1000; full profit = 14000
      expect(r.value).toBeCloseTo(14000, 2);
      expect(r.breakdown?.['overheadAllocation']).toBeCloseTo(1000, 2);
    });

    it('full variant profit < standard variant profit', () => {
      const configWithOverhead = {
        ...FIRM_CONFIG,
        ...({ overheadRatePerHour: 5 } as object),
      } as FirmConfig;
      const standard = matterProfitability.execute(makeContext(), 'standard');
      const full = matterProfitability.execute(
        makeContext({ firmConfig: configWithOverhead }),
        'full',
      );
      expect(full.entityResults['mat-001']?.value!).toBeLessThan(
        standard.entityResults['mat-001']?.value!,
      );
    });
  });
});

// =============================================================================
// F-PR-02: Fee Earner Profitability
// =============================================================================

describe('F-PR-02 feeEarnerProfitability', () => {
  it('returns correct formula metadata', () => {
    const result = feeEarnerProfitability.execute(makeContext());
    expect(result.formulaId).toBe('F-PR-02');
    expect(result.formulaName).toBe('Fee Earner Profitability');
    expect(result.resultType).toBe('currency');
  });

  describe('Salaried (Alice, £60k/yr, £25k revenue)', () => {
    it('profit = revenue - employment cost', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L001'];
      // 25000 - 60000 = -35000
      expect(r.value).toBeCloseTo(-35000, 2);
    });

    it('ROI is correct', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L001'];
      // ROI = (-35000 / 60000) × 100 ≈ -58.33%
      expect(r.additionalValues?.['roi']).toBeCloseTo(-35000 / 60000 * 100, 1);
    });

    it('revenue multiple is correct', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L001'];
      // 25000 / 60000 ≈ 0.417
      expect(r.additionalValues?.['revenueMultiple']).toBeCloseTo(25000 / 60000, 3);
    });

    it('breakdown includes annualisedEmploymentCost', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const bd = result.entityResults['L001']?.breakdown;
      expect(bd?.['annualisedEmploymentCost']).toBe(60000);
      expect(bd?.['revenue']).toBe(25000);
    });
  });

  describe('FeeShare (Charlie, 60% to lawyer, 40% firm, £6k gross)', () => {
    it('value = firmNetProfit = firmRetain - overhead', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L003'];
      // firmRetain = 6000 × 0.40 = 2400; overheadCost = 0
      expect(r.value).toBeCloseTo(2400, 2);
    });

    it('additionalValues includes lawyerShare and firmRetain', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L003'];
      // lawyerShare = 6000 × 0.60 = 3600
      expect(r.additionalValues?.['lawyerShare']).toBeCloseTo(3600, 2);
      expect(r.additionalValues?.['firmRetain']).toBeCloseTo(2400, 2);
    });

    it('lawyerPerspectiveProfit = lawyerShare', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L003'];
      expect(r.additionalValues?.['lawyerPerspectiveProfit']).toBeCloseTo(3600, 2);
    });

    it('firmNetProfit < firmRetain when overhead is configured', () => {
      const configWithOverhead = {
        ...FIRM_CONFIG,
        ...({ feeShareOverheadPerEarner: 500 } as object),
      } as FirmConfig;
      const result = feeEarnerProfitability.execute(makeContext({ firmConfig: configWithOverhead }));
      const r = result.entityResults['L003'];
      // firmRetain = 2400; overhead = 500; firmNetProfit = 1900
      expect(r.value).toBeCloseTo(1900, 2);
      expect(r.additionalValues?.['firmNetProfit']).toBeCloseTo(1900, 2);
      expect(r.additionalValues?.['firmNetProfit']!).toBeLessThan(
        r.additionalValues?.['firmRetain'] as number,
      );
    });

    it('feeSharePercent and firmRetainPercent in additionalValues', () => {
      const result = feeEarnerProfitability.execute(makeContext());
      const r = result.entityResults['L003'];
      expect(r.additionalValues?.['feeSharePercent']).toBe(60);
      expect(r.additionalValues?.['firmRetainPercent']).toBe(40);
    });
  });

  it('warns when payModel not set', () => {
    const noModel = makeFeeEarner('L010', 'No Model', 5000, {});
    const result = feeEarnerProfitability.execute(
      makeContext({ feeEarners: [noModel] }),
    );
    expect(result.metadata.warnings.length).toBeGreaterThan(0);
    expect(result.metadata.warnings[0]).toMatch(/payModel not set/i);
  });
});

// =============================================================================
// F-PR-03: Department Profitability
// =============================================================================

describe('F-PR-03 departmentProfitability', () => {
  it('returns correct formula metadata', () => {
    const result = departmentProfitability.execute(makeContext());
    expect(result.formulaId).toBe('F-PR-03');
    expect(result.formulaName).toBe('Department Profitability');
    expect(result.resultType).toBe('currency');
  });

  it('computes correct profit for Corporate department', () => {
    const result = departmentProfitability.execute(makeContext());
    const corp = result.entityResults['dept-corp'];
    expect(corp).toBeDefined();

    // Corporate revenue = dept.invoicedRevenue = 31000
    // Labour: M1 (Alice 50h×50=2500, Charlie 50h×150=7500) + M3 (Alice 30h×50=1500)
    // Total labour = 11500
    // Profit = 31000 - 11500 = 19500
    expect(corp.value).toBeCloseTo(19500, 2);
  });

  it('computes correct profit for Private Client department', () => {
    const result = departmentProfitability.execute(makeContext());
    const pc = result.entityResults['dept-pc'];
    expect(pc).toBeDefined();
    // Revenue = 6000; Bob: 40h × £37.5 = 1500
    // Profit = 4500
    expect(pc.value).toBeCloseTo(4500, 2);
  });

  it('includes margin in additionalValues', () => {
    const result = departmentProfitability.execute(makeContext());
    const corp = result.entityResults['dept-corp'];
    // Margin = 19500 / 31000 ≈ 62.9%
    expect(corp.additionalValues?.['margin']).toBeCloseTo(19500 / 31000 * 100, 1);
  });

  it('aggregates correctly by matching department dynamic field on matters', () => {
    const result = departmentProfitability.execute(makeContext());
    // Both Corp matters are included in Corporate dept labour
    const corpBd = result.entityResults['dept-corp']?.breakdown;
    expect(corpBd?.['matterCount']).toBe(2); // M1 + M3
  });

  it('matterCount is correct per department', () => {
    const result = departmentProfitability.execute(makeContext());
    expect(result.entityResults['dept-pc']?.breakdown?.['matterCount']).toBe(1);
  });
});

// =============================================================================
// F-PR-04: Client Profitability
// =============================================================================

describe('F-PR-04 clientProfitability', () => {
  it('returns correct formula metadata', () => {
    const result = clientProfitability.execute(makeContext());
    expect(result.formulaId).toBe('F-PR-04');
    expect(result.formulaName).toBe('Client Profitability');
    expect(result.resultType).toBe('currency');
  });

  it('aggregates correctly for Acme Ltd (2 matters)', () => {
    const result = clientProfitability.execute(makeContext());
    const acme = result.entityResults['client-001'];
    expect(acme).toBeDefined();

    // Revenue = client.totalInvoiced = 25000
    // Labour: M1 (Alice 50h×50=2500, Charlie 50h×150=7500) + M3 (Alice 30h×50=1500) = 11500
    // Profit = 25000 - 11500 = 13500
    expect(acme.value).toBeCloseTo(13500, 2);
  });

  it('correct profit for Jones Family (single matter)', () => {
    const result = clientProfitability.execute(makeContext());
    const jones = result.entityResults['client-002'];
    // Revenue = 6000; Bob: 40h × £37.5 = 1500; Profit = 4500
    expect(jones.value).toBeCloseTo(4500, 2);
  });

  it('includes matterCount and averageRevenuePerMatter', () => {
    const result = clientProfitability.execute(makeContext());
    const acme = result.entityResults['client-001'];
    expect(acme.additionalValues?.['matterCount']).toBe(2);
    // avg = 25000 / 2 = 12500
    expect(acme.additionalValues?.['averageRevenuePerMatter']).toBeCloseTo(12500, 2);
  });

  it('includes margin in additionalValues', () => {
    const result = clientProfitability.execute(makeContext());
    const acme = result.entityResults['client-001'];
    // Margin = 13500 / 25000 = 54%
    expect(acme.additionalValues?.['margin']).toBeCloseTo(54, 1);
  });

  it('includes disbursement leakage when disbursements present', () => {
    const disb: EnrichedDisbursement = {
      entityType: 'disbursement',
      matterId: 'mat-001',
      firmExposure: 500,
      ageInDays: 30,
      ...({ subtotal: 500 } as object),
    } as EnrichedDisbursement;
    const result = clientProfitability.execute(makeContext({ disbursements: [disb] }));
    const acme = result.entityResults['client-001'];
    // Profit = 25000 - 11500 - 500 = 13000
    expect(acme.value).toBeCloseTo(13000, 2);
    expect(acme.additionalValues?.['disbursementLeakage']).toBe(500);
  });
});

// =============================================================================
// F-PR-05: Firm Profitability
// =============================================================================

describe('F-PR-05 firmProfitability', () => {
  it('returns correct formula metadata', () => {
    const result = firmProfitability.execute(makeContext());
    expect(result.formulaId).toBe('F-PR-05');
    expect(result.formulaName).toBe('Firm Profitability');
    expect(result.resultType).toBe('currency');
  });

  it('computes total revenue from firm.totalInvoicedRevenue', () => {
    const result = firmProfitability.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;
    expect(bd?.['totalRevenue']).toBe(37000);
  });

  it('correctly separates salaried vs fee share labour costs', () => {
    const result = firmProfitability.execute(makeContext());
    const bd = result.entityResults['firm']?.breakdown;

    // Alice SN-004 = 60000; Bob SN-004 = 45000 → salaried = 105000
    expect(bd?.['salariedLabourCost']).toBeCloseTo(105000, 2);

    // Charlie: 6000 × 60% = 3600 fee share cost
    expect(bd?.['feeShareCost']).toBeCloseTo(3600, 2);

    expect(bd?.['totalLabourCost']).toBeCloseTo(108600, 2);
  });

  it('firm profit = totalRevenue - totalLabourCost - leakage - overhead', () => {
    const result = firmProfitability.execute(makeContext());
    const firm = result.entityResults['firm'];
    // 37000 - 108600 - 0 - 0 = -71600
    expect(firm.value).toBeCloseTo(-71600, 2);
  });

  it('includes revenuePerFeeEarner and profitPerFeeEarner', () => {
    const result = firmProfitability.execute(makeContext());
    const av = result.entityResults['firm']?.additionalValues;
    // activeFeeEarnerCount = 3
    expect(av?.['revenuePerFeeEarner']).toBeCloseTo(37000 / 3, 1);
    expect(av?.['profitPerFeeEarner']).toBeCloseTo(-71600 / 3, 1);
  });

  it('deducts overhead when firmConfig has overheadTotal', () => {
    const configWithOverhead = {
      ...FIRM_CONFIG,
      ...({ overheadTotal: 10000 } as object),
    } as FirmConfig;
    const result = firmProfitability.execute(makeContext({ firmConfig: configWithOverhead }));
    const firm = result.entityResults['firm'];
    // -71600 - 10000 = -81600
    expect(firm.value).toBeCloseTo(-81600, 2);
    expect(firm.breakdown?.['totalOverhead']).toBe(10000);
  });

  it('warns when a salaried earner has no SN-004 data', () => {
    const result = firmProfitability.execute(makeContext({ snippetResults: {} }));
    // All earners missing SN-004
    expect(result.metadata.warnings.length).toBeGreaterThan(0);
  });

  it('handles null inputs gracefully (empty snippet results)', () => {
    const result = firmProfitability.execute(makeContext({ snippetResults: {} }));
    // Should not throw; all costs default to 0
    expect(result.entityResults['firm']).toBeDefined();
    const firm = result.entityResults['firm'];
    // FeeShare: Charlie 6000 × 60% = 3600; salaried = 0 (no SN-004)
    // totalLabour = 3600; profit = 37000 - 3600 = 33400
    expect(firm.value).toBeCloseTo(33400, 2);
  });
});
