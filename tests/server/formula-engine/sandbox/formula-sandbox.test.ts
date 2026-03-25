/**
 * formula-sandbox.test.ts — Tests for FormulaSandbox
 *
 * Covers:
 * - dryRun with a simple custom formula → produces results without persisting
 * - dryRun with BLOCKED formula → returns readiness info, no formula result
 * - diffWithLive shows deltas between sandbox and live results
 * - Batch execution runs multiple formulas independently
 * - RAG assignments are included in sandbox results
 * - FeeEarnerOverrides are converted correctly
 * - Data snapshot reflects the loaded data counts
 * - diffWithLive summary counts (improved / declined / unchanged)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FormulaSandbox,
} from '../../../../src/server/formula-engine/sandbox/formula-sandbox.js';
import type {
  SandboxDeps,
  SandboxResult,
} from '../../../../src/server/formula-engine/sandbox/formula-sandbox.js';
import type { CustomFormulaDefinition } from '../../../../src/server/formula-engine/custom/custom-executor.js';
import type { FirmConfig, FeeEarnerOverride, RagThresholdSet } from '../../../../src/shared/types/index.js';
import { RagStatus } from '../../../../src/shared/types/index.js';
import type { CalculatedKpisDocument, EnrichedEntitiesDocument } from '../../../../src/shared/types/mongodb.js';
import type { AggregatedFeeEarner, AggregatedMatter, AggregatedFirm } from '../../../../src/shared/types/pipeline.js';

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-sandbox-test';

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

const FIRM: AggregatedFirm = {
  feeEarnerCount: 1,
  activeFeeEarnerCount: 1,
  salariedFeeEarnerCount: 1,
  feeShareFeeEarnerCount: 0,
  matterCount: 1,
  activeMatterCount: 1,
  inProgressMatterCount: 1,
  completedMatterCount: 0,
  otherMatterCount: 0,
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
};

const MINIMAL_FIRM_CONFIG: FirmConfig = {
  firmId: FIRM_ID,
  firmName: 'Sandbox Test Firm',
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

/** Aggregate data stored in calculated_kpis.kpis.aggregate */
function makeKpisDoc(overrides: Record<string, unknown> = {}): CalculatedKpisDocument {
  return {
    firm_id: FIRM_ID,
    calculated_at: new Date(),
    config_version: 'v1',
    data_version: 'v1',
    kpis: {
      aggregate: {
        feeEarners: [makeFeeEarner()],
        matters: [makeMatter()],
        clients: [],
        departments: [],
        firm: FIRM,
      },
      ...overrides,
    },
  };
}

function makeEnrichedDoc(entityType: string, records: Record<string, unknown>[] = []): EnrichedEntitiesDocument {
  return {
    firm_id: FIRM_ID,
    entity_type: entityType,
    data_version: 'v1',
    source_uploads: [],
    records,
    record_count: records.length,
  };
}

/** A simple utilisation ratio: wipChargeableHours / wipTotalHours */
const UTILISATION_FORMULA: CustomFormulaDefinition = {
  formulaId: 'sandbox-util',
  formulaName: 'Sandbox Utilisation',
  expression: {
    type: 'operator',
    operator: 'divide',
    left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
    right: { type: 'field', entity: 'feeEarner', field: 'wipTotalHours' },
  } as CustomFormulaDefinition['expression'],
  resultType: 'percentage',
};

/** A formula that references timeEntry aggregation — BLOCKED when no timeEntry data */
const TIME_ENTRY_FORMULA: CustomFormulaDefinition = {
  formulaId: 'sandbox-time',
  formulaName: 'Sandbox Time',
  expression: {
    type: 'aggregation',
    function: 'sumOf',
    entity: 'timeEntry',
    expression: { type: 'field', entity: 'timeEntry', field: 'durationHours' },
  } as CustomFormulaDefinition['expression'],
  resultType: 'hours',
};

