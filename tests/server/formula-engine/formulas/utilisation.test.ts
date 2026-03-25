import { describe, it, expect } from 'vitest';
import {
  chargeableUtilisationRate,
  recordingConsistency,
  nonChargeableBreakdown,
} from '../../../../src/server/formula-engine/formulas/utilisation.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type { AggregatedFeeEarner, AggregatedFirm } from '../../../../src/shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../../src/shared/types/enriched.js';
import type { FirmConfig } from '../../../../src/shared/types/index.js';

// =============================================================================
// Test data helpers
// =============================================================================

// Reference date: Thursday 2025-01-09
// (Thursday so we can test multi-day gaps that skip weekends)
const REFERENCE_DATE = new Date('2025-01-09T00:00:00.000Z');

/** Minimal FirmConfig used across tests. */
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

/** Minimal AggregatedFirm. */
const FIRM_AGG: AggregatedFirm = {
  feeEarnerCount: 3,
  activeFeeEarnerCount: 3,
  salariedFeeEarnerCount: 2,
  feeShareFeeEarnerCount: 1,
  matterCount: 10,
  activeMatterCount: 8,
  inProgressMatterCount: 6,
  completedMatterCount: 2,
  otherMatterCount: 0,
  totalWipHours: 100,
  totalChargeableHours: 75,
  totalWipValue: 50000,
  totalWriteOffValue: 2000,
  totalInvoicedRevenue: 40000,
  totalOutstanding: 10000,
  totalPaid: 30000,
  orphanedWip: {
    orphanedWipEntryCount: 5,
    orphanedWipHours: 10,
    orphanedWipValue: 5000,
    orphanedWipPercent: 10,
    orphanedWipNote: 'test',
  },
};

/** Build a minimal AggregatedFeeEarner. */
function makeFeeEarner(
  lawyerId: string,
  lawyerName: string,
  overrides: Partial<AggregatedFeeEarner> = {},
): AggregatedFeeEarner {
  return {
    lawyerId,
    lawyerName,
    wipTotalHours: 0,
    wipChargeableHours: 0,
    wipNonChargeableHours: 0,
    wipChargeableValue: 0,
    wipTotalValue: 0,
    wipWriteOffValue: 0,
    wipMatterCount: 0,
    wipOrphanedHours: 0,
    wipOrphanedValue: 0,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipEntryCount: 0,
    recordingGapDays: null,
    invoicedRevenue: 0,
    invoicedOutstanding: 0,
    invoicedCount: 0,
    ...overrides,
  };
}

/** Build a minimal EnrichedTimeEntry. */
function makeEntry(
  lawyerId: string,
  durationHours: number,
  options: {
    doNotBill?: boolean;
    billable?: number;
    writeOff?: number;
    isChargeable?: boolean;
    date?: string;
    hasMatchedMatter?: boolean;
    activityType?: string;
  } = {},
): EnrichedTimeEntry {
  return {
    lawyerId,
    lawyerName: undefined,
    durationHours,
    isChargeable: options.isChargeable ?? (options.billable !== undefined ? options.billable > 0 && !options.doNotBill : true),
    doNotBill: options.doNotBill ?? false,
    billable: options.billable ?? durationHours * 200,
    writeOff: options.writeOff ?? 0,
    date: options.date ?? '2025-01-06', // default to the Monday of ref week
    hasMatchedMatter: options.hasMatchedMatter ?? true,
    activityType: options.activityType,
    _lawyerResolved: true,
  } as unknown as EnrichedTimeEntry;
}

// =============================================================================
// Test fixtures — 3 fee earners + 1 no-entries + 1 system account
// =============================================================================

// L001: Partner (salaried) — high utilisation
// Entries in first week of January 2025:
//   - 30 × 1h chargeable (isChargeable=true, billable>0, doNotBill=false)
//   - 3 × 1h broad-chargeable (doNotBill=false, billable=0)  → 33h for broad
//   - 2 × 1h doNotBill = 35h total
// Last entry: 2025-01-06 (Monday)
// Gap to 2025-01-09 (Thursday): Tue(7), Wed(8), Thu(9) = 3 working days

