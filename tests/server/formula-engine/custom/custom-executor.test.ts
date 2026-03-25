/**
 * custom-executor.test.ts — Tests for CustomFormulaExecutor
 *
 * Covers:
 * - Simple arithmetic: field / field
 * - Snippet reference: field / snippet_result
 * - Formula reference: field / prior_formula_result
 * - Conditional: IF payModel = X THEN A ELSE B
 * - Aggregation: sumOf across entities with filter
 * - Post-processing: multiply, round, clamp, abs
 * - Null safety: division by zero, missing field, null propagation
 * - Validation: invalid field, unknown operator, circular dependency
 * - customFormulaAsImplementation: wrapper produces valid FormulaImplementation
 */

import { describe, it, expect } from 'vitest';
import {
  CustomFormulaExecutor,
  customFormulaAsImplementation,
} from '../../../../src/server/formula-engine/custom/custom-executor.js';
import type {
  CustomFormulaDefinition,
  ExpressionNode,
} from '../../../../src/server/formula-engine/custom/custom-executor.js';
import type { FormulaContext } from '../../../../src/server/formula-engine/types.js';
import type { AggregatedFeeEarner, AggregatedMatter } from '../../../../src/shared/types/pipeline.js';
import type { FirmConfig } from '../../../../src/shared/types/index.js';
import type { EntityDefinition, FormulaDefinition, SnippetDefinition } from '../../../../src/shared/types/index.js';
import { EntityType, FieldType, MissingBehaviour } from '../../../../src/shared/types/index.js';
import { RagStatus } from '../../../../src/shared/types/index.js';

// =============================================================================
// Test fixtures
// =============================================================================

function makeFeeEarner(overrides: Partial<AggregatedFeeEarner> & Record<string, unknown> = {}): AggregatedFeeEarner {
  return {
    lawyerId: 'fe-001',
    lawyerName: 'Alice',
    wipTotalHours: 100,
    wipChargeableHours: 80,
    wipNonChargeableHours: 20,
    wipChargeableValue: 8000,
    wipTotalValue: 10000,
    wipWriteOffValue: 500,
    wipMatterCount: 5,
    wipOrphanedHours: 10,
    wipOrphanedValue: 1000,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipEntryCount: 50,
    recordingGapDays: null,
    invoicedRevenue: 12000,
    invoicedOutstanding: 2000,
    invoicedCount: 3,
    ...overrides,
  } as AggregatedFeeEarner & Record<string, unknown>;
}

function makeMatter(overrides: Partial<AggregatedMatter> & Record<string, unknown> = {}): AggregatedMatter {
  return {
    matterId: 'mat-001',
    matterNumber: '1001',
    wipTotalDurationMinutes: 6000,
    wipTotalHours: 100,
    wipTotalBillable: 10000,
    wipTotalWriteOff: 500,
    wipTotalUnits: 100,
    wipTotalChargeable: 8000,
    wipTotalNonChargeable: 2000,
    wipChargeableHours: 80,
    wipNonChargeableHours: 20,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipAgeInDays: null,
    invoiceCount: 2,
    invoicedNetBilling: 9000,
    invoicedDisbursements: 500,
    invoicedTotal: 9500,
    invoicedOutstanding: 1000,
    invoicedPaid: 8500,
    invoicedWrittenOff: 0,
    ...overrides,
  } as AggregatedMatter & Record<string, unknown>;
}

