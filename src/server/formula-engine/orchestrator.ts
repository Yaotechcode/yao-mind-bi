/**
 * orchestrator.ts — Calculation Orchestrator
 *
 * Ties together the entire formula engine pipeline:
 *   1. Load enriched data + firm config from MongoDB/Supabase
 *   2. Check formula readiness
 *   3. Build FormulaContext
 *   4. Take a formula version snapshot
 *   5. Execute all snippets and formulas in dependency order
 *   6. Run RAG evaluation
 *   7. Persist the complete result to MongoDB
 *   8. Clear the stale flag
 *
 * Dependencies are injectable for deterministic testing.
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
  AggregatedFirm,
} from '../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '../../shared/types/enriched.js';
import type { FirmConfig, FeeEarnerOverride } from '../../shared/types/index.js';
import type { CalculatedKpisDocument, EnrichedEntitiesDocument } from '../../shared/types/mongodb.js';
import { FormulaEngine } from './engine.js';
import { registerAllBuiltInFormulas } from './formulas/index.js';
import { registerAllBuiltInSnippets } from './snippets/index.js';
import type { SnippetEngine } from './snippets/snippet-engine.js';
import { buildFormulaContext } from './context-builder.js';
import {
  checkAllReadiness,
  deriveConfigPaths,
  FormulaReadiness,
} from './readiness-checker.js';
import type { FormulaReadinessResult } from './readiness-checker.js';
import { RagEngine } from './rag-engine.js';
import type { RagAssignment, RagEngineResult } from './rag-engine.js';
import { FormulaVersionManager } from './version-manager.js';
import type { FormulaVersionSnapshot } from './version-manager.js';
import { getBuiltInFormulaDefinitions } from '../../shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../../shared/formulas/built-in-snippets.js';
import type { FormulaResult, ExecutionPlan, SnippetResult } from './types.js';
import {
  getLatestCalculatedKpis,
  getLatestEnrichedEntities,
  storeCalculatedKpis,
  clearRecalculationFlag,
} from '../lib/mongodb-operations.js';
import { getFirmConfig, getFeeEarnerOverrides } from '../services/config-service.js';
import { buildSnapshotsFromKpiResults } from '../datasource/enrich/kpi-snapshot-builder.js';
import { writeKpiSnapshots } from '../services/kpi-snapshot-service.js';
import { scanForRiskFlags } from '../datasource/enrich/risk-scanner.js';
import { storeRiskFlags } from '../lib/mongodb-operations.js';

// =============================================================================
// Public types
// =============================================================================

export interface CalculationResult {
  firmId: string;
  calculatedAt: string;
  configVersion: string;
  dataVersion: string;
  formulaVersionSnapshot: FormulaVersionSnapshot;
  results: Record<string, FormulaResult>;
  snippetResults: Record<string, Record<string, SnippetResult>>;
  ragAssignments: Record<string, Record<string, RagAssignment>>;
  ragSummary: RagEngineResult['summary'] & {
    alertsRed: RagEngineResult['alertsRed'];
    alertsAmber: RagEngineResult['alertsAmber'];
  };
  readiness: Record<string, FormulaReadinessResult>;
  executionPlan: ExecutionPlan;
  totalExecutionTimeMs: number;
  formulaCount: number;
  successCount: number;
  errorCount: number;
  errors: { formulaId: string; error: string }[];
}

// =============================================================================
// Injectable dependencies
// =============================================================================

export interface OrchestratorDeps {
  getKpis?: (firmId: string) => Promise<CalculatedKpisDocument | null>;
  getEnrichedEntities?: (firmId: string, entityType: string) => Promise<EnrichedEntitiesDocument | null>;
  fetchFirmConfig?: (firmId: string) => Promise<FirmConfig>;
  fetchFeeEarnerOverrides?: (firmId: string) => Promise<Record<string, FeeEarnerOverride[]>>;
  persistKpis?: (firmId: string, kpis: Record<string, unknown>, configVersion: string, dataVersion: string) => Promise<void>;
  clearStaleFlag?: (firmId: string) => Promise<void>;
  /** Optional injectable version manager (primarily for testing). */
  versionManager?: Pick<FormulaVersionManager, 'createFormulaVersionSnapshot'>;
  /** Optional injectable kpi snapshot writer (primarily for testing). */
  writeSnapshots?: (firmId: string, rows: import('../services/kpi-snapshot-service.js').KpiSnapshotRow[]) => Promise<void>;
  /** Optional injectable risk flag writer (primarily for testing). */
  writeRiskFlags?: (firmId: string, flags: import('../../shared/types/mongodb.js').RiskFlagDocument[]) => Promise<void>;
}

// =============================================================================
// Empty firm sentinel
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
// CalculationOrchestrator
// =============================================================================

