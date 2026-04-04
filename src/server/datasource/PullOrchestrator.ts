/**
 * PullOrchestrator.ts
 *
 * Coordinates the complete pull sequence for one firm:
 *   Authenticate → Fetch → Normalise → Enrich → Store → Calculate → Snapshot → Risk Scan
 *
 * This is the single entry point called by the Background Function.
 * All pull_status tracking is handled here. Callers only need:
 *
 *   const result = await new PullOrchestrator(firmId).run();
 *
 * Steps (mirroring the prompt spec):
 *   1.  requireNoConcurrentPull
 *   2.  startPull
 *   3.  Authenticate
 *   4.  Fetch lookup tables
 *   5.  Fetch matters
 *   6.  Fetch remaining datasets in parallel
 *   7.  Normalise + resolve + strip
 *   8.  Enrich (WIP, datePaid, feeEarner CSV merge, client profiles)
 *   9.  Store enriched entities in MongoDB
 *   10. Calculate KPIs via CalculationOrchestrator
 *   11. Build + write kpi_snapshots to Supabase
 *   12. Scan for risk flags + store in MongoDB
 *   13. completePull
 */

import {
  requireNoConcurrentPull,
  startPull,
  updatePullStage,
  completePull,
  failPull,
} from '../services/pull-status-service.js';
import { DataSourceAdapter } from './DataSourceAdapter.js';
import { YaoAuthError, YaoAuthExpiredError, YaoApiError, YaoRateLimitError } from './errors.js';
import {
  transformAttorney,
  transformMatter,
  transformTimeEntry,
  transformInvoice,
  transformDisbursement,
  transformTask,
  transformContact,
} from './normalise/transformations.js';
import { resolveAll } from './normalise/resolver.js';
import { stripSensitiveFromArray } from './normalise/stripper.js';
import { buildWipEnrichment } from './enrich/wip-aggregator.js';
import { enrichInvoicesWithDatePaid } from './enrich/invoice-enricher.js';
import { mergeAllFeeEarners } from './enrich/fee-earner-merger.js';
import { buildClientProfiles } from './enrich/client-profile-builder.js';
import { buildSnapshotsFromKpiResults } from './enrich/kpi-snapshot-builder.js';
import { CalculationOrchestrator } from '../formula-engine/orchestrator.js';
import { writeKpiSnapshots } from '../services/kpi-snapshot-service.js';
import { scanForRiskFlags } from './enrich/risk-scanner.js';
import {
  storeEnrichedEntities,
  storeRiskFlags,
} from '../lib/mongodb-operations.js';
import { getFirmConfig } from '../services/config-service.js';

// =============================================================================
// Public types
// =============================================================================

export interface PullResult {
  success: boolean;
  pulledAt: string;
  stats: {
    attorneys: number;
    matters: number;
    timeEntries: number;
    invoices: number;
    disbursements: number;
    tasks: number;
    contacts: number;
    kpiSnapshotsWritten: number;
    riskFlagsGenerated: number;
  };
  errors: string[];
  warnings: string[];
}

// =============================================================================
// Injectable dependencies (for testing)
// =============================================================================

export interface PullOrchestratorDeps {
  /** Override the DataSourceAdapter class (constructor injection). */
  createAdapter?: (firmId: string) => Pick<
    DataSourceAdapter,
    | 'authenticate'
    | 'fetchLookupTables'
    | 'fetchMatters'
    | 'fetchTimeEntries'
    | 'fetchInvoices'
    | 'fetchLedgers'
    | 'fetchTasks'
    | 'fetchContacts'
    | 'fetchInvoiceSummary'
    | 'routeLedgers'
  >;
  /** Override the CalculationOrchestrator (for unit testing without MongoDB). */
  createCalcOrchestrator?: (firmId: string) => Pick<CalculationOrchestrator, 'calculateAll'>;
}

// =============================================================================
// PullOrchestrator
// =============================================================================

export class PullOrchestrator {
  private readonly firmId: string;
  private readonly deps: Required<PullOrchestratorDeps>;

  constructor(firmId: string, deps: PullOrchestratorDeps = {}) {
    this.firmId = firmId;
    this.deps = {
      createAdapter:          deps.createAdapter          ?? ((id) => new DataSourceAdapter(id)),
      createCalcOrchestrator: deps.createCalcOrchestrator ?? (() => new CalculationOrchestrator()),
    };
  }