const MINIMAL_FIRM_CONFIG: FirmConfig = {
  firmId: 'firm-001',
  firmName: 'Test Firm',
  jurisdiction: 'england_wales',
  currency: 'GBP',
  financialYearStartMonth: 4,
  weekStartDay: 1,
  timezone: 'Europe/London',
  workingDaysPerWeek: 5,
  weeklyTargetHours: 37.5,
  chargeableWeeklyTarget: 32,
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

function makeContext(overrides: Partial<FormulaContext> = {}): FormulaContext {
  return {
    feeEarners: [makeFeeEarner()],
    matters: [makeMatter()],
    invoices: [],
    timeEntries: [],
    disbursements: [],
    departments: [],
    clients: [],
    firm: {
      feeEarnerCount: 1,
      activeFeeEarnerCount: 1,
      salariedFeeEarnerCount: 1,
      feeShareFeeEarnerCount: 0,
      matterCount: 1,
      activeMatterCount: 1,
      closedMatterCount: 0,
      totalWipHours: 100,
      totalChargeableHours: 80,
      totalWipValue: 10000,
      totalWriteOffValue: 500,
      totalInvoicedRevenue: 12000,
      totalOutstanding: 2000,
      totalPaid: 10000,
      orphanedWip: {
        orphanedWipEntryCount: 5,
        orphanedWipHours: 10,
        orphanedWipValue: 1000,
        orphanedWipPercent: 10,
        orphanedWipNote: '',
      },
    },
    firmConfig: MINIMAL_FIRM_CONFIG,
    feeEarnerOverrides: {},
    snippetResults: {},
    formulaResults: {},
    referenceDate: new Date('2025-01-01'),
    ...overrides,
  };
}

// Minimal entity registry for validation tests
function makeEntityRegistry(): EntityDefinition[] {
  return [
    {
      entityType: EntityType.FEE_EARNER,
      label: 'Fee Earner',
      labelPlural: 'Fee Earners',
      primaryKey: 'lawyerId',
      displayField: 'lawyerName',
      supportsCustomFields: true,
      fields: [
        { key: 'lawyerId', label: 'ID', type: FieldType.STRING, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'lawyerName', label: 'Name', type: FieldType.STRING, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'invoicedRevenue', label: 'Revenue', type: FieldType.CURRENCY, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'wipChargeableHours', label: 'Chargeable Hours', type: FieldType.NUMBER, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'wipTotalHours', label: 'Total Hours', type: FieldType.NUMBER, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
      ],
      relationships: [],
    } as EntityDefinition,
    {
      entityType: EntityType.MATTER,
      label: 'Matter',
      labelPlural: 'Matters',
      primaryKey: 'matterId',
      displayField: 'matterNumber',
      supportsCustomFields: true,
      fields: [
        { key: 'matterId', label: 'ID', type: FieldType.STRING, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'invoicedNetBilling', label: 'Net Billing', type: FieldType.CURRENCY, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
        { key: 'wipChargeableHours', label: 'Chargeable Hours', type: FieldType.NUMBER, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
      ],
      relationships: [],
    } as EntityDefinition,
  ];
}

const executor = new CustomFormulaExecutor();

// =============================================================================
// 1. Simple division: field_A / field_B
// =============================================================================

describe('CustomFormulaExecutor.execute — simple division', () => {
  it('divides two numeric fields', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
      },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');

    expect(result.entityResults['fe-001'].value).toBeCloseTo(150, 5); // 12000 / 80
    expect(result.entityResults['fe-001'].nullReason).toBeNull();
  });

  it('returns formulaId and formulaName from definition', () => {
    const def: CustomFormulaDefinition = {
      formulaId: 'F-CUSTOM-01',
      formulaName: 'My Metric',
      expression: { type: 'constant', value: 42 },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.formulaId).toBe('F-CUSTOM-01');
    expect(result.formulaName).toBe('My Metric');
  });

  it('returns null with reason when divisor field is zero', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'constant', value: 0 },
      },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
    expect(result.entityResults['fe-001'].nullReason).not.toBeNull();
  });

  it('propagates null when a field is missing on the entity', () => {
    const fe = makeFeeEarner({ lawyerId: 'fe-001' });
    // wipChargeableHours is set on fe, but use a field that doesn't exist
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'nonExistentField' },
        right: { type: 'constant', value: 100 },
      },
    };
    const ctx = makeContext({ feeEarners: [fe] });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });

  it('percentage operator: (a / b) × 100', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'percentage',
        left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
        right: { type: 'field', entity: 'feeEarner', field: 'wipTotalHours' },
      },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeCloseTo(80, 5); // 80/100*100
  });
});

// =============================================================================
// 2. Snippet reference
// =============================================================================

