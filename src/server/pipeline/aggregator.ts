// src/server/pipeline/aggregator.ts
// Stage 6: Aggregate — pure functions only. No database calls.

import type {
  JoinResult,
  AggregateResult,
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
  AggregatedFirm,
  WipVsInvoiceDiscrepancy,
} from '../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice } from '../../shared/types/enriched.js';
import { buildDataQualityReport } from './data-quality.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addToArrayMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Safely extract a number from an unknown-typed field. Returns 0 if not a number. */
function num(value: unknown): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

// Unused direct sumField — kept for clarity; callers use inline reduce with num()
void 0;

function minDate(dates: unknown[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return null;
  return new Date(Math.min(...valid.map(d => d.getTime())));
}

function maxDate(dates: unknown[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map(d => d.getTime())));
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

export function aggregate(
  joinResult: JoinResult,
  today: Date,
  availableFileTypes: string[] = []
): AggregateResult {

  // ── Index time entries ──────────────────────────────────────────────────
  // Keyed by matterId (primary), matterNumber (secondary), and lawyerId / lawyerName
  const entriesByMatterId  = new Map<string, EnrichedTimeEntry[]>();
  const entriesByMatterNum = new Map<string, EnrichedTimeEntry[]>();
  const entriesByLawyerId  = new Map<string, EnrichedTimeEntry[]>();
  const entriesByLawyerName = new Map<string, EnrichedTimeEntry[]>();

  for (const entry of joinResult.timeEntries) {
    if (entry.hasMatchedMatter) {
      if (typeof entry.matterId === 'string')     addToArrayMap(entriesByMatterId,  entry.matterId,  entry);
      if (typeof entry.matterNumber === 'string') addToArrayMap(entriesByMatterNum, entry.matterNumber, entry);
    }

    if (typeof entry.lawyerId === 'string') {
      addToArrayMap(entriesByLawyerId, entry.lawyerId, entry);
    } else if (typeof entry.lawyerName === 'string') {
      addToArrayMap(entriesByLawyerName, entry.lawyerName, entry);
    }
  }

  // ── Index invoices ──────────────────────────────────────────────────────
  const invoicesByMatterNum  = new Map<string, EnrichedInvoice[]>();
  const invoicesByLawyerId   = new Map<string, EnrichedInvoice[]>();

  for (const invoice of joinResult.invoices) {
    if (typeof invoice.matterNumber === 'string') {
      addToArrayMap(invoicesByMatterNum, invoice.matterNumber, invoice);
    }
    const respId = invoice.responsibleLawyerId;
    if (typeof respId === 'string') {
      addToArrayMap(invoicesByLawyerId, respId, invoice);
    }
  }

  // ── Aggregate matters ───────────────────────────────────────────────────
  const aggregatedMatters: AggregatedMatter[] = joinResult.matters.map(matter => {
    const matterId     = typeof matter.matterId === 'string'     ? matter.matterId     : undefined;
    const matterNumber = typeof matter.matterNumber === 'string' ? matter.matterNumber : undefined;

    const mEntries =
      (matterId     ? entriesByMatterId.get(matterId)       : undefined) ??
      (matterNumber ? entriesByMatterNum.get(matterNumber)  : undefined) ??
      [];

    // WIP aggregates
    const wipTotalDurationMinutes = mEntries.reduce((s, e) => s + num(e.durationMinutes), 0);
    const wipTotalHours           = wipTotalDurationMinutes / 60;
    const wipTotalBillable        = mEntries.reduce((s, e) => s + num(e.billableValue), 0);
    const wipTotalWriteOff        = mEntries.reduce((s, e) => s + num(e.writeOffValue), 0);
    const wipTotalUnits           = mEntries.length;

    const chargeable    = mEntries.filter(e => e.isChargeable === true);
    const nonChargeable = mEntries.filter(e => e.isChargeable !== true);

    const wipTotalChargeable    = chargeable.reduce((s, e) => s + num(e.billableValue), 0);
    const wipTotalNonChargeable = nonChargeable.reduce((s, e) => s + num(e.billableValue), 0);
    const wipChargeableHours    = chargeable.reduce((s, e) => s + num(e.durationHours), 0);
    const wipNonChargeableHours = nonChargeable.reduce((s, e) => s + num(e.durationHours), 0);

    const entryDates        = mEntries.map(e => e.date);
    const wipOldestEntryDate = minDate(entryDates);
    const wipNewestEntryDate = maxDate(entryDates);
    const wipAgeInDays       = wipOldestEntryDate
      ? Math.floor((today.getTime() - wipOldestEntryDate.getTime()) / 86400000)
      : null;

    // Invoice aggregates
    const mInvoices = (matterNumber ? invoicesByMatterNum.get(matterNumber) : undefined) ?? [];

    const invoiceCount         = mInvoices.length;
    const invoicedNetBilling   = mInvoices.reduce((s, i) => s + num(i.subtotal), 0);
    const invoicedDisbursements = mInvoices.reduce((s, i) => s + num(i.totalDisbursements), 0);
    const invoicedTotal        = mInvoices.reduce((s, i) => s + num(i.total), 0);
    const invoicedOutstanding  = mInvoices.reduce((s, i) => s + num(i.outstanding), 0);
    const invoicedPaid         = mInvoices.reduce((s, i) => s + num(i.paid), 0);
    const invoicedWrittenOff   = mInvoices.reduce((s, i) => s + num(i.writtenOff), 0);

    // Dual source of truth
    let discrepancy: WipVsInvoiceDiscrepancy | undefined;
    if (wipTotalBillable > 0 && invoicedNetBilling > 0) {
      const billingDifference        = wipTotalBillable - invoicedNetBilling;
      const billingDifferencePercent = (billingDifference / wipTotalBillable) * 100;
      const hasMajorDiscrepancy      = Math.abs(billingDifferencePercent) > 10;
      discrepancy = { billingDifference, billingDifferencePercent, hasMajorDiscrepancy };
    }

    const result: AggregatedMatter = {
      matterId,
      matterNumber,
      wipTotalDurationMinutes,
      wipTotalHours,
      wipTotalBillable,
      wipTotalWriteOff,
      wipTotalUnits,
      wipTotalChargeable,
      wipTotalNonChargeable,
      wipChargeableHours,
      wipNonChargeableHours,
      wipOldestEntryDate,
      wipNewestEntryDate,
      wipAgeInDays,
      invoiceCount,
      invoicedNetBilling,
      invoicedDisbursements,
      invoicedTotal,
      invoicedOutstanding,
      invoicedPaid,
      invoicedWrittenOff,
    };
    if (discrepancy !== undefined) result.discrepancy = discrepancy;
    return result;
  });

  // Build matter aggregate lookup
  const matterAggById  = new Map<string, AggregatedMatter>();
  const matterAggByNum = new Map<string, AggregatedMatter>();
  for (const m of aggregatedMatters) {
    if (m.matterId)     matterAggById.set(m.matterId, m);
    if (m.matterNumber) matterAggByNum.set(m.matterNumber, m);
  }

  // ── Aggregate fee earners ───────────────────────────────────────────────
  const aggregatedFeeEarners: AggregatedFeeEarner[] = joinResult.feeEarners.map(feeEarner => {
    const lawyerId   = typeof feeEarner.lawyerId   === 'string' ? feeEarner.lawyerId   : undefined;
    const lawyerName = typeof feeEarner.lawyerName === 'string' ? feeEarner.lawyerName : undefined;

    const feEntries: EnrichedTimeEntry[] =
      (lawyerId   ? entriesByLawyerId.get(lawyerId)     : undefined) ??
      (lawyerName ? entriesByLawyerName.get(lawyerName) : undefined) ??
      [];

    const wipTotalHours       = feEntries.reduce((s, e) => s + num(e.durationHours), 0);
    const chargeable          = feEntries.filter(e => e.isChargeable === true);
    const nonChargeable       = feEntries.filter(e => e.isChargeable !== true);
    const wipChargeableHours  = chargeable.reduce((s, e) => s + num(e.durationHours), 0);
    const wipNonChargeableHours = nonChargeable.reduce((s, e) => s + num(e.durationHours), 0);
    const wipChargeableValue  = chargeable.reduce((s, e) => s + num(e.billableValue), 0);
    const wipTotalValue       = feEntries.reduce((s, e) => s + num(e.billableValue), 0);
    const wipWriteOffValue    = feEntries.reduce((s, e) => s + num(e.writeOffValue), 0);

    const matchedEntries  = feEntries.filter(e => e.hasMatchedMatter);
    const orphanedEntries = feEntries.filter(e => !e.hasMatchedMatter);

    const matterIds = new Set<string>();
    for (const e of matchedEntries) {
      if (typeof e.matterId === 'string') matterIds.add(e.matterId);
    }
    const wipMatterCount = matterIds.size;

    const wipOrphanedHours = orphanedEntries.reduce((s, e) => s + num(e.durationHours), 0);
    const wipOrphanedValue = orphanedEntries.reduce((s, e) => s + num(e.billableValue), 0);

    const entryDates         = feEntries.map(e => e.date);
    const wipOldestEntryDate = minDate(entryDates);
    const wipNewestEntryDate = maxDate(entryDates);
    const wipEntryCount      = feEntries.length;

    const recordingGapDays: number | null = wipNewestEntryDate
      ? Math.floor((today.getTime() - wipNewestEntryDate.getTime()) / 86400000)
      : null;

    // Invoice aggregates — from invoices where responsibleLawyerId = lawyerId
    const feInvoices = (lawyerId ? invoicesByLawyerId.get(lawyerId) : undefined) ?? [];
    const invoicedRevenue     = feInvoices.reduce((s, i) => s + num(i.feeEarnerRevenue ?? (i.subtotal - i.totalFirmFees - i.totalDisbursements)), 0);
    const invoicedOutstanding = feInvoices.reduce((s, i) => s + num(i.outstanding), 0);
    const invoicedCount       = feInvoices.length;

    return {
      lawyerId,
      lawyerName,
      wipTotalHours,
      wipChargeableHours,
      wipNonChargeableHours,
      wipChargeableValue,
      wipTotalValue,
      wipWriteOffValue,
      wipMatterCount,
      wipOrphanedHours,
      wipOrphanedValue,
      wipOldestEntryDate,
      wipNewestEntryDate,
      wipEntryCount,
      recordingGapDays,
      invoicedRevenue,
      invoicedOutstanding,
      invoicedCount,
    };
  });

  // Build fee earner aggregate lookup
  const feeEarnerAggById = new Map<string, AggregatedFeeEarner>();
  for (const fe of aggregatedFeeEarners) {
    if (fe.lawyerId) feeEarnerAggById.set(fe.lawyerId, fe);
  }

  // ── Aggregate clients ───────────────────────────────────────────────────
  const aggregatedClients: AggregatedClient[] = joinResult.clients.map(client => {
    const contactId  = typeof client.contactId  === 'string' ? client.contactId  : undefined;
    const displayName = typeof client.displayName === 'string' ? client.displayName : undefined;
    const clientName  = typeof client.clientName  === 'string' ? client.clientName  : undefined;

    const clientMatters = joinResult.matters.filter(m => {
      const mContactId   = typeof m.contactId   === 'string' ? m.contactId   : null;
      const mClientName  = typeof m.clientName   === 'string' ? m.clientName  : null;
      return (contactId && mContactId === contactId) || (displayName && mClientName === displayName);
    });

    let totalWipValue = 0, totalInvoiced = 0, totalOutstanding = 0, totalPaid = 0;
    let oldestMatterDate: Date | null = null;

    for (const matter of clientMatters) {
      const mId  = typeof matter.matterId     === 'string' ? matter.matterId     : undefined;
      const mNum = typeof matter.matterNumber === 'string' ? matter.matterNumber : undefined;
      const agg  = (mId ? matterAggById.get(mId) : undefined) ?? (mNum ? matterAggByNum.get(mNum) : undefined);
      if (agg) {
        totalWipValue    += agg.wipTotalBillable;
        totalInvoiced    += agg.invoicedNetBilling;
        totalOutstanding += agg.invoicedOutstanding;
        totalPaid        += agg.invoicedPaid;
      }
      const created = matter.createdDate;
      if (created instanceof Date) {
        if (!oldestMatterDate || created < oldestMatterDate) oldestMatterDate = created;
      }
    }

    return {
      contactId,
      displayName,
      clientName,
      matterCount:        clientMatters.length,
      activeMatterCount:  clientMatters.filter(m => m.isActive).length,
      closedMatterCount:  clientMatters.filter(m => m.isClosed).length,
      totalWipValue,
      totalInvoiced,
      totalOutstanding,
      totalPaid,
      oldestMatterDate,
    };
  });

  // ── Aggregate departments ───────────────────────────────────────────────
  const aggregatedDepartments: AggregatedDepartment[] = joinResult.departments.map(dept => {
    const deptName = dept.name;

    const deptMatters    = joinResult.matters.filter(m => m.department === deptName);
    const deptFeeEarners = joinResult.feeEarners.filter(fe => fe.department === deptName);

    let wipTotalHours = 0, wipChargeableHours = 0, wipChargeableValue = 0;
    let invoicedRevenue = 0, invoicedOutstanding = 0;

    for (const matter of deptMatters) {
      const mId  = typeof matter.matterId     === 'string' ? matter.matterId     : undefined;
      const mNum = typeof matter.matterNumber === 'string' ? matter.matterNumber : undefined;
      const agg  = (mId ? matterAggById.get(mId) : undefined) ?? (mNum ? matterAggByNum.get(mNum) : undefined);
      if (agg) {
        wipTotalHours      += agg.wipTotalHours;
        wipChargeableHours += agg.wipChargeableHours;
      }
    }

    for (const fe of deptFeeEarners) {
      const lawyerId = typeof fe.lawyerId === 'string' ? fe.lawyerId : undefined;
      const feAgg    = lawyerId ? feeEarnerAggById.get(lawyerId) : undefined;
      if (feAgg) {
        wipChargeableValue += feAgg.wipChargeableValue;
        invoicedRevenue    += feAgg.invoicedRevenue;
        invoicedOutstanding += feAgg.invoicedOutstanding;
      }
    }

    return {
      name:                 deptName,
      departmentId:         dept.departmentId ?? null,
      feeEarnerCount:       deptFeeEarners.length,
      activeFeeEarnerCount: deptFeeEarners.length, // simplified — no isActive field on FeeEarner
      activeMatterCount:    deptMatters.filter(m => m.isActive).length,
      totalMatterCount:     deptMatters.length,
      wipTotalHours,
      wipChargeableHours,
      wipChargeableValue,
      invoicedRevenue,
      invoicedOutstanding,
    };
  });

  // ── Aggregate firm ──────────────────────────────────────────────────────
  const allEntries    = joinResult.timeEntries;
  const allInvoices   = joinResult.invoices;
  const allMatters    = joinResult.matters;
  const allFeeEarners = joinResult.feeEarners;

  const feeEarnerCount = allFeeEarners.length;
  const salariedCount  = allFeeEarners.filter(fe => fe.payModel === 'Salaried').length;
  const feeShareCount  = allFeeEarners.filter(fe => fe.payModel === 'FeeShare').length;

  const matterCount          = allMatters.length;
  const activeMatterCount    = allMatters.filter(m => m.isActive).length;
  const completedMatterCount = allMatters.filter(m => m.isClosed).length;
  const inProgressMatterCount = allMatters.filter(m => {
    const s = typeof m.status === 'string' ? m.status.toUpperCase() : '';
    return s === 'IN_PROGRESS';
  }).length;
  const otherMatterCount = matterCount - activeMatterCount - completedMatterCount;

  // Compute WIP totals directly from all entries (includes orphaned)
  const totalWipHours         = allEntries.reduce((s, e) => s + num(e.durationHours), 0);
  const totalChargeableHours  = allEntries.filter(e => e.isChargeable === true).reduce((s, e) => s + num(e.durationHours), 0);
  const totalWipValue         = allEntries.reduce((s, e) => s + num(e.billableValue), 0);
  const totalWriteOffValue    = allEntries.reduce((s, e) => s + num(e.writeOffValue), 0);

  const totalInvoicedRevenue  = allInvoices.reduce((s, i) => s + num(i.feeEarnerRevenue ?? (i.subtotal - i.totalFirmFees - i.totalDisbursements)), 0);
  const totalOutstanding      = allInvoices.reduce((s, i) => s + num(i.outstanding), 0);
  const totalPaid             = allInvoices.reduce((s, i) => s + num(i.paid), 0);

  const orphanedEntries       = allEntries.filter(e => !e.hasMatchedMatter);
  const orphanedWipEntryCount = orphanedEntries.length;
  const orphanedWipHours      = orphanedEntries.reduce((s, e) => s + num(e.durationHours), 0);
  const orphanedWipValue      = orphanedEntries.reduce((s, e) => s + num(e.billableValue), 0);
  const orphanedWipPercent    = totalWipValue > 0 ? (orphanedWipValue / totalWipValue) * 100 : 0;

  const firm: AggregatedFirm = {
    feeEarnerCount,
    activeFeeEarnerCount: feeEarnerCount, // simplified — no isActive on FeeEarner
    salariedFeeEarnerCount: salariedCount,
    feeShareFeeEarnerCount: feeShareCount,
    matterCount,
    activeMatterCount,
    inProgressMatterCount,
    completedMatterCount,
    otherMatterCount,
    totalWipHours,
    totalChargeableHours,
    totalWipValue,
    totalWriteOffValue,
    totalInvoicedRevenue,
    totalOutstanding,
    totalPaid,
    orphanedWip: {
      orphanedWipEntryCount,
      orphanedWipHours,
      orphanedWipValue,
      orphanedWipPercent,
      orphanedWipNote:
        'These entries have no matching matter in the Full Matters export. ' +
        'They represent real work and are included in fee earner totals. ' +
        'Expand the Full Matters export or review matter data to resolve.',
    },
  };

  // ── Data quality ────────────────────────────────────────────────────────
  const partialResult = { feeEarners: aggregatedFeeEarners, matters: aggregatedMatters, clients: aggregatedClients, departments: aggregatedDepartments, firm };
  const dataQuality = buildDataQualityReport(joinResult, partialResult, availableFileTypes);

  return { ...partialResult, dataQuality };
}
