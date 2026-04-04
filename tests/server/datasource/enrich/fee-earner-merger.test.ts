import { describe, it, expect } from 'vitest';

import {
  buildFeeEarnerMergeMap,
  mergeFeeEarnerData,
} from '../../../../src/server/datasource/enrich/fee-earner-merger.js';

import type { NormalisedAttorney } from '../../../../src/server/datasource/normalise/types.js';

// =============================================================================
// Fixture builders
// =============================================================================

function makeAttorney(o: Partial<NormalisedAttorney> = {}): NormalisedAttorney {
  return {
    _id: 'att-1',
    fullName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    email: 'alice@firm.com',
    status: 'ACTIVE',
    defaultRate: 250,
    allRates: [{ label: 'Standard', value: 250, default: true }],
    integrationAccountId: 'integ-001',
    integrationAccountCode: 'A001',
    jobTitle: 'Senior Associate',
    phone: null,
    lawFirm: 'firm-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...o,
  };
}

function makeCsvRecord(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    integration_account_id: 'integ-001',
    email: 'alice@firm.com',
    payModel: 'Salaried',
    annualSalary: 60000,
    monthlySalary: 5000,
    monthlyPension: 250,
    monthlyEmployerNI: 600,
    monthlyVariablePay: 0,
    annualTarget: 180000,
    targetWeeklyHours: 37.5,
    chargeableWeeklyTarget: 26.25,
    annualLeaveEntitlement: 25,
    feeSharePercent: null,
    firmLeadPercent: 10,
    ...o,
  };
}

// =============================================================================
// buildFeeEarnerMergeMap
// =============================================================================

describe('buildFeeEarnerMergeMap()', () => {
  it('indexes records by integration_account_id', () => {
    const records = [makeCsvRecord({ integration_account_id: 'integ-001' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('integ-001')).toBe(true);
  });

  it('indexes records by email (lower-cased)', () => {
    const records = [makeCsvRecord({ email: 'Alice@Firm.com', integration_account_id: '' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('alice@firm.com')).toBe(true);
  });

  it('indexes by both keys when both present', () => {
    const records = [makeCsvRecord({ integration_account_id: 'integ-001', email: 'alice@firm.com' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('integ-001')).toBe(true);
    expect(map.has('alice@firm.com')).toBe(true);
    // Both point to the same record
    expect(map.get('integ-001')).toBe(map.get('alice@firm.com'));
  });

  it('skips empty integration_account_id strings', () => {
    const records = [makeCsvRecord({ integration_account_id: '' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('')).toBe(false);
  });

  it('handles records with no integration_account_id — uses email only', () => {
    const records = [makeCsvRecord({ integration_account_id: undefined, email: 'bob@firm.com' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('bob@firm.com')).toBe(true);
  });

  it('handles empty input', () => {
    expect(buildFeeEarnerMergeMap([])).toEqual(new Map());
  });
});

// =============================================================================
// mergeFeeEarnerData — successful match by integrationAccountId
// =============================================================================

describe('mergeFeeEarnerData() — match by integrationAccountId', () => {
  it('merges CSV fields onto attorney record', () => {
    const attorney = makeAttorney({ integrationAccountId: 'integ-001' });
    const csv = makeCsvRecord({ integration_account_id: 'integ-001' });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);

    expect(result.payModel).toBe('Salaried');
    expect(result.annualSalary).toBe(60000);
    expect(result.monthlySalary).toBe(5000);
    expect(result.monthlyPension).toBe(250);
    expect(result.monthlyEmployerNI).toBe(600);
    expect(result.monthlyVariablePay).toBe(0);
    expect(result.annualTarget).toBe(180000);
    expect(result.targetWeeklyHours).toBe(37.5);
    expect(result.chargeableWeeklyTarget).toBe(26.25);
    expect(result.annualLeaveEntitlement).toBe(25);
    expect(result.feeSharePercent).toBeNull();
    expect(result.firmLeadPercent).toBe(10);
    expect(result.csvDataPresent).toBe(true);
  });

  it('prefers integrationAccountId over email when both would match', () => {
    const attorney = makeAttorney({
      integrationAccountId: 'integ-001',
      email: 'alice@firm.com',
    });
    const csvByInteg = makeCsvRecord({
      integration_account_id: 'integ-001',
      email: 'other@firm.com',
      annualSalary: 70000,
    });
    const csvByEmail = makeCsvRecord({
      integration_account_id: '',
      email: 'alice@firm.com',
      annualSalary: 50000,
    });
    const map = buildFeeEarnerMergeMap([csvByInteg, csvByEmail]);
    const result = mergeFeeEarnerData(attorney, map);
    // Should have matched by integrationAccountId (70000)
    expect(result.annualSalary).toBe(70000);
  });
});

// =============================================================================
// mergeFeeEarnerData — email fallback
// =============================================================================

describe('mergeFeeEarnerData() — email fallback', () => {
  it('falls back to email when no integrationAccountId on attorney', () => {
    const attorney = makeAttorney({ integrationAccountId: null, email: 'alice@firm.com' });
    const csv = makeCsvRecord({ integration_account_id: undefined, email: 'alice@firm.com' });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.csvDataPresent).toBe(true);
    expect(result.annualSalary).toBe(60000);
  });

  it('falls back to email when integrationAccountId does not match', () => {
    const attorney = makeAttorney({ integrationAccountId: 'integ-999', email: 'alice@firm.com' });
    const csv = makeCsvRecord({ integration_account_id: 'integ-001', email: 'alice@firm.com' });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    // integ-999 not in map, alice@firm.com is
    expect(result.csvDataPresent).toBe(true);
    expect(result.annualSalary).toBe(60000);
  });

  it('email matching is case-insensitive', () => {
    const attorney = makeAttorney({ integrationAccountId: null, email: 'Alice@Firm.COM' });
    const csv = makeCsvRecord({ integration_account_id: undefined, email: 'alice@firm.com' });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.csvDataPresent).toBe(true);
  });
});

// =============================================================================
// mergeFeeEarnerData — no CSV match
// =============================================================================

describe('mergeFeeEarnerData() — no match', () => {
  it('returns all cost fields as null when no CSV data found', () => {
    const attorney = makeAttorney({ integrationAccountId: 'integ-999', email: 'nobody@firm.com' });
    const result = mergeFeeEarnerData(attorney, new Map());

    expect(result.csvDataPresent).toBe(false);
    expect(result.payModel).toBeNull();
    expect(result.annualSalary).toBeNull();
    expect(result.monthlySalary).toBeNull();
    expect(result.monthlyPension).toBeNull();
    expect(result.monthlyEmployerNI).toBeNull();
    expect(result.monthlyVariablePay).toBeNull();
    expect(result.annualTarget).toBeNull();
    expect(result.targetWeeklyHours).toBeNull();
    expect(result.chargeableWeeklyTarget).toBeNull();
    expect(result.annualLeaveEntitlement).toBeNull();
    expect(result.feeSharePercent).toBeNull();
    expect(result.firmLeadPercent).toBeNull();
  });
});

// =============================================================================
// mergeFeeEarnerData — API fields not overwritten
// =============================================================================

describe('mergeFeeEarnerData() — API fields preserved', () => {
  it('never overwrites _id', () => {
    const attorney = makeAttorney({ _id: 'att-original' });
    const csv = makeCsvRecord({ _id: 'att-from-csv' });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map)._id).toBe('att-original');
  });

  it('never overwrites fullName', () => {
    const attorney = makeAttorney({ fullName: 'Alice Smith' });
    const csv = makeCsvRecord({ fullName: 'Wrong Name' });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map).fullName).toBe('Alice Smith');
  });

  it('never overwrites defaultRate', () => {
    const attorney = makeAttorney({ defaultRate: 300 });
    const csv = makeCsvRecord({ defaultRate: 100 });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map).defaultRate).toBe(300);
  });

  it('never overwrites email', () => {
    const attorney = makeAttorney({ email: 'alice@firm.com' });
    const csv = makeCsvRecord({ email: 'other@firm.com' });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map).email).toBe('alice@firm.com');
  });

  it('never overwrites status', () => {
    const attorney = makeAttorney({ status: 'ACTIVE' });
    const csv = makeCsvRecord({ status: 'DISABLED' });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map).status).toBe('ACTIVE');
  });
});