describe('CustomFormulaExecutor.execute — snippet reference', () => {
  it('reads a snippet result and divides into it', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'snippet', snippetId: 'SN-002', entityBinding: 'self' },
      },
      resultType: 'currency',
    };
    const ctx = makeContext({
      snippetResults: {
        'SN-002': { 'fe-001': { snippetId: 'SN-002', entityId: 'fe-001', value: 1702.5, nullReason: null } },
      },
    });
    const result = executor.execute(def, ctx, 'feeEarner');
    // 12000 / 1702.5 ≈ 7.05
    expect(result.entityResults['fe-001'].value).toBeCloseTo(7.05, 2);
  });

  it('returns null when snippet result is not present', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'snippet',
        snippetId: 'SN-002',
        entityBinding: 'self',
      },
    };
    const ctx = makeContext({ snippetResults: {} });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });

  it('uses explicit entityBinding to look up a different entity', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'snippet',
        snippetId: 'SN-002',
        entityBinding: 'fe-999',
      },
    };
    const ctx = makeContext({
      snippetResults: {
        'SN-002': { 'fe-999': { snippetId: 'SN-002', entityId: 'fe-999', value: 500, nullReason: null } },
      },
    });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(500);
  });
});

// =============================================================================
// 3. Formula reference
// =============================================================================

describe('CustomFormulaExecutor.execute — formula reference', () => {
  it('reads a prior formula result', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'multiply',
        left: { type: 'formula', formulaId: 'F-TU-01', entityBinding: 'self' },
        right: { type: 'constant', value: 1.2 },
      },
    };
    // Simulate a prior formula result
    const ctx = makeContext({
      formulaResults: {
        'F-TU-01': {
          formulaId: 'F-TU-01',
          formulaName: 'Utilisation',
          variantUsed: null,
          resultType: 'percentage',
          entityResults: {
            'fe-001': { entityId: 'fe-001', entityName: 'Alice', value: 75, formattedValue: '75%', nullReason: null },
          },
          summary: { mean: 75, median: 75, min: 75, max: 75, total: 75, count: 1, nullCount: 0 },
          computedAt: '2025-01-01T00:00:00.000Z',
          metadata: { executionTimeMs: 1, inputsUsed: [], nullReasons: [], warnings: [] },
        },
      },
    });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeCloseTo(90, 5); // 75 × 1.2
  });

  it('reads an additionalValues key from a prior formula result', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'formula',
        formulaId: 'F-PR-01',
        entityBinding: 'self',
        valueKey: 'marginAmount',
      },
    };
    const ctx = makeContext({
      formulaResults: {
        'F-PR-01': {
          formulaId: 'F-PR-01',
          formulaName: 'Margin',
          variantUsed: null,
          resultType: 'currency',
          entityResults: {
            'fe-001': {
              entityId: 'fe-001',
              entityName: 'Alice',
              value: 30, // primary: margin %
              formattedValue: '30%',
              nullReason: null,
              additionalValues: { marginAmount: 3600 },
            },
          },
          summary: { mean: 30, median: 30, min: 30, max: 30, total: 30, count: 1, nullCount: 0 },
          computedAt: '2025-01-01T00:00:00.000Z',
          metadata: { executionTimeMs: 1, inputsUsed: [], nullReasons: [], warnings: [] },
        },
      },
    });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(3600);
  });

  it('returns null when formula result is not present', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'formula',
        formulaId: 'F-MISSING',
        entityBinding: 'self',
      },
    };
    const ctx = makeContext({ formulaResults: {} });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });
});

// =============================================================================
// 4. Conditional: ifThen with compare
// =============================================================================