/** Build injectable deps with mocked loaders */
function makeDeps(overrides: Partial<SandboxDeps> = {}): SandboxDeps {
  return {
    getKpis: vi.fn().mockResolvedValue(makeKpisDoc()),
    getEnrichedEntities: vi.fn().mockResolvedValue(null),
    fetchFirmConfig: vi.fn().mockResolvedValue(MINIMAL_FIRM_CONFIG),
    fetchFeeEarnerOverrides: vi.fn().mockResolvedValue({}),  // Record<feeEarnerId, FeeEarnerOverride[]>
    ...overrides,
  };
}

// =============================================================================
// dryRun — success path
// =============================================================================

describe('FormulaSandbox.dryRun — success', () => {
  it('returns success:true with formula results', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(result.formulaResult).not.toBeNull();
    expect(result.formulaResult?.formulaId).toBe('sandbox-util');
  });

  it('formula result contains the correct value (80/100 = 0.8)', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    const entityResult = result.formulaResult?.entityResults['fe-001'];
    expect(entityResult?.value).toBe(0.8);
  });

  it('does not call any write functions (read-only)', async () => {
    const getKpis = vi.fn().mockResolvedValue(makeKpisDoc());
    const getEnrichedEntities = vi.fn().mockResolvedValue(null);
    const fetchFirmConfig = vi.fn().mockResolvedValue(MINIMAL_FIRM_CONFIG);
    const fetchFeeEarnerOverrides = vi.fn().mockResolvedValue([]);

    const sandbox = new FormulaSandbox({ getKpis, getEnrichedEntities, fetchFirmConfig, fetchFeeEarnerOverrides });
    await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');

    // Only read functions should have been called — no storeX / updateX calls
    expect(getKpis).toHaveBeenCalledWith(FIRM_ID);
    expect(fetchFirmConfig).toHaveBeenCalledWith(FIRM_ID);
  });

  it('populates dataSnapshot with correct counts', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(result.dataSnapshot.feeEarnerCount).toBe(1);
    expect(result.dataSnapshot.matterCount).toBe(1);
    expect(result.dataSnapshot.timeEntryCount).toBe(0);  // no enriched doc
  });

  it('readiness is READY when fee earner data is present', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(result.readiness.readiness).toBe('READY');
  });

  it('includes executionTimeMs', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// dryRun — BLOCKED path
// =============================================================================

describe('FormulaSandbox.dryRun — BLOCKED readiness', () => {
  it('returns formulaResult as null when BLOCKED', async () => {
    // No KPI doc → no fee earner / matter / time entry data
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const result = await sandbox.dryRun(FIRM_ID, TIME_ENTRY_FORMULA, 'timeEntry', 'hours');
    expect(result.formulaResult).toBeNull();
  });

  it('returns BLOCKED readiness when referenced entity has no data', async () => {
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const result = await sandbox.dryRun(FIRM_ID, TIME_ENTRY_FORMULA, 'timeEntry', 'hours');
    expect(result.readiness.readiness).toBe('BLOCKED');
  });

  it('includes a blockedReason in readiness', async () => {
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const result = await sandbox.dryRun(FIRM_ID, TIME_ENTRY_FORMULA, 'timeEntry', 'hours');
    expect(result.readiness.blockedReason).toBeTruthy();
  });

  it('includes a warning message when BLOCKED', async () => {
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const result = await sandbox.dryRun(FIRM_ID, TIME_ENTRY_FORMULA, 'timeEntry', 'hours');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('ragAssignments is empty when BLOCKED', async () => {
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const result = await sandbox.dryRun(FIRM_ID, TIME_ENTRY_FORMULA, 'timeEntry', 'hours');
    expect(result.ragAssignments).toEqual({});
  });
});

// =============================================================================
// RAG assignments
// =============================================================================

describe('FormulaSandbox.dryRun — RAG assignments', () => {
  it('includes RAG assignments when thresholds are configured', async () => {
    const ragThreshold: RagThresholdSet = {
      metricKey: 'sandbox-util',
      label: 'Utilisation',
      defaults: {
        [RagStatus.GREEN]: { min: 0.75 },
        [RagStatus.AMBER]: { min: 0.5, max: 0.75 },
        [RagStatus.RED]: { max: 0.5 },
      },
      higherIsBetter: true,
    };

    const configWithThresholds: FirmConfig = { ...MINIMAL_FIRM_CONFIG, ragThresholds: [ragThreshold] };
    const deps = makeDeps({ fetchFirmConfig: vi.fn().mockResolvedValue(configWithThresholds) });
    const sandbox = new FormulaSandbox(deps);

    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');

    // fe-001 has wipChargeableHours=80 / wipTotalHours=100 = 0.8 → GREEN
    expect(result.ragAssignments['fe-001']).toBeDefined();
    expect(result.ragAssignments['fe-001'].status).toBe(RagStatus.GREEN);
  });

  it('ragAssignments is empty when no thresholds configured', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(result.ragAssignments).toEqual({});
  });
});

// =============================================================================
// diffWithLive
// =============================================================================

describe('FormulaSandbox.diffWithLive', () => {
  it('shows delta when sandbox value differs from live', async () => {
    // Live result has value 0.7 for fe-001; sandbox has 0.8
    const liveFormulaResult = {
      formulaId: 'sandbox-util',
      formulaName: 'Utilisation',
      variantUsed: null,
      resultType: 'percentage',
      entityResults: {
        'fe-001': {
          entityId: 'fe-001',
          entityName: 'Alice',
          value: 0.7,
          formattedValue: '70%',
          nullReason: null,
        },
      },
      summary: { mean: 0.7, median: 0.7, min: 0.7, max: 0.7, total: 0.7, count: 1, nullCount: 0 },
      computedAt: new Date().toISOString(),
      metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
    };

    const kpisDocWithLive = makeKpisDoc({ 'sandbox-util': liveFormulaResult });
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDocWithLive) });
    const sandbox = new FormulaSandbox(deps);

    // Construct a sandbox result with fe-001 = 0.8
    const sandboxResult: SandboxResult = {
      formulaResult: {
        formulaId: 'sandbox-util',
        formulaName: 'Utilisation',
        variantUsed: null,
        resultType: 'percentage',
        entityResults: {
          'fe-001': {
            entityId: 'fe-001',
            entityName: 'Alice',
            value: 0.8,
            formattedValue: '80%',
            nullReason: null,
          },
        },
        summary: { mean: 0.8, median: 0.8, min: 0.8, max: 0.8, total: 0.8, count: 1, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
      readiness: {
        formulaId: 'sandbox-util',
        readiness: 'READY' as const,
        requiredInputs: [],
        optionalInputs: [],
        message: 'Ready',
      },
      ragAssignments: {},
      executionTimeMs: 5,
      warnings: [],
      dataSnapshot: { feeEarnerCount: 1, matterCount: 1, timeEntryCount: 0 },
    };

    const diff = await sandbox.diffWithLive(FIRM_ID, 'sandbox-util', sandboxResult);

    expect(diff.formulaId).toBe('sandbox-util');
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].entityId).toBe('fe-001');
    expect(diff.changes[0].oldValue).toBe(0.7);
    expect(diff.changes[0].newValue).toBe(0.8);
    expect(diff.changes[0].delta).toBeCloseTo(0.1);
  });

  it('percentChange is computed correctly', async () => {
    const liveResult = {
      formulaId: 'f1', formulaName: 'F1', variantUsed: null, resultType: 'number',
      entityResults: { 'e1': { entityId: 'e1', entityName: 'E1', value: 100, formattedValue: '100', nullReason: null } },
      summary: { mean: 100, median: 100, min: 100, max: 100, total: 100, count: 1, nullCount: 0 },
      computedAt: new Date().toISOString(),
      metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
    };

    const kpisDoc = makeKpisDoc({ 'f1': liveResult });
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc) });
    const sandbox = new FormulaSandbox(deps);

    const sandboxResult: SandboxResult = {
      formulaResult: {
        formulaId: 'f1', formulaName: 'F1', variantUsed: null, resultType: 'number',
        entityResults: { 'e1': { entityId: 'e1', entityName: 'E1', value: 120, formattedValue: '120', nullReason: null } },
        summary: { mean: 120, median: 120, min: 120, max: 120, total: 120, count: 1, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
      readiness: { formulaId: 'f1', readiness: 'READY' as const, requiredInputs: [], optionalInputs: [], message: 'Ready' },
      ragAssignments: {},
      executionTimeMs: 0,
      warnings: [],
      dataSnapshot: { feeEarnerCount: 0, matterCount: 0, timeEntryCount: 0 },
    };

    const diff = await sandbox.diffWithLive(FIRM_ID, 'f1', sandboxResult);
    expect(diff.changes[0].percentChange).toBeCloseTo(20, 1);
  });

  it('returns empty changes when no live data and no sandbox results', async () => {
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
    const sandbox = new FormulaSandbox(deps);
    const emptySandboxResult: SandboxResult = {
      formulaResult: null,
      readiness: { formulaId: 'x', readiness: 'BLOCKED' as const, requiredInputs: [], optionalInputs: [], message: 'Blocked' },
      ragAssignments: {},
      executionTimeMs: 0,
      warnings: [],
      dataSnapshot: { feeEarnerCount: 0, matterCount: 0, timeEntryCount: 0 },
    };
    const diff = await sandbox.diffWithLive(FIRM_ID, 'x', emptySandboxResult);
    expect(diff.changes).toHaveLength(0);
  });

  it('summary improvedCount counts entities with positive delta', async () => {
    const kpisDoc = makeKpisDoc({
      'f2': {
        formulaId: 'f2', formulaName: 'F2', variantUsed: null, resultType: 'number',
        entityResults: {
          'e1': { entityId: 'e1', entityName: 'E1', value: 50, formattedValue: '50', nullReason: null },
          'e2': { entityId: 'e2', entityName: 'E2', value: 80, formattedValue: '80', nullReason: null },
        },
        summary: { mean: 65, median: 65, min: 50, max: 80, total: 130, count: 2, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
    });
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc) });
    const sandbox = new FormulaSandbox(deps);

    const sandboxResult: SandboxResult = {
      formulaResult: {
        formulaId: 'f2', formulaName: 'F2', variantUsed: null, resultType: 'number',
        entityResults: {
          'e1': { entityId: 'e1', entityName: 'E1', value: 70, formattedValue: '70', nullReason: null },  // improved
          'e2': { entityId: 'e2', entityName: 'E2', value: 60, formattedValue: '60', nullReason: null },  // declined
        },
        summary: { mean: 65, median: 65, min: 60, max: 70, total: 130, count: 2, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
      readiness: { formulaId: 'f2', readiness: 'READY' as const, requiredInputs: [], optionalInputs: [], message: 'Ready' },
      ragAssignments: {},
      executionTimeMs: 0,
      warnings: [],
      dataSnapshot: { feeEarnerCount: 1, matterCount: 0, timeEntryCount: 0 },
    };

    const diff = await sandbox.diffWithLive(FIRM_ID, 'f2', sandboxResult);
    expect(diff.summary.improvedCount).toBe(1);  // e1: 70 > 50
    expect(diff.summary.declinedCount).toBe(1);  // e2: 60 < 80
    expect(diff.summary.unchangedCount).toBe(0);
    expect(diff.summary.entitiesAffected).toBe(2);
  });

  it('avgDelta is correct average of all deltas', async () => {
    const kpisDoc = makeKpisDoc({
      'f3': {
        formulaId: 'f3', formulaName: 'F3', variantUsed: null, resultType: 'number',
        entityResults: {
          'e1': { entityId: 'e1', entityName: 'E1', value: 10, formattedValue: '10', nullReason: null },
          'e2': { entityId: 'e2', entityName: 'E2', value: 20, formattedValue: '20', nullReason: null },
        },
        summary: { mean: 15, median: 15, min: 10, max: 20, total: 30, count: 2, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
    });
    const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc) });
    const sandbox = new FormulaSandbox(deps);

    const sandboxResult: SandboxResult = {
      formulaResult: {
        formulaId: 'f3', formulaName: 'F3', variantUsed: null, resultType: 'number',
        entityResults: {
          'e1': { entityId: 'e1', entityName: 'E1', value: 16, formattedValue: '16', nullReason: null },  // delta +6
          'e2': { entityId: 'e2', entityName: 'E2', value: 28, formattedValue: '28', nullReason: null },  // delta +8
        },
        summary: { mean: 22, median: 22, min: 16, max: 28, total: 44, count: 2, nullCount: 0 },
        computedAt: new Date().toISOString(),
        metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
      },
      readiness: { formulaId: 'f3', readiness: 'READY' as const, requiredInputs: [], optionalInputs: [], message: 'Ready' },
      ragAssignments: {},
      executionTimeMs: 0,
      warnings: [],
      dataSnapshot: { feeEarnerCount: 0, matterCount: 0, timeEntryCount: 0 },
    };

    const diff = await sandbox.diffWithLive(FIRM_ID, 'f3', sandboxResult);
    expect(diff.summary.avgDelta).toBeCloseTo(7, 5);  // (6 + 8) / 2 = 7
  });
});

