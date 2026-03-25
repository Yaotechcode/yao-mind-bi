import { describe, it, expect } from 'vitest';
import { agedDebtorAnalysis } from '../../../../src/server/formula-engine/formulas/debtors.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type {
  AggregatedMatter,
  AggregatedFirm,
  AggregatedFeeEarner,
} from '../../../../src/shared/types/pipeline.js';
import type { EnrichedInvoice } from '../../../../src/shared/types/enriched.js';
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
  matterCount: 3,
  activeMatterCount: 3,
  inProgressMatterCount: 3,
  completedMatterCount: 0,
  otherMatterCount: 0,
  totalWipHours: 200,
  totalChargeableHours: 150,
  totalWipValue: 50000,
  totalWriteOffValue: 0,
  totalInvoicedRevenue: 30000,
  totalOutstanding: 12000,
  totalPaid: 18000,
  orphanedWip: {
    orphanedWipEntryCount: 0,
    orphanedWipHours: 0,
    orphanedWipValue: 0,
    orphanedWipPercent: 0,
    orphanedWipNote: '',
  },
};

// ---------------------------------------------------------------------------
// Invoice helpers
// ---------------------------------------------------------------------------

function makeInvoice(
  clientName: string,
  outstanding: number,
  daysOutstanding: number,
  extra: Partial<EnrichedInvoice> = {},
): EnrichedInvoice {
  return {
    entityType: 'invoice',
    isOverdue: outstanding > 0 && daysOutstanding > 30,
    daysOutstanding,
    ageBand: daysOutstanding <= 30 ? '0-30' : daysOutstanding <= 60 ? '31-60' : '91-120',
    clientName,
    ...({ outstanding, subtotal: outstanding + 1000, paid: 1000 } as object),
    ...extra,
  } as EnrichedInvoice;
}

/**
 * Test invoices:
 *   Acme Ltd:   £5000 outstanding, 20 days  → 'current' band
 *   Acme Ltd:   £3000 outstanding, 45 days  → '31-60' band
 *   Jones:      £2000 outstanding, 75 days  → '61-90' band
 *   Jones:      £1000 outstanding, 150 days → '91-180' band
 *   Paid invo:  £0 outstanding              → excluded
 *
 * Total unpaid = 5000 + 3000 + 2000 + 1000 = 11000
 *
 * Firm weighted avg = (20×5000 + 45×3000 + 75×2000 + 150×1000) / 11000
 *                   = (100000 + 135000 + 150000 + 150000) / 11000
 *                   = 535000 / 11000 ≈ 48.64 days
 *
 * Acme weighted avg = (20×5000 + 45×3000) / 8000 = (100000+135000)/8000 = 29.375 days
 * Jones weighted avg = (75×2000 + 150×1000) / 3000 = (150000+150000)/3000 = 100 days
 */
const INV_ACME_CURRENT = makeInvoice('Acme Ltd', 5000, 20);
const INV_ACME_3160   = makeInvoice('Acme Ltd', 3000, 45);
const INV_JONES_6190  = makeInvoice('Jones Family', 2000, 75);
const INV_JONES_91180 = makeInvoice('Jones Family', 1000, 150);
const INV_PAID        = makeInvoice('Acme Ltd', 0, 0);   // excluded (outstanding=0)

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [] as AggregatedFeeEarner[],
    matters: [] as AggregatedMatter[],
    invoices: [INV_ACME_CURRENT, INV_ACME_3160, INV_JONES_6190, INV_JONES_91180, INV_PAID],
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
// F-DM-01: Aged Debtor Analysis
// =============================================================================