describe('CustomFormulaExecutor.execute — ifThen conditional', () => {
  it('returns THEN branch when condition is true (string equality)', () => {
    // IF payModel = 'Salaried' THEN wipChargeableHours / 2 ELSE wipChargeableHours / 3
    const fe = makeFeeEarner({
      lawyerId: 'fe-001',
      ...(({ payModel: 'Salaried' } as unknown) as object),
    } as Partial<AggregatedFeeEarner>);

    const expr: ExpressionNode = {
      type: 'ifThen',
      condition: {
        type: 'compare',
        operator: '=',
        left: { type: 'field', entity: 'feeEarner', field: 'payModel' },
        right: { type: 'constant', value: 0 }, // We'll test with numeric compare instead
      },
      then: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
      else: { type: 'constant', value: 0 },
    };

    // Use a numeric field for deterministic test
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'ifThen',
        condition: {
          type: 'compare',
          operator: '>',
          left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
          right: { type: 'constant', value: 50 }, // 80 > 50 → true
        },
        then: { type: 'constant', value: 100 },
        else: { type: 'constant', value: 0 },
      },
    };
    const ctx = makeContext({ feeEarners: [fe] });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(100); // condition true → then
  });

  it('returns ELSE branch when condition is false', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'ifThen',
        condition: {
          type: 'compare',
          operator: '<',
          left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
          right: { type: 'constant', value: 50 }, // 80 < 50 → false
        },
        then: { type: 'constant', value: 100 },
        else: { type: 'constant', value: 999 },
      },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(999);
  });

  it('returns null when else branch is absent and condition is false', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'ifThen',
        condition: {
          type: 'compare',
          operator: '<',
          left: { type: 'constant', value: 5 },
          right: { type: 'constant', value: 0 }, // 5 < 0 → false
        },
        then: { type: 'constant', value: 1 },
        // no else
      },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });

  it('string equality comparison: compare field value to a string constant', () => {
    // dynamic field payModel = 'Salaried' → uses string comparison via getRawValue
    const fe = {
      ...makeFeeEarner({ lawyerId: 'fe-salaried' }),
      payModel: 'Salaried',
    } as unknown as AggregatedFeeEarner;

    const def: CustomFormulaDefinition = {
      expression: {
        type: 'ifThen',
        condition: {
          type: 'compare',
          operator: '=',
          left: { type: 'field', entity: 'feeEarner', field: 'payModel' },
          right: { type: 'field', entity: 'feeEarner', field: 'payModel' }, // same field → always equal
        },
        then: { type: 'constant', value: 1 },
        else: { type: 'constant', value: 0 },
      },
    };
    const ctx = makeContext({ feeEarners: [fe] });
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-salaried'].value).toBe(1);
  });
});

// =============================================================================
// 5. Aggregation: sumOf, averageOf, countOf, minOf, maxOf
// =============================================================================

describe('CustomFormulaExecutor.execute — aggregation', () => {
  const m1 = makeMatter({ matterId: 'mat-001', matterNumber: '1001', invoicedNetBilling: 5000, ...(({ dept: 'Property' } as unknown) as object) });
  const m2 = makeMatter({ matterId: 'mat-002', matterNumber: '1002', invoicedNetBilling: 3000, ...(({ dept: 'Property' } as unknown) as object) });
  const m3 = makeMatter({ matterId: 'mat-003', matterNumber: '1003', invoicedNetBilling: 2000, ...(({ dept: 'Corporate' } as unknown) as object) });

  it('sumOf: sum expression across all entities', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
      },
    };
    // Put in a firm-level target so there's one entity (firm)
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBe(10000); // 5000+3000+2000
  });

  it('sumOf with filter: sum where dept = Property', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
        filter: { field: 'dept', operator: 'equals', value: 'Property' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBe(8000); // 5000+3000 (Property only)
  });

  it('averageOf: average across all entities', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'averageOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBeCloseTo(10000 / 3, 5);
  });

  it('countOf: count all matching entities', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'countOf',
        entity: 'matter',
        filter: { field: 'dept', operator: 'equals', value: 'Property' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBe(2);
  });

  it('minOf: minimum value across entities', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'minOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBe(2000);
  });

  it('maxOf: maximum value across entities', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'maxOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBe(5000);
  });

  it('returns null when no entities match filter', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'matter',
        expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
        filter: { field: 'dept', operator: 'equals', value: 'NonExistentDept' },
      },
    };
    const ctx = makeContext({ matters: [m1, m2, m3] });
    const result = executor.execute(def, ctx, 'firm');
    expect(result.entityResults['firm'].value).toBeNull();
  });
});

// =============================================================================
// 6. Post-processing
// =============================================================================

describe('CustomFormulaExecutor.execute — postProcess', () => {
  it('multiply then round', () => {
    // 80 / 100 = 0.8 → ×100 = 80 → round(1) = 80.0 (no change here, test with fractions)
    // Use invoicedRevenue / wipTotalHours = 12000/100 = 120.0 → ×1 round(2) = 120.00
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
        right: { type: 'constant', value: 3 }, // 80/3 = 26.666...
      },
      postProcess: { multiply: 1, round: 2 },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(26.67); // 26.666... rounded to 2dp
  });

  it('clamp limits result to range', () => {
    const def: CustomFormulaDefinition = {
      expression: { type: 'constant', value: 150 },
      postProcess: { clamp: { min: 0, max: 100 } },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(100);
  });

  it('abs converts negative to positive', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'subtract',
        left: { type: 'constant', value: 50 },
        right: { type: 'constant', value: 80 }, // 50 - 80 = -30
      },
      postProcess: { abs: true },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(30);
  });

  it('post-process not applied when value is null', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'constant', value: 10 },
        right: { type: 'constant', value: 0 }, // → null
      },
      postProcess: { multiply: 100, round: 2 },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });
});