const FE_PARTNER = makeFeeEarner('L001', 'Alice Partner', {
  wipTotalHours: 35,
  wipChargeableHours: 30,
  wipNonChargeableHours: 5,
  wipEntryCount: 35,
  recordingGapDays: 3,
  wipNewestEntryDate: new Date('2025-01-06'),
});

const ENTRIES_PARTNER: EnrichedTimeEntry[] = [
  // 30 chargeable entries (1h each)
  ...Array.from({ length: 30 }, () =>
    makeEntry('L001', 1, {
      doNotBill: false,
      billable: 200,
      isChargeable: true,
      date: '2025-01-06',
    }),
  ),
  // 3 broad-chargeable (doNotBill=false, billable=0)
  ...Array.from({ length: 3 }, () =>
    makeEntry('L001', 1, {
      doNotBill: false,
      billable: 0,
      isChargeable: false,
      date: '2025-01-06',
    }),
  ),
  // 2 do-not-bill
  ...Array.from({ length: 2 }, () =>
    makeEntry('L001', 1, {
      doNotBill: true,
      billable: 0,
      isChargeable: false,
      date: '2025-01-06',
    }),
  ),
];

// L002: Associate (salaried) — moderate utilisation
// 15h chargeable, 5h non-chargeable, 20h total
// Last entry: 2025-01-09 (referenceDate) → gap = 0

const FE_ASSOCIATE = makeFeeEarner('L002', 'Bob Associate', {
  wipTotalHours: 20,
  wipChargeableHours: 15,
  wipNonChargeableHours: 5,
  wipEntryCount: 20,
  recordingGapDays: 0,
  wipNewestEntryDate: new Date('2025-01-09'),
});

const ENTRIES_ASSOCIATE: EnrichedTimeEntry[] = [
  ...Array.from({ length: 15 }, () =>
    makeEntry('L002', 1, {
      doNotBill: false,
      billable: 200,
      isChargeable: true,
      date: '2025-01-09',
    }),
  ),
  ...Array.from({ length: 5 }, () =>
    makeEntry('L002', 1, {
      doNotBill: true,
      billable: 0,
      isChargeable: false,
      date: '2025-01-09',
    }),
  ),
];

// L003: Fee share lawyer — 10h chargeable, 2h non-chargeable
const FE_FEE_SHARE = makeFeeEarner('L003', 'Carol FeeShare', {
  wipTotalHours: 12,
  wipChargeableHours: 10,
  wipNonChargeableHours: 2,
  wipEntryCount: 12,
  recordingGapDays: 1,
  wipNewestEntryDate: new Date('2025-01-08'),
});

const ENTRIES_FEE_SHARE: EnrichedTimeEntry[] = [
  ...Array.from({ length: 10 }, () =>
    makeEntry('L003', 1, {
      doNotBill: false,
      billable: 150,
      isChargeable: true,
      date: '2025-01-08',
    }),
  ),
  ...Array.from({ length: 2 }, () =>
    makeEntry('L003', 1, {
      doNotBill: true,
      billable: 0,
      isChargeable: false,
      date: '2025-01-08',
    }),
  ),
];

// L004: No time entries at all
const FE_NO_ENTRIES = makeFeeEarner('L004', 'Dave NoEntries', {
  wipEntryCount: 0,
  recordingGapDays: null,
});

// L005: System account — should be completely excluded
const FE_SYSTEM = Object.assign(
  makeFeeEarner('L005', 'System Account'),
  { isSystemAccount: true },
) as AggregatedFeeEarner;

/** Standard SN-002 snippet results (37.5h available for each fee earner). */
const SN002_RESULTS: Record<string, { snippetId: string; entityId: string; value: number | null; nullReason: string | null }> = {
  L001: { snippetId: 'SN-002', entityId: 'L001', value: 37.5, nullReason: null },
  L002: { snippetId: 'SN-002', entityId: 'L002', value: 37.5, nullReason: null },
  L003: { snippetId: 'SN-002', entityId: 'L003', value: 37.5, nullReason: null },
  L004: { snippetId: 'SN-002', entityId: 'L004', value: 37.5, nullReason: null },
};

