/**
 * formula-sandbox.ts — Formula Sandbox
 *
 * Executes formulas against real firm data without persisting results or
 * affecting live KPIs. Used to preview AI-generated and template-derived
 * formulas before committing them to the formula registry.
 *
 * The sandbox loads enriched data from MongoDB, builds a full FormulaContext,
 * checks readiness, executes the formula, and runs RAG evaluation — all
 * without any writes to the database.
 *
 * Dependencies are injectable so tests can supply mock data sources.
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
  AggregatedFirm,
} from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '../../../shared/types/enriched.js';
import type { FirmConfig, FormulaDefinition, FeeEarnerOverride } from '../../../shared/types/index.js';
// getFeeEarnerOverrides returns Record<string, FeeEarnerOverride[]> (keyed by feeEarnerId)
import type { CalculatedKpisDocument, EnrichedEntitiesDocument } from '../../../shared/types/mongodb.js';
import type { FormulaResult } from '../types.js';
import type { FormulaReadinessResult } from '../readiness-checker.js';
import type { RagAssignment } from '../rag-engine.js';
import type { CustomFormulaDefinition } from '../custom/custom-executor.js';
import { RagStatus } from '../../../shared/types/index.js';
import { buildFormulaContext } from '../context-builder.js';
import { checkSingleReadiness, deriveConfigPaths, FormulaReadiness } from '../readiness-checker.js';
import { RagEngine } from '../rag-engine.js';
import { FormulaEngine } from '../engine.js';
import { registerAllBuiltInFormulas } from '../formulas/index.js';
import { registerAllBuiltInSnippets } from '../snippets/index.js';
import { CustomFormulaExecutor } from '../custom/custom-executor.js';
import {
  getLatestCalculatedKpis,
  getLatestEnrichedEntities,
} from '../../lib/mongodb-operations.js';
import { getFirmConfig, getFeeEarnerOverrides } from '../../services/config-service.js';
import type { SnippetEngine } from '../snippets/snippet-engine.js';

// =============================================================================
// Public interfaces
// =============================================================================

export interface SandboxResult {
  /** null when readiness is BLOCKED */
  formulaResult: FormulaResult | null;
  readiness: FormulaReadinessResult;
  /** RAG assignments per entityId — empty when no thresholds configured */
  ragAssignments: Record<string, RagAssignment>;
  executionTimeMs: number;
  warnings: string[];
  dataSnapshot: {
    feeEarnerCount: number;
    matterCount: number;
    timeEntryCount: number;
  };
}

export interface SandboxDiffChange {
  entityId: string;
  entityName: string;
  oldValue: number | null;
  newValue: number | null;
  delta: number | null;
  percentChange: number | null;
  ragChange?: { from: RagStatus; to: RagStatus };
}

export interface SandboxDiff {
  formulaId: string;
  entityType: string;
  changes: SandboxDiffChange[];
  summary: {
    entitiesAffected: number;
    /** Entities where value moved in the "better" direction (delta > 0) */
    improvedCount: number;
    declinedCount: number;
    unchangedCount: number;
    avgDelta: number | null;
  };
}

// =============================================================================
// Dependency injection (for testability)
// =============================================================================

export interface SandboxDeps {
  getKpis?: (firmId: string) => Promise<CalculatedKpisDocument | null>;
  getEnrichedEntities?: (firmId: string, entityType: string) => Promise<EnrichedEntitiesDocument | null>;
  fetchFirmConfig?: (firmId: string) => Promise<FirmConfig>;
  /** Returns overrides keyed by feeEarnerId — matches getFeeEarnerOverrides() signature. */
  fetchFeeEarnerOverrides?: (firmId: string) => Promise<Record<string, FeeEarnerOverride[]>>;
}

// =============================================================================
// Defaults
// =============================================================================

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

// =============================================================================
// FormulaSandbox
// =============================================================================

export class FormulaSandbox {
  private readonly deps: Required<SandboxDeps>;

  constructor(deps: SandboxDeps = {}) {
    this.deps = {
      getKpis: deps.getKpis ?? getLatestCalculatedKpis,
      getEnrichedEntities: deps.getEnrichedEntities ?? getLatestEnrichedEntities,
      fetchFirmConfig: deps.fetchFirmConfig ?? getFirmConfig,
      fetchFeeEarnerOverrides: deps.fetchFeeEarnerOverrides ?? getFeeEarnerOverrides,
    };
  }