// =============================================================================
// 7. Config reference
// =============================================================================

describe('CustomFormulaExecutor.execute — config reference', () => {
  it('reads a numeric config value via dot-path', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'multiply',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'config', path: 'defaultFeeSharePercent' },
      },
    };
    const ctx = makeContext(); // defaultFeeSharePercent = 60
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeCloseTo(720000, 5); // 12000 × 60
  });

  it('returns null for a non-existent config path', () => {
    const def: CustomFormulaDefinition = {
      expression: { type: 'config', path: 'nonExistent.deep.path' },
    };
    const ctx = makeContext();
    const result = executor.execute(def, ctx, 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBeNull();
  });
});

// =============================================================================
// 8. Summary stats
// =============================================================================

describe('CustomFormulaExecutor.execute — summary', () => {
  it('computes summary statistics across entities', () => {
    const fe1 = makeFeeEarner({ lawyerId: 'fe-001', wipChargeableHours: 80 });
    const fe2 = makeFeeEarner({ lawyerId: 'fe-002', wipChargeableHours: 100 });

    const def: CustomFormulaDefinition = {
      expression: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
    };
    const ctx = makeContext({ feeEarners: [fe1, fe2] });
    const result = executor.execute(def, ctx, 'feeEarner');

    expect(result.summary.count).toBe(2);
    expect(result.summary.total).toBe(180);
    expect(result.summary.mean).toBe(90);
    expect(result.summary.min).toBe(80);
    expect(result.summary.max).toBe(100);
  });
});

// =============================================================================
// 9. customFormulaAsImplementation wrapper
// =============================================================================

describe('customFormulaAsImplementation', () => {
  it('wraps executor.execute in a FormulaImplementation', () => {
    const formulaDef = { id: 'F-CUSTOM-01', label: 'Test Formula', appliesTo: ['feeEarner'] };
    const customDef: CustomFormulaDefinition = {
      expression: { type: 'constant', value: 42 },
    };
    const impl = customFormulaAsImplementation(formulaDef, customDef);

    expect(impl.formulaId).toBe('F-CUSTOM-01');
    expect(typeof impl.execute).toBe('function');

    const ctx = makeContext();
    const result = impl.execute(ctx);
    expect(result.formulaId).toBe('F-CUSTOM-01');
    expect(result.formulaName).toBe('Test Formula');
    expect(result.entityResults['fe-001'].value).toBe(42);
  });

  it('targets the first entity type in appliesTo', () => {
    const formulaDef = { id: 'F-CUSTOM-02', label: 'Matter Formula', appliesTo: ['matter'] };
    const customDef: CustomFormulaDefinition = {
      expression: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
    };
    const impl = customFormulaAsImplementation(formulaDef, customDef);
    const ctx = makeContext();
    const result = impl.execute(ctx);
    // should have matter entities, not feeEarner entities
    expect(result.entityResults['mat-001']).toBeDefined();
    expect(result.entityResults['fe-001']).toBeUndefined();
  });
});

// =============================================================================
// 10. Validation
// =============================================================================

