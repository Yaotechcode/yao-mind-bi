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

import type { NormalisedInvoice, NormalisedTimeEntry } from '../normalise/types.js';
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
  /** Branch 1 — sum of time entry `billable` for entries this attorney recorded that were billed. */
  invoicedFromTimeEntries: number;
  /** Branch 2 — manual upward override surplus, attributed to the invoice's solicitor. */
  invoicedOverrideUplift: number;
  /** Branch 3 — fixed fees and other fee lines, attributed to the invoice's solicitor. */
  invoicedFixedAndOtherFees: number;
  /** Sum of the three branches above (kept for backward compatibility). */
  invoicedNetBilling: number;
  invoicedOutstanding: number;
  invoicedPaid: number;
  invoiceCount: number;
}

// Statuses included in MATTER aggregation (exclude DRAFT, CANCELED, ERROR).
// NOTE: WRITTEN_OFF is intentionally NOT included here — the matter-level
// treatment of WRITTEN_OFF is a separately tracked issue. See
// FEE_EARNER_BILLABLE_STATUSES for the fee-earner attribution set.
const BILLABLE_STATUSES = new Set(['ISSUED', 'PAID', 'CREDITED']);

// Statuses included in FEE EARNER attribution. WRITTEN_OFF is a distinct invoice
// status (not the written_off amount field): a fully written-off invoice would
// otherwise vanish from attribution entirely. Write-offs are already reflected in
// time entry `billable` values at consolidation time, so including WRITTEN_OFF
// invoices does not double-deduct.
const FEE_EARNER_BILLABLE_STATUSES = new Set(['ISSUED', 'PAID', 'CREDITED', 'WRITTEN_OFF']);

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
    invoicedFromTimeEntries: 0,
    invoicedOverrideUplift: 0,
    invoicedFixedAndOtherFees: 0,
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
 * Attributes billed value to fee earners using a three-branch additive model.
 * Each branch captures a distinct, non-overlapping source of revenue:
 *
 *   Branch 1 — Time entry billable values, attributed to the entry's assignee
 *              (the fee earner who did the work) for entries that were billed on
 *              an invoice in a billable status. This is the primary mechanism.
 *   Branch 2 — Override uplift: the surplus when a solicitor manually overrides
 *              an invoice's total billable above the sum of its entries' values.
 *              Attributed to the invoice's solicitor.
 *   Branch 3 — Fixed fees and other fee lines (billingAmount + totalOtherFees)
 *              that never flow through time entries. Attributed to the solicitor.
 *
 * Only invoices in FEE_EARNER_BILLABLE_STATUSES (incl. WRITTEN_OFF) participate.
 * invoicedNetBilling is the sum of the three branches.
 */
export function aggregateInvoicesByFeeEarner(
  invoices: NormalisedInvoice[],
  timeEntries: NormalisedTimeEntry[],
): Map<string, InvoiceFeeEarnerSummary> {
  const map = new Map<string, InvoiceFeeEarnerSummary>();
  const ensure = (lawyerId: string): InvoiceFeeEarnerSummary => {
    let summary = map.get(lawyerId);
    if (!summary) {
      summary = emptyFeeEarnerSummary();
      map.set(lawyerId, summary);
    }
    return summary;
  };

  // Lookups: invoice _id → status, and time entry _id → billable value.
  const invoiceStatusMap = new Map<string, string>();
  for (const invoice of invoices) invoiceStatusMap.set(invoice._id, invoice.status);
  const timeEntryValueMap = new Map<string, number>();
  for (const entry of timeEntries) timeEntryValueMap.set(entry._id, entry.billable);

  // --- Branch 1: time entry billable values, by assignee ---
  for (const entry of timeEntries) {
    if (entry.invoiceId === null) continue;
    const invoiceStatus = invoiceStatusMap.get(entry.invoiceId);
    if (invoiceStatus === undefined || !FEE_EARNER_BILLABLE_STATUSES.has(invoiceStatus)) continue;
    if (entry.lawyerId === null) continue;
    // billable already reflects write-downs at consolidation — do NOT subtract write_off.
    ensure(entry.lawyerId).invoicedFromTimeEntries += entry.billable;
  }

  // --- Invoice-level branches (2 & 3) + invoice-level financials ---
  for (const invoice of invoices) {
    if (!FEE_EARNER_BILLABLE_STATUSES.has(invoice.status)) continue;
    if (!invoice.responsibleLawyerId) continue;
    const summary = ensure(invoice.responsibleLawyerId);

    summary.invoicedOutstanding += invoice.outstanding;
    summary.invoicedPaid += invoice.paid;
    summary.invoiceCount += 1;

    // Branch 2 — override uplift (floored at 0; downward overrides ignored).
    if (invoice.timeEntriesOverrideValue > 0) {
      const sumOfEntryValues = Array.isArray(invoice.timeEntryIds)
        ? invoice.timeEntryIds.reduce((acc, id) => acc + (timeEntryValueMap.get(id) ?? 0), 0)
        : 0;
      const uplift = Math.max(0, invoice.billableEntries - sumOfEntryValues);
      summary.invoicedOverrideUplift += uplift;
    }

    // Branch 3 — fixed fees + other fee lines (total_firm_fees excluded).
    const fixedAndOther = invoice.billingAmount + invoice.totalOtherFees;
    if (fixedAndOther > 0) {
      summary.invoicedFixedAndOtherFees += fixedAndOther;
    }
  }

  // --- Total: sum of the three branches ---
  for (const summary of map.values()) {
    summary.invoicedNetBilling =
      summary.invoicedFromTimeEntries +
      summary.invoicedOverrideUplift +
      summary.invoicedFixedAndOtherFees;
  }

  return map;
}
