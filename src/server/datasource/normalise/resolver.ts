/**
 * resolver.ts — ObjectId resolution using in-memory lookup maps.
 *
 * The transformation layer sets IDs (lawyerId, departmentId, etc.) from the raw
 * API response. This layer fills in the corresponding name/rate/status fields
 * using the lookup maps built at the start of the pull.
 *
 * Rules:
 *  - Never mutate input records — always return new objects
 *  - If a map entry is missing, leave the field as null (no throw)
 *  - Only fill a field if it is currently null AND the corresponding ID is set
 *  - Log resolution statistics so missing-map coverage problems are visible
 */

import type { LookupMaps } from './types.js';
import type {
  NormalisedTimeEntry,
  NormalisedMatter,
  NormalisedInvoice,
  NormalisedDisbursement,
  NormalisedTask,
} from './types.js';

// =============================================================================
// Resolution statistics
// =============================================================================

export interface ResolutionStats {
  timeEntries: {
    lawyerRate: number;
    lawyerStatus: number;
    lawyerIntegrationId: number;
    total: number;
  };
  matters: {
    departmentName: number;
    caseTypeName: number;
    responsibleLawyerName: number;
    responsibleLawyerRate: number;
    supervisorName: number;
    paralegalName: number;
    total: number;
  };
  invoices: {
    responsibleLawyerName: number;
    total: number;
  };
}

// =============================================================================
// Individual resolvers
// =============================================================================

/**
 * Enriches a time entry with attorney details from the lookup map.
 * Fills lawyerDefaultRate, lawyerStatus, lawyerIntegrationId when lawyerId is set.
 */
export function resolveTimeEntryEnrichment(
  entry: NormalisedTimeEntry,
  maps: LookupMaps,
  stats?: ResolutionStats['timeEntries'],
): NormalisedTimeEntry {
  if (!entry.lawyerId) return entry;

  const attorney = maps.attorneyMap[entry.lawyerId];
  if (!attorney) return entry;

  let changed = false;
  const patch: Partial<NormalisedTimeEntry> = {};

  if (entry.lawyerDefaultRate === null && attorney.defaultRate !== null) {
    patch.lawyerDefaultRate = attorney.defaultRate;
    if (stats) { stats.lawyerRate++; changed = true; }
  }

  if (entry.lawyerStatus === null) {
    patch.lawyerStatus = attorney.status;
    if (stats) { stats.lawyerStatus++; changed = true; }
  }

  if (entry.lawyerIntegrationId === null && attorney.integrationAccountId !== null) {
    patch.lawyerIntegrationId = attorney.integrationAccountId;
    if (stats) { stats.lawyerIntegrationId++; changed = true; }
  }

  if (!changed && Object.keys(patch).length === 0) return entry;

  if (stats && changed) stats.total++;
  return { ...entry, ...patch };
}

/**
 * Enriches a matter by filling any null name/rate fields from lookup maps.
 * Only fills fields that are null while their corresponding ID is set.
 */
