// src/server/pipeline/joiner.ts
// Stage 4: Join — pure functions only. No database calls.

import type {
  NormaliseResult,
  NormalisedRecord,
  PipelineIndexes,
  JoinResult,
  JoinStats,
} from '../../shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedMatter,
  EnrichedFeeEarner,
  EnrichedInvoice,
  EnrichedClient,
  EnrichedDisbursement,
  EnrichedTask,
  EnrichedDepartment,
} from '../../shared/types/enriched.js';
import { fuzzyMatchLawyer, normaliseName } from './indexer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRecords(
  normalisedResults: Record<string, NormaliseResult>,
  key: string
): NormalisedRecord[] {
  return normalisedResults[key]?.records ?? [];
}

function getAgeBand(daysOutstanding: number): string {
  if (daysOutstanding <= 30) return '0-30';
  if (daysOutstanding <= 60) return '31-60';
  if (daysOutstanding <= 90) return '61-90';
  if (daysOutstanding <= 120) return '91-120';
  return '120+';
}

const CLOSED_STATUSES = new Set(['COMPLETED', 'ARCHIVED', 'NOT_PROCEEDING', 'CLOSED']);
const CLOSED_ONLY = new Set(['COMPLETED', 'CLOSED']);

// ---------------------------------------------------------------------------
// joinRecords
// ---------------------------------------------------------------------------