  // ---------------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------------

  async run(): Promise<PullResult> {
    const { firmId } = this;
    const pulledAt   = new Date().toISOString();
    const errors:   string[] = [];
    const warnings: string[] = [];
    const stats = {
      attorneys:           0,
      matters:             0,
      timeEntries:         0,
      invoices:            0,
      disbursements:       0,
      tasks:               0,
      contacts:            0,
      kpiSnapshotsWritten: 0,
      riskFlagsGenerated:  0,
    };

    // -------------------------------------------------------------------------
    // Step 1 + 2: Concurrency guard + start
    // -------------------------------------------------------------------------
    try {
      await requireNoConcurrentPull(firmId);
      await startPull(firmId);
    } catch (err) {
      // PullAlreadyRunningError or Supabase failure — don't start
      return this.failResult(pulledAt, errors, warnings, stats, err);
    }

    try {
      // -----------------------------------------------------------------------
      // Step 3: Authenticate
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Authenticating');
      const adapter = this.deps.createAdapter(firmId);
      await adapter.authenticate();

      // -----------------------------------------------------------------------
      // Step 4: Fetch lookup tables
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching lookup tables');
      const { attorneys, departments, caseTypes, attorneyMap, caseTypeMap, departmentMap } = await adapter.fetchLookupTables();
      const maps = { attorneyMap, caseTypeMap, departmentMap };
      stats.attorneys = attorneys.length;

      // -----------------------------------------------------------------------
      // Step 5: Fetch matters
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching matters');
      const rawMatters = await adapter.fetchMatters();
      stats.matters = rawMatters.length;
      await updatePullStage(firmId, 'Fetching matters', { matters: rawMatters.length });

      // -----------------------------------------------------------------------
      // Step 6: Fetch remaining datasets in parallel
      // -----------------------------------------------------------------------
      await updatePullStage(
        firmId,
        'Fetching time entries, invoices, ledgers, tasks, contacts',
      );
      const [rawTimeEntries, rawInvoices, rawLedgersList, rawTasks, rawContacts] =
        await Promise.all([
          adapter.fetchTimeEntries(),
          adapter.fetchInvoices(),
          adapter.fetchLedgers(),
          adapter.fetchTasks(),
          adapter.fetchContacts(),
        ]);
      const ledgers = adapter.routeLedgers(rawLedgersList);
      stats.timeEntries   = rawTimeEntries.length;
      stats.invoices      = rawInvoices.length;
      stats.disbursements = ledgers.disbursements.length;
      stats.tasks         = rawTasks.length;
      stats.contacts      = rawContacts.length;

      await updatePullStage(firmId, 'Fetching time entries, invoices, ledgers, tasks, contacts', {
        matters:     stats.matters,
        timeEntries: stats.timeEntries,
        invoices:    stats.invoices,
        tasks:       stats.tasks,
        contacts:    stats.contacts,
      });

      // -----------------------------------------------------------------------
      // Step 7: Normalise + resolve + strip
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Normalising');

      // Transform raw → normalised
      const normAttorneys     = stripSensitiveFromArray(attorneys.map(transformAttorney));
      const normMatters       = stripSensitiveFromArray(rawMatters.map((m) => transformMatter(m, maps)));
      const normTimeEntries   = rawTimeEntries.map(transformTimeEntry);
      const normInvoices      = rawInvoices.map(transformInvoice);
      const normDisbursements = ledgers.disbursements.map(transformDisbursement);
      const normTasks         = rawTasks.map(transformTask);
      const normContacts      = rawContacts.map(transformContact);

      // Resolve map lookups (names, rates, department names)
      const resolved = resolveAll(
        {
          matters:       normMatters,
          timeEntries:   normTimeEntries,
          invoices:      normInvoices,
          disbursements: normDisbursements,
          tasks:         normTasks,
        },
        maps,
      );

      // Belt-and-suspenders: strip sensitive fields again after resolution
      const safeMatters     = stripSensitiveFromArray(resolved.matters);
      const safeTimeEntries = stripSensitiveFromArray(resolved.timeEntries);
      const safeInvoices    = stripSensitiveFromArray(resolved.invoices);

      // -----------------------------------------------------------------------
      // Step 8: Enrich
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Enriching');

      const wipEnrichment    = buildWipEnrichment(safeTimeEntries);
      const enrichedInvoices = enrichInvoicesWithDatePaid(safeInvoices, ledgers.invoicePayments);

      let enrichedFeeEarners = normAttorneys;
      try {
        enrichedFeeEarners = await mergeAllFeeEarners(normAttorneys, firmId);
      } catch (mergeErr) {
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        warnings.push(`Fee earner CSV merge skipped: ${msg}`);
      }

      const clientProfiles = buildClientProfiles(normContacts, safeMatters, enrichedInvoices);

      // -----------------------------------------------------------------------
      // Step 9: Store enriched data
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Storing enriched data');

      await Promise.all([
        storeEnrichedEntities(firmId, 'feeEarner',    enrichedFeeEarners as unknown as Record<string, unknown>[],    [], undefined),
        storeEnrichedEntities(firmId, 'matter',       safeMatters as unknown as Record<string, unknown>[],           [], undefined),
        storeEnrichedEntities(firmId, 'timeEntry',    safeTimeEntries as unknown as Record<string, unknown>[],       [], undefined),
        storeEnrichedEntities(firmId, 'invoice',      enrichedInvoices as unknown as Record<string, unknown>[],      [], undefined),
        storeEnrichedEntities(firmId, 'disbursement', resolved.disbursements as unknown as Record<string, unknown>[], [], undefined),
        storeEnrichedEntities(firmId, 'task',         resolved.tasks as unknown as Record<string, unknown>[],        [], undefined),
        storeEnrichedEntities(firmId, 'client',       clientProfiles as unknown as Record<string, unknown>[],        [], undefined),
        storeEnrichedEntities(firmId, 'wip',          [wipEnrichment as unknown as Record<string, unknown>],         [], undefined),
      ]);

      void departments; // fetched as part of lookup tables — stored via maps, not as enriched entity
      void caseTypes;

      // -----------------------------------------------------------------------
      // Step 10: Calculate KPIs
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Calculating KPIs');
      const calcOrchestrator = this.deps.createCalcOrchestrator(firmId);
      const kpiResult = await calcOrchestrator.calculateAll(firmId);

      // -----------------------------------------------------------------------
      // Step 11: Write kpi_snapshots
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Writing snapshots');
      const config = await getFirmConfig(firmId);
      const snapshotRows = buildSnapshotsFromKpiResults(
        firmId,
        pulledAt,
        { kpis: kpiResult as unknown as Record<string, unknown> },
      );

      try {
        await writeKpiSnapshots(firmId, snapshotRows);
        stats.kpiSnapshotsWritten = snapshotRows.length;
      } catch (snapErr) {
        const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
        warnings.push(`kpi_snapshots write failed (non-fatal): ${msg}`);
      }

      // -----------------------------------------------------------------------
      // Step 12: Scan + store risk flags
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Scanning for risks');
      const riskFlags = scanForRiskFlags({
        firmId,
        kpiSnapshots: snapshotRows,
        config,
        pulledAt,
      });

      try {
        await storeRiskFlags(firmId, riskFlags);
        stats.riskFlagsGenerated = riskFlags.length;
      } catch (riskErr) {
        const msg = riskErr instanceof Error ? riskErr.message : String(riskErr);
        warnings.push(`risk_flags store failed (non-fatal): ${msg}`);
      }

      // -----------------------------------------------------------------------
      // Step 13: Complete
      // -----------------------------------------------------------------------
      await completePull(firmId);

      return { success: true, pulledAt, stats, errors, warnings };

    } catch (err) {
      const message = this.humaniseError(err);
      errors.push(message);
      await failPull(firmId, message).catch(() => {/* best effort */});
      return { success: false, pulledAt, stats, errors, warnings };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private humaniseError(err: unknown): string {
    if (err instanceof YaoAuthError) {
      return 'Invalid Yao API credentials — please update in Settings';
    }
    if (err instanceof YaoAuthExpiredError) {
      return 'Yao API token expired mid-pull — authentication may need refreshing';
    }
    if (err instanceof YaoApiError) {
      return `Yao API error (HTTP ${err.statusCode}) — ${err.message}`;
    }
    if (err instanceof YaoRateLimitError) {
      return `Yao API rate limit exceeded — ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private failResult(
    pulledAt: string,
    errors: string[],
    warnings: string[],
    stats: PullResult['stats'],
    err: unknown,
  ): PullResult {
    errors.push(this.humaniseError(err));
    return { success: false, pulledAt, stats, errors, warnings };
  }
}
