import { describe, it, expect } from 'vitest';
import {
  checkAllReadiness,
  checkSingleReadiness,
  deriveConfigPaths,
  FormulaReadiness,
} from '../../../src/server/formula-engine/readiness-checker.js';
import { getBuiltInFormulaDefinitions } from '../../../src/shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../../../src/shared/formulas/built-in-snippets.js';
import type { FirmConfig } from '../../../src/shared/types/index.js';
import type { EntityType } from '../../../src/shared/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFirmConfig(overrides: Partial<FirmConfig> = {}): FirmConfig {
  return {
    firmId: 'firm-001',
    firmName: 'Test Firm',
    jurisdiction: 'England and Wales',
    currency: 'GBP',
    financialYearStartMonth: 4,
    weekStartDay: 1,
    timezone: 'Europe/London',
    schemaVersion: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    entityDefinitions: {},
    columnMappingTemplates: [],
    customFields: [],
    ragThresholds: [],
    formulas: [],
    snippets: [],
    feeEarnerOverrides: [],
    ...overrides,
  };
}

/** Build availableData with all entities absent and minimal config. */
function noData(configOverrides: Record<string, boolean> = {}) {
  return {
    entityTypes: {} as Record<string, { present: boolean; recordCount: number }>,
    configPaths: { ...configOverrides },
  };
}

/** Build availableData with specific entity types present. */
function withEntities(
  entityTypes: string[],
  configOverrides: Record<string, boolean> = {},
  recordCounts: Record<string, number> = {},
) {
  const et: Record<string, { present: boolean; recordCount: number }> = {};
  for (const type of entityTypes) {
    et[type] = { present: true, recordCount: recordCounts[type] ?? 100 };
  }
  return {
    entityTypes: et,
    configPaths: { ...configOverrides },
  };
}

/** Full data available — all entity types present. */
function allData(configOverrides: Record<string, boolean> = {}) {
  return withEntities(
    ['feeEarner', 'timeEntry', 'matter', 'invoice', 'disbursement', 'client', 'department'],
    configOverrides,
  );
}

const ALL_FORMULAS = getBuiltInFormulaDefinitions();
const ALL_SNIPPETS = getBuiltInSnippetDefinitions();

// ---------------------------------------------------------------------------
// No data uploaded — everything should be BLOCKED
// ---------------------------------------------------------------------------