// =============================================================================
// FeeShare pay model
// =============================================================================

describe('mergeFeeEarnerData() — FeeShare model', () => {
  it('maps FeeShare payModel correctly', () => {
    const attorney = makeAttorney();
    const csv = makeCsvRecord({
      payModel: 'FeeShare',
      annualSalary: null,
      monthlySalary: null,
      feeSharePercent: 35,
    });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.payModel).toBe('FeeShare');
    expect(result.feeSharePercent).toBe(35);
    expect(result.annualSalary).toBeNull();
  });

  it('treats unrecognised payModel string as null', () => {
    const attorney = makeAttorney();
    const csv = makeCsvRecord({ payModel: 'Partner' });
    const map = buildFeeEarnerMergeMap([csv]);
    expect(mergeFeeEarnerData(attorney, map).payModel).toBeNull();
  });
});

// =============================================================================
// Multiple attorneys
// =============================================================================

describe('multiple attorneys', () => {
  it('merges each attorney independently using correct CSV record', () => {
    const attorneys = [
      makeAttorney({ _id: 'att-1', integrationAccountId: 'integ-001', email: 'alice@firm.com' }),
      makeAttorney({ _id: 'att-2', integrationAccountId: 'integ-002', email: 'bob@firm.com' }),
      makeAttorney({ _id: 'att-3', integrationAccountId: null, email: 'carol@firm.com' }),
    ];
    const csvRecords = [
      makeCsvRecord({ integration_account_id: 'integ-001', annualSalary: 60000 }),
      makeCsvRecord({ integration_account_id: 'integ-002', email: 'bob@firm.com', annualSalary: 80000 }),
      // carol has no CSV data
    ];
    const map = buildFeeEarnerMergeMap(csvRecords);
    const results = attorneys.map((a) => mergeFeeEarnerData(a, map));

    expect(results[0].annualSalary).toBe(60000);
    expect(results[0].csvDataPresent).toBe(true);

    expect(results[1].annualSalary).toBe(80000);
    expect(results[1].csvDataPresent).toBe(true);

    expect(results[2].csvDataPresent).toBe(false);
    expect(results[2].annualSalary).toBeNull();
  });
});