export class CalculationOrchestrator {
  private readonly deps: Required<OrchestratorDeps>;
  private readonly versionManager: FormulaVersionManager;

  constructor(deps: OrchestratorDeps = {}) {
    this.deps = {
      getKpis: deps.getKpis ?? getLatestCalculatedKpis,
      getEnrichedEntities: deps.getEnrichedEntities ?? getLatestEnrichedEntities,
      fetchFirmConfig: deps.fetchFirmConfig ?? getFirmConfig,
      fetchFeeEarnerOverrides: deps.fetchFeeEarnerOverrides ?? getFeeEarnerOverrides,
      persistKpis: deps.persistKpis ?? storeCalculatedKpis,
      clearStaleFlag: deps.clearStaleFlag ?? clearRecalculationFlag,
      versionManager: deps.versionManager ?? new FormulaVersionManager(),
      writeSnapshots: deps.writeSnapshots ?? writeKpiSnapshots,
      writeRiskFlags: deps.writeRiskFlags ?? storeRiskFlags,
    };
    // versionManager is stored in deps so tests can inject a mock without needing Supabase
    this.versionManager = this.deps.versionManager as FormulaVersionManager;
  }

  // ---------------------------------------------------------------------------
  // calculateAll
  // ---------------------------------------------------------------------------