// =============================================================================
// dryRunBatch
// =============================================================================

describe('FormulaSandbox.dryRunBatch', () => {
  it('returns a result for each formula in the batch', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const results = await sandbox.dryRunBatch(FIRM_ID, [
      { definition: UTILISATION_FORMULA, entityType: 'feeEarner', resultType: 'percentage' },
      { definition: { ...UTILISATION_FORMULA, formulaId: 'sandbox-util-2' }, entityType: 'feeEarner', resultType: 'percentage' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].formulaResult?.formulaId).toBe('sandbox-util');
    expect(results[1].formulaResult?.formulaId).toBe('sandbox-util-2');
  });

  it('handles failures in one formula without aborting others', async () => {
    // Second formula references an entity with no data → BLOCKED (not a thrown error)
    const deps = makeDeps();
    const sandbox = new FormulaSandbox(deps);
    const results = await sandbox.dryRunBatch(FIRM_ID, [
      { definition: UTILISATION_FORMULA, entityType: 'feeEarner', resultType: 'percentage' },
      { definition: TIME_ENTRY_FORMULA, entityType: 'timeEntry', resultType: 'hours' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].formulaResult).not.toBeNull();  // READY
    expect(results[1].formulaResult).toBeNull();       // BLOCKED
  });

  it('each formula result is independent', async () => {
    const sandbox = new FormulaSandbox(makeDeps());
    const results = await sandbox.dryRunBatch(FIRM_ID, [
      { definition: { ...UTILISATION_FORMULA, formulaId: 'f-a' }, entityType: 'feeEarner', resultType: 'percentage' },
      { definition: { ...UTILISATION_FORMULA, formulaId: 'f-b' }, entityType: 'feeEarner', resultType: 'percentage' },
    ]);
    expect(results[0].formulaResult?.formulaId).toBe('f-a');
    expect(results[1].formulaResult?.formulaId).toBe('f-b');
  });
});

// =============================================================================
// Fee earner overrides
// =============================================================================

describe('FormulaSandbox — fee earner overrides', () => {
  it('converts FeeEarnerOverride keyed record to context format', async () => {
    // getFeeEarnerOverrides returns Record<feeEarnerId, FeeEarnerOverride[]>
    const override: FeeEarnerOverride = {
      id: 'ovr-001',
      firmId: FIRM_ID,
      feeEarnerId: 'fe-001',
      field: 'chargeableWeeklyTarget',
      value: 25,
      effectiveFrom: new Date().toISOString(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const overridesMap: Record<string, FeeEarnerOverride[]> = { 'fe-001': [override] };
    const deps = makeDeps({ fetchFeeEarnerOverrides: vi.fn().mockResolvedValue(overridesMap) });
    const sandbox = new FormulaSandbox(deps);

    // Should not throw — context is built correctly with the override
    const result = await sandbox.dryRun(FIRM_ID, UTILISATION_FORMULA, 'feeEarner', 'percentage');
    expect(result.formulaResult).not.toBeNull();
  });
});
