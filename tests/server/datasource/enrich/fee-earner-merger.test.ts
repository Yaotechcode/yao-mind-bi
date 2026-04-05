import { describe, it, expect, vi } from 'vitest';

import {
  buildFeeEarnerMergeMap,
  buildSurnameMergeMap,
  buildUniqueApiSurnames,
  normaliseName,
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
    name: 'Alice Smith',
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
// normaliseName
// =============================================================================

describe('normaliseName()', () => {
  it('lowercases and trims', () => {
    expect(normaliseName('  Alice Smith  ')).toBe('alice smith');
  });

  it('collapses multiple spaces', () => {
    expect(normaliseName('Alice   Smith')).toBe('alice smith');
  });

  it('strips (Disabled) suffix case-insensitively', () => {
    expect(normaliseName('Alice Smith (Disabled)')).toBe('alice smith');
    expect(normaliseName('Alice Smith (DISABLED)')).toBe('alice smith');
  });

  it('strips arbitrary parenthetical groups', () => {
    expect(normaliseName('Alice Smith (Former)')).toBe('alice smith');
  });

  it('handles name with no parentheticals unchanged', () => {
    expect(normaliseName('Nathaniel Colbran')).toBe('nathaniel colbran');
  });
});

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

  it('indexes by normalised name key', () => {
    const records = [makeCsvRecord({ name: 'Alice Smith', integration_account_id: '' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('n:alice smith')).toBe(true);
  });

  it('normalises name key — strips parentheticals and lowercases', () => {
    const records = [makeCsvRecord({ name: 'Alice Smith (Disabled)', integration_account_id: '' })];
    const map = buildFeeEarnerMergeMap(records);
    expect(map.has('n:alice smith')).toBe(true);
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
// buildSurnameMergeMap
// =============================================================================

describe('buildSurnameMergeMap()', () => {
  it('returns a map keyed by normalised surname', () => {
    const records = [makeCsvRecord({ name: 'Alice Smith' })];
    const map = buildSurnameMergeMap(records);
    expect(map.has('smith')).toBe(true);
  });

  it('excludes surnames that appear more than once in CSV', () => {
    const records = [
      makeCsvRecord({ name: 'Alice Smith', integration_account_id: 'i1' }),
      makeCsvRecord({ name: 'Bob Smith', integration_account_id: 'i2' }),
    ];
    const map = buildSurnameMergeMap(records);
    expect(map.has('smith')).toBe(false);
  });

  it('includes unique surnames only', () => {
    const records = [
      makeCsvRecord({ name: 'Alice Smith', integration_account_id: 'i1' }),
      makeCsvRecord({ name: 'Bob Jones', integration_account_id: 'i2' }),
      makeCsvRecord({ name: 'Carol Jones', integration_account_id: 'i3' }),
    ];
    const map = buildSurnameMergeMap(records);
    expect(map.has('smith')).toBe(true);
    expect(map.has('jones')).toBe(false);
  });

  it('strips parentheticals from CSV name before extracting surname', () => {
    const records = [makeCsvRecord({ name: 'Alice Smith (Disabled)' })];
    const map = buildSurnameMergeMap(records);
    expect(map.has('smith')).toBe(true);
  });

  it('returns empty map for empty input', () => {
    expect(buildSurnameMergeMap([])).toEqual(new Map());
  });
});

// =============================================================================
// buildUniqueApiSurnames
// =============================================================================

describe('buildUniqueApiSurnames()', () => {
  it('returns surnames that appear exactly once', () => {
    const attorneys = [
      makeAttorney({ lastName: 'Smith' }),
      makeAttorney({ lastName: 'Jones' }),
    ];
    const unique = buildUniqueApiSurnames(attorneys);
    expect(unique.has('smith')).toBe(true);
    expect(unique.has('jones')).toBe(true);
  });

  it('excludes surnames shared by multiple attorneys', () => {
    const attorneys = [
      makeAttorney({ lastName: 'Smith', _id: 'a1' }),
      makeAttorney({ lastName: 'Smith', _id: 'a2' }),
      makeAttorney({ lastName: 'Jones', _id: 'a3' }),
    ];
    const unique = buildUniqueApiSurnames(attorneys);
    expect(unique.has('smith')).toBe(false);
    expect(unique.has('jones')).toBe(true);
  });

  it('normalises surnames before counting', () => {
    const attorneys = [
      makeAttorney({ lastName: 'Smith' }),
      makeAttorney({ lastName: 'SMITH', _id: 'a2' }),
    ];
    const unique = buildUniqueApiSurnames(attorneys);
    expect(unique.has('smith')).toBe(false);
  });

  it('returns empty set for empty input', () => {
    expect(buildUniqueApiSurnames([])).toEqual(new Set());
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
// mergeFeeEarnerData — name match (strategy 3)
// =============================================================================

describe('mergeFeeEarnerData() — name match', () => {
  it('matches when integrationAccountId and email are absent', () => {
    const attorney = makeAttorney({
      fullName: 'Alice Smith',
      integrationAccountId: null,
      email: null,
    });
    const csv = makeCsvRecord({
      name: 'Alice Smith',
      integration_account_id: undefined,
      email: undefined,
    });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.csvDataPresent).toBe(true);
    expect(result.annualSalary).toBe(60000);
  });

  it('name match is case-insensitive and whitespace-normalised', () => {
    const attorney = makeAttorney({
      fullName: 'ALICE  SMITH',
      integrationAccountId: null,
      email: null,
    });
    const csv = makeCsvRecord({
      name: 'Alice Smith',
      integration_account_id: undefined,
      email: undefined,
    });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.csvDataPresent).toBe(true);
  });

  it('name match strips parentheticals from CSV name', () => {
    const attorney = makeAttorney({
      fullName: 'Alice Smith',
      integrationAccountId: null,
      email: null,
    });
    const csv = makeCsvRecord({
      name: 'Alice Smith (Disabled)',
      integration_account_id: undefined,
      email: undefined,
    });
    const map = buildFeeEarnerMergeMap([csv]);
    const result = mergeFeeEarnerData(attorney, map);
    expect(result.csvDataPresent).toBe(true);
  });

  it('prefers name match over surname-only match', () => {
    const attorney = makeAttorney({
      fullName: 'Alice Smith',
      lastName: 'Smith',
      integrationAccountId: null,
      email: null,
    });
    const csvFull = makeCsvRecord({ name: 'Alice Smith', integration_account_id: undefined, email: undefined, annualSalary: 60000 });
    const csvOther = makeCsvRecord({ name: 'Bob Smith', integration_account_id: undefined, email: undefined, annualSalary: 99999 });
    const map = buildFeeEarnerMergeMap([csvFull]);
    const surnameMap = buildSurnameMergeMap([csvOther]); // csvOther has unique 'Smith' in this map
    const uniqueApiSurnames = new Set(['smith']);
    const result = mergeFeeEarnerData(attorney, map, surnameMap, uniqueApiSurnames);
    // Should match by full name (60000), not by surname from surnameMap (99999)
    expect(result.annualSalary).toBe(60000);
  });
});

// =============================================================================
// mergeFeeEarnerData — surname match (strategy 4)
// =============================================================================

describe('mergeFeeEarnerData() — surname match', () => {
  it('matches by surname when all other strategies fail and surname is unique', () => {
    const attorney = makeAttorney({
      fullName: 'Nathaniel Colbran',
      firstName: 'Nathaniel',
      lastName: 'Colbran',
      integrationAccountId: null,
      email: null,
    });
    // CSV has a slightly different name format but unique surname
    const csv = makeCsvRecord({
      name: 'N Colbran',
      integration_account_id: undefined,
      email: undefined,
      annualSalary: 75000,
    });
    const mergeMap = buildFeeEarnerMergeMap([csv]);
    const surnameMap = buildSurnameMergeMap([csv]);
    const uniqueApiSurnames = new Set(['colbran']);

    const result = mergeFeeEarnerData(attorney, mergeMap, surnameMap, uniqueApiSurnames);
    expect(result.csvDataPresent).toBe(true);
    expect(result.annualSalary).toBe(75000);
  });

  it('does NOT match by surname when surname is not unique in API list', () => {
    const attorney = makeAttorney({
      fullName: 'Alice Smith',
      lastName: 'Smith',
      integrationAccountId: null,
      email: null,
    });
    const csv = makeCsvRecord({ name: 'Alice Smith', integration_account_id: undefined, email: undefined });
    const mergeMap = buildFeeEarnerMergeMap([]); // no name key — force to surname path
    const surnameMap = buildSurnameMergeMap([csv]);
    // 'smith' not in uniqueApiSurnames — two attorneys share it
    const uniqueApiSurnames = new Set<string>(); // smith excluded

    const result = mergeFeeEarnerData(attorney, mergeMap, surnameMap, uniqueApiSurnames);
    expect(result.csvDataPresent).toBe(false);
  });

  it('does NOT match by surname when surname appears more than once in CSV', () => {
    const attorney = makeAttorney({
      fullName: 'Alice Smith',
      lastName: 'Smith',
      integrationAccountId: null,
      email: null,
    });
    const csv1 = makeCsvRecord({ name: 'Alice Smith', integration_account_id: undefined, email: undefined });
    const csv2 = makeCsvRecord({ name: 'Bob Smith', integration_account_id: undefined, email: undefined });
    const mergeMap = buildFeeEarnerMergeMap([]);
    const surnameMap = buildSurnameMergeMap([csv1, csv2]); // 'smith' excluded as ambiguous
    const uniqueApiSurnames = new Set(['smith']);

    const result = mergeFeeEarnerData(attorney, mergeMap, surnameMap, uniqueApiSurnames);
    expect(result.csvDataPresent).toBe(false);
  });

  it('surname match is case-insensitive', () => {
    const attorney = makeAttorney({
      fullName: 'Alice SMITH',
      lastName: 'SMITH',
      integrationAccountId: null,
      email: null,
    });
    const csv = makeCsvRecord({ name: 'Alice Smith', integration_account_id: undefined, email: undefined, annualSalary: 60000 });
    const mergeMap = buildFeeEarnerMergeMap([]);
    const surnameMap = buildSurnameMergeMap([csv]);
    const uniqueApiSurnames = new Set(['smith']); // normalised

    const result = mergeFeeEarnerData(attorney, mergeMap, surnameMap, uniqueApiSurnames);
    expect(result.csvDataPresent).toBe(true);
    expect(result.annualSalary).toBe(60000);
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
      makeAttorney({ _id: 'att-3', fullName: 'Carol White', firstName: 'Carol', lastName: 'White', integrationAccountId: null, email: 'carol@firm.com' }),
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