  /**
   * Run the complete calculation pipeline for a firm.
   *
   * Steps (in order):
   *   1. Load enriched data (aggregate + time entries/invoices/disbursements)
   *   2. Load firm config and fee earner overrides
   *   3. Build formula context
   *   4. Check readiness for all formulas
   *   5. Take a formula version snapshot
   *   6. Build execution plan (skipping BLOCKED formulas)
   *   7. Execute all snippets and formulas
   *   8. Run RAG evaluation
   *   9. Persist complete results to MongoDB
   *  10. Clear the stale flag
   */
  async calculateAll(firmId: string): Promise<CalculationResult> {
    const start = Date.now();

    // -------------------------------------------------------------------------
    // 1. Load data + config in parallel
    // -------------------------------------------------------------------------
    const [enrichedData, firmConfig, overridesArr] = await Promise.all([
      this.loadEnrichedData(firmId),
      this.deps.fetchFirmConfig(firmId),
      this.deps.fetchFeeEarnerOverrides(firmId),
    ]);

    const configVersion = firmConfig.updatedAt instanceof Date
      ? firmConfig.updatedAt.toISOString()
      : (typeof firmConfig.updatedAt === 'string' ? firmConfig.updatedAt : new Date().toISOString());

    // Prefer the data_version from the stored KPI document (set by the pipeline).
    const kpisDoc = await this.deps.getKpis(firmId);
    const dataVersion = kpisDoc?.data_version ?? new Date().toISOString();

    // -------------------------------------------------------------------------
    // 2. Convert fee earner overrides to field-keyed record
    // -------------------------------------------------------------------------
    const feeEarnerOverrides = this.buildOverridesMap(overridesArr, firmConfig);

    // -------------------------------------------------------------------------
    // 3. Build FormulaContext
    // -------------------------------------------------------------------------
    const context = buildFormulaContext(firmId, firmConfig, feeEarnerOverrides, enrichedData);

    // -------------------------------------------------------------------------
    // 4. Check readiness
    // -------------------------------------------------------------------------
    const formulaDefinitions = getBuiltInFormulaDefinitions();
    const snippetDefinitions = getBuiltInSnippetDefinitions();

    const entityTypes = this.buildEntityTypesMap(enrichedData);
    const configPaths = deriveConfigPaths(firmConfig);
    const readiness = checkAllReadiness(formulaDefinitions, snippetDefinitions, { entityTypes, configPaths }, firmConfig);

    // -------------------------------------------------------------------------
    // 5. Formula version snapshot
    // -------------------------------------------------------------------------
    const allFormulaIds = [
      ...formulaDefinitions.map((f) => f.formulaId),
      ...snippetDefinitions.map((s) => s.snippetId),
    ];
    const formulaVersionSnapshot = await this.versionManager.createFormulaVersionSnapshot(firmId, allFormulaIds);

    // -------------------------------------------------------------------------
    // 6. Setup engine + build execution plan (skip BLOCKED formulas)
    // -------------------------------------------------------------------------
    const engine = new FormulaEngine();
    registerAllBuiltInFormulas(engine);
    // Cast: FormulaEngine and SnippetEngine share the registerSnippet API;
    // TypeScript's private-field nominalism prevents direct assignment.
    registerAllBuiltInSnippets(engine as unknown as SnippetEngine);

    const rawPlan = engine.buildExecutionPlan(formulaDefinitions, snippetDefinitions);

    // Filter out BLOCKED formulas from the plan
    const blockedIds = new Set(
      Object.entries(readiness)
        .filter(([, r]) => r.readiness === FormulaReadiness.BLOCKED)
        .map(([id]) => id),
    );

    const plan: ExecutionPlan = {
      ...rawPlan,
      formulaOrder: rawPlan.formulaOrder.filter((id) => !blockedIds.has(id)),
      skippedFormulas: [
        ...rawPlan.skippedFormulas,
        ...Array.from(blockedIds)
          .filter((id) => rawPlan.formulaOrder.includes(id))
          .map((id) => ({ formulaId: id, reason: readiness[id]?.blockedReason ?? 'Blocked — required data missing' })),
      ],
    };

    // -------------------------------------------------------------------------
    // 7. Execute snippets + formulas
    // -------------------------------------------------------------------------
    const engineResult = await engine.executeAll(plan, context);

    // -------------------------------------------------------------------------
    // 8. RAG evaluation
    // -------------------------------------------------------------------------
    const entityMetadata = this.buildEntityMetadata(enrichedData.feeEarners);
    const ragEngine = new RagEngine();
    const ragResult = ragEngine.evaluateAll(engineResult.results, firmConfig.ragThresholds ?? [], entityMetadata);

    // -------------------------------------------------------------------------
    // 9. Persist results
    // -------------------------------------------------------------------------
    const kpisPayload: Record<string, unknown> = {
      // Preserve the pipeline's aggregate blob if it exists
      ...(kpisDoc?.kpis ?? {}),
      formulaResults: engineResult.results,
      snippetResults: engineResult.snippetResults,
      ragAssignments: ragResult.assignments,
      ragSummary: {
        ...ragResult.summary,
        alertsRed: ragResult.alertsRed,
        alertsAmber: ragResult.alertsAmber,
      },
      readiness,
      formulaVersionSnapshot,
      calculationMetadata: {
        totalExecutionTimeMs: Date.now() - start,
        formulaCount: engineResult.formulaCount,
        successCount: engineResult.successCount,
        errorCount: engineResult.errorCount,
        errors: engineResult.errors,
        blockedCount: blockedIds.size,
        calculatedAt: new Date().toISOString(),
      },
    };

    await this.deps.persistKpis(firmId, kpisPayload, configVersion, dataVersion);

    // -------------------------------------------------------------------------
    // 9b. Write kpi_snapshots to Supabase (fire after MongoDB persist)
    // -------------------------------------------------------------------------
    const pulledAt = new Date().toISOString();
    const snapshotRows = buildSnapshotsFromKpiResults(
      firmId,
      pulledAt,
      { kpis: kpisPayload as { formulaResults?: Record<string, FormulaResult>; ragAssignments?: Record<string, Record<string, RagAssignment>> } },
    );
    try {
      await this.deps.writeSnapshots(firmId, snapshotRows);
      console.info(`[orchestrator] Wrote ${snapshotRows.length} kpi_snapshot rows to Supabase`);
    } catch (snapshotErr) {
      console.error('[orchestrator] Failed to write kpi_snapshots to Supabase — calculation result still persisted to MongoDB', snapshotErr);
    }

    // -------------------------------------------------------------------------
    // 9c. Run risk scanner and persist risk_flags to MongoDB
    // -------------------------------------------------------------------------
    try {
      const riskFlags = scanForRiskFlags({
        firmId,
        kpiSnapshots: snapshotRows,
        config: firmConfig,
        pulledAt,
      });
      await this.deps.writeRiskFlags(firmId, riskFlags);
      console.info(`[orchestrator] Stored ${riskFlags.length} risk flags for firmId=${firmId}`);
    } catch (riskErr) {
      console.error('[orchestrator] Failed to store risk flags — calculation result still valid', riskErr);
    }

    // -------------------------------------------------------------------------
    // 10. Clear stale flag
    // -------------------------------------------------------------------------
    await this.deps.clearStaleFlag(firmId);

    // -------------------------------------------------------------------------
    // Return
    // -------------------------------------------------------------------------
    const totalMs = Date.now() - start;

    return {
      firmId,
      calculatedAt: new Date().toISOString(),
      configVersion,
      dataVersion,
      formulaVersionSnapshot,
      results: engineResult.results,
      snippetResults: engineResult.snippetResults,
      ragAssignments: ragResult.assignments,
      ragSummary: {
        ...ragResult.summary,
        alertsRed: ragResult.alertsRed,
        alertsAmber: ragResult.alertsAmber,
      },
      readiness,
      executionPlan: plan,
      totalExecutionTimeMs: totalMs,
      formulaCount: engineResult.formulaCount,
      successCount: engineResult.successCount,
      errorCount: engineResult.errorCount,
      errors: engineResult.errors,
    };
  }

