import { describe, it, expect } from 'vitest';
import { FormulaEngine } from '../../../src/server/formula-engine/engine.js';
import { buildFormulaContext, getEffectiveConfig } from '../../../src/server/formula-engine/context-builder.js';
import { formatValue, summariseResults } from '../../../src/server/formula-engine/result-formatter.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  SnippetImplementation,
  EntityFormulaResult,
} from '../../../src/server/formula-engine/types.js';
import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
} from '../../../src/shared/formulas/types.js';
import { EntityType, FormulaType, FieldType } from '../../../src/shared/types/index.js';
import type { FirmConfig } from '../../../src/shared/types/index.js';
import type { AggregatedFirm, AggregatedFeeEarner } from '../../../src/shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Minimal test fixtures
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

function makeFirm(overrides: Partial<AggregatedFirm> = {}): AggregatedFirm {
  return {
    feeEarnerCount: 0,
    activeFeeEarnerCount: 0,
    salariedFeeEarnerCount: 0,
    feeShareFeeEarnerCount: 0,
    matterCount: 0,
    activeMatterCount: 0,
    inProgressMatterCount: 0,
    completedMatterCount: 0,
    otherMatterCount: 0,
    totalWipHours: 0,
    totalChargeableHours: 0,
    totalWipValue: 0,
    totalWriteOffValue: 0,
    totalInvoicedRevenue: 0,
    totalOutstanding: 0,
    totalPaid: 0,
    orphanedWip: {
      orphanedWipEntryCount: 0,
      orphanedWipHours: 0,
      orphanedWipValue: 0,
      orphanedWipPercent: 0,
      orphanedWipNote: '',
    },
    ...overrides,
  };
}

function makeFeeEarner(overrides: Partial<AggregatedFeeEarner> = {}): AggregatedFeeEarner {
  return {
    lawyerId: 'fe-001',
    lawyerName: 'Alice Smith',
    wipTotalHours: 100,
    wipChargeableHours: 75,
    wipNonChargeableHours: 25,
    wipChargeableValue: 15000,
    wipTotalValue: 20000,
    wipWriteOffValue: 500,
    wipMatterCount: 10,
    wipOrphanedHours: 5,
    wipOrphanedValue: 800,
    wipOldestEntryDate: null,
    wipNewestEntryDate: null,
    wipEntryCount: 50,
    recordingGapDays: null,
    invoicedRevenue: 12000,
    invoicedOutstanding: 3000,
    invoicedCount: 8,
    ...overrides,
  };
}

function makeContext(
  firmConfig: FirmConfig = makeFirmConfig(),
  feeEarners: AggregatedFeeEarner[] = [],
): FormulaContext {
  return buildFormulaContext(
    'firm-001',
    firmConfig,
    {},
    {
      feeEarners,
      matters: [],
      invoices: [],
      timeEntries: [],
      disbursements: [],
      departments: [],
      clients: [],
      firm: makeFirm(),
    },
    new Date('2024-06-01'),
  );
}

function makeFormulaImpl(
  formulaId: string,
  returnValue: number | null,
  entityId = 'firm',
): FormulaImplementation {
  return {
    formulaId,
    execute: (context): FormulaResult => {
      const entityResult: EntityFormulaResult = {
        entityId,
        entityName: entityId,
        value: returnValue,
        formattedValue: returnValue !== null ? String(returnValue) : null,
        nullReason: returnValue === null ? 'No data available' : null,
      };
      return {
        formulaId,
        formulaName: formulaId,
        variantUsed: null,
        resultType: 'number',
        entityResults: { [entityId]: entityResult },
        summary: {
          mean: returnValue,
          median: returnValue,
          min: returnValue,
          max: returnValue,
          total: returnValue,
          count: 1,
          nullCount: returnValue === null ? 1 : 0,
        },
        computedAt: new Date().toISOString(),
        metadata: {
          executionTimeMs: 0,
          inputsUsed: [],
          nullReasons: returnValue === null ? ['No data available'] : [],
          warnings: [],
        },
      };
      void context;
    },
  };
}

function makeFormulaDef(
  formulaId: string,
  dependsOn: string[] = [],
): BuiltInFormulaDefinition {
  return {
    formulaId,
    name: formulaId,
    description: '',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'number',
    definition: { approach: '', nullHandling: 'return null', aggregationLevel: 'feeEarner' },
    activeVariant: 'default',
    variants: { default: { name: 'Default', description: '', logic: '' } },
    modifiers: [],
    dependsOn,
    displayConfig: { dashboard: 'test' },
  };
}