export function resolveMatterEnrichment(
  matter: NormalisedMatter,
  maps: LookupMaps,
  stats?: ResolutionStats['matters'],
): NormalisedMatter {
  const patch: Partial<NormalisedMatter> = {};
  let anyFilled = false;

  // Department name from map
  if (matter.departmentName === null && matter.departmentId) {
    const name = maps.departmentMap[matter.departmentId];
    if (name) {
      patch.departmentName = name;
      if (stats) { stats.departmentName++; anyFilled = true; }
    }
  }

  // Case type name from map
  if (matter.caseTypeName === null && matter.caseTypeId) {
    const ct = maps.caseTypeMap[matter.caseTypeId];
    if (ct) {
      patch.caseTypeName = ct.title;
      if (stats) { stats.caseTypeName++; anyFilled = true; }
    }
  }

  // Responsible lawyer — name + rate
  if (matter.responsibleLawyerId) {
    const atty = maps.attorneyMap[matter.responsibleLawyerId];
    if (atty) {
      if (matter.responsibleLawyerName === null) {
        patch.responsibleLawyerName = atty.fullName;
        if (stats) { stats.responsibleLawyerName++; anyFilled = true; }
      }
      if (matter.responsibleLawyerRate === null && atty.defaultRate !== null) {
        patch.responsibleLawyerRate = atty.defaultRate;
        if (stats) { stats.responsibleLawyerRate++; anyFilled = true; }
      }
    }
  }

  // Supervisor name
  if (matter.supervisorName === null && matter.supervisorId) {
    const atty = maps.attorneyMap[matter.supervisorId];
    if (atty) {
      patch.supervisorName = atty.fullName;
      if (stats) { stats.supervisorName++; anyFilled = true; }
    }
  }

  // Paralegal name
  if (matter.paralegalName === null && matter.paralegalId) {
    const atty = maps.attorneyMap[matter.paralegalId];
    if (atty) {
      patch.paralegalName = atty.fullName;
      if (stats) { stats.paralegalName++; anyFilled = true; }
    }
  }

  if (Object.keys(patch).length === 0) return matter;
  if (stats && anyFilled) stats.total++;
  return { ...matter, ...patch };
}

/**
 * Enriches an invoice by filling solicitor name from the attorney map
 * when only an ID is present.
 */
export function resolveInvoiceEnrichment(
  invoice: NormalisedInvoice,
  maps: LookupMaps,
  stats?: ResolutionStats['invoices'],
): NormalisedInvoice {
  if (!invoice.responsibleLawyerId || invoice.responsibleLawyerName !== null) return invoice;

  const atty = maps.attorneyMap[invoice.responsibleLawyerId];
  if (!atty) return invoice;

  if (stats) { stats.responsibleLawyerName++; stats.total++; }
  return { ...invoice, responsibleLawyerName: atty.fullName };
}

// =============================================================================
// resolveAll
// =============================================================================

type ResolveAllInput = {
  matters: NormalisedMatter[];
  timeEntries: NormalisedTimeEntry[];
  invoices: NormalisedInvoice[];
  disbursements: NormalisedDisbursement[];
  tasks: NormalisedTask[];
};

/**
 * Applies all resolution functions to all records in one pass.
 * Returns a new data object — inputs are not mutated.
 * Logs resolution statistics showing how many fields were filled by map lookup.
 */
export function resolveAll(data: ResolveAllInput, maps: LookupMaps): ResolveAllInput {
  const stats: ResolutionStats = {
    timeEntries: { lawyerRate: 0, lawyerStatus: 0, lawyerIntegrationId: 0, total: 0 },
    matters: {
      departmentName: 0, caseTypeName: 0,
      responsibleLawyerName: 0, responsibleLawyerRate: 0,
      supervisorName: 0, paralegalName: 0,
      total: 0,
    },
    invoices: { responsibleLawyerName: 0, total: 0 },
  };

  const timeEntries = data.timeEntries.map((e) =>
    resolveTimeEntryEnrichment(e, maps, stats.timeEntries),
  );
  const matters = data.matters.map((m) =>
    resolveMatterEnrichment(m, maps, stats.matters),
  );
  const invoices = data.invoices.map((i) =>
    resolveInvoiceEnrichment(i, maps, stats.invoices),
  );

  console.log(
    '[resolver] Resolution complete —' +
      ` timeEntries: ${stats.timeEntries.total} enriched` +
      ` (rate: ${stats.timeEntries.lawyerRate}, status: ${stats.timeEntries.lawyerStatus}` +
      `, integrationId: ${stats.timeEntries.lawyerIntegrationId})` +
      ` | matters: ${stats.matters.total} enriched` +
      ` (deptName: ${stats.matters.departmentName}, caseTypeName: ${stats.matters.caseTypeName}` +
      `, lawyerName: ${stats.matters.responsibleLawyerName})` +
      ` | invoices: ${stats.invoices.total} enriched`,
  );

  return {
    ...data,
    timeEntries,
    matters,
    invoices,
  };
}