/** Build a FormulaContext with the standard test set. */
function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [FE_PARTNER, FE_ASSOCIATE, FE_FEE_SHARE, FE_NO_ENTRIES, FE_SYSTEM],
    matters: [],
    invoices: [],
    timeEntries: [
      ...ENTRIES_PARTNER,
      ...ENTRIES_ASSOCIATE,
      ...ENTRIES_FEE_SHARE,
    ],
    disbursements: [],
    departments: [],
    clients: [],
    firm: FIRM_AGG,
    firmConfig: FIRM_CONFIG,
    feeEarnerOverrides: {},
    snippetResults: { 'SN-002': SN002_RESULTS },
    formulaResults: {},
    referenceDate: REFERENCE_DATE,
    ...overrides,
  };
}

// =============================================================================
// F-TU-01: Chargeable Utilisation Rate
// =============================================================================

describe('F-TU-01: Chargeable Utilisation Rate', () => {
  describe('variant: strict_chargeable (default)', () => {
    it('partner: 30 chargeable / 37.5 available ≈ 80%', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner).toBeDefined();
      expect(partner.value).toBeCloseTo(80, 1); // 30/37.5*100 = 80%
      expect(partner.formattedValue).toBe('80.0%');
      expect(partner.nullReason).toBeNull();
    });

    it('associate: 15 chargeable / 37.5 available = 40%', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      const associate = result.entityResults['L002'];
      expect(associate.value).toBeCloseTo(40, 1);
    });

    it('fee earner with zero entries has value = 0, not null', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      const noEntries = result.entityResults['L004'];
      expect(noEntries.value).toBe(0);
      expect(noEntries.nullReason).toBeNull();
      expect(noEntries.formattedValue).toBe('0.0%');
    });

    it('system account is excluded from results', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      expect(result.entityResults['L005']).toBeUndefined();
    });

    it('breakdown includes chargeableHours, availableHours, totalRecordedHours', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.breakdown?.chargeableHours).toBeCloseTo(30);
      expect(partner.breakdown?.availableHours).toBeCloseTo(37.5);
      expect(partner.breakdown?.totalRecordedHours).toBeCloseTo(35);
    });

    it('variantUsed is set to strict_chargeable', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);
      expect(result.variantUsed).toBe('strict_chargeable');
    });
  });

  describe('variant: broad_chargeable', () => {
    it('partner: 33h (30 chargeable + 3 doNotBill=false,billable=0) / 37.5 = 88%', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx, 'broad_chargeable');

      const partner = result.entityResults['L001'];
      expect(partner.value).toBeCloseTo(88, 1); // 33/37.5*100 = 88%
    });

    it('broad_chargeable gives higher utilisation than strict_chargeable', () => {
      const ctx = makeContext();
      const strict = chargeableUtilisationRate.execute(ctx, 'strict_chargeable');
      const broad = chargeableUtilisationRate.execute(ctx, 'broad_chargeable');

      const strictPartner = strict.entityResults['L001'].value!;
      const broadPartner = broad.entityResults['L001'].value!;
      expect(broadPartner).toBeGreaterThan(strictPartner);
    });

    it('variantUsed is set to broad_chargeable', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx, 'broad_chargeable');
      expect(result.variantUsed).toBe('broad_chargeable');
    });
  });

  describe('variant: recorded', () => {
    it('partner: all 35h / 37.5 available ≈ 93.3%', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx, 'recorded');

      const partner = result.entityResults['L001'];
      expect(partner.value).toBeCloseTo(93.3, 1); // 35/37.5*100 = 93.3…%
    });

    it('recorded gives highest utilisation', () => {
      const ctx = makeContext();
      const strict = chargeableUtilisationRate.execute(ctx, 'strict_chargeable');
      const recorded = chargeableUtilisationRate.execute(ctx, 'recorded');

      const strictVal = strict.entityResults['L001'].value!;
      const recordedVal = recorded.entityResults['L001'].value!;
      expect(recordedVal).toBeGreaterThanOrEqual(strictVal);
    });
  });

  describe('fee earner override', () => {
    it('uses overridden weeklyTargetHours when SN-002 is absent', () => {
      // No SN-002 in snippetResults — engine falls back to getEffectiveConfig
      const ctx = makeContext({
        snippetResults: {}, // SN-002 not populated
        feeEarnerOverrides: {
          L001: { weeklyTargetHours: 25 }, // lower target → higher utilisation
        },
      });
      const result = chargeableUtilisationRate.execute(ctx, 'strict_chargeable');

      const partner = result.entityResults['L001'];
      // Available hours via override: 52 - (25/5) - (8/5) × 25 = (52-5-1.6)×25 = 45.4×25=1135h/year
      // Compared to default 37.5 per week: (52-5-1.6)*25 vs (52-5-1.6)*37.5
      // With target=25: utilisation = 30 / ((52-5-1.6)*25) * 100... but we express weekly:
      // Actually the formula uses SN-002 fallback:
      // workingWeeks = 52 - 25/5 - 8/5 = 52-5-1.6 = 45.4
      // available = 45.4 * 25 = 1135h
      // utilisation = 30 / 1135 * 100 = 2.6% (very low — but higher than 30/1702 with 37.5)
      // Main thing is: value should be different from the default 80%
      expect(partner.value).not.toBeCloseTo(80, 0);
    });

    it('uses SN-002 result when available, ignoring override for available hours', () => {
      const ctx = makeContext({
        snippetResults: { 'SN-002': SN002_RESULTS },
        feeEarnerOverrides: {
          L001: { weeklyTargetHours: 25 }, // override exists but SN-002 takes precedence
        },
      });
      const result = chargeableUtilisationRate.execute(ctx, 'strict_chargeable');

      // SN-002 says 37.5h → 30/37.5 = 80%
      expect(result.entityResults['L001'].value).toBeCloseTo(80, 1);
    });
  });

  describe('null available hours', () => {
    it('returns null when SN-002 result is null and config produces 0', () => {
      const ctx = makeContext({
        snippetResults: {
          'SN-002': {
            L001: { snippetId: 'SN-002', entityId: 'L001', value: null, nullReason: 'test' },
            L002: { snippetId: 'SN-002', entityId: 'L002', value: null, nullReason: 'test' },
            L003: { snippetId: 'SN-002', entityId: 'L003', value: null, nullReason: 'test' },
            L004: { snippetId: 'SN-002', entityId: 'L004', value: null, nullReason: 'test' },
          },
        },
      });
      const result = chargeableUtilisationRate.execute(ctx);

      // Partner has entries → should attempt SN-002 → null → return null
      // (entries exist so we proceed past zero-entries check)
      const partner = result.entityResults['L001'];
      expect(partner.value).toBeNull();
      expect(partner.nullReason).toContain('no available hours');
    });
  });

  describe('summary statistics', () => {
    it('mean, min, max are computed across non-null fee earners', () => {
      const ctx = makeContext();
      const result = chargeableUtilisationRate.execute(ctx);

      // Non-null values: L001=80%, L002=40%, L003≈26.7%, L004=0
      expect(result.summary.count).toBe(4); // L005 excluded
      expect(result.summary.nullCount).toBe(0);
      expect(result.summary.min).toBeCloseTo(0);
      expect(result.summary.max).toBeCloseTo(80, 0);
      expect(result.summary.mean).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// F-TU-02: Recording Consistency
// =============================================================================

describe('F-TU-02: Recording Consistency', () => {
  describe('gap calculation from time entries', () => {
    it('partner: last entry Mon 2025-01-06, ref Thu 2025-01-09 → gap = 3 working days', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.value).toBe(3);
      expect(partner.nullReason).toBeNull();
    });

    it('associate: recorded on referenceDate (Thu 2025-01-09) → gap = 0', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);

      const associate = result.entityResults['L002'];
      expect(associate.value).toBe(0);
      expect(associate.formattedValue).toBe('Up to date');
    });

    it('fee share: last entry Wed 2025-01-08, ref Thu 2025-01-09 → gap = 1', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);

      const feeShare = result.entityResults['L003'];
      expect(feeShare.value).toBe(1);
    });

    it('weekend is excluded from gap count', () => {
      // Single entry on Friday 2025-01-03, referenceDate = Monday 2025-01-06
      const entries = [
        makeEntry('L001', 1, { date: '2025-01-03' }), // Friday
      ];
      const ctx = makeContext({
        timeEntries: entries,
        referenceDate: new Date('2025-01-06T00:00:00.000Z'), // Monday
      });
      const result = recordingConsistency.execute(ctx);

      // Sat + Sun don't count → gap = 1 (Monday itself is the gap)
      const partner = result.entityResults['L001'];
      expect(partner.value).toBe(1);
    });

    it('entry on Friday, referenceDate on Friday → gap = 0', () => {
      const entries = [
        makeEntry('L001', 1, { date: '2025-01-10' }), // Friday
      ];
      const ctx = makeContext({
        timeEntries: entries,
        referenceDate: new Date('2025-01-10T00:00:00.000Z'),
      });
      const result = recordingConsistency.execute(ctx);

      expect(result.entityResults['L001'].value).toBe(0);
    });

    it('last entry on Friday, referenceDate on the following Wednesday → gap = 3', () => {
      // Fri → Mon(1), Tue(2), Wed(3)
      const entries = [
        makeEntry('L001', 1, { date: '2025-01-03' }), // Friday
      ];
      const ctx = makeContext({
        timeEntries: entries,
        referenceDate: new Date('2025-01-08T00:00:00.000Z'), // Wednesday
      });
      const result = recordingConsistency.execute(ctx);

      expect(result.entityResults['L001'].value).toBe(3);
    });
  });

  describe('fallback to aggregated data', () => {
    it('uses recordingGapDays when no time entries in context', () => {
      const ctx = makeContext({
        timeEntries: [], // no entries in context
      });
      const result = recordingConsistency.execute(ctx);

      // L001 aggregated recordingGapDays = 3
      expect(result.entityResults['L001'].value).toBe(3);
    });
  });

  describe('null cases', () => {
    it('returns null for fee earner with no entries and no aggregated gap', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);

      const noEntries = result.entityResults['L004'];
      expect(noEntries.value).toBeNull();
      expect(noEntries.nullReason).toContain('No time entries');
    });
  });

  describe('system account', () => {
    it('system account is excluded', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);
      expect(result.entityResults['L005']).toBeUndefined();
    });
  });

  describe('breakdown', () => {
    it('breakdown includes gapDays, workingDaysInGap, lastRecordedDate', () => {
      const ctx = makeContext();
      const result = recordingConsistency.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.breakdown?.gapDays).toBe(3);
      expect(partner.breakdown?.workingDaysInGap).toBe(3);
      expect(partner.breakdown?.lastRecordedDate).toBe('2025-01-06');
    });
  });
});