function makeSnippetDef(
  snippetId: string,
  dependsOn: string[] = [],
): BuiltInSnippetDefinition {
  return {
    snippetId,
    name: snippetId,
    description: '',
    entityType: EntityType.FEE_EARNER,
    resultType: 'number',
    definition: { approach: '', nullHandling: 'return null', aggregationLevel: 'feeEarner' },
    dependsOn,
  };
}

// ---------------------------------------------------------------------------
// FormulaEngine — execution order
// ---------------------------------------------------------------------------

describe('FormulaEngine — execution order', () => {
  it('executes formulas in dependency order', async () => {
    const executionOrder: string[] = [];

    const engine = new FormulaEngine();

    // F-B depends on F-A → F-A must run first
    const implA = makeFormulaImpl('F-A', 100);
    const implB = makeFormulaImpl('F-B', 200);
    const wrappedA: FormulaImplementation = {
      formulaId: 'F-A',
      execute: (ctx) => { executionOrder.push('F-A'); return implA.execute(ctx); },
    };
    const wrappedB: FormulaImplementation = {
      formulaId: 'F-B',
      execute: (ctx) => { executionOrder.push('F-B'); return implB.execute(ctx); },
    };

    engine.registerFormula('F-A', wrappedA);
    engine.registerFormula('F-B', wrappedB);

    const plan = engine.buildExecutionPlan(
      [makeFormulaDef('F-A'), makeFormulaDef('F-B', ['F-A'])],
      [],
    );
    const context = makeContext();
    await engine.executeAll(plan, context);

    expect(executionOrder.indexOf('F-A')).toBeLessThan(executionOrder.indexOf('F-B'));
  });

  it('executes snippets before formulas that do not declare the dependency', async () => {
    const executionOrder: string[] = [];

    const engine = new FormulaEngine();

    const snippetImpl: SnippetImplementation = {
      snippetId: 'SN-001',
      execute: (ctx) => {
        executionOrder.push('SN-001');
        return { snippetId: 'SN-001', entityId: 'fe-001', value: 50, nullReason: null };
        void ctx;
      },
    };
    const formulaImpl: FormulaImplementation = {
      formulaId: 'F-TU-01',
      execute: (ctx) => {
        executionOrder.push('F-TU-01');
        return makeFormulaImpl('F-TU-01', 75).execute(ctx);
      },
    };

    engine.registerSnippet('SN-001', snippetImpl);
    engine.registerFormula('F-TU-01', formulaImpl);

    // SN-001 and F-TU-01 have no declared dependency, but snippet-first ordering
    // should still put SN-001 first
    const plan = engine.buildExecutionPlan(
      [makeFormulaDef('F-TU-01')],
      [makeSnippetDef('SN-001')],
    );
    const context = makeContext(makeFirmConfig(), [makeFeeEarner()]);
    await engine.executeAll(plan, context);

    expect(executionOrder.indexOf('SN-001')).toBeLessThan(executionOrder.indexOf('F-TU-01'));
  });

  it('skips formulas with no registered implementation (adds to skippedFormulas)', async () => {
    const engine = new FormulaEngine();
    // No implementations registered
    const plan = engine.buildExecutionPlan([makeFormulaDef('F-A')], []);
    const context = makeContext();
    const result = await engine.executeAll(plan, context);

    expect(result.successCount).toBe(0);
    const skipped = result.plan.skippedFormulas.find((s) => s.formulaId === 'F-A');
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toContain('No implementation registered');
  });

  it('catches errors thrown by formula implementations and continues', async () => {
    const engine = new FormulaEngine();

    const throwingImpl: FormulaImplementation = {
      formulaId: 'F-BAD',
      execute: () => { throw new Error('division by zero'); },
    };
    const goodImpl = makeFormulaImpl('F-GOOD', 42);

    engine.registerFormula('F-BAD', throwingImpl);
    engine.registerFormula('F-GOOD', goodImpl);

    const plan = engine.buildExecutionPlan(
      [makeFormulaDef('F-BAD'), makeFormulaDef('F-GOOD')],
      [],
    );
    const context = makeContext();
    const result = await engine.executeAll(plan, context);

    expect(result.errorCount).toBe(1);
    expect(result.errors[0].formulaId).toBe('F-BAD');
    expect(result.errors[0].error).toContain('division by zero');
    expect(result.successCount).toBe(1);
    expect(result.results['F-GOOD']).toBeDefined();
  });

  it('stores completed formula results in context.formulaResults', async () => {
    const engine = new FormulaEngine();
    engine.registerFormula('F-A', makeFormulaImpl('F-A', 99));

    const plan = engine.buildExecutionPlan([makeFormulaDef('F-A')], []);
    const context = makeContext();
    await engine.executeAll(plan, context);

    expect(context.formulaResults['F-A']).toBeDefined();
    expect(context.formulaResults['F-A'].formulaId).toBe('F-A');
  });
});