  // ---------------------------------------------------------------------------
  // recalculateAffected
  // ---------------------------------------------------------------------------

  /**
   * Recalculate only the formulas affected by a config change.
   *
   * For MVP, this delegates to calculateAll — the full recalculation is fast
   * enough at this scale. A future optimisation can limit execution to the
   * specified formula IDs and their dependents.
   */
  async recalculateAffected(
    firmId: string,
    _changedFormulaIds: string[],
  ): Promise<CalculationResult> {
    return this.calculateAll(firmId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
    const [kpisDoc, timeEntryDoc, invoiceDoc, disbursementDoc, feeEarnerDoc] = await Promise.all([
      this.deps.getKpis(firmId),
      this.deps.getEnrichedEntities(firmId, 'timeEntry'),
      this.deps.getEnrichedEntities(firmId, 'invoice'),
      this.deps.getEnrichedEntities(firmId, 'disbursement'),
      this.deps.getEnrichedEntities(firmId, 'feeEarner'),
    ]);

    const aggregate = kpisDoc?.kpis?.['aggregate'] as Record<string, unknown> | undefined;

    // Fee earners from the legacy pipeline aggregate (preferred) or from the
    // API pull's enriched entity store (fallback). The enriched entities use
    // NormalisedAttorney field names (_id, fullName) — map them to the
    // AggregatedFeeEarner shape expected by the formula engine.
    let feeEarners = (aggregate?.feeEarners ?? []) as AggregatedFeeEarner[];
    if (feeEarners.length === 0 && (feeEarnerDoc?.records?.length ?? 0) > 0) {
      feeEarners = (feeEarnerDoc!.records as unknown as Record<string, unknown>[]).map((r) => ({
        // Identity — formula engine uses lawyerId / lawyerName for grouping
        lawyerId: (r['_id'] as string | undefined),
        lawyerName: (r['fullName'] as string | undefined),
        // WIP aggregates not available in NormalisedAttorney; formulas that need
        // them will read from time entries directly (e.g. F-TU-01).
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
        // Pass through all extra fields (payModel, rate, grade, status, etc.)
        // so that formulas using dynamic field access can read them.
        ...r,
      } as AggregatedFeeEarner));
      console.log(`[orchestrator] loadEnrichedData: no aggregate feeEarners — fell back to ${feeEarners.length} enriched entities`);
    }

    return {
      feeEarners,
      matters: (aggregate?.matters ?? []) as AggregatedMatter[],
      clients: (aggregate?.clients ?? []) as AggregatedClient[],
      departments: (aggregate?.departments ?? []) as AggregatedDepartment[],
      firm: (aggregate?.firm ?? EMPTY_FIRM) as AggregatedFirm,
      timeEntries: ((timeEntryDoc?.records ?? []) as unknown[]) as EnrichedTimeEntry[],
      invoices: ((invoiceDoc?.records ?? []) as unknown[]) as EnrichedInvoice[],
      disbursements: ((disbursementDoc?.records ?? []) as unknown[]) as EnrichedDisbursement[],
    };
  }

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
   * Convert getFeeEarnerOverrides result (Record<feeEarnerId, FeeEarnerOverride[]>)
   * to the Record<feeEarnerId, Record<field, value>> shape expected by buildFormulaContext.
   *
   * Only applies overrides that are currently in effect (effectiveFrom ≤ now < effectiveTo).
   */
  private buildOverridesMap(
    overridesArr: Record<string, FeeEarnerOverride[]>,
    _firmConfig: FirmConfig,
  ): Record<string, Record<string, unknown>> {
    const now = new Date();
    const map: Record<string, Record<string, unknown>> = {};

    for (const [feeEarnerId, overrides] of Object.entries(overridesArr)) {
      map[feeEarnerId] = {};
      for (const o of overrides) {
        // Effective date guard
        if (o.effectiveFrom && new Date(o.effectiveFrom) > now) continue;
        if (o.effectiveTo && new Date(o.effectiveTo) < now) continue;
        map[feeEarnerId][o.field] = o.value;
      }
    }

    return map;
  }

  /** Build entity metadata map (grade + payModel per entityId) for RAG grade overrides. */
  private buildEntityMetadata(
    feeEarners: AggregatedFeeEarner[],
  ): Record<string, { grade?: string; payModel?: string }> {
    const meta: Record<string, { grade?: string; payModel?: string }> = {};
    for (const fe of feeEarners) {
      const id = fe.lawyerId ?? fe.lawyerName ?? 'unknown';
      const feRec = fe as unknown as Record<string, unknown>;
      meta[id] = {
        grade: feRec['grade'] as string | undefined,
        payModel: feRec['payModel'] as string | undefined,
      };
    }
    return meta;
  }
}
