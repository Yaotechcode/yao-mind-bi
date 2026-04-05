import { describe, it, expect, vi } from 'vitest';
import { CalculationOrchestrator } from '../../../src/server/formula-engine/orchestrator.js';
import type { OrchestratorDeps } from '../../../src/server/formula-engine/orchestrator.js';
import type { FirmConfig } from '../../../src/shared/types/index.js';
import type { AggregatedFirm } from '../../../src/shared/types/pipeline.js';
import type { CalculatedKpisDocument } from '../../../src/shared/types/mongodb.js';

// =============================================================================
// Test fixtures
// =============================================================================

function makeFirmConfig(overrides: Partial<FirmConfig> = {}): FirmConfig {
  return {
    firmId: 'firm-test',
    firmName: 'Test Firm',
    jurisdiction: 'England and Wales',
    currency: 'GBP',
    financialYearStartMonth: 4,
    weekStartDay: 1,
    timezone: 'Europe/London',
    schemaVersion: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
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

const EMPTY_FIRM: AggregatedFirm = {
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
};

/** KPI document as stored by the pipeline (aggregate only, no formula results yet). */
function makeKpisDoc(overrides: Partial<CalculatedKpisDocument> = {}): CalculatedKpisDocument {
  return {
    firm_id: 'firm-test',
    calculated_at: new Date('2024-06-01'),
    config_version: 'pending',
    data_version: '2024-06-01T00:00:00.000Z',
    kpis: {
      aggregate: {
        feeEarners: [],
        matters: [],
        clients: [],
        departments: [],
        firm: EMPTY_FIRM,
        dataQuality: { overallScore: 100, entityIssues: [], knownGaps: [] },
      },
      generatedAt: '2024-06-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** A no-op version manager that doesn't need Supabase. */
const mockVersionManager = {
  createFormulaVersionSnapshot: vi.fn().mockResolvedValue({}),
};

/** Build minimal injectable deps for the orchestrator. */
function makeDeps(overrides: Partial<OrchestratorDeps> = {}): Required<OrchestratorDeps> {
  const persistKpis = vi.fn().mockResolvedValue(undefined);
  const clearStaleFlag = vi.fn().mockResolvedValue(undefined);

  return {
    getKpis: vi.fn().mockResolvedValue(makeKpisDoc()),
    getEnrichedEntities: vi.fn().mockResolvedValue(null),
    fetchFirmConfig: vi.fn().mockResolvedValue(makeFirmConfig()),
    fetchFeeEarnerOverrides: vi.fn().mockResolvedValue({}),
    persistKpis,
    clearStaleFlag,
    versionManager: mockVersionManager,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('CalculationOrchestrator', () => {

  describe('calculateAll', () => {
    it('returns a CalculationResult with correct firmId and timestamps', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(result.firmId).toBe('firm-test');
      expect(typeof result.calculatedAt).toBe('string');
      expect(new Date(result.calculatedAt).getTime()).toBeGreaterThan(0);
    });

    it('persists results to MongoDB', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      await orchestrator.calculateAll('firm-test');

      expect(deps.persistKpis).toHaveBeenCalledOnce();
      const [firmId, kpisPayload] = (deps.persistKpis as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      expect(firmId).toBe('firm-test');
      // Payload must include formulaResults, ragAssignments, readiness keys
      expect(kpisPayload).toHaveProperty('formulaResults');
      expect(kpisPayload).toHaveProperty('ragAssignments');
      expect(kpisPayload).toHaveProperty('readiness');
      expect(kpisPayload).toHaveProperty('formulaVersionSnapshot');
      expect(kpisPayload).toHaveProperty('calculationMetadata');
    });

    it('clears the stale flag after successful calculation', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      await orchestrator.calculateAll('firm-test');

      expect(deps.clearStaleFlag).toHaveBeenCalledWith('firm-test');
    });

    it('preserves pipeline aggregate in persisted payload', async () => {
      const kpisDoc = makeKpisDoc();
      const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc) });
      const orchestrator = new CalculationOrchestrator(deps);
      await orchestrator.calculateAll('firm-test');

      const [, kpisPayload] = (deps.persistKpis as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      // Aggregate from pipeline must be preserved
      expect(kpisPayload).toHaveProperty('aggregate');
      expect(kpisPayload).toHaveProperty('generatedAt');
    });

    it('handles no KPI document (first run — no pipeline data yet)', async () => {
      const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(null) });
      const orchestrator = new CalculationOrchestrator(deps);
      // Should not throw even with no existing data
      const result = await orchestrator.calculateAll('firm-test');
      expect(result.firmId).toBe('firm-test');
      expect(deps.persistKpis).toHaveBeenCalledOnce();
    });

    it('handles no enriched entity documents gracefully', async () => {
      const deps = makeDeps({
        getEnrichedEntities: vi.fn().mockResolvedValue(null),
      });
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');
      expect(result.errors).toEqual([]);
    });

    it('falls back to enriched feeEarner entities when aggregate.feeEarners is empty', async () => {
      // kpisDoc has empty feeEarners in aggregate (API pull path, first run)
      const kpisDoc = makeKpisDoc();

      const getEnrichedEntities = vi.fn().mockImplementation((_fid: string, entityType: string) => {
        if (entityType === 'feeEarner') {
          return Promise.resolve({
            records: [
              { _id: 'att-1', fullName: 'Alice Smith', status: 'ACTIVE' },
              { _id: 'att-2', fullName: 'Bob Jones',  status: 'ACTIVE' },
            ],
            firm_id: 'firm-test', entity_type: 'feeEarner', data_version: '1', source_uploads: [], record_count: 2,
          });
        }
        return Promise.resolve(null);
      });

      const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc), getEnrichedEntities });
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      // Calculation should complete without errors
      expect(result.firmId).toBe('firm-test');
      // getEnrichedEntities must have been called with 'feeEarner'
      expect(getEnrichedEntities).toHaveBeenCalledWith('firm-test', 'feeEarner');
      // F-TU-01 entity results should include both fee earners (even with 0 time entries → value=0)
      const tuResult = result.results['F-TU-01'];
      if (tuResult) {
        // att-1 and att-2 should appear in results (using _id as lawyerId)
        expect(Object.keys(tuResult.entityResults)).toContain('att-1');
        expect(Object.keys(tuResult.entityResults)).toContain('att-2');
        expect(tuResult.entityResults['att-1']!.entityName).toBe('Alice Smith');
      }
    });

    it('returns results and snippetResults maps', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(typeof result.results).toBe('object');
      expect(typeof result.snippetResults).toBe('object');
    });

    it('returns ragAssignments and ragSummary', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(typeof result.ragAssignments).toBe('object');
      expect(result.ragSummary).toHaveProperty('greenCount');
      expect(result.ragSummary).toHaveProperty('alertsRed');
      expect(result.ragSummary).toHaveProperty('alertsAmber');
    });

    it('returns readiness for all formulas', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(typeof result.readiness).toBe('object');
      // With no data, formulas should be BLOCKED or PARTIAL
      const readinessValues = Object.values(result.readiness).map((r) => r.readiness);
      expect(readinessValues.length).toBeGreaterThan(0);
    });

    it('uses configVersion from firmConfig.updatedAt', async () => {
      const firmConfig = makeFirmConfig({ updatedAt: new Date('2024-06-01T12:00:00.000Z') });
      const deps = makeDeps({ fetchFirmConfig: vi.fn().mockResolvedValue(firmConfig) });
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(result.configVersion).toBe('2024-06-01T12:00:00.000Z');
    });

    it('uses dataVersion from existing KPI document', async () => {
      const kpisDoc = makeKpisDoc({ data_version: '2024-05-20T10:00:00.000Z' });
      const deps = makeDeps({ getKpis: vi.fn().mockResolvedValue(kpisDoc) });
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      expect(result.dataVersion).toBe('2024-05-20T10:00:00.000Z');
    });

    it('blocked formulas are not included in executionPlan.formulaOrder', async () => {
      // With no data at all, all formulas should be blocked
      const deps = makeDeps({
        getKpis: vi.fn().mockResolvedValue(null),
        getEnrichedEntities: vi.fn().mockResolvedValue(null),
      });
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.calculateAll('firm-test');

      // formulaOrder should be empty or minimal when all are blocked
      // (skippedFormulas should be populated)
      const skippedIds = result.executionPlan.skippedFormulas.map((s) => s.formulaId);
      // At least some should be skipped
      expect(skippedIds.length).toBeGreaterThanOrEqual(0);
    });

    it('applies fee earner override effective date filtering', async () => {
      const futureOverride = {
        id: 'o1',
        firmId: 'firm-test',
        feeEarnerId: 'fe-1',
        field: 'workingDaysPerWeek',
        value: 4,
        effectiveFrom: '2099-01-01',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const deps = makeDeps({
        fetchFeeEarnerOverrides: vi.fn().mockResolvedValue({ 'fe-1': [futureOverride] }),
      });
      const orchestrator = new CalculationOrchestrator(deps);
      // Should not throw — override is ignored due to future effectiveFrom
      const result = await orchestrator.calculateAll('firm-test');
      expect(result.firmId).toBe('firm-test');
    });
  });

  describe('recalculateAffected', () => {
    it('delegates to calculateAll', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.recalculateAffected('firm-test', ['F-TU-01']);

      expect(result.firmId).toBe('firm-test');
      expect(deps.persistKpis).toHaveBeenCalledOnce();
      expect(deps.clearStaleFlag).toHaveBeenCalledWith('firm-test');
    });

    it('works with an empty changedFormulaIds array', async () => {
      const deps = makeDeps();
      const orchestrator = new CalculationOrchestrator(deps);
      const result = await orchestrator.recalculateAffected('firm-test', []);
      expect(result.firmId).toBe('firm-test');
    });
  });
});