// ---------------------------------------------------------------------------
// FormulaEngine — executeSingle
// ---------------------------------------------------------------------------

describe('FormulaEngine — executeSingle', () => {
  it('executes a single formula and returns its result', async () => {
    const engine = new FormulaEngine();
    engine.registerFormula('F-A', makeFormulaImpl('F-A', 55));

    const context = makeContext();
    const { result } = await engine.executeSingle('F-A', context);

    expect(result.formulaId).toBe('F-A');
    expect(result.entityResults['firm'].value).toBe(55);
  });

  it('throws when no implementation is registered for the formula', async () => {
    const engine = new FormulaEngine();
    const context = makeContext();

    await expect(engine.executeSingle('F-UNREGISTERED', context)).rejects.toThrow(
      'No implementation registered for formula: F-UNREGISTERED',
    );
  });

  it('runs registered snippets before the formula', async () => {
    const engine = new FormulaEngine();
    const feeEarner = makeFeeEarner({ lawyerId: 'fe-001' });

    const snippetImpl: SnippetImplementation = {
      snippetId: 'SN-001',
      execute: () => ({ snippetId: 'SN-001', entityId: 'fe-001', value: 123, nullReason: null }),
    };

    let seenSnippetResults = false;
    const formulaImpl: FormulaImplementation = {
      formulaId: 'F-A',
      execute: (ctx) => {
        seenSnippetResults = ctx.snippetResults['SN-001']?.['fe-001']?.value === 123;
        return makeFormulaImpl('F-A', 1).execute(ctx);
      },
    };

    engine.registerSnippet('SN-001', snippetImpl);
    engine.registerFormula('F-A', formulaImpl);

    const context = makeContext(makeFirmConfig(), [feeEarner]);
    await engine.executeSingle('F-A', context);

    expect(seenSnippetResults).toBe(true);
  });

  it('does not mutate the original context.snippetResults', async () => {
    const engine = new FormulaEngine();
    const feeEarner = makeFeeEarner({ lawyerId: 'fe-001' });

    engine.registerSnippet('SN-001', {
      snippetId: 'SN-001',
      execute: () => ({ snippetId: 'SN-001', entityId: 'fe-001', value: 99, nullReason: null }),
    });
    engine.registerFormula('F-A', makeFormulaImpl('F-A', 1));

    const context = makeContext(makeFirmConfig(), [feeEarner]);
    const originalSnippetResults = context.snippetResults;

    await engine.executeSingle('F-A', context);

    // Original context.snippetResults reference should be unchanged
    expect(context.snippetResults).toBe(originalSnippetResults);
  });
});

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

describe('buildFormulaContext', () => {
  it('populates all data fields from enrichedData', () => {
    const config = makeFirmConfig();
    const feeEarner = makeFeeEarner();
    const context = buildFormulaContext(
      'firm-001',
      config,
      {},
      {
        feeEarners: [feeEarner],
        matters: [],
        invoices: [],
        timeEntries: [],
        disbursements: [],
        departments: [],
        clients: [],
        firm: makeFirm(),
      },
    );

    expect(context.feeEarners).toHaveLength(1);
    expect(context.feeEarners[0].lawyerId).toBe('fe-001');
    expect(context.firmConfig).toBe(config);
  });

  it('initialises snippetResults and formulaResults as empty objects', () => {
    const context = makeContext();
    expect(context.snippetResults).toEqual({});
    expect(context.formulaResults).toEqual({});
  });

  it('uses provided referenceDate', () => {
    const ref = new Date('2023-12-31');
    const context = buildFormulaContext('firm-001', makeFirmConfig(), {}, {
      feeEarners: [],
      matters: [],
      invoices: [],
      timeEntries: [],
      disbursements: [],
      departments: [],
      clients: [],
      firm: makeFirm(),
    }, ref);

    expect(context.referenceDate).toEqual(ref);
  });
});

// ---------------------------------------------------------------------------
// getEffectiveConfig — override merging
// ---------------------------------------------------------------------------