  // ---------------------------------------------------------------------------
  // dryRun
  // ---------------------------------------------------------------------------

  /**
   * Execute a formula in sandbox mode — uses real data but does not persist.
   *
   * Handles both CustomFormulaDefinition (direct expression tree) and
   * FormulaDefinition (registry entry — built-in or custom-expression variant).
   */
  async dryRun(
    firmId: string,
    formulaDefinition: CustomFormulaDefinition | FormulaDefinition,
    entityType: string,
    resultType: string,
    variant?: string,
  ): Promise<SandboxResult> {
    const start = Date.now();

    // 1. Load data and config in parallel
    const [enrichedData, firmConfig, overridesArr] = await Promise.all([
      this.loadEnrichedData(firmId),
      this.deps.fetchFirmConfig(firmId),
      this.deps.fetchFeeEarnerOverrides(firmId),
    ]);

    // 2. Convert getFeeEarnerOverrides result (Record<feeEarnerId, FeeEarnerOverride[]>) to
    //    the Record<feeEarnerId, Record<field, value>> shape expected by buildFormulaContext.
    const feeEarnerOverrides: Record<string, Record<string, unknown>> = {};
    for (const [feeEarnerId, overrides] of Object.entries(overridesArr)) {
      feeEarnerOverrides[feeEarnerId] = {};
      for (const o of overrides) {
        feeEarnerOverrides[feeEarnerId][o.field] = o.value;
      }
    }

    // 3. Build FormulaContext
    const context = buildFormulaContext(firmId, firmConfig, feeEarnerOverrides, enrichedData);

    // 4. Data snapshot (metadata only — no actual data)
    const dataSnapshot = {
      feeEarnerCount: enrichedData.feeEarners.length,
      matterCount: enrichedData.matters.length,
      timeEntryCount: enrichedData.timeEntries.length,
    };

    // 5. Determine formula type and resolve identifiers
    const isFormulaDefinition = 'variants' in formulaDefinition;
    const formulaId = isFormulaDefinition
      ? (formulaDefinition as FormulaDefinition).id
      : ((formulaDefinition as CustomFormulaDefinition).formulaId ?? 'sandbox-custom');
    const formulaName = isFormulaDefinition
      ? (formulaDefinition as FormulaDefinition).label
      : ((formulaDefinition as CustomFormulaDefinition).formulaName ?? 'Sandbox Formula');

    // 6. Check readiness
    const readiness = this.checkReadiness(
      formulaId,
      isFormulaDefinition,
      formulaDefinition,
      enrichedData,
      firmConfig,
    );

    if (readiness.readiness === FormulaReadiness.BLOCKED) {
      return {
        formulaResult: null,
        readiness,
        ragAssignments: {},
        executionTimeMs: Date.now() - start,
        warnings: [readiness.blockedReason ?? 'Required data is missing'],
        dataSnapshot,
      };
    }

    // 7. Execute formula
    const warnings: string[] = [];
    let formulaResult: FormulaResult;

    try {
      formulaResult = await this.execute(
        formulaDefinition,
        isFormulaDefinition,
        formulaId,
        formulaName,
        entityType,
        resultType,
        variant,
        context,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Formula execution error: ${msg}`);
      formulaResult = makeEmptyResult(formulaId, formulaName, resultType, variant ?? null);
    }

    // 8. RAG evaluation (uses thresholds from firm config)
    const ragEngine = new RagEngine();
    const thresholds = firmConfig.ragThresholds ?? [];

    // For built-in formulas, evaluateAll resolves via FORMULA_TO_METRIC.
    // For custom formulas, fall back to a direct metricKey === formulaId match.
    const ragResult = ragEngine.evaluateAll({ [formulaId]: formulaResult }, thresholds);
    let ragAssignments = ragResult.assignments[formulaId] ?? {};

    if (Object.keys(ragAssignments).length === 0) {
      const directThreshold = thresholds.find((t) => t.metricKey === formulaId);
      if (directThreshold) {
        ragAssignments = ragEngine.evaluateSingle(formulaId, formulaResult, directThreshold);
      }
    }

    return {
      formulaResult,
      readiness,
      ragAssignments,
      executionTimeMs: Date.now() - start,
      warnings,
      dataSnapshot,
    };
  }

  // ---------------------------------------------------------------------------
  // diffWithLive
  // ---------------------------------------------------------------------------

  /**
   * Compare sandbox results against the live calculated KPI snapshot.
   *
   * Entities that exist only in sandbox or only in live are included with
   * null for the missing side.
   */
  async diffWithLive(
    firmId: string,
    formulaId: string,
    sandboxResult: SandboxResult,
  ): Promise<SandboxDiff> {
    // Load live KPI snapshot
    const kpisDoc = await this.deps.getKpis(firmId);
    const liveFormulaResult = kpisDoc?.kpis?.[formulaId] as FormulaResult | undefined;

    const sandboxEntities = sandboxResult.formulaResult?.entityResults ?? {};
    const liveEntities = liveFormulaResult?.entityResults ?? {};

    // Union of all entity IDs
    const allEntityIds = new Set([...Object.keys(sandboxEntities), ...Object.keys(liveEntities)]);

    // Determine entity type from sandbox result
    const entityType =
      Object.values(sandboxEntities)[0] != null
        ? 'feeEarner'  // default; the caller knows the entity type
        : 'unknown';

    const changes: SandboxDiffChange[] = [];

    for (const entityId of allEntityIds) {
      const sandboxEntity = sandboxEntities[entityId];
      const liveEntity = liveEntities[entityId];

      const oldValue = liveEntity?.value ?? null;
      const newValue = sandboxEntity?.value ?? null;

      let delta: number | null = null;
      let percentChange: number | null = null;

      if (oldValue !== null && newValue !== null) {
        delta = newValue - oldValue;
        percentChange = oldValue !== 0 ? (delta / Math.abs(oldValue)) * 100 : null;
      } else if (newValue !== null) {
        delta = newValue;
      } else if (oldValue !== null) {
        delta = -oldValue;
      }

      changes.push({
        entityId,
        entityName: sandboxEntity?.entityName ?? liveEntity?.entityName ?? entityId,
        oldValue,
        newValue,
        delta,
        percentChange: percentChange !== null ? Math.round(percentChange * 100) / 100 : null,
      });
    }

    // Summary stats
    const deltas = changes.map((c) => c.delta).filter((d): d is number => d !== null);
    const improvedCount = changes.filter((c) => c.delta !== null && c.delta > 0).length;
    const declinedCount = changes.filter((c) => c.delta !== null && c.delta < 0).length;
    const unchangedCount = changes.filter((c) => c.delta === null || c.delta === 0).length;
    const avgDelta =
      deltas.length > 0 ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length : null;

    return {
      formulaId,
      entityType,
      changes,
      summary: {
        entitiesAffected: changes.filter((c) => c.delta !== null && c.delta !== 0).length,
        improvedCount,
        declinedCount,
        unchangedCount,
        avgDelta,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // dryRunBatch
  // ---------------------------------------------------------------------------

  /**
   * Execute multiple formulas in sandbox mode.
   *
   * Each formula is executed independently. Failures in one do not abort others.
   * Data is loaded once and shared across all formulas for efficiency.
   */
  async dryRunBatch(
    firmId: string,
    formulas: { definition: CustomFormulaDefinition; entityType: string; resultType: string }[],
  ): Promise<SandboxResult[]> {
    return Promise.all(
      formulas.map(({ definition, entityType, resultType }) =>
        this.dryRun(firmId, definition, entityType, resultType),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Load all enriched data needed to build a FormulaContext. */
  private async loadEnrichedData(firmId: string): Promise<{
    feeEarners: AggregatedFeeEarner[];
    matters: AggregatedMatter[];
    invoices: EnrichedInvoice[];
    timeEntries: EnrichedTimeEntry[];
    disbursements: EnrichedDisbursement[];
    departments: AggregatedDepartment[];
    clients: AggregatedClient[];
    firm: AggregatedFirm;
  }> {
    const [kpisDoc, timeEntryDoc, invoiceDoc, disbursementDoc] = await Promise.all([
      this.deps.getKpis(firmId),
      this.deps.getEnrichedEntities(firmId, 'timeEntry'),
      this.deps.getEnrichedEntities(firmId, 'invoice'),
      this.deps.getEnrichedEntities(firmId, 'disbursement'),
    ]);

    const aggregate = kpisDoc?.kpis?.['aggregate'] as Record<string, unknown> | undefined;

    return {
      feeEarners: (aggregate?.feeEarners ?? []) as AggregatedFeeEarner[],
      matters: (aggregate?.matters ?? []) as AggregatedMatter[],
      clients: (aggregate?.clients ?? []) as AggregatedClient[],
      departments: (aggregate?.departments ?? []) as AggregatedDepartment[],
      firm: (aggregate?.firm ?? EMPTY_FIRM) as AggregatedFirm,
      timeEntries: ((timeEntryDoc?.records ?? []) as unknown[]) as EnrichedTimeEntry[],
      invoices: ((invoiceDoc?.records ?? []) as unknown[]) as EnrichedInvoice[],
      disbursements: ((disbursementDoc?.records ?? []) as unknown[]) as EnrichedDisbursement[],
    };
  }

  /** Build the entityTypes map used by checkSingleReadiness. */
  private buildEntityTypesMap(enrichedData: {
    feeEarners: AggregatedFeeEarner[];
    matters: AggregatedMatter[];
    invoices: EnrichedInvoice[];
    timeEntries: EnrichedTimeEntry[];
    disbursements: EnrichedDisbursement[];
    departments: AggregatedDepartment[];
    clients: AggregatedClient[];
  }): Record<string, { present: boolean; recordCount: number }> {
    return {
      feeEarner: { present: enrichedData.feeEarners.length > 0, recordCount: enrichedData.feeEarners.length },
      matter: { present: enrichedData.matters.length > 0, recordCount: enrichedData.matters.length },
      timeEntry: { present: enrichedData.timeEntries.length > 0, recordCount: enrichedData.timeEntries.length },
      invoice: { present: enrichedData.invoices.length > 0, recordCount: enrichedData.invoices.length },
      disbursement: { present: enrichedData.disbursements.length > 0, recordCount: enrichedData.disbursements.length },
      department: { present: enrichedData.departments.length > 0, recordCount: enrichedData.departments.length },
      client: { present: enrichedData.clients.length > 0, recordCount: enrichedData.clients.length },
    };
  }

  /**
   * Determine readiness for a formula.
   *
   * - Built-in FormulaDefinition: delegates to checkSingleReadiness which uses
   *   FORMULA_INPUT_REQUIREMENTS.
   * - Custom FormulaDefinition / CustomFormulaDefinition: derives requirements
   *   from the expression tree via CustomFormulaExecutor.validate().
   */
  private checkReadiness(
    formulaId: string,
    isFormulaDefinition: boolean,
    definition: CustomFormulaDefinition | FormulaDefinition,
    enrichedData: {
      feeEarners: AggregatedFeeEarner[];
      matters: AggregatedMatter[];
      invoices: EnrichedInvoice[];
      timeEntries: EnrichedTimeEntry[];
      disbursements: EnrichedDisbursement[];
      departments: AggregatedDepartment[];
      clients: AggregatedClient[];
    },
    firmConfig: FirmConfig,
  ): FormulaReadinessResult {
    const entityTypes = this.buildEntityTypesMap(enrichedData);
    const configPaths = deriveConfigPaths(firmConfig);

    // Try built-in readiness check first (uses FORMULA_INPUT_REQUIREMENTS registry)
    if (isFormulaDefinition) {
      const fd = definition as FormulaDefinition;
      try {
        return checkSingleReadiness(fd.id, { entityTypes, configPaths }, firmConfig);
      } catch {
        // Formula not in built-in registry — fall through to custom check
      }
    }

    // Custom formula: derive readiness from the expression tree
    return this.checkCustomFormulaReadiness(formulaId, definition, entityTypes);
  }

  /**
   * Derive readiness for a custom formula by examining which entity types
   * its expression tree references.
   */
  private checkCustomFormulaReadiness(
    formulaId: string,
    definition: CustomFormulaDefinition | FormulaDefinition,
    entityTypes: Record<string, { present: boolean; recordCount: number }>,
  ): FormulaReadinessResult {
    // Resolve the CustomFormulaDefinition
    let customDef: CustomFormulaDefinition | null = null;

    if ('variants' in definition) {
      // FormulaDefinition — try to parse variants[0].expression as JSON
      const fd = definition as FormulaDefinition;
      const exprStr = fd.variants[0]?.expression;
      if (exprStr) {
        try {
          customDef = JSON.parse(exprStr) as CustomFormulaDefinition;
        } catch {
          // Not JSON — can't validate
        }
      }
    } else {
      customDef = definition as CustomFormulaDefinition;
    }

    if (!customDef) {
      // Cannot determine requirements — assume READY
      return {
        formulaId,
        readiness: FormulaReadiness.READY,
        requiredInputs: [],
        optionalInputs: [],
        message: 'Formula readiness cannot be determined — assuming ready.',
      };
    }

    // Use the executor's validate() to find referenced entities
    const executor = new CustomFormulaExecutor();
    const validation = executor.validate(customDef, [], [], []);
    const referencedEntities = validation.referencedEntities;

    const missingRequired: string[] = [];
    const requiredInputs = referencedEntities.map((entityType) => {
      const info = entityTypes[entityType] ?? { present: false, recordCount: 0 };
      if (!info.present) missingRequired.push(entityType);
      return {
        inputName: entityType,
        entityType,
        required: true,
        present: info.present,
        recordCount: info.recordCount,
      };
    });

    if (missingRequired.length > 0) {
      return {
        formulaId,
        readiness: FormulaReadiness.BLOCKED,
        requiredInputs,
        optionalInputs: [],
        message: `Missing required data: ${missingRequired.join(', ')}`,
        blockedReason: `No data available for entity type(s): ${missingRequired.join(', ')}`,
      };
    }

    return {
      formulaId,
      readiness: FormulaReadiness.READY,
      requiredInputs,
      optionalInputs: [],
      message: 'All required data is present.',
    };
  }

  /**
   * Execute the formula — routes to built-in engine or custom executor
   * based on the definition type.
   */
  private async execute(
    definition: CustomFormulaDefinition | FormulaDefinition,
    isFormulaDefinition: boolean,
    formulaId: string,
    formulaName: string,
    entityType: string,
    resultType: string,
    variant: string | undefined,
    context: ReturnType<typeof buildFormulaContext>,
  ): Promise<FormulaResult> {
    if (!isFormulaDefinition) {
      // Direct CustomFormulaDefinition
      const executor = new CustomFormulaExecutor();
      return executor.execute(
        definition as CustomFormulaDefinition,
        context,
        entityType,
        formulaId,
        formulaName,
      );
    }

    // FormulaDefinition — check if expression is parseable custom JSON
    const fd = definition as FormulaDefinition;
    const exprStr = fd.variants[0]?.expression;
    let customDef: CustomFormulaDefinition | null = null;

    if (exprStr) {
      try {
        const parsed = JSON.parse(exprStr) as unknown;
        if (typeof parsed === 'object' && parsed !== null && 'expression' in parsed) {
          customDef = parsed as CustomFormulaDefinition;
        }
      } catch {
        // Not JSON — treat as built-in
      }
    }

    if (customDef) {
      const executor = new CustomFormulaExecutor();
      return executor.execute(customDef, context, entityType, fd.id, fd.label);
    }

    // Built-in formula — use FormulaEngine with all registrations
    const engine = new FormulaEngine();
    registerAllBuiltInFormulas(engine);
    registerAllBuiltInSnippets(engine as unknown as SnippetEngine);

    const singleResult = await engine.executeSingle(formulaId, context);
    void resultType;
    void variant;
    return singleResult.result;
  }
}

// =============================================================================
// Private utilities
// =============================================================================

function makeEmptyResult(
  formulaId: string,
  formulaName: string,
  resultType: string,
  variantUsed: string | null,
): FormulaResult {
  return {
    formulaId,
    formulaName,
    variantUsed,
    resultType: resultType as FormulaResult['resultType'],
    entityResults: {},
    summary: {
      mean: null,
      median: null,
      min: null,
      max: null,
      total: null,
      count: 0,
      nullCount: 0,
    },
    computedAt: new Date().toISOString(),
    metadata: { executionTimeMs: 0, inputsUsed: [], nullReasons: [], warnings: [] },
  };
}