describe('F-DM-01 agedDebtorAnalysis', () => {
  it('returns correct formula metadata', () => {
    const result = agedDebtorAnalysis.execute(makeContext());
    expect(result.formulaId).toBe('F-DM-01');
    expect(result.formulaName).toBe('Aged Debtor Analysis');
    expect(result.resultType).toBe('days');
  });

  it('returns 0 with empty breakdown when no unpaid invoices', () => {
    const result = agedDebtorAnalysis.execute(makeContext({ invoices: [INV_PAID] }));
    expect(result.entityResults['firm']?.value).toBe(0);
    const bd = result.entityResults['firm']?.breakdown;
    expect(bd?.['totalOutstanding']).toBe(0);
  });

  describe('age band categorisation', () => {
    it('categorises 20-day invoice as current band', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const firmBd = result.entityResults['firm']?.breakdown;
      const bands = firmBd?.['ageBands'] as Array<{ band: string; invoiceCount: number; totalValue: number }>;
      const current = bands.find((b) => b.band === 'current');
      expect(current?.invoiceCount).toBe(1);
      expect(current?.totalValue).toBe(5000);
    });

    it('categorises 45-day invoice as 31-60 band', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const bands = result.entityResults['firm']?.breakdown?.['ageBands'] as Array<{
        band: string;
        invoiceCount: number;
        totalValue: number;
      }>;
      const band3160 = bands.find((b) => b.band === '31-60');
      expect(band3160?.invoiceCount).toBe(1);
      expect(band3160?.totalValue).toBe(3000);
    });

    it('categorises 75-day invoice as 61-90 band', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const bands = result.entityResults['firm']?.breakdown?.['ageBands'] as Array<{
        band: string;
        invoiceCount: number;
        totalValue: number;
      }>;
      const band6190 = bands.find((b) => b.band === '61-90');
      expect(band6190?.invoiceCount).toBe(1);
      expect(band6190?.totalValue).toBe(2000);
    });

    it('categorises 150-day invoice as 91-180 band', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const bands = result.entityResults['firm']?.breakdown?.['ageBands'] as Array<{
        band: string;
        invoiceCount: number;
        totalValue: number;
      }>;
      const band91180 = bands.find((b) => b.band === '91-180');
      expect(band91180?.invoiceCount).toBe(1);
      expect(band91180?.totalValue).toBe(1000);
    });

    it('excludes paid invoices (outstanding=0)', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const bd = result.entityResults['firm']?.breakdown;
      // Total outstanding = 5000+3000+2000+1000 = 11000 (not 11000+0)
      expect(bd?.['totalOutstanding']).toBe(11000);
    });
  });

  describe('weighted average age calculation', () => {
    it('computes correct firm-level weighted average age', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const firmValue = result.entityResults['firm']?.value;
      // (20×5000 + 45×3000 + 75×2000 + 150×1000) / 11000 ≈ 48.64
      expect(firmValue).toBeCloseTo(535000 / 11000, 1);
    });

    it('computes correct client-level weighted average age for Acme', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const acme = result.entityResults['Acme Ltd'];
      expect(acme).toBeDefined();
      // (20×5000 + 45×3000) / 8000 = 29.375
      expect(acme.value).toBeCloseTo(235000 / 8000, 1);
    });

    it('computes correct client-level weighted average age for Jones', () => {
      const result = agedDebtorAnalysis.execute(makeContext());
      const jones = result.entityResults['Jones Family'];
      expect(jones).toBeDefined();
      // (75×2000 + 150×1000) / 3000 = 100
      expect(jones.value).toBeCloseTo(100, 1);
    });
  });

  it('includes longestOutstanding in firm breakdown', () => {
    const result = agedDebtorAnalysis.execute(makeContext());
    expect(result.entityResults['firm']?.breakdown?.['longestOutstanding']).toBe(150);
  });

  it('includes topDebtors list in firm breakdown', () => {
    const result = agedDebtorAnalysis.execute(makeContext());
    const topDebtors = result.entityResults['firm']?.breakdown?.['topDebtors'] as Array<{
      clientName: string;
      outstanding: number;
    }>;
    expect(topDebtors).toBeDefined();
    expect(topDebtors.length).toBeGreaterThan(0);
    // Acme has most outstanding (8000 total)
    expect(topDebtors[0]?.clientName).toBe('Acme Ltd');
    expect(topDebtors[0]?.outstanding).toBe(8000);
  });

  it('creates per-client entity results', () => {
    const result = agedDebtorAnalysis.execute(makeContext());
    expect(result.entityResults['Acme Ltd']).toBeDefined();
    expect(result.entityResults['Jones Family']).toBeDefined();
  });

  it('percentOfTotal sums to 100 across all bands', () => {
    const result = agedDebtorAnalysis.execute(makeContext());
    const bands = result.entityResults['firm']?.breakdown?.['ageBands'] as Array<{
      percentOfTotal: number;
    }>;
    const total = bands.reduce((s, b) => s + b.percentOfTotal, 0);
    expect(total).toBeCloseTo(100, 1);
  });
});