describe('getEffectiveConfig', () => {
  it('returns system defaults when firm config has no optional fields', () => {
    const config = makeFirmConfig();
    const feeEarner = makeFeeEarner();
    const effective = getEffectiveConfig(feeEarner, config);

    expect(effective.costRateMethod).toBe('fully_loaded');
    expect(effective.feeSharePercent).toBe(0);
    expect(effective.workingDaysPerWeek).toBe(5);
    expect(effective.weeklyTargetHours).toBe(37.5);
    expect(effective.chargeableWeeklyTarget).toBe(30);
    expect(effective.annualLeaveEntitlement).toBe(25);
    expect(effective.bankHolidaysPerYear).toBe(8);
    expect(effective.currency).toBe('GBP');
  });

  it('uses firm config values when they are set', () => {
    const config = makeFirmConfig({
      costRateMethod: 'direct',
      workingDaysPerWeek: 4,
      weeklyTargetHours: 30,
      chargeableWeeklyTarget: 24,
      annualLeaveEntitlement: 28,
      defaultFeeSharePercent: 15,
    });
    const effective = getEffectiveConfig(makeFeeEarner(), config);

    expect(effective.costRateMethod).toBe('direct');
    expect(effective.workingDaysPerWeek).toBe(4);
    expect(effective.weeklyTargetHours).toBe(30);
    expect(effective.chargeableWeeklyTarget).toBe(24);
    expect(effective.annualLeaveEntitlement).toBe(28);
    expect(effective.feeSharePercent).toBe(15);
  });

  it('fee earner override takes precedence over firm config', () => {
    const config = makeFirmConfig({
      workingDaysPerWeek: 5,
      chargeableWeeklyTarget: 30,
    });
    const override = { workingDaysPerWeek: 3, chargeableWeeklyTarget: 20 };
    const effective = getEffectiveConfig(makeFeeEarner(), config, override);

    expect(effective.workingDaysPerWeek).toBe(3);
    expect(effective.chargeableWeeklyTarget).toBe(20);
  });

  it('stores the raw override map in overrides field', () => {
    const override = { customField: 'abc', workingDaysPerWeek: 3 };
    const effective = getEffectiveConfig(makeFeeEarner(), makeFirmConfig(), override);

    expect(effective.overrides['customField']).toBe('abc');
  });

  it('fee earner override of 0 does NOT fall through to firm default', () => {
    // 0 is a valid value (e.g., 0 fee share) — must not be treated as absent
    const config = makeFirmConfig({ defaultFeeSharePercent: 20 });
    const override = { feeSharePercent: 0 };
    const effective = getEffectiveConfig(makeFeeEarner(), config, override);

    expect(effective.feeSharePercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Result Formatter
// ---------------------------------------------------------------------------

describe('formatValue', () => {
  it('formats currency with £ symbol and thousands separator', () => {
    expect(formatValue(1234.56, 'currency')).toBe('£1,234.56');
    expect(formatValue(1000000, 'currency')).toBe('£1,000,000.00');
    expect(formatValue(-500.5, 'currency')).toBe('£-500.50');
  });

  it('formats percentage to one decimal place', () => {
    expect(formatValue(75.25, 'percentage')).toBe('75.3%');
    expect(formatValue(100, 'percentage')).toBe('100.0%');
    expect(formatValue(0, 'percentage')).toBe('0.0%');
  });

  it('formats hours to one decimal place with unit suffix', () => {
    expect(formatValue(6.5, 'hours')).toBe('6.5 hrs');
    expect(formatValue(0, 'hours')).toBe('0.0 hrs');
  });

  it('formats days as rounded integer with unit suffix', () => {
    expect(formatValue(45.7, 'days')).toBe('46 days');
    expect(formatValue(1, 'days')).toBe('1 days');
  });

  it('formats number as integer with thousands separator', () => {
    expect(formatValue(1234, 'number')).toBe('1,234');
    expect(formatValue(0, 'number')).toBe('0');
  });

  it('formats ratio with two decimal places and x suffix', () => {
    expect(formatValue(2.5, 'ratio')).toBe('2.50x');
  });

  it('formats boolean: non-zero = Yes, zero = No', () => {
    expect(formatValue(1, 'boolean')).toBe('Yes');
    expect(formatValue(0, 'boolean')).toBe('No');
  });

  it('returns null when value is null', () => {
    expect(formatValue(null, 'currency')).toBeNull();
    expect(formatValue(null, 'percentage')).toBeNull();
    expect(formatValue(null, 'hours')).toBeNull();
  });

  it('accepts a custom currency symbol', () => {
    expect(formatValue(100, 'currency', '$')).toBe('$100.00');
  });
});

// ---------------------------------------------------------------------------
// summariseResults
// ---------------------------------------------------------------------------

describe('summariseResults', () => {
  function makeEntityResult(entityId: string, value: number | null): EntityFormulaResult {
    return {
      entityId,
      entityName: entityId,
      value,
      formattedValue: value !== null ? String(value) : null,
      nullReason: value === null ? 'missing' : null,
    };
  }

  it('computes correct statistics for a set of values', () => {
    const results = {
      a: makeEntityResult('a', 10),
      b: makeEntityResult('b', 20),
      c: makeEntityResult('c', 30),
    };
    const summary = summariseResults(results);

    expect(summary.count).toBe(3);
    expect(summary.nullCount).toBe(0);
    expect(summary.total).toBe(60);
    expect(summary.mean).toBe(20);
    expect(summary.median).toBe(20);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(30);
  });

  it('excludes nulls from statistical calculations', () => {
    const results = {
      a: makeEntityResult('a', 10),
      b: makeEntityResult('b', null),
      c: makeEntityResult('c', 30),
    };
    const summary = summariseResults(results);

    expect(summary.count).toBe(3);
    expect(summary.nullCount).toBe(1);
    expect(summary.mean).toBe(20); // (10 + 30) / 2
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(30);
  });

  it('returns all-null summary when all values are null', () => {
    const results = {
      a: makeEntityResult('a', null),
      b: makeEntityResult('b', null),
    };
    const summary = summariseResults(results);

    expect(summary.mean).toBeNull();
    expect(summary.median).toBeNull();
    expect(summary.min).toBeNull();
    expect(summary.max).toBeNull();
    expect(summary.total).toBeNull();
    expect(summary.count).toBe(2);
    expect(summary.nullCount).toBe(2);
  });

  it('handles single-element set correctly', () => {
    const results = { a: makeEntityResult('a', 42) };
    const summary = summariseResults(results);

    expect(summary.mean).toBe(42);
    expect(summary.median).toBe(42);
    expect(summary.min).toBe(42);
    expect(summary.max).toBe(42);
    expect(summary.total).toBe(42);
  });

  it('computes correct median for even-length set', () => {
    const results = {
      a: makeEntityResult('a', 10),
      b: makeEntityResult('b', 20),
      c: makeEntityResult('c', 30),
      d: makeEntityResult('d', 40),
    };
    const summary = summariseResults(results);
    expect(summary.median).toBe(25); // (20 + 30) / 2
  });

  it('returns zero-count summary for empty result set', () => {
    const summary = summariseResults({});
    expect(summary.count).toBe(0);
    expect(summary.nullCount).toBe(0);
    expect(summary.mean).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Null handling — formula returning null must not throw
// ---------------------------------------------------------------------------

describe('null input handling', () => {
  it('formula returning null entity result is stored without error', async () => {
    const engine = new FormulaEngine();

    const nullReturningImpl: FormulaImplementation = {
      formulaId: 'F-NULL',
      execute: (ctx): FormulaResult => {
        const entityResult: EntityFormulaResult = {
          entityId: 'firm',
          entityName: 'firm',
          value: null,
          formattedValue: null,
          nullReason: 'No WIP data available',
        };
        return {
          formulaId: 'F-NULL',
          formulaName: 'F-NULL',
          variantUsed: null,
          resultType: 'currency',
          entityResults: { firm: entityResult },
          summary: {
            mean: null, median: null, min: null, max: null, total: null,
            count: 1, nullCount: 1,
          },
          computedAt: new Date().toISOString(),
          metadata: {
            executionTimeMs: 0,
            inputsUsed: [],
            nullReasons: ['No WIP data available'],
            warnings: [],
          },
        };
        void ctx;
      },
    };

    engine.registerFormula('F-NULL', nullReturningImpl);
    const plan = engine.buildExecutionPlan([{
      formulaId: 'F-NULL',
      name: 'F-NULL',
      description: '',
      category: 'utilisation',
      formulaType: 'built_in',
      entityType: EntityType.FIRM,
      resultType: 'currency',
      definition: { approach: '', nullHandling: 'return null', aggregationLevel: 'firm' },
      activeVariant: 'default',
      variants: { default: { name: 'Default', description: '', logic: '' } },
      modifiers: [],
      dependsOn: [],
      displayConfig: { dashboard: 'test' },
    }], []);

    const context = makeContext();
    const result = await engine.executeAll(plan, context);

    expect(result.errorCount).toBe(0);
    expect(result.successCount).toBe(1);
    expect(result.results['F-NULL'].entityResults['firm'].value).toBeNull();
    expect(result.results['F-NULL'].entityResults['firm'].nullReason).toBe('No WIP data available');
  });
});
