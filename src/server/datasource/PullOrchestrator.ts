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
import { buildWipEnrichment, type WipSummary } from './enrich/wip-aggregator.js';
import {
  enrichInvoicesWithDatePaid,
  aggregateInvoicesByMatter,
} from './enrich/invoice-enricher.js';
import { mergeAllFeeEarners } from './enrich/fee-earner-merger.js';
import { buildClientProfiles } from './enrich/client-profile-builder.js';
import { buildSnapshotsFromKpiResults } from './enrich/kpi-snapshot-builder.js';
import type { NormalisedInvoice, NormalisedDisbursement } from './normalise/types.js';
import { CalculationOrchestrator } from '../formula-engine/orchestrator.js';
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
    | 'fetchTargets'
    | 'fetchMatters'
    | 'fetchTimeEntries'
    | 'fetchTimeEntrySummary'
    | 'validateTimeEntryTotals'
    | 'fetchInvoices'
    | 'fetchLedgers'
    | 'fetchTasks'
    | 'fetchContacts'
    | 'fetchInvoiceSummary'
    | 'routeLedgers'
    | 'getWarnings'
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
      // Step 3: Authenticate + load firm config
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Authenticating');
      const adapter = this.deps.createAdapter(firmId);
      await adapter.authenticate();

      const firmConfig = await getFirmConfig(firmId);
      const lookbackMonths = firmConfig?.dataPullLookbackMonths ?? 13;
      const fromDateObj = new Date();
      fromDateObj.setMonth(fromDateObj.getMonth() - lookbackMonths);
      const dateFrom = fromDateObj.toISOString().split('T')[0];
      console.log(`[PullOrchestrator] starting pull for firm ${firmId} — lookback: ${lookbackMonths} months (cutoff: ${dateFrom})`);

      // -----------------------------------------------------------------------
      // Step 4: Fetch lookup tables
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching lookup tables');
      const { attorneys, departments, caseTypes, attorneyMap, caseTypeMap, departmentMap } = await adapter.fetchLookupTables();
      const maps = { attorneyMap, caseTypeMap, departmentMap };
      stats.attorneys = attorneys.length;

      // -----------------------------------------------------------------------
      // Step 4b: Fetch targets for current month (best effort)
      //
      // Provides per-attorney work_hours_per_day + non_chargeable_ratio, used
      // as a fallback for fee earners with no CSV upload. Returns null if not
      // configured (404) — non-fatal.
      // -----------------------------------------------------------------------
      const competence = new Date().toISOString().slice(0, 7); // YYYY-MM
      const targets = await adapter.fetchTargets(competence);
      const targetsByUser = new Map<string, { workHoursPerDay: number; nonChargeableRatio: number }>();
      if (targets?.user_targets) {
        for (const ut of targets.user_targets) {
          targetsByUser.set(ut.user_id, {
            workHoursPerDay: ut.work_hours_per_day,
            nonChargeableRatio: ut.non_chargeable_ratio,
          });
        }
        console.log(`[PullOrchestrator] targets API: ${targetsByUser.size} user targets for ${competence}`);
      } else {
        console.log(`[PullOrchestrator] targets API: no targets returned for ${competence}`);
      }

      // -----------------------------------------------------------------------
      // Step 5: Fetch matters
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching matters');
      const rawMatters = await adapter.fetchMatters();
      stats.matters = rawMatters.length;
      await updatePullStage(firmId, 'Fetching matters', { matters: rawMatters.length });

      // -----------------------------------------------------------------------
      // Step 6a: Sequential fetch-process-store per entity
      // Peak memory: one large dataset in memory at a time.
      // Each entity's raw data goes out of scope before the next fetch begins.
      // -----------------------------------------------------------------------

      // --- 6a-1: Normalise matters + fee earners (matters already fetched in Step 5)
      // safeMatters store is DEFERRED until after WIP and invoice aggregation are
      // merged in (Step 6c). Without that merge, wipTotalBillable would be 0 on
      // every matter, blocking F-RB-01 (firm realisation).
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Processing matters');

      const normAttorneys = stripSensitiveFromArray(attorneys.map(transformAttorney));
      const safeMatters   = stripSensitiveFromArray(
        resolveAll(
          {
            matters:       stripSensitiveFromArray(rawMatters.map((m) => transformMatter(m, maps))),
            timeEntries:   [],
            invoices:      [],
            disbursements: [],
            tasks:         [],
          },
          maps,
        ).matters,
      );
      // rawMatters no longer referenced after this point

      // Archived matters — used by ledger fetch to skip irrelevant ledger records
      const archivedMatterIds = new Set<string>(
        (safeMatters as unknown as Array<Record<string, unknown>>)
          .filter((m) => m['status'] === 'ARCHIVED')
          .map((m) => String(m['_id'] ?? '')),
      );

      void departments; // stored via maps, not as enriched entity
      void caseTypes;

      let enrichedFeeEarners = normAttorneys;
      try {
        enrichedFeeEarners = await mergeAllFeeEarners(normAttorneys, firmId);
      } catch (mergeErr) {
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        warnings.push(`Fee earner CSV merge skipped: ${msg}`);
      }

      // wipByMatter is set inside the time-entries block and consumed during
      // matter enrichment in Step 6c.
      let wipByMatter: Map<string, WipSummary> | null = null;

      // --- 6a-2: Time entries — fetch, normalise, enrich (WIP), store, release
      // rawTimeEntries and safeTimeEntries released at end of block.
      // WIP aggregation maps declared here so they survive beyond the block scope.
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching time entries');
      const chargeableHoursByLawyer = new Map<string, number>();
      const totalHoursByLawyer      = new Map<string, number>();
      {
        // Pass attorney IDs for the completeness fallback — works around the
        // known Yao API edge case where the unfiltered query misses entries
        // for certain attorneys (e.g. Ben Haulkham, Carla Fishlock).
        const attorneyIds = attorneys.map((a) => a._id);
        const rawTimeEntries  = await adapter.fetchTimeEntries(dateFrom, attorneyIds);
        stats.timeEntries     = rawTimeEntries.length;
        const safeTimeEntries = stripSensitiveFromArray(
          resolveAll(
            {
              matters:       [],
              timeEntries:   rawTimeEntries.map(transformTimeEntry),
              invoices:      [],
              disbursements: [],
              tasks:         [],
            },
            maps,
          ).timeEntries,
        );

        // Aggregate chargeable and total hours per attorney while safeTimeEntries is in scope
        for (const te of safeTimeEntries) {
          const teRec = te as unknown as Record<string, unknown>;
          const lid   = teRec['lawyerId'] != null ? String(teRec['lawyerId']) : null;
          if (!lid) continue;
          const hours = typeof teRec['durationHours'] === 'number' ? teRec['durationHours'] : 0;
          totalHoursByLawyer.set(lid, (totalHoursByLawyer.get(lid) ?? 0) + hours);
          if (teRec['isChargeable'] !== false) {
            chargeableHoursByLawyer.set(lid, (chargeableHoursByLawyer.get(lid) ?? 0) + hours);
          }
        }

        // Validate against /time-entries/summary — detects silent pagination
        // failures by comparing fetched total against server-computed total.
        try {
          const fetchedHours = (safeTimeEntries as unknown as Array<Record<string, unknown>>).reduce(
            (s, e) => s + (typeof e['durationHours'] === 'number' ? (e['durationHours'] as number) : 0),
            0,
          );
          const summary = await adapter.fetchTimeEntrySummary(dateFrom);
          adapter.validateTimeEntryTotals(fetchedHours, summary);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[PullOrchestrator] time entries summary validation skipped: ${msg}`);
        }

        const wipEnrichment = buildWipEnrichment(safeTimeEntries);
        // Promote byMatter to outer scope — needed for matter enrichment in Step 6c.
        wipByMatter = wipEnrichment.byMatter;
        await Promise.all([
          storeEnrichedEntities(firmId, 'timeEntry', safeTimeEntries as unknown as Record<string, unknown>[], [], undefined),
          storeEnrichedEntities(firmId, 'wip',       [wipEnrichment as unknown as Record<string, unknown>],   [], undefined),
        ]);
      }

      // Now store fee earner records enriched with department + WIP hours.
      // safeMatters (department) and chargeableHoursByLawyer/totalHoursByLawyer are all in scope.
      {
        const deptCountsByLawyer = new Map<string, Map<string, number>>();
        for (const m of safeMatters as unknown as Array<Record<string, unknown>>) {
          const lid  = m['responsibleLawyerId'] != null ? String(m['responsibleLawyerId']) : null;
          const dept = m['departmentName']       != null ? String(m['departmentName'])       : null;
          if (!lid || !dept) continue;
          const counts = deptCountsByLawyer.get(lid) ?? new Map<string, number>();
          counts.set(dept, (counts.get(dept) ?? 0) + 1);
          deptCountsByLawyer.set(lid, counts);
        }

        const enrichedWithAggregates = (enrichedFeeEarners as unknown as Array<Record<string, unknown>>).map((fe) => {
          const id        = fe['_id'] != null ? String(fe['_id']) : '';
          const deptCounts = deptCountsByLawyer.get(id);
          let topDept: string | null = null;
          if (deptCounts) {
            let maxCount = 0;
            for (const [dept, count] of deptCounts) {
              if (count > maxCount) { maxCount = count; topDept = dept; }
            }
          }

          // Targets API fallback: if no CSV match populated targetWeeklyHours
          // or chargeableWeeklyTarget, derive them from the targets endpoint.
          const target = targetsByUser.get(id);
          const csvTargetWeekly      = fe['targetWeeklyHours']        as number | null | undefined;
          const csvChargeableWeekly  = fe['chargeableWeeklyTarget']   as number | null | undefined;
          const apiWeeklyHours       = target ? target.workHoursPerDay * 5 : null;
          const apiChargeableWeekly  = target ? target.workHoursPerDay * 5 * (1 - target.nonChargeableRatio) : null;

          return {
            ...fe,
            departmentName:        topDept,
            wipChargeableHours:    chargeableHoursByLawyer.get(id) ?? 0,
            wipTotalHours:         totalHoursByLawyer.get(id)      ?? 0,
            targetWeeklyHours:     csvTargetWeekly      ?? apiWeeklyHours      ?? null,
            chargeableWeeklyTarget: csvChargeableWeekly ?? apiChargeableWeekly ?? null,
          };
        });

        const targetsMerged = enrichedWithAggregates.filter(
          (fe) => targetsByUser.has(String((fe as Record<string, unknown>)['_id'] ?? '')),
        ).length;
        await storeEnrichedEntities(firmId, 'feeEarner', enrichedWithAggregates, [], undefined);
        console.log(
          `[PullOrchestrator] stored ${enrichedWithAggregates.length} fee earners with ` +
          `departmentName + WIP hours (${chargeableHoursByLawyer.size} have chargeable hours, ` +
          `${targetsMerged} have targets API data)`,
        );
      }

      await updatePullStage(firmId, 'Fetching time entries', {
        matters:     stats.matters,
        timeEntries: stats.timeEntries,
      });

      // --- 6a-3: Invoices — fetch, normalise. Store DEFERRED until Step 6c
      // so that datePaid (derived from ledger records in Step 6b) can be merged
      // before the persisted write. safeInvoices is consumed by Step 6c.
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching invoices');
      const rawInvoices  = await adapter.fetchInvoices(dateFrom);
      stats.invoices     = rawInvoices.length;
      const safeInvoices = stripSensitiveFromArray(
        resolveAll(
          {
            matters:       [],
            timeEntries:   [],
            invoices:      rawInvoices.map(transformInvoice),
            disbursements: [],
            tasks:         [],
          },
          maps,
        ).invoices,
      );
      // rawInvoices no longer referenced after this point
      await updatePullStage(firmId, 'Fetching invoices', {
        matters:     stats.matters,
        timeEntries: stats.timeEntries,
        invoices:    stats.invoices,
      });

      // --- 6a-4: Tasks — fetch, normalise, store, release
      // rawTasks released at end of block
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching tasks');
      {
        const rawTasks      = await adapter.fetchTasks();
        stats.tasks         = rawTasks.length;
        const resolvedTasks = resolveAll(
          {
            matters:       [],
            timeEntries:   [],
            invoices:      [],
            disbursements: [],
            tasks:         rawTasks.map(transformTask),
          },
          maps,
        );
        await storeEnrichedEntities(firmId, 'task', resolvedTasks.tasks as unknown as Record<string, unknown>[], [], undefined);
      }
      await updatePullStage(firmId, 'Fetching tasks', {
        matters:     stats.matters,
        timeEntries: stats.timeEntries,
        invoices:    stats.invoices,
        tasks:       stats.tasks,
      });

      // --- 6a-5: CONTACTS DISABLED — client display names already available inline
      // on matters.clients[].contact.display_name and invoices.clients[].display_name
      // Re-enable if standalone contact profiles are needed in a future phase
      // -----------------------------------------------------------------------
      // await updatePullStage(firmId, 'Fetching contacts');
      // {
      //   const rawContacts    = await adapter.fetchContacts();
      //   stats.contacts       = rawContacts.length;
      //   const normContacts   = rawContacts.map(transformContact);
      //   const clientProfiles = buildClientProfiles(normContacts, safeMatters, safeInvoices);
      //   await storeEnrichedEntities(firmId, 'client', clientProfiles as unknown as Record<string, unknown>[], [], undefined);
      // }
      // Collect non-fatal adapter warnings (e.g. early pagination stop)
      warnings.push(...adapter.getWarnings());
      // await updatePullStage(firmId, 'Fetching contacts', { ... }); // disabled with contacts

      // -----------------------------------------------------------------------
      // Step 6b: Ledgers — parallel triple-fetch by ledger_type
      //
      // The Yao API only accepts a single LedgerEntryType per call (`ledger_type`),
      // so three parallel paginated requests cover the BI-relevant types:
      //   OFFICE_PAYMENT       → disbursements
      //   CLIENT_TO_OFFICE     → invoice payments + disbursement recoveries
      //   OFFICE_RECEIPT       → invoice payments + disbursement recoveries
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Fetching ledgers');
      const [officePaymentLedgers, clientToOfficeLedgers, officeReceiptLedgers] = await Promise.all([
        adapter.fetchLedgers('OFFICE_PAYMENT',   dateFrom, archivedMatterIds),
        adapter.fetchLedgers('CLIENT_TO_OFFICE', dateFrom, archivedMatterIds),
        adapter.fetchLedgers('OFFICE_RECEIPT',   dateFrom, archivedMatterIds),
      ]);
      const allLedgers = [...officePaymentLedgers, ...clientToOfficeLedgers, ...officeReceiptLedgers];
      const routed = adapter.routeLedgers(allLedgers);
      console.log(
        `[PullOrchestrator] ledgers: ${allLedgers.length} total | ` +
        `disbursements=${routed.disbursements.length}, ` +
        `invoicePayments=${routed.invoicePayments.length}, ` +
        `disbursementRecoveries=${routed.disbursementRecoveries.length}`,
      );

      // Build normalised disbursement entities from OFFICE_PAYMENT records
      const safeDisbursements = stripSensitiveFromArray(
        resolveAll(
          {
            matters:       [],
            timeEntries:   [],
            invoices:      [],
            disbursements: routed.disbursements.map(transformDisbursement),
            tasks:         [],
          },
          maps,
        ).disbursements,
      );
      stats.disbursements = safeDisbursements.length;
      await updatePullStage(firmId, 'Fetching ledgers', { disbursements: stats.disbursements });

      // -----------------------------------------------------------------------
      // Step 6c: Final enrichment + stores
      //   1. Derive datePaid on invoices using invoicePayments ledgers
      //   2. Aggregate invoices by matter
      //   3. Merge WIP + invoice aggregates into matter records
      //   4. Store matters, invoices, disbursements (in parallel)
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Enriching matters with WIP and invoice aggregates');
      const enrichedInvoices = enrichInvoicesWithDatePaid(
        safeInvoices as unknown as NormalisedInvoice[],
        routed.invoicePayments,
      );
      const invoiceByMatter = aggregateInvoicesByMatter(enrichedInvoices);

      const mattersFinal = (safeMatters as unknown as Array<Record<string, unknown>>).map((m) => {
        const mId = String(m['_id'] ?? '');
        if (!mId) return m;
        const wip = wipByMatter?.get(mId);
        const inv = invoiceByMatter.get(mId);
        const out: Record<string, unknown> = { ...m };
        if (wip) {
          out['wipTotalBillable']      = wip.totalBillable;
          out['wipTotalWriteOff']      = wip.totalWriteOff;
          out['wipTotalHours']         = wip.totalHours;
          out['wipChargeableHours']    = wip.chargeableHours;
          out['wipNonChargeableHours'] = wip.nonChargeableHours;
        }
        if (inv) {
          out['invoicedNetBilling']   = inv.invoicedNetBilling;
          out['invoicedOutstanding']  = inv.invoicedOutstanding;
          out['invoicedPaid']         = inv.invoicedPaid;
          out['invoicedWrittenOff']   = inv.invoicedWrittenOff;
          out['invoiceCount']         = inv.invoiceCount;
        }
        return out;
      });

      const mattersWithWip      = mattersFinal.filter((m) => m['wipTotalBillable']     != null).length;
      const mattersWithInvoices = mattersFinal.filter((m) => m['invoicedNetBilling']    != null).length;
      console.log(
        `[PullOrchestrator] matter enrichment: ${mattersFinal.length} matters | ` +
        `WIP merged into ${mattersWithWip} | invoice aggregates merged into ${mattersWithInvoices}`,
      );

      await Promise.all([
        storeEnrichedEntities(firmId, 'matter',       mattersFinal,                                                                  [], undefined),
        storeEnrichedEntities(firmId, 'invoice',      enrichedInvoices as unknown as Record<string, unknown>[],                      [], undefined),
        storeEnrichedEntities(firmId, 'disbursement', safeDisbursements as unknown as Record<string, unknown>[],                     [], undefined),
      ]);

      // -----------------------------------------------------------------------
      // Step 10: Calculate KPIs
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Calculating KPIs');
      const calcOrchestrator = this.deps.createCalcOrchestrator(firmId);
      const kpiResult = await calcOrchestrator.calculateAll(firmId);

      // -----------------------------------------------------------------------
      // Step 11: kpi_snapshots — already written by CalculationOrchestrator
      // (step 9b inside calculateAll). Do NOT call writeKpiSnapshots again here:
      // a second call with an empty array would DELETE the rows just written.
      // Build snapshotRows only for the risk flag scan below.
      //
      // CalculationResult uses field 'results' (not 'formulaResults'), so pass
      // the fields explicitly — do NOT cast the whole object as Record<string,unknown>.
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Writing snapshots');
      const snapshotRows = buildSnapshotsFromKpiResults(
        firmId,
        pulledAt,
        {
          kpis: {
            formulaResults: kpiResult.results,
            ragAssignments: kpiResult.ragAssignments,
          },
        },
      );
      stats.kpiSnapshotsWritten = snapshotRows.length;

      // -----------------------------------------------------------------------
      // Step 12: Scan + store risk flags
      // -----------------------------------------------------------------------
      await updatePullStage(firmId, 'Scanning for risks');
      const riskFlags = scanForRiskFlags({
        firmId,
        kpiSnapshots: snapshotRows,
        config: firmConfig,
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