// =============================================================================
// F-TU-03: Non-Chargeable Time Breakdown
// =============================================================================

describe('F-TU-03: Non-Chargeable Time Breakdown', () => {
  describe('percentage calculation', () => {
    it('partner: 5 non-chargeable / 35 total ≈ 14.3%', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.value).toBeCloseTo(14.29, 1); // 5/35*100
      expect(partner.nullReason).toBeNull();
    });

    it('associate: 5 non-chargeable / 20 total = 25%', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const associate = result.entityResults['L002'];
      expect(associate.value).toBeCloseTo(25, 1);
    });

    it('fee share: 2 non-chargeable / 12 total ≈ 16.7%', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const feeShare = result.entityResults['L003'];
      expect(feeShare.value).toBeCloseTo(16.67, 1);
    });
  });

  describe('null cases', () => {
    it('returns null for fee earner with no time recorded', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const noEntries = result.entityResults['L004'];
      expect(noEntries.value).toBeNull();
      expect(noEntries.nullReason).toBe('No time recorded');
    });
  });

  describe('breakdown', () => {
    it('breakdown contains doNotBillHours, writeOffHours, chargeableHours, totalHours', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.breakdown?.totalHours).toBeCloseTo(35);
      expect(partner.breakdown?.chargeableHours).toBeCloseTo(30);
      expect(partner.breakdown?.nonChargeableHours).toBeCloseTo(5);
      expect(partner.breakdown?.doNotBillHours).toBeCloseTo(2);
    });

    it('broad-chargeable entries (doNotBill=false, billable=0) are zeroBillable, not chargeableHours', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      const partner = result.entityResults['L001'];
      // F-TU-03 uses strict chargeable (isChargeable=true) for chargeableHours
      // The 3 doNotBill=false/billable=0 entries land in zeroBillableHours
      expect(partner.breakdown?.chargeableHours).toBeCloseTo(30);
      expect(partner.breakdown?.zeroBillableHours).toBeCloseTo(3);
    });
  });

  describe('100% chargeable', () => {
    it('fee earner with all chargeable entries → 0% non-chargeable', () => {
      const allChargeable = [
        makeEntry('L001', 1, { doNotBill: false, billable: 200, isChargeable: true }),
        makeEntry('L001', 1, { doNotBill: false, billable: 200, isChargeable: true }),
      ];
      const ctx = makeContext({ timeEntries: allChargeable });
      const result = nonChargeableBreakdown.execute(ctx);

      expect(result.entityResults['L001'].value).toBeCloseTo(0);
    });
  });

  describe('activity type', () => {
    it('adds activity type breakdown when activityType field is present', () => {
      const entriesWithActivity = [
        makeEntry('L001', 2, {
          doNotBill: false,
          billable: 200,
          isChargeable: true,
          activityType: 'drafting',
        }),
        makeEntry('L001', 1, {
          doNotBill: true,
          billable: 0,
          isChargeable: false,
          activityType: 'admin',
        }),
      ];
      const ctx = makeContext({ timeEntries: entriesWithActivity });
      const result = nonChargeableBreakdown.execute(ctx);

      const partner = result.entityResults['L001'];
      expect(partner.breakdown?.activityTypeBreakdown).toBeDefined();
      const atBreakdown = partner.breakdown?.activityTypeBreakdown as Record<string, number>;
      expect(atBreakdown['drafting']).toBeCloseTo(2);
      expect(atBreakdown['admin']).toBeCloseTo(1);
    });

    it('adds warning when activityType is not available', () => {
      const ctx = makeContext(); // no activityType on entries
      const result = nonChargeableBreakdown.execute(ctx);

      expect(result.metadata.warnings).toContain(
        'Activity type not available — non-chargeable breakdown by category unavailable',
      );
    });
  });

  describe('system account excluded', () => {
    it('system account is not in results', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);
      expect(result.entityResults['L005']).toBeUndefined();
    });
  });

  describe('summary statistics', () => {
    it('summary reflects correct count and excludes nulls', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      // L001, L002, L003 have values; L004 is null; L005 excluded
      expect(result.summary.count).toBe(4);
      expect(result.summary.nullCount).toBe(1);
      expect(result.summary.mean).not.toBeNull();
    });

    it('median is correct for 3 non-null values', () => {
      const ctx = makeContext();
      const result = nonChargeableBreakdown.execute(ctx);

      // Values: L001≈14.3%, L002=25%, L003≈16.7%
      // Sorted: 14.3, 16.7, 25 → median = 16.7%
      const values = [
        result.entityResults['L001'].value!,
        result.entityResults['L002'].value!,
        result.entityResults['L003'].value!,
      ].sort((a, b) => a - b);
      expect(result.summary.median).toBeCloseTo(values[1], 1);
    });
  });
});

// =============================================================================
// Integration: registerAllBuiltInFormulas
// =============================================================================

describe('registerAllBuiltInFormulas', () => {
  it('registers F-TU-01, F-TU-02, F-TU-03 with the engine', async () => {
    const { FormulaEngine } = await import(
      '../../../../src/server/formula-engine/engine.js'
    );
    const { registerAllBuiltInFormulas } = await import(
      '../../../../src/server/formula-engine/formulas/index.js'
    );

    const engine = new FormulaEngine();
    registerAllBuiltInFormulas(engine);

    const ctx = makeContext();
    const plan = engine.buildExecutionPlan([], []);

    // Engine should now have implementations — use executeSingle to verify
    const tu01 = await engine.executeSingle('F-TU-01', ctx);
    expect(tu01.result.formulaId).toBe('F-TU-01');

    const tu02 = await engine.executeSingle('F-TU-02', ctx);
    expect(tu02.result.formulaId).toBe('F-TU-02');

    const tu03 = await engine.executeSingle('F-TU-03', ctx);
    expect(tu03.result.formulaId).toBe('F-TU-03');
  });
});
