/**
 * invoice-enricher.ts — Invoice enrichment and aggregation.
 *
 * Derives datePaid from ledger records and aggregates invoices by matter
 * and fee earner for use by the formula engine.
 *
 * Rules:
 *  - Pure functions — no side effects, no async
 *  - REVERSED ledger records are ignored for datePaid derivation
 *  - Only ISSUED, PAID, CREDITED invoices included in matter aggregation
 *  - Groups by matterId; invoices with no matterId are excluded from byMatter
 */

import type { NormalisedInvoice } from '../normalise/types.js';
import type { YaoLedger } from '../types.js';

// =============================================================================
// Types
// =============================================================================

export interface InvoiceMatterSummary {
  invoicedNetBilling: number;
  invoicedOutstanding: number;
  invoicedPaid: number;
  invoicedWrittenOff: number;
  invoiceCount: number;
  latestInvoiceDate: string | null;
}

export interface InvoiceFeeEarnerSummary {
  invoicedNetBilling: number;
  invoicedOutstanding: number;
  invoicedPaid: number;
  invoiceCount: number;
}

// Statuses included in aggregations (exclude DRAFT, CANCELED, ERROR)
const BILLABLE_STATUSES = new Set(['ISSUED', 'PAID', 'CREDITED']);

// =============================================================================
// datePaid derivation
// =============================================================================

/**
 * Finds the payment date for a given invoice from the invoicePayments ledger
 * records. Returns null if no matching payment exists.
 *
 * Matching rule: ledger.invoice === invoice._id (string equality).
 * REVERSED status ledger records are excluded.
 * If multiple payments match, prefer the one where outstanding === 0
 * (meaning the invoice was fully settled); otherwise use the latest date.
 */
export function deriveInvoiceDatePaid(
  invoice: NormalisedInvoice,
  invoicePayments: YaoLedger[],
): string | null {
  const matches = invoicePayments.filter(
    (l) => l.invoice === invoice._id && l.status !== 'REVERSED',
  );

  if (matches.length === 0) return null;

  // Prefer the record that brings outstanding to zero
  const settledRecord = matches.find((l) => l.outstanding === 0);
  if (settledRecord) return settledRecord.date;

  // Fall back to the latest date among matching records
  return matches.reduce((latest, l) => (l.date > latest ? l.date : latest), matches[0].date);
}

/**
 * Applies deriveInvoiceDatePaid to every invoice in the array.
 * Returns a new array with datePaid populated where derivable.
 * Logs resolution stats.
 */
export function enrichInvoicesWithDatePaid(
  invoices: NormalisedInvoice[],
  invoicePayments: YaoLedger[],
): NormalisedInvoice[] {
  let resolved = 0;

  const enriched = invoices.map((invoice) => {
    if (invoice.datePaid !== null) return invoice; // already set upstream

    const datePaid = deriveInvoiceDatePaid(invoice, invoicePayments);
    if (datePaid !== null) {
      resolved += 1;
      return { ...invoice, datePaid };
    }
    return invoice;
  });

  const remaining = invoices.length - resolved - invoices.filter((i) => i.datePaid !== null).length;
  console.log(
    `[invoice-enricher] datePaid resolved: ${resolved}/${invoices.length} — ` +
      `${remaining} still null`,
  );

  return enriched;
}

// =============================================================================
// Billing type derivation
// =============================================================================

export type MatterBillingType = 'fixed_fee' | 'hourly' | 'unknown';

/**
 * Derives the billing type for a matter from its fields.
 *
 * Priority order:
 *   1. Explicit `billingType` field (string) — used directly if present and recognised.
 *   2. `isFixedFee` boolean — 'fixed_fee' when true, 'hourly' when false.
 *   3. Falls back to 'unknown' when neither is available.
 */
export function deriveMatterBillingType(matter: Record<string, unknown>): MatterBillingType {
  const explicit = matter['billingType'];
  if (explicit === 'fixed_fee' || explicit === 'hourly') return explicit;
  const isFixed = matter['isFixedFee'];
  if (isFixed === true) return 'fixed_fee';
  if (isFixed === false) return 'hourly';
  return 'unknown';
}

// =============================================================================
// Aggregation helpers
// =============================================================================

function emptyMatterSummary(): InvoiceMatterSummary {
  return {
    invoicedNetBilling: 0,
    invoicedOutstanding: 0,
    invoicedPaid: 0,
    invoicedWrittenOff: 0,
    invoiceCount: 0,
    latestInvoiceDate: null,
  };
}

function emptyFeeEarnerSummary(): InvoiceFeeEarnerSummary {
  return {
    invoicedNetBilling: 0,
    invoicedOutstanding: 0,
    invoicedPaid: 0,
    invoiceCount: 0,
  };
}

// =============================================================================
// Public aggregation functions
// =============================================================================

/**
 * Groups invoices by matterId.
 * Only ISSUED, PAID, CREDITED invoices are included.
 * Invoices with no matterId are excluded.
 */
export function aggregateInvoicesByMatter(
  invoices: NormalisedInvoice[],
): Map<string, InvoiceMatterSummary> {
  const map = new Map<string, InvoiceMatterSummary>();

  for (const invoice of invoices) {
    if (!BILLABLE_STATUSES.has(invoice.status)) continue;
    if (!invoice.matterId) continue;

    let summary = map.get(invoice.matterId);
    if (!summary) {
      summary = emptyMatterSummary();
      map.set(invoice.matterId, summary);
    }

    summary.invoicedNetBilling += invoice.total;
    summary.invoicedOutstanding += invoice.outstanding;
    summary.invoicedPaid += invoice.paid;
    summary.invoicedWrittenOff += invoice.writtenOff;
    summary.invoiceCount += 1;

    if (
      invoice.invoiceDate &&
      (summary.latestInvoiceDate === null || invoice.invoiceDate > summary.latestInvoiceDate)
    ) {
      summary.latestInvoiceDate = invoice.invoiceDate;
    }
  }

  return map;
}

/**
 * Groups invoices by responsibleLawyerId.
 * Invoices with no responsibleLawyerId are excluded.
 * All non-DRAFT/CANCELED/ERROR statuses are included.
 */
export function aggregateInvoicesByFeeEarner(
  invoices: NormalisedInvoice[],
): Map<string, InvoiceFeeEarnerSummary> {
  const map = new Map<string, InvoiceFeeEarnerSummary>();

  for (const invoice of invoices) {
    if (!BILLABLE_STATUSES.has(invoice.status)) continue;
    if (!invoice.responsibleLawyerId) continue;

    let summary = map.get(invoice.responsibleLawyerId);
    if (!summary) {
      summary = emptyFeeEarnerSummary();
      map.set(invoice.responsibleLawyerId, summary);
    }

    summary.invoicedNetBilling += invoice.total;
    summary.invoicedOutstanding += invoice.outstanding;
    summary.invoicedPaid += invoice.paid;
    summary.invoiceCount += 1;
  }

  return map;
}