export function joinRecords(
  normalisedResults: Record<string, NormaliseResult>,
  indexes: PipelineIndexes,
  today: Date = new Date()
): JoinResult {

  // -------------------------------------------------------------------------
  // TIME ENTRIES (wipJson)
  // -------------------------------------------------------------------------
  const timeEntries: EnrichedTimeEntry[] = [];
  const teStats = {
    total: 0,
    matched: 0,
    orphaned: 0,
    orphanedValue: 0,
    lawyerResolved: 0,
    lawyerUnresolved: 0,
  };

  for (const entry of getRecords(normalisedResults, 'wipJson')) {
    teStats.total++;

    const enriched: EnrichedTimeEntry = {
      ...entry,
      hasMatchedMatter: false,
      _lawyerResolved: false,
    };

    // Matter resolution
    const matterId = typeof entry.matterId === 'string' ? entry.matterId : undefined;
    const matterNumber = typeof entry.matterNumber === 'string' ? entry.matterNumber : undefined;

    let matchedMatter: NormalisedRecord | undefined;
    if (matterId) {
      matchedMatter = indexes.matterById.get(matterId);
    }
    if (!matchedMatter && matterNumber) {
      matchedMatter = indexes.matterByNumber.get(matterNumber);
    }

    if (matchedMatter) {
      enriched.hasMatchedMatter = true;
      // Copy matterId from matter if not on entry
      if (!matterId && typeof matchedMatter.matterId === 'string') {
        enriched.matterId = matchedMatter.matterId;
      }
      // Copy clientName from matter
      if (matchedMatter.clientName != null) {
        enriched.clientName = matchedMatter.clientName as string;
      }
      teStats.matched++;
    } else {
      enriched.hasMatchedMatter = false;
      enriched._orphanReason = 'no_matching_matter';
      teStats.orphaned++;
      teStats.orphanedValue += typeof entry.billableValue === 'number' ? entry.billableValue : 0;
    }

    // Fee earner resolution
    const lawyerId = typeof entry.lawyerId === 'string' ? entry.lawyerId : undefined;
    const lawyerNameRaw = typeof entry.lawyerName === 'string' ? entry.lawyerName : undefined;

    let matchedFeeEarner: NormalisedRecord | null = null;
    if (lawyerId) {
      matchedFeeEarner = indexes.feeEarnerById.get(lawyerId) ?? null;
    }
    if (!matchedFeeEarner && lawyerNameRaw) {
      matchedFeeEarner = fuzzyMatchLawyer(lawyerNameRaw, indexes);
    }

    if (matchedFeeEarner) {
      enriched._lawyerResolved = true;
      enriched.lawyerName = typeof matchedFeeEarner.lawyerName === 'string'
        ? matchedFeeEarner.lawyerName
        : lawyerNameRaw ?? undefined;
      enriched.lawyerGrade = typeof matchedFeeEarner.grade === 'string'
        ? matchedFeeEarner.grade
        : null;
      enriched.lawyerPayModel = typeof matchedFeeEarner.payModel === 'string'
        ? matchedFeeEarner.payModel
        : null;
      teStats.lawyerResolved++;
    } else {
      enriched._lawyerResolved = false;
      enriched.lawyerGrade = null;
      enriched.lawyerPayModel = null;
      enriched.lawyerName = lawyerNameRaw ?? undefined;
      teStats.lawyerUnresolved++;
    }

    timeEntries.push(enriched);
  }

  // -------------------------------------------------------------------------
  // MATTERS (fullMattersJson)
  // -------------------------------------------------------------------------
  const matters: EnrichedMatter[] = [];
  const matterStats = {
    total: 0,
    closedMattersMerged: 0,
    clientResolved: 0,
    clientUnresolved: 0,
  };

  // Build a lookup for closed matters
  const closedRecords = getRecords(normalisedResults, 'closedMattersJson');
  const closedByMatterId = new Map<string, NormalisedRecord>();
  const closedByMatterNumber = new Map<string, NormalisedRecord>();
  for (const cr of closedRecords) {
    if (typeof cr.matterId === 'string') closedByMatterId.set(cr.matterId, cr);
    if (typeof cr.matterNumber === 'string') closedByMatterNumber.set(cr.matterNumber, cr);
  }

  for (const matter of getRecords(normalisedResults, 'fullMattersJson')) {
    matterStats.total++;

    const enriched: EnrichedMatter = {
      ...matter,
      hasClosedMatterData: false,
      _clientResolved: false,
      isActive: false,
      isClosed: false,
      isFixedFee: null,
    };

    // Closed matters supplement
    const mId = typeof matter.matterId === 'string' ? matter.matterId : undefined;
    const mNum = typeof matter.matterNumber === 'string' ? matter.matterNumber : undefined;

    let closedMatch: NormalisedRecord | undefined;
    if (mId) closedMatch = closedByMatterId.get(mId);
    if (!closedMatch && mNum) closedMatch = closedByMatterNumber.get(mNum);

    if (closedMatch) {
      enriched.hasClosedMatterData = true;
      matterStats.closedMattersMerged++;

      // Supplement ONLY these 5 fields — do NOT overwrite existing values
      if (enriched.invoiceNetBilling == null && closedMatch.invoiceNetBilling != null) {
        enriched.invoiceNetBilling = closedMatch.invoiceNetBilling as number;
      }
      if (enriched.invoicedDisbursements == null && closedMatch.invoicedDisbursements != null) {
        enriched.invoicedDisbursements = closedMatch.invoicedDisbursements as number;
      }
      if (enriched.invoiceOutstanding == null && closedMatch.invoiceOutstanding != null) {
        enriched.invoiceOutstanding = closedMatch.invoiceOutstanding as number;
      }
      if (enriched.wipBillable == null && closedMatch.wipBillable != null) {
        enriched.wipBillable = closedMatch.wipBillable as number;
      }
      if (enriched.wipWriteOff == null && closedMatch.wipWriteOff != null) {
        enriched.wipWriteOff = closedMatch.wipWriteOff as number;
      }
    }

    // Client resolution
    if (matter.clientName != null && matter.clientName !== '') {
      enriched.clientName = matter.clientName as string;
      enriched._clientResolved = true;
      matterStats.clientResolved++;
    } else {
      // Try by contactId
      const contactId = typeof matter.contactId === 'string' ? matter.contactId : undefined;
      let clientRecord: NormalisedRecord | undefined;
      if (contactId) {
        clientRecord = indexes.clientById.get(contactId);
      }
      if (!clientRecord && typeof matter.clientName === 'string') {
        clientRecord = indexes.clientByName.get(normaliseName(matter.clientName));
      }
      if (clientRecord && typeof clientRecord.displayName === 'string') {
        enriched.clientName = clientRecord.displayName;
        enriched._clientResolved = true;
        matterStats.clientResolved++;
      } else {
        enriched._clientResolved = false;
        matterStats.clientUnresolved++;
      }
    }

    // Status-derived fields
    const statusUpper = typeof matter.status === 'string'
      ? matter.status.toUpperCase()
      : '';

    enriched.isActive = !CLOSED_STATUSES.has(statusUpper);
    enriched.isClosed = CLOSED_ONLY.has(statusUpper);

    matters.push(enriched);
  }

  // -------------------------------------------------------------------------
  // INVOICES (invoicesJson)
  // -------------------------------------------------------------------------
  const invoices: EnrichedInvoice[] = [];
  const invoiceStats = { total: 0, matterResolved: 0, matterUnresolved: 0 };

  for (const invoice of getRecords(normalisedResults, 'invoicesJson')) {
    invoiceStats.total++;

    const enriched: EnrichedInvoice = {
      ...invoice,
      isOverdue: false,
      daysOutstanding: null,
      ageBand: null,
    };

    // Matter resolution
    const invMatterNumber = typeof invoice.matterNumber === 'string' ? invoice.matterNumber : undefined;
    const matchedMatter = invMatterNumber ? indexes.matterByNumber.get(invMatterNumber) : undefined;

    if (matchedMatter) {
      enriched.matterId = typeof matchedMatter.matterId === 'string' ? matchedMatter.matterId : undefined;
      enriched.matterStatus = typeof matchedMatter.status === 'string' ? matchedMatter.status : null;
      enriched.department = typeof matchedMatter.department === 'string' ? matchedMatter.department : undefined;
      invoiceStats.matterResolved++;
    } else {
      invoiceStats.matterUnresolved++;
    }

    // Date-derived fields
    const dueDate = invoice.dueDate;
    const outstanding = (invoice.outstanding as number) ?? 0;

    const isOverdue =
      dueDate instanceof Date &&
      dueDate < today &&
      outstanding > 0;

    enriched.isOverdue = isOverdue;

    if (isOverdue && dueDate instanceof Date) {
      const daysOutstanding = Math.floor(
        (today.getTime() - dueDate.getTime()) / 86400000
      );
      enriched.daysOutstanding = daysOutstanding;
      enriched.ageBand = getAgeBand(daysOutstanding);
    }

    // Client name
    if (typeof invoice.clientId === 'string') {
      const clientRecord = indexes.clientById.get(invoice.clientId);
      if (clientRecord && typeof clientRecord.displayName === 'string') {
        enriched.clientName = clientRecord.displayName;
      }
    } else if (typeof invoice.displayName === 'string') {
      enriched.clientName = invoice.displayName;
    }

    invoices.push(enriched);
  }

  // -------------------------------------------------------------------------
  // DISBURSEMENTS (disbursementsJson)
  // -------------------------------------------------------------------------
  const disbursements: EnrichedDisbursement[] = [];
  const disbStats = { total: 0, matterResolved: 0, matterUnresolved: 0 };

  for (const disb of getRecords(normalisedResults, 'disbursementsJson')) {
    disbStats.total++;

    const enriched: EnrichedDisbursement = {
      ...disb,
      firmExposure: null,
      ageInDays: null,
    };

    // Matter resolution — copy department
    const disbMatterId = typeof disb.matterId === 'string' ? disb.matterId : undefined;
    const matchedMatter = disbMatterId ? indexes.matterById.get(disbMatterId) : undefined;

    if (matchedMatter) {
      if (typeof matchedMatter.department === 'string') {
        enriched.department = matchedMatter.department;
      }
      disbStats.matterResolved++;
    } else {
      disbStats.matterUnresolved++;
    }

    enriched.firmExposure = Math.abs(typeof disb.outstanding === 'number' ? disb.outstanding : 0);

    if (disb.date instanceof Date) {
      enriched.ageInDays = Math.floor(
        (today.getTime() - (disb.date as Date).getTime()) / 86400000
      );
    }

    disbursements.push(enriched);
  }

  // -------------------------------------------------------------------------
  // TASKS (tasksJson)
  // -------------------------------------------------------------------------
  const tasks: EnrichedTask[] = [];

  for (const task of getRecords(normalisedResults, 'tasksJson')) {
    const enriched: EnrichedTask = { ...task };

    // Matter resolution (no field to copy, just for potential future use)
    const taskMatterId = typeof task.matterId === 'string' ? task.matterId : undefined;
    if (taskMatterId) {
      indexes.matterById.get(taskMatterId); // resolution side-effect omitted per spec (no fields to copy)
    }

    // Overdue and days
    const dueDate = task.dueDate;
    const isOverdue =
      dueDate instanceof Date &&
      dueDate < today &&
      task.status !== 'COMPLETED';

    enriched.isOverdue = isOverdue;

    if (dueDate instanceof Date) {
      const daysUntilDue = Math.floor(
        ((dueDate as Date).getTime() - today.getTime()) / 86400000
      );
      enriched.daysUntilDue = daysUntilDue;
      if (isOverdue) {
        enriched.daysOverdue = Math.abs(daysUntilDue);
      }
    }

    tasks.push(enriched);
  }

  // -------------------------------------------------------------------------
  // FEE EARNERS — pass through
  // -------------------------------------------------------------------------
  const feeEarners: EnrichedFeeEarner[] = getRecords(normalisedResults, 'feeEarner').map(
    (r) => ({ ...r } as EnrichedFeeEarner)
  );

  // -------------------------------------------------------------------------
  // CLIENTS — pass through
  // -------------------------------------------------------------------------
  const clients: EnrichedClient[] = getRecords(normalisedResults, 'contactsJson').map(
    (r) => ({ ...r } as EnrichedClient)
  );

  // -------------------------------------------------------------------------
  // DEPARTMENTS — empty (built in Stage 5)
  // -------------------------------------------------------------------------
  const departments: EnrichedDepartment[] = [];

  // -------------------------------------------------------------------------
  // Build JoinStats
  // -------------------------------------------------------------------------
  const joinStats: JoinStats = {
    timeEntries: teStats,
    matters: matterStats,
    invoices: invoiceStats,
    disbursements: disbStats,
  };

  return {
    timeEntries,
    matters,
    feeEarners,
    invoices,
    clients,
    disbursements,
    tasks,
    departments,
    joinStats,
  };
}