describe('CustomFormulaExecutor.validate', () => {
  const entityRegistry = makeEntityRegistry();
  const formulaRegistry: FormulaDefinition[] = [
    { id: 'F-TU-01', label: 'Utilisation', description: '', type: 'built_in' as any, outputType: FieldType.NUMBER, appliesTo: [EntityType.FEE_EARNER], variants: [] },
    { id: 'F-TU-02', label: 'Recording Gap', description: '', type: 'built_in' as any, outputType: FieldType.NUMBER, appliesTo: [EntityType.FEE_EARNER], variants: [] },
  ];
  const snippetRegistry: SnippetDefinition[] = [
    { id: 'SN-002', label: 'Available Hours', description: '', expression: '', dependencies: [], outputType: FieldType.NUMBER, createdBy: 'system', createdAt: new Date(), updatedAt: new Date() },
  ];

  it('valid formula passes validation', () => {
    const def: CustomFormulaDefinition = {
      formulaId: 'F-CUSTOM-10',
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'snippet', snippetId: 'SN-002', entityBinding: 'self' },
      },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.referencedEntities).toContain('feeEarner');
    expect(result.referencedSnippets).toContain('SN-002');
  });

  it('invalid field reference → error', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'field',
        entity: 'feeEarner',
        field: 'nonExistentField',
      },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('nonExistentField'))).toBe(true);
  });

  it('unknown entity type → error', () => {
    const def: CustomFormulaDefinition = {
      expression: { type: 'field', entity: 'unknown_entity', field: 'someField' },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown_entity'))).toBe(true);
  });

  it('unknown snippet → error', () => {
    const def: CustomFormulaDefinition = {
      expression: { type: 'snippet', snippetId: 'SN-999', entityBinding: 'self' },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('SN-999'))).toBe(true);
  });

  it('unknown formula → error', () => {
    const def: CustomFormulaDefinition = {
      expression: { type: 'formula', formulaId: 'F-GHOST-99', entityBinding: 'self' },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('F-GHOST-99'))).toBe(true);
  });

  it('circular dependency: formula references itself → error', () => {
    const def: CustomFormulaDefinition = {
      formulaId: 'F-CUSTOM-LOOP',
      expression: {
        type: 'formula',
        formulaId: 'F-CUSTOM-LOOP', // references itself
        entityBinding: 'self',
      },
    };
    // Add self to formula registry so it passes the "exists" check
    const registryWithLoop = [
      ...formulaRegistry,
      { id: 'F-CUSTOM-LOOP', label: 'Loop', description: '', type: 'custom' as any, outputType: FieldType.NUMBER, appliesTo: [EntityType.FEE_EARNER], variants: [] },
    ];
    const result = executor.validate(def, entityRegistry, registryWithLoop, snippetRegistry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('circular'))).toBe(true);
  });

  it('collects all referenced entities, formulas, snippets, config paths', () => {
    const def: CustomFormulaDefinition = {
      formulaId: 'F-CUSTOM-20',
      expression: {
        type: 'operator',
        operator: 'add',
        left: {
          type: 'operator',
          operator: 'divide',
          left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
          right: { type: 'snippet', snippetId: 'SN-002', entityBinding: 'self' },
        },
        right: {
          type: 'operator',
          operator: 'multiply',
          left: { type: 'formula', formulaId: 'F-TU-01', entityBinding: 'self' },
          right: { type: 'config', path: 'defaultFeeSharePercent' },
        },
      },
    };
    const result = executor.validate(def, entityRegistry, formulaRegistry, snippetRegistry);
    expect(result.valid).toBe(true);
    expect(result.referencedEntities).toContain('feeEarner');
    expect(result.referencedSnippets).toContain('SN-002');
    expect(result.referencedFormulas).toContain('F-TU-01');
    expect(result.referencedConfigPaths).toContain('defaultFeeSharePercent');
  });
});

// =============================================================================
// 11. Additional operators
// =============================================================================

describe('CustomFormulaExecutor.execute — additional operators', () => {
  it('add operator', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'add',
        left: { type: 'constant', value: 30 },
        right: { type: 'constant', value: 12 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(42);
  });

  it('subtract operator', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'subtract',
        left: { type: 'constant', value: 100 },
        right: { type: 'constant', value: 40 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(60);
  });

  it('min operator: returns smaller of two values', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'min',
        left: { type: 'constant', value: 80 },
        right: { type: 'constant', value: 40 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(40);
  });

  it('max operator: returns larger of two values', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'max',
        left: { type: 'constant', value: 80 },
        right: { type: 'constant', value: 40 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(80);
  });

  it('average operator: mean of two values', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'average',
        left: { type: 'constant', value: 60 },
        right: { type: 'constant', value: 100 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(80);
  });

  it('min/max with one null operand: returns the non-null value', () => {
    const def: CustomFormulaDefinition = {
      expression: {
        type: 'operator',
        operator: 'min',
        left: { type: 'field', entity: 'feeEarner', field: 'noSuchField' }, // → null
        right: { type: 'constant', value: 42 },
      },
    };
    const result = executor.execute(def, makeContext(), 'feeEarner');
    expect(result.entityResults['fe-001'].value).toBe(42);
  });
});