describe('no data uploaded', () => {
  it('all 23 formulas are BLOCKED when no entity data is present', () => {
    const results = checkAllReadiness(ALL_FORMULAS, ALL_SNIPPETS, noData(), makeFirmConfig());
    const formulaResults = Object.entries(results)
      .filter(([id]) => id.startsWith('F-'));

    expect(formulaResults).toHaveLength(23);
    for (const [id, result] of formulaResults) {
      expect(result.readiness, `${id} should be BLOCKED with no data`).toBe(FormulaReadiness.BLOCKED);
    }
  });

  it('all 5 snippets are BLOCKED when no entity data is present', () => {
    const results = checkAllReadiness(ALL_FORMULAS, ALL_SNIPPETS, noData(), makeFirmConfig());
    const snippetResults = Object.entries(results)
      .filter(([id]) => id.startsWith('SN-'));

    expect(snippetResults).toHaveLength(5);
    for (const [id, result] of snippetResults) {
      expect(result.readiness, `${id} should be BLOCKED with no data`).toBe(FormulaReadiness.BLOCKED);
    }
  });

  it('BLOCKED result includes a human-readable message', () => {
    const result = checkSingleReadiness('F-TU-01', noData(), makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    expect(result.message).toContain('Blocked');
    expect(result.blockedReason).toBeTruthy();
    expect(result.blockedReason!.length).toBeGreaterThan(10);
  });

  it('BLOCKED result identifies the missing entity in blockedReason', () => {
    const result = checkSingleReadiness('F-TU-01', noData(), makeFirmConfig());
    // F-TU-01 needs feeEarner and timeEntry
    expect(result.blockedReason).toMatch(/fee earner|time entr|WIP/i);
  });
});

// ---------------------------------------------------------------------------
// WIP + fee earner data only (no invoices, matters, etc.)
// ---------------------------------------------------------------------------

describe('WIP and fee earner data only', () => {
  const data = withEntities(['feeEarner', 'timeEntry']);

  it('F-TU-01 (utilisation) is PARTIAL — config defaults will be used', () => {
    const result = checkSingleReadiness('F-TU-01', data, makeFirmConfig());
    // All required entities present; config not fully set → PARTIAL
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
  });

  it('F-TU-02 (recording consistency) is PARTIAL — config defaults will be used', () => {
    const result = checkSingleReadiness('F-TU-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
  });

  it('F-TU-03 (non-chargeable breakdown) is READY — no config or optional data needed', () => {
    const result = checkSingleReadiness('F-TU-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-RB-01 (realisation) is BLOCKED — invoice data missing', () => {
    const result = checkSingleReadiness('F-RB-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    expect(result.blockedReason).toMatch(/invoice/i);
  });

  it('F-RB-03 (revenue per earner) is BLOCKED — invoice data missing', () => {
    const result = checkSingleReadiness('F-RB-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
  });

  it('F-PR-01 (matter profitability) is BLOCKED — matter data missing', () => {
    const result = checkSingleReadiness('F-PR-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    expect(result.blockedReason).toMatch(/matter/i);
  });

  it('F-WL-03 (disbursement recovery) is BLOCKED — disbursement and invoice missing', () => {
    const result = checkSingleReadiness('F-WL-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
  });

  it('SN-002 (available working hours) is PARTIAL — config defaults used', () => {
    const result = checkSingleReadiness('SN-002', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
    expect(result.partialDetails).toBeTruthy();
    expect(result.partialDetails!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WIP + fee earner + all config set → utilisation formulas ready
// ---------------------------------------------------------------------------

describe('WIP + fee earner data with full config', () => {
  const config = makeFirmConfig({
    weeklyTargetHours: 37.5,
    workingDaysPerWeek: 5,
    annualLeaveEntitlement: 25,
    bankHolidaysPerYear: 8,
    chargeableWeeklyTarget: 30,
  });
  const data = withEntities(['feeEarner', 'timeEntry'], deriveConfigPaths(config));

  it('F-TU-01 is PARTIAL (per-earner targets not set) even with full firm config', () => {
    // Per-earner targets configPath is synthetic — not in firmConfig fields
    const result = checkSingleReadiness('F-TU-01', data, config);
    // Still PARTIAL because feeEarner.perEarnerTargets not in configPaths
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
  });

  it('F-TU-01 is READY when per-earner targets are also marked present', () => {
    const dataWithTargets = withEntities(
      ['feeEarner', 'timeEntry'],
      { ...deriveConfigPaths(config), 'feeEarner.perEarnerTargets': true },
    );
    const result = checkSingleReadiness('F-TU-01', dataWithTargets, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-TU-03 remains READY — no config dependencies', () => {
    const result = checkSingleReadiness('F-TU-03', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });
});

// ---------------------------------------------------------------------------
// WIP + fee earner + invoices → billing formulas enabled
// ---------------------------------------------------------------------------

describe('WIP + fee earner + invoice data', () => {
  const data = withEntities(['feeEarner', 'timeEntry', 'invoice']);

  it('F-RB-01 (realisation) is PARTIAL — matter data absent for fixed-fee filtering', () => {
    const result = checkSingleReadiness('F-RB-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
    expect(result.partialDetails?.some((d) => /matter|fixed-fee/i.test(d))).toBe(true);
  });

  it('F-RB-02 (effective hourly rate) is PARTIAL — matter data absent', () => {
    const result = checkSingleReadiness('F-RB-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
  });
});

// ---------------------------------------------------------------------------
// All data uploaded (without config)
// ---------------------------------------------------------------------------

describe('all entity data uploaded, no config set', () => {
  const data = allData();

  it('F-TU-03 is READY — no config or optional entities needed', () => {
    const result = checkSingleReadiness('F-TU-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-RB-04 (billing velocity) is READY — all three required entities present', () => {
    const result = checkSingleReadiness('F-RB-04', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-WL-03 (disbursement recovery) is READY — matter + disbursement + invoice present', () => {
    const result = checkSingleReadiness('F-WL-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-DM-01 (aged debtors) is ENHANCED — all required + optional matter data present', () => {
    const result = checkSingleReadiness('F-DM-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
    expect(result.enhancedDetails).toBeTruthy();
    expect(result.enhancedDetails!.length).toBeGreaterThan(0);
  });

  it('F-WL-01 (WIP age) is ENHANCED — optional invoice data present', () => {
    const result = checkSingleReadiness('F-WL-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
  });

  it('F-WL-02 (write-off analysis) is ENHANCED — optional matter and invoice present', () => {
    const result = checkSingleReadiness('F-WL-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
  });

  it('F-PR-01 (matter profitability) is PARTIAL — costRateMethod config not set', () => {
    const result = checkSingleReadiness('F-PR-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    // costRateMethod is required config → BLOCKED
    expect(result.blockedReason).toMatch(/cost.?rate/i);
  });

  it('F-PR-02 (fee earner profitability) is BLOCKED — costRateMethod required config missing', () => {
    const result = checkSingleReadiness('F-PR-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
  });
});

// ---------------------------------------------------------------------------
// All data + full config → most formulas READY or ENHANCED
// ---------------------------------------------------------------------------

describe('all data + full config', () => {
  const config = makeFirmConfig({
    weeklyTargetHours: 37.5,
    workingDaysPerWeek: 5,
    annualLeaveEntitlement: 25,
    bankHolidaysPerYear: 8,
    chargeableWeeklyTarget: 30,
    costRateMethod: 'fully_loaded',
    defaultFirmRetainPercent: 20,
    defaultFeeSharePercent: 40,
    utilisationApproach: 'assume_fulltime',
    revenueAttribution: 'responsible_lawyer',
    ragThresholds: [{ metricKey: 'test', label: 'test', defaults: { green: {}, amber: {}, red: {} }, higherIsBetter: true }],
  });

  const data = allData({
    ...deriveConfigPaths(config),
    'feeEarner.salaryData': true,
    'feeEarner.perEarnerTargets': true,
    'feeEarner.gradeData': true,
    'invoice.datePaid': true,
    'matter.isFixedFee': true,
  });

  it('F-TU-01 is READY with full config and per-earner targets', () => {
    const result = checkSingleReadiness('F-TU-01', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-PR-01 (matter profitability) is ENHANCED — all optional data present', () => {
    const result = checkSingleReadiness('F-PR-01', data, config);
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
  });

  it('F-PR-02 (fee earner profitability) is ENHANCED — optional matter present', () => {
    const result = checkSingleReadiness('F-PR-02', data, config);
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
  });

  it('F-RB-01 (realisation) is ENHANCED — optional matter present', () => {
    const result = checkSingleReadiness('F-RB-01', data, config);
    expect(result.readiness).toBe(FormulaReadiness.ENHANCED);
  });

  it('F-PR-03 (department profitability) is READY', () => {
    const result = checkSingleReadiness('F-PR-03', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('F-CS-02 (fee earner scorecard) is READY — scorecardWeights heuristic matches ragThresholds', () => {
    const result = checkSingleReadiness('F-CS-02', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('SN-005 (cost rate by pay model) is READY with costRateMethod configured', () => {
    const result = checkSingleReadiness('SN-005', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });

  it('SN-001 (fully loaded cost rate) is READY with salary data present', () => {
    const result = checkSingleReadiness('SN-001', data, config);
    expect(result.readiness).toBe(FormulaReadiness.READY);
  });
});

// ---------------------------------------------------------------------------
// Config-specific PARTIAL cases
// ---------------------------------------------------------------------------

describe('config-driven partial states', () => {
  it('F-TU-01 partialDetails mentions weeklyTargetHours when not configured', () => {
    const data = withEntities(['feeEarner', 'timeEntry'], { 'feeEarner.perEarnerTargets': false });
    const result = checkSingleReadiness('F-TU-01', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
    const hasWeeklyHoursNote = result.partialDetails?.some((d) =>
      /weeklyTargetHours|weekly.*target|target.*hour/i.test(d),
    );
    expect(hasWeeklyHoursNote).toBe(true);
  });

  it('F-RB-03 partialDetails mentions revenueAttribution when not configured', () => {
    const data = withEntities(['feeEarner', 'invoice']);
    const result = checkSingleReadiness('F-RB-03', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
    const hasAttributionNote = result.partialDetails?.some((d) =>
      /revenueAttribution|revenue.*attribution/i.test(d),
    );
    expect(hasAttributionNote).toBe(true);
  });

  it('F-DM-02 is PARTIAL (not BLOCKED) when datePaid absent — can run but returns null for most clients', () => {
    const data = withEntities(['client', 'invoice']);
    const result = checkSingleReadiness('F-DM-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.PARTIAL);
    expect(result.partialDetails?.some((d) => /datePaid|payment date/i.test(d))).toBe(true);
  });

  it('SN-005 is BLOCKED when costRateMethod not configured', () => {
    const data = withEntities(['feeEarner']);
    const result = checkSingleReadiness('SN-005', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    expect(result.blockedReason).toMatch(/cost.?rate/i);
  });

  it('F-PR-02 is BLOCKED when costRateMethod not configured even with all entities present', () => {
    const data = withEntities(['feeEarner', 'matter', 'invoice']);
    const result = checkSingleReadiness('F-PR-02', data, makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
  });
});

// ---------------------------------------------------------------------------
// Message quality
// ---------------------------------------------------------------------------

describe('message quality', () => {
  it('BLOCKED message starts with "Blocked —"', () => {
    const result = checkSingleReadiness('F-TU-01', noData(), makeFirmConfig());
    expect(result.message).toMatch(/^Blocked —/);
  });

  it('PARTIAL message starts with "Partial —"', () => {
    const result = checkSingleReadiness('F-TU-01', withEntities(['feeEarner', 'timeEntry']), makeFirmConfig());
    expect(result.message).toMatch(/^Partial —/);
  });

  it('READY message says ready', () => {
    const result = checkSingleReadiness('F-TU-03', withEntities(['feeEarner', 'timeEntry']), makeFirmConfig());
    expect(result.message).toMatch(/ready/i);
  });

  it('ENHANCED message says enhanced', () => {
    const result = checkSingleReadiness('F-DM-01', allData(), makeFirmConfig());
    expect(result.message).toMatch(/enhanced/i);
  });

  it('BLOCKED message is actionable — tells user what to upload', () => {
    const result = checkSingleReadiness('F-RB-01', withEntities(['feeEarner', 'timeEntry']), makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.BLOCKED);
    // Message should mention uploading something
    expect(result.message.toLowerCase()).toMatch(/upload|missing|required/i);
  });

  it('requiredInputs are populated for formulas with entity requirements', () => {
    const result = checkSingleReadiness('F-TU-01', noData(), makeFirmConfig());
    expect(result.requiredInputs.length).toBeGreaterThan(0);
    expect(result.requiredInputs.every((i) => i.required)).toBe(true);
  });

  it('optionalInputs are populated for formulas with optional entities', () => {
    const result = checkSingleReadiness('F-RB-01', withEntities(['feeEarner', 'timeEntry', 'invoice']), makeFirmConfig());
    expect(result.optionalInputs.length).toBeGreaterThan(0);
    expect(result.optionalInputs.every((i) => !i.required)).toBe(true);
  });

  it('timeEntry quality note is present when timeEntry data is available', () => {
    const data = withEntities(['feeEarner', 'timeEntry']);
    const result = checkSingleReadiness('F-TU-01', data, makeFirmConfig());
    const teInput = result.requiredInputs.find((i) => i.entityType === 'timeEntry');
    expect(teInput?.qualityNote).toBeTruthy();
    expect(teInput?.qualityNote).toMatch(/orphan/i);
  });
});

// ---------------------------------------------------------------------------
// deriveConfigPaths helper
// ---------------------------------------------------------------------------

describe('deriveConfigPaths', () => {
  it('marks only configured fields as true', () => {
    const config = makeFirmConfig({
      weeklyTargetHours: 37.5,
      costRateMethod: 'fully_loaded',
    });
    const paths = deriveConfigPaths(config);

    expect(paths['weeklyTargetHours']).toBe(true);
    expect(paths['costRateMethod']).toBe(true);
    expect(paths['workingDaysPerWeek']).toBe(false); // not set in config
    expect(paths['annualLeaveEntitlement']).toBe(false);
  });

  it('sets scorecardWeights heuristic based on ragThresholds presence', () => {
    const configWithThresholds = makeFirmConfig({
      ragThresholds: [{ metricKey: 'F-TU-01', label: 'Utilisation', defaults: { green: {}, amber: {}, red: {} }, higherIsBetter: true }],
    });
    const configEmpty = makeFirmConfig();

    expect(deriveConfigPaths(configWithThresholds)['scorecardWeights']).toBe(true);
    expect(deriveConfigPaths(configEmpty)['scorecardWeights']).toBe(false);
  });

  it('synthetic config paths default to false', () => {
    const paths = deriveConfigPaths(makeFirmConfig());
    expect(paths['invoice.datePaid']).toBe(false);
    expect(paths['feeEarner.salaryData']).toBe(false);
    expect(paths['feeEarner.perEarnerTargets']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkAllReadiness coverage
// ---------------------------------------------------------------------------

describe('checkAllReadiness', () => {
  it('returns entries for all 23 formulas + 5 snippets', () => {
    const results = checkAllReadiness(ALL_FORMULAS, ALL_SNIPPETS, noData(), makeFirmConfig());
    const allIds = Object.keys(results);
    expect(allIds.filter((id) => id.startsWith('F-'))).toHaveLength(23);
    expect(allIds.filter((id) => id.startsWith('SN-'))).toHaveLength(5);
  });

  it('returns READY for formula with no registered requirements (custom formula)', () => {
    const result = checkSingleReadiness('CUSTOM-999', noData(), makeFirmConfig());
    expect(result.readiness).toBe(FormulaReadiness.READY);
    expect(result.message).toMatch(/no data requirements/i);
  });
});
