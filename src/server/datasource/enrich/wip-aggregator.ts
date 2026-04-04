/**
 * wip-aggregator.ts — WIP aggregation from normalised time entries.
 *
 * Groups time entry data by matter and by fee earner to produce the WIP
 * summaries used by the formula engine.
 *
 * Rules:
 *  - Pure functions — no side effects, no async
 *  - Entries with no matterId go to orphaned (should be 0 via Yao API)
 *  - Entries with no lawyerId grouped under '__unknown__'
 *  - activityType null is grouped as '__unknown__' in activityBreakdown
 */

import type { NormalisedTimeEntry } from '../normalise/types.js';

// =============================================================================
// Types
// =============================================================================

export interface WipSummary {
  totalHours: number;
  chargeableHours: number;
  nonChargeableHours: number;
  totalBillable: number;
  totalWriteOff: number;
  totalRecorded: number;
  entryCount: number;
  lastEntryDate: string | null;
  activityBreakdown: Record<string, { hours: number; value: number }>;
}

export interface WipEnrichment {
  byMatter: Map<string, WipSummary>;
  byFeeEarner: Map<string, WipSummary>;
  orphaned: NormalisedTimeEntry[];
  totalStats: WipSummary;
}

const UNKNOWN_KEY = '__unknown__';

// =============================================================================
// WipSummary helpers
// =============================================================================

function emptyWipSummary(): WipSummary {
  return {
    totalHours: 0,
    chargeableHours: 0,
    nonChargeableHours: 0,
    totalBillable: 0,
    totalWriteOff: 0,
    totalRecorded: 0,
    entryCount: 0,
    lastEntryDate: null,
    activityBreakdown: {},
  };
}

function accumulateEntry(summary: WipSummary, entry: NormalisedTimeEntry): void {
  summary.totalHours += entry.durationHours;
  summary.totalBillable += entry.billable;
  summary.totalWriteOff += entry.writeOff;
  summary.totalRecorded += entry.recordedValue;
  summary.entryCount += 1;

  if (entry.isChargeable) {
    summary.chargeableHours += entry.durationHours;
  } else {
    summary.nonChargeableHours += entry.durationHours;
  }

  // Latest entry date
  if (
    entry.date &&
    (summary.lastEntryDate === null || entry.date > summary.lastEntryDate)
  ) {
    summary.lastEntryDate = entry.date;
  }

  // Activity breakdown
  const actKey = entry.activityType ?? UNKNOWN_KEY;
  const existing = summary.activityBreakdown[actKey];
  if (existing) {
    existing.hours += entry.durationHours;
    existing.value += entry.billable;
  } else {
    summary.activityBreakdown[actKey] = {
      hours: entry.durationHours,
      value: entry.billable,
    };
  }
}

// =============================================================================
// Public aggregation functions
// =============================================================================

/**
 * Groups time entries by matterId.
 * Entries with no matterId at runtime are not included in the map
 * (they are returned as orphaned by buildWipEnrichment).
 */
export function aggregateWipByMatter(
  timeEntries: NormalisedTimeEntry[],
): Map<string, WipSummary> {
  const map = new Map<string, WipSummary>();

  for (const entry of timeEntries) {
    const key = (entry.matterId as string | null | undefined) ?? null;
    if (!key) continue; // orphaned — handled by buildWipEnrichment

    let summary = map.get(key);
    if (!summary) {
      summary = emptyWipSummary();
      map.set(key, summary);
    }
    accumulateEntry(summary, entry);
  }

  return map;
}

/**
 * Groups time entries by lawyerId.
 * Entries with no lawyerId are grouped under '__unknown__'.
 */
export function aggregateWipByFeeEarner(
  timeEntries: NormalisedTimeEntry[],
): Map<string, WipSummary> {
  const map = new Map<string, WipSummary>();

  for (const entry of timeEntries) {
    const key = entry.lawyerId ?? UNKNOWN_KEY;

    let summary = map.get(key);
    if (!summary) {
      summary = emptyWipSummary();
      map.set(key, summary);
    }
    accumulateEntry(summary, entry);
  }

  return map;
}

/**
 * Calculates the number of days since the most recent time entry for a given
 * fee earner. Returns null if the fee earner has no entries at all.
 *
 * @param timeEntries   All normalised time entries for the firm
 * @param lawyerId      The attorney _id to check
 * @param referenceDate Date to measure from (default: today UTC)
 */
export function computeRecordingGapDays(
  timeEntries: NormalisedTimeEntry[],
  lawyerId: string,
  referenceDate?: Date,
): number | null {
  let latestDate: string | null = null;

  for (const entry of timeEntries) {
    if (entry.lawyerId !== lawyerId) continue;
    if (!entry.date) continue;
    if (latestDate === null || entry.date > latestDate) {
      latestDate = entry.date;
    }
  }

  if (latestDate === null) return null;

  const ref = referenceDate ?? new Date();
  // Compare using UTC date strings to avoid timezone drift
  const refDateStr = ref.toISOString().slice(0, 10);
  const refMs = Date.parse(refDateStr);
  const lastMs = Date.parse(latestDate);

  return Math.max(0, Math.round((refMs - lastMs) / 86_400_000));
}

/**
 * Builds the full WIP enrichment object: aggregated by matter, by fee earner,
 * orphaned entries, and firm-wide totals.
 */
export function buildWipEnrichment(timeEntries: NormalisedTimeEntry[]): WipEnrichment {
  // Separate orphaned entries (no matterId — should not occur via API)
  const valid: NormalisedTimeEntry[] = [];
  const orphaned: NormalisedTimeEntry[] = [];

  for (const entry of timeEntries) {
    if (!(entry.matterId as string | null | undefined)) {
      orphaned.push(entry);
    } else {
      valid.push(entry);
    }
  }

  const byMatter = aggregateWipByMatter(valid);
  const byFeeEarner = aggregateWipByFeeEarner(timeEntries); // all entries — includes orphaned in __unknown__ matter context, but we still want fee earner totals

  // Firm-wide totals from all valid entries
  const totalStats = emptyWipSummary();
  for (const entry of timeEntries) {
    accumulateEntry(totalStats, entry);
  }

  return { byMatter, byFeeEarner, orphaned, totalStats };
}
