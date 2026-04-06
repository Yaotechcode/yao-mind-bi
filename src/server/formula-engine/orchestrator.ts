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
    // 2b. Apply calculation window filter (if configured)
    // -------------------------------------------------------------------------
    const windowMonths = firmConfig.billingMethodConfig?.calculationWindowMonths ?? 0;
    if (windowMonths > 0) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - windowMonths);
      const cutoffIso = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

      const prevInvoiceCount = enrichedData.invoices.length;
      const prevTeCount = enrichedData.timeEntries.length;

      enrichedData.invoices = enrichedData.invoices.filter((inv) => {
        const d = (inv as unknown as Record<string, unknown>)['invoiceDate'];
        return typeof d === 'string' && d >= cutoffIso;
      });
      enrichedData.timeEntries = enrichedData.timeEntries.filter((te) => {
        const d = (te as unknown as Record<string, unknown>)['date'];
        return typeof d === 'string' && d >= cutoffIso;
      });

      // Re-aggregate invoicedRevenue and wipChargeableHours per fee earner
      // from the window-filtered records so that formula results respect the window.
      // Uses the same BILLABLE_STATUSES set as the main aggregation (WRITTEN_OFF included).
      const BILLABLE_STATUSES_WINDOW = new Set(['ISSUED', 'PAID', 'CREDITED', 'WRITTEN_OFF']);
      const windowActiveIds = new Set<string>(
        enrichedData.feeEarners.map((fe) => {
          const r = fe as unknown as Record<string, unknown>;
          return String(r['lawyerId'] ?? r['_id'] ?? '');
        }).filter(Boolean),
      );
      const filteredRevenueByLawyer = new Map<string, number>();
      let windowFirmRevenue = 0;
      for (const inv of enrichedData.invoices) {
        const r = inv as unknown as Record<string, unknown>;
        const status = typeof r['status'] === 'string' ? r['status'] : '';
        if (!BILLABLE_STATUSES_WINDOW.has(status)) continue;
        const feeRev = typeof r['feeEarnerRevenue'] === 'number'
          ? r['feeEarnerRevenue']
          : (typeof r['subtotal'] === 'number' ? r['subtotal'] : 0)
            - (typeof r['totalFirmFees'] === 'number' ? r['totalFirmFees'] : 0)
            - (typeof r['totalDisbursements'] === 'number' ? r['totalDisbursements'] : 0);
        windowFirmRevenue += feeRev;
        const lawyerId = r['responsibleLawyerId'] != null ? String(r['responsibleLawyerId']) : null;
        if (!lawyerId) continue;
        if (windowActiveIds.size > 0 && !windowActiveIds.has(lawyerId)) continue; // skip disabled attorneys
        filteredRevenueByLawyer.set(lawyerId, (filteredRevenueByLawyer.get(lawyerId) ?? 0) + feeRev);
      }
      const filteredHoursByLawyer = new Map<string, number>();
      for (const te of enrichedData.timeEntries) {
        const r = te as unknown as Record<string, unknown>;
        if (r['isChargeable'] !== true) continue;
        const lawyerId = r['lawyerId'] != null ? String(r['lawyerId']) : null;
        if (!lawyerId) continue;
        const hours = typeof r['durationHours'] === 'number' ? r['durationHours'] : 0;
        filteredHoursByLawyer.set(lawyerId, (filteredHoursByLawyer.get(lawyerId) ?? 0) + hours);
      }
      enrichedData.feeEarners = enrichedData.feeEarners.map((fe) => {
        const id = String((fe as unknown as Record<string, unknown>)['lawyerId'] ?? (fe as unknown as Record<string, unknown>)['_id'] ?? '');
        return {
          ...fe,
          invoicedRevenue: filteredRevenueByLawyer.get(id) ?? 0,
          wipChargeableHours: filteredHoursByLawyer.get(id) ?? 0,
        };
      });
      // Patch firm-level totalInvoicedRevenue to reflect the window-filtered sum
      if (windowFirmRevenue > 0) {
        enrichedData.firm = { ...enrichedData.firm, totalInvoicedRevenue: windowFirmRevenue };
      }

      console.log(
        `[orchestrator] calculation window: ${windowMonths} months (cutoff ${cutoffIso}) — ` +
        `invoices ${prevInvoiceCount}→${enrichedData.invoices.length}, ` +
        `timeEntries ${prevTeCount}→${enrichedData.timeEntries.length}, ` +
        `firmRevenue: £${windowFirmRevenue.toFixed(0)}`,
      );
    }

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
    // 6b. Diagnostic: log execution plan summary
    // -------------------------------------------------------------------------
    const feeEarnerFormulasInPlan = plan.formulaOrder.filter((id) => {
      const def = formulaDefinitions.find((f) => f.formulaId === id);
      return def?.entityType === 'feeEarner';
    });
    const blockedFeeEarnerFormulas = Array.from(blockedIds).filter((id) => {
      const def = formulaDefinitions.find((f) => f.formulaId === id);
      return def?.entityType === 'feeEarner';
    });
    console.log(`[orchestrator] execution plan: ${plan.formulaOrder.length} formulas, ${plan.skippedFormulas.length} skipped, ${blockedIds.size} blocked`);
    console.log(`[orchestrator] fee earner formulas in plan: [${feeEarnerFormulasInPlan.join(', ')}]`);
    console.log(`[orchestrator] blocked fee earner formulas: [${blockedFeeEarnerFormulas.join(', ')}]`);
    if (blockedFeeEarnerFormulas.length > 0) {
      for (const id of blockedFeeEarnerFormulas) {
        console.log(`[orchestrator] BLOCKED ${id}: ${readiness[id]?.blockedReason ?? 'unknown reason'}`);
      }
    }
    console.log(`[orchestrator] context entity counts — feeEarners:${context.feeEarners.length} matters:${context.matters.length} timeEntries:${context.timeEntries.length}`);

    // -------------------------------------------------------------------------
    // 7. Execute snippets + formulas
    // -------------------------------------------------------------------------
    const engineResult = await engine.executeAll(plan, context);

    // Log any formula execution errors so they're visible in Netlify logs
    if (engineResult.errors.length > 0) {
      console.error(`[orchestrator] ${engineResult.errors.length} formula(s) threw during execution:`);
      for (const e of engineResult.errors) {
        console.error(`  [orchestrator] formula error — ${e.formulaId}: ${e.error}`);
      }
    }
    console.log(`[orchestrator] formula execution complete — success:${engineResult.successCount} errors:${engineResult.errorCount} results:${Object.keys(engineResult.results).length}`);
    console.log(`[orchestrator] result keys: [${Object.keys(engineResult.results).join(', ')}]`);

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

    // -------------------------------------------------------------------------
    // 9b. Write kpi_snapshots to Supabase — CRITICAL PATH, runs before MongoDB
    // -------------------------------------------------------------------------
    // This is the primary dashboard data store. It must complete regardless of
    // whether the MongoDB calculated_kpis write succeeds. Order is intentional:
    // kpi_snapshots first, then MongoDB (non-fatal).
    //
    // Pass formulaResults and ragAssignments directly from the in-memory engine
    // result — NOT from kpisPayload which spreads the old MongoDB document and
    // can contain stale/chunked data (formulaResultsChunked: true, no formulaResults).
    const pulledAt = new Date().toISOString();
    const snapshotRows = buildSnapshotsFromKpiResults(
      firmId,
      pulledAt,
      {
        kpis: {
          formulaResults: engineResult.results,
          ragAssignments: ragResult.assignments,
        },
      },
    );
    try {
      await this.deps.writeSnapshots(firmId, snapshotRows);
      console.info(`[orchestrator] Wrote ${snapshotRows.length} kpi_snapshot rows to Supabase`);
    } catch (snapshotErr) {
      console.error('[orchestrator] Failed to write kpi_snapshots to Supabase:', snapshotErr);
    }

    // -------------------------------------------------------------------------
    // 9c. Persist full results to MongoDB — non-fatal (secondary store)
    // -------------------------------------------------------------------------
    // calculated_kpis is used by the AI layer and historical reference only.
    // Large payloads (>12MB) are chunked across documents. If this write fails
    // (e.g. BSON size limit), dashboards are unaffected — kpi_snapshots already written.
    try {
      await this.deps.persistKpis(firmId, kpisPayload, configVersion, dataVersion);
      console.info('[orchestrator] Stored calculated KPIs to MongoDB');
    } catch (persistErr) {
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      console.warn('[orchestrator] calculated_kpis write skipped (non-fatal):', msg);
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
    const [kpisDoc, timeEntryDoc, invoiceDoc, disbursementDoc, feeEarnerDoc, matterDoc] = await Promise.all([
      this.deps.getKpis(firmId),
      this.deps.getEnrichedEntities(firmId, 'timeEntry'),
      this.deps.getEnrichedEntities(firmId, 'invoice'),
      this.deps.getEnrichedEntities(firmId, 'disbursement'),
      this.deps.getEnrichedEntities(firmId, 'feeEarner'),
      this.deps.getEnrichedEntities(firmId, 'matter'),
    ]);

    const aggregate = kpisDoc?.kpis?.['aggregate'] as Record<string, unknown> | undefined;

    // -------------------------------------------------------------------------
    // Fee earners: prefer fresh API-pulled data from enriched_entities.feeEarner
    // over legacy aggregate data. The enriched entities use NormalisedAttorney
    // field names (_id, fullName) — map them to the AggregatedFeeEarner shape.
    // Only fall back to aggregate.feeEarners if no enriched entity doc exists.
    // -------------------------------------------------------------------------
    const enrichedFeeEarnerRecords = feeEarnerDoc?.records as unknown as Record<string, unknown>[] | undefined;
    let feeEarners: AggregatedFeeEarner[];

    // Pre-aggregate chargeable hours per fee earner from time entries
    const chargeableHoursByLawyer = new Map<string, number>();
    const timeEntryRecords = ((timeEntryDoc?.records ?? []) as unknown[]) as Array<Record<string, unknown>>;
    for (const te of timeEntryRecords) {
      const lawyerId = te['lawyerId'] != null ? String(te['lawyerId']) : null;
      if (!lawyerId) continue;
      const isChargeable = te['isChargeable'] === true || (!te['doNotBill'] && (te['billable'] as number ?? 0) > 0);
      if (!isChargeable) continue;
      const hours = typeof te['durationHours'] === 'number' ? te['durationHours'] : 0;
      chargeableHoursByLawyer.set(lawyerId, (chargeableHoursByLawyer.get(lawyerId) ?? 0) + hours);
    }

    // Pre-aggregate invoiced revenue per fee earner from invoices (billable statuses only).
    // WRITTEN_OFF is included: the invoice was raised and counts as revenue even if partially
    // written off — write-off amount is separately tracked in wipTotalWriteOff.
    const BILLABLE_STATUSES = new Set(['ISSUED', 'PAID', 'CREDITED', 'WRITTEN_OFF']);

    // Build set of active attorney IDs so we can detect disabled-attorney invoices.
    const activeAttorneyIds = new Set<string>(
      (enrichedFeeEarnerRecords ?? []).map((r) => String(r['_id'] ?? '')).filter(Boolean),
    );

    const invoicedRevenueByLawyer = new Map<string, number>();
    let unattributedRevenue = 0;
    let unattributedCount = 0;
    let attributedCount = 0;
    let firmInvoicedRevenue = 0; // sum across ALL BILLABLE_STATUSES invoices regardless of attribution

    const invoiceRecords = ((invoiceDoc?.records ?? []) as unknown[]) as Array<Record<string, unknown>>;
    for (const inv of invoiceRecords) {
      const status = typeof inv['status'] === 'string' ? inv['status'] : '';
      if (!BILLABLE_STATUSES.has(status)) continue;

      // Use feeEarnerRevenue when available; fall back to subtotal - totalFirmFees - totalDisbursements
      const feeEarnerRevenue = typeof inv['feeEarnerRevenue'] === 'number'
        ? inv['feeEarnerRevenue']
        : (typeof inv['subtotal'] === 'number' ? inv['subtotal'] : 0)
          - (typeof inv['totalFirmFees'] === 'number' ? inv['totalFirmFees'] : 0)
          - (typeof inv['totalDisbursements'] === 'number' ? inv['totalDisbursements'] : 0);

      firmInvoicedRevenue += feeEarnerRevenue;

      const lawyerId = inv['responsibleLawyerId'] != null ? String(inv['responsibleLawyerId']) : null;
      if (!lawyerId) continue;

      if (activeAttorneyIds.size > 0 && !activeAttorneyIds.has(lawyerId)) {
        // Invoice belongs to a disabled or unknown attorney — track separately, do NOT
        // assign to any fee earner's invoicedRevenue to avoid polluting active earner totals.
        unattributedRevenue += feeEarnerRevenue;
        unattributedCount += 1;
        continue;
      }

      invoicedRevenueByLawyer.set(lawyerId, (invoicedRevenueByLawyer.get(lawyerId) ?? 0) + feeEarnerRevenue);
      attributedCount += 1;
    }

    const attributedRevenue = [...invoicedRevenueByLawyer.values()].reduce((a, b) => a + b, 0);
    console.log(
      `[orchestrator] revenue attribution — attributed: £${attributedRevenue.toFixed(0)} (${attributedCount} invoices), ` +
      `unattributed: £${unattributedRevenue.toFixed(0)} (${unattributedCount} invoices, disabled/unknown attorneys)`,
    );

    if ((enrichedFeeEarnerRecords?.length ?? 0) > 0) {
      feeEarners = enrichedFeeEarnerRecords!.map((r) => ({
        // WIP aggregates not available in NormalisedAttorney; formulas compute
        // them from time entries directly (e.g. F-TU-01 uses context.timeEntries).
        wipTotalHours: 0,
        wipChargeableHours: chargeableHoursByLawyer.get(String(r['_id'] ?? '')) ?? 0,
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
        invoicedRevenue: invoicedRevenueByLawyer.get(String(r['_id'] ?? '')) ?? 0,
        invoicedOutstanding: 0,
        invoicedCount: 0,
        // Pass through all extra fields (payModel, rate, grade, status, etc.)
        ...r,
        // Identity fields MUST come after ...r to guarantee they are set correctly.
        // r['_id'] may be a MongoDB ObjectId object if the Yao attorney _id is a
        // 24-hex string — calling .toString() ensures a plain string comparison
        // against entry.lawyerId (which is always set as a string via transformTimeEntry).
        lawyerId: r['_id'] != null ? String(r['_id']) : undefined,
        lawyerName: r['fullName'] != null ? String(r['fullName']) : undefined,
      } as AggregatedFeeEarner));
      const totalChargeableHours = [...chargeableHoursByLawyer.values()].reduce((a, b) => a + b, 0);
      console.log(`[orchestrator] feeEarners: ${feeEarners.length} loaded from enriched_entities (API pull data)`);
      console.log(`[orchestrator] pre-aggregated — chargeableHours: ${totalChargeableHours.toFixed(1)}, invoicedRevenue (attributed): £${attributedRevenue.toFixed(0)}, firm total: £${firmInvoicedRevenue.toFixed(0)}`);
    } else {
      // Fallback to legacy aggregate (CSV upload pipeline)
      feeEarners = (aggregate?.feeEarners ?? []) as AggregatedFeeEarner[];
      console.log(`[orchestrator] feeEarners: ${feeEarners.length} from aggregate (no enriched_entities — enrichedFeeEarnerRecords=${enrichedFeeEarnerRecords?.length ?? 'null'})`);
    }

    // -------------------------------------------------------------------------
    // Matters: prefer aggregate (has full WIP aggregates from pipeline) but fall
    // back to enriched_entities.matter (NormalisedMatter shape) when aggregate
    // has no matter data (e.g. first API pull with no prior legacy pipeline run).
    // -------------------------------------------------------------------------
    let matters: AggregatedMatter[];
    const aggregateMatters = (aggregate?.matters ?? []) as AggregatedMatter[];

    if (aggregateMatters.length > 0) {
      matters = aggregateMatters;
      console.log(`[orchestrator] matters: ${matters.length} from aggregate`);
    } else {
      // Map NormalisedMatter → AggregatedMatter shape (WIP fields default to 0;
      // formulas that need per-matter WIP will compute from context.timeEntries).
      const matterRecords = matterDoc?.records as unknown as Record<string, unknown>[] | undefined;
      matters = (matterRecords ?? []).map((r) => ({
        // Identity
        matterId: (r['_id'] as string | undefined),
        matterNumber: (r['numberString'] as string | undefined) ?? String(r['number'] ?? ''),
        // WIP aggregates (zero — formulas compute from context.timeEntries)
        wipTotalDurationMinutes: 0,
        wipTotalHours: 0,
        wipTotalBillable: 0,
        wipTotalWriteOff: 0,
        wipTotalUnits: 0,
        wipTotalChargeable: 0,
        wipTotalNonChargeable: 0,
        wipChargeableHours: 0,
        wipNonChargeableHours: 0,
        wipOldestEntryDate: null,
        wipNewestEntryDate: null,
        wipAgeInDays: null,
        // Invoice aggregates (zero — formulas compute from context.invoices)
        invoiceCount: 0,
        invoicedNetBilling: 0,
        invoicedDisbursements: 0,
        invoicedTotal: 0,
        invoicedOutstanding: 0,
        invoicedPaid: 0,
        invoicedWrittenOff: 0,
        // Pass through all NormalisedMatter fields (budget, isFixedFee, status,
        // caseName, _id, number, numberString, departmentId, etc.)
        ...r,
      } as AggregatedMatter));
      console.log(`[orchestrator] matters: ${matters.length} from enriched_entities (no aggregate — matterRecords=${matterRecords?.length ?? 'null'})`);
    }

    // Diagnostic summary
    console.log(`[orchestrator] loadEnrichedData summary — feeEarners:${feeEarners.length} matters:${matters.length} timeEntries:${timeEntryDoc?.records?.length ?? 0} invoices:${invoiceDoc?.records?.length ?? 0}`);

    return {
      feeEarners,
      matters,
      clients: (aggregate?.clients ?? []) as AggregatedClient[],
      departments: (aggregate?.departments ?? []) as AggregatedDepartment[],
      // Override totalInvoicedRevenue with the invoice-derived firm total so that
      // F-PR-05 firm profitability includes both attributed and unattributed revenue
      // (unattributed = invoices from disabled/unknown attorneys that are not assigned
      // to any active fee earner's invoicedRevenue but still represent real firm income).
      firm: {
        ...((aggregate?.firm ?? EMPTY_FIRM) as AggregatedFirm),
        totalInvoicedRevenue: firmInvoicedRevenue > 0
          ? firmInvoicedRevenue
          : ((aggregate?.firm as AggregatedFirm | undefined)?.totalInvoicedRevenue ?? 0),
      },
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
