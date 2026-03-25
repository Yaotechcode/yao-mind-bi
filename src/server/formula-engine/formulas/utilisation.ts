/**
 * utilisation.ts — Utilisation & Time formula implementations
 *
 * F-TU-01: Chargeable Utilisation Rate
 * F-TU-02: Recording Consistency (working-day gap since last entry)
 * F-TU-03: Non-Chargeable Time Breakdown
 *
 * All implementations:
 *   - Are pure synchronous functions — no DB calls, no side effects
 *   - Never throw — errors produce null EntityFormulaResult with nullReason
 *   - Skip fee earners where isSystemAccount = true
 *   - Return value = 0 (not null) for fee earners with no time entries (F-TU-01)
 */

import type { AggregatedFeeEarner } from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../shared/types/enriched.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  EntityFormulaResult,
  EffectiveConfig,
} from '../types.js';
import { formatValue, summariseResults } from '../result-formatter.js';
import { getEffectiveConfig } from '../context-builder.js';

// =============================================================================
// Private Helpers
// =============================================================================

/** Stable entity ID: prefer lawyerId, fall back to lawyerName. */
function resolveEntityId(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerId ?? feeEarner.lawyerName ?? 'unknown';
}

/** Display name for results. */
function resolveEntityName(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerName ?? feeEarner.lawyerId ?? 'Unknown';
}

/** True if this fee earner is a system / internal account (should be excluded). */
function isSystemAccount(feeEarner: AggregatedFeeEarner): boolean {
  return (feeEarner as unknown as Record<string, unknown>)['isSystemAccount'] === true;
}

/** Filter time entries to those belonging to a specific fee earner. */
function getEntriesForFeeEarner(
  timeEntries: EnrichedTimeEntry[],
  feeEarner: AggregatedFeeEarner,
): EnrichedTimeEntry[] {
  const id = feeEarner.lawyerId;
  const name = feeEarner.lawyerName;
  return timeEntries.filter((entry) => {
    // Prefer ID match when both sides have an ID
    if (id && entry.lawyerId) return entry.lawyerId === id;
    // Fall back to name match
    if (name && entry.lawyerName) return entry.lawyerName === name;
    return false;
  });
}

/**
 * Compute available working hours for one fee earner.
 * Mirrors the SN-002 formula:
 *   workingWeeks = 52 − (leave / daysPerWeek) − (bankHolidays / daysPerWeek)
 *   availableHours = workingWeeks × weeklyTargetHours
 */
function computeAvailableHours(config: EffectiveConfig): number {
  const workingWeeks =
    52 -
    config.annualLeaveEntitlement / config.workingDaysPerWeek -
    config.bankHolidaysPerYear / config.workingDaysPerWeek;
  return workingWeeks * config.weeklyTargetHours;
}

/**
 * Get the SN-002 (available working hours) result for a fee earner.
 * Falls back to computing from effective config if the snippet has not been run.
 */
function getAvailableHours(
  context: FormulaContext,
  feeEarner: AggregatedFeeEarner,
  entityId: string,
): number | null {
  const sn002 = context.snippetResults['SN-002']?.[entityId];
  if (sn002 !== undefined) return sn002.value; // may be null

  // Snippet not registered/run — compute directly
  const override = context.feeEarnerOverrides[entityId];
  const config = getEffectiveConfig(feeEarner, context.firmConfig, override);
  return computeAvailableHours(config);
}

/**
 * Safe type accessor for NormalisedRecord boolean fields.
 * Defaults to false when the value is absent or not boolean.
 */
function boolField(entry: EnrichedTimeEntry, key: string): boolean {
  const v = (entry as Record<string, unknown>)[key];
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  return false;
}

/**
 * Safe type accessor for NormalisedRecord numeric fields.
 * Returns 0 for absent, null, or non-numeric values.
 */
function numField(entry: EnrichedTimeEntry, key: string): number {
  const v = (entry as Record<string, unknown>)[key];
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v === 'string') {
    const parsed = parseFloat(v);
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * Parse the `date` field of a time entry into a UTC midnight Date.
 * Returns null for unparseable values.
 */
function parseEntryDate(entry: EnrichedTimeEntry): Date | null {
  const raw = (entry as Record<string, unknown>)['date'];
  if (!raw) return null;
  const d = new Date(raw as string);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Count calendar days that are Mon–Fri in the half-open interval
 * (after `from`, up to and including `to`).
 *
 * Returns 0 when from >= to (no gap).
 */
function countWorkingDaysInGap(from: Date, to: Date): number {
  if (from >= to) return 0;

  let count = 0;
  // Clone and advance past `from`
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1),
  );
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );

  while (cursor <= end) {
    const dow = cursor.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Build a ISO-timestamp for `computedAt`. */
function now(): string {
  return new Date().toISOString();
}

// =============================================================================
// F-TU-01: Chargeable Utilisation Rate
// =============================================================================

export const chargeableUtilisationRate: FormulaImplementation = {
  formulaId: 'F-TU-01',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'strict_chargeable';
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    for (const feeEarner of context.feeEarners) {
      if (isSystemAccount(feeEarner)) continue;

      const entityId = resolveEntityId(feeEarner);
      const entityName = resolveEntityName(feeEarner);
      const entries = getEntriesForFeeEarner(context.timeEntries, feeEarner);

      // Total recorded hours (all entries, all variants)
      const totalRecordedHours = entries.reduce(
        (sum, e) => sum + (e.durationHours ?? 0),
        0,
      );

      // Fee earner exists but has not recorded any time → meaningful zero
      if (entries.length === 0) {
        const availableHours = getAvailableHours(context, feeEarner, entityId);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: 0,
          formattedValue: '0.0%',
          nullReason: null,
          breakdown: { chargeableHours: 0, availableHours, totalRecordedHours: 0 },
        };
        continue;
      }

      const availableHours = getAvailableHours(context, feeEarner, entityId);

      if (availableHours === null || availableHours === 0) {
        const reason = 'Cannot calculate — no available hours';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: { chargeableHours: null, availableHours, totalRecordedHours },
        };
        continue;
      }

      // Determine chargeable hours based on active variant
      let chargeableHours: number;
      switch (activeVariant) {
        case 'strict_chargeable':
          // doNotBill=false AND billable>0  (i.e. isChargeable === true)
          chargeableHours = entries
            .filter((e) => e.isChargeable === true)
            .reduce((sum, e) => sum + (e.durationHours ?? 0), 0);
          break;

        case 'broad_chargeable':
          // All entries where doNotBill is false (billable value may be 0)
          chargeableHours = entries
            .filter((e) => boolField(e, 'doNotBill') === false)
            .reduce((sum, e) => sum + (e.durationHours ?? 0), 0);
          break;

        case 'recorded':
          // All recorded hours regardless of billing disposition
          chargeableHours = totalRecordedHours;
          break;

        default:
          warnings.push(`Unknown variant '${activeVariant}' — falling back to strict_chargeable`);
          chargeableHours = entries
            .filter((e) => e.isChargeable === true)
            .reduce((sum, e) => sum + (e.durationHours ?? 0), 0);
      }

      const utilisation = (chargeableHours / availableHours) * 100;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: utilisation,
        formattedValue: formatValue(utilisation, 'percentage'),
        nullReason: null,
        breakdown: { chargeableHours, availableHours, totalRecordedHours },
      };
    }

    return {
      formulaId: 'F-TU-01',
      formulaName: 'Chargeable Utilisation Rate',
      variantUsed: activeVariant,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'feeEarnerConfig', 'SN-002'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-TU-02: Recording Consistency
// =============================================================================

export const recordingConsistency: FormulaImplementation = {
  formulaId: 'F-TU-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    // Normalise reference date to UTC midnight for consistent day comparisons
    const ref = context.referenceDate;
    const referenceDate = new Date(
      Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()),
    );

    for (const feeEarner of context.feeEarners) {
      if (isSystemAccount(feeEarner)) continue;

      const entityId = resolveEntityId(feeEarner);
      const entityName = resolveEntityName(feeEarner);
      const entries = getEntriesForFeeEarner(context.timeEntries, feeEarner);

      // --- Recompute from time entries when available ---
      if (entries.length > 0) {
        // Collect all distinct dates with at least one entry
        const entryDates = entries
          .map((e) => parseEntryDate(e))
          .filter((d): d is Date => d !== null);

        if (entryDates.length === 0) {
          // Entries exist but none have parseable dates — fall through to aggregated fallback
          const gap = feeEarner.recordingGapDays;
          if (gap === null || gap === undefined) {
            const reason = 'No parseable entry dates found';
            nullReasons.add(reason);
            entityResults[entityId] = buildNullGapResult(entityId, entityName, reason);
          } else {
            entityResults[entityId] = buildGapResult(entityId, entityName, gap, null, warnings);
          }
          continue;
        }

        // Find the most recent entry date
        const latestDate = new Date(
          Math.max(...entryDates.map((d) => d.getTime())),
        );
        const lastRecordedDate = new Date(
          Date.UTC(
            latestDate.getUTCFullYear(),
            latestDate.getUTCMonth(),
            latestDate.getUTCDate(),
          ),
        );

        const gap = countWorkingDaysInGap(lastRecordedDate, referenceDate);

        entityResults[entityId] = buildGapResult(
          entityId,
          entityName,
          gap,
          lastRecordedDate.toISOString().slice(0, 10),
          warnings,
        );
        continue;
      }

      // --- No time entries in context — use pre-computed aggregated value ---
      if (feeEarner.recordingGapDays !== null && feeEarner.recordingGapDays !== undefined) {
        warnings.push(
          `${entityName}: recordingGapDays from aggregated data is calendar days, not working days`,
        );
        entityResults[entityId] = buildGapResult(
          entityId,
          entityName,
          feeEarner.recordingGapDays,
          feeEarner.wipNewestEntryDate
            ? feeEarner.wipNewestEntryDate.toISOString().slice(0, 10)
            : null,
          warnings,
        );
        continue;
      }

      // Fee earner has truly never recorded time
      const reason = 'No time entries found';
      nullReasons.add(reason);
      entityResults[entityId] = buildNullGapResult(entityId, entityName, reason);
    }

    return {
      formulaId: 'F-TU-02',
      formulaName: 'Recording Consistency',
      variantUsed: null,
      resultType: 'number',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'feeEarnerConfig'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

function buildGapResult(
  entityId: string,
  entityName: string,
  gap: number,
  lastRecordedDate: string | null,
  _warnings: string[],
): EntityFormulaResult {
  return {
    entityId,
    entityName,
    value: gap,
    formattedValue: gap === 0 ? 'Up to date' : `${gap} working day${gap === 1 ? '' : 's'}`,
    nullReason: null,
    breakdown: {
      gapDays: gap,
      workingDaysInGap: gap,
      lastRecordedDate,
    },
  };
}

function buildNullGapResult(
  entityId: string,
  entityName: string,
  reason: string,
): EntityFormulaResult {
  return {
    entityId,
    entityName,
    value: null,
    formattedValue: null,
    nullReason: reason,
    breakdown: { gapDays: null, workingDaysInGap: null, lastRecordedDate: null },
  };
}

// =============================================================================
// F-TU-03: Non-Chargeable Time Breakdown
// =============================================================================

export const nonChargeableBreakdown: FormulaImplementation = {
  formulaId: 'F-TU-03',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    // Check whether activityType is available (enablesFeatures check)
    const hasActivityType = context.timeEntries.some(
      (e) => (e as Record<string, unknown>)['activityType'] !== undefined,
    );
    if (!hasActivityType) {
      warnings.push(
        'Activity type not available — non-chargeable breakdown by category unavailable',
      );
    }

    for (const feeEarner of context.feeEarners) {
      if (isSystemAccount(feeEarner)) continue;

      const entityId = resolveEntityId(feeEarner);
      const entityName = resolveEntityName(feeEarner);
      const entries = getEntriesForFeeEarner(context.timeEntries, feeEarner);

      const totalHours = entries.reduce(
        (sum, e) => sum + (e.durationHours ?? 0),
        0,
      );

      if (totalHours === 0) {
        const reason = 'No time recorded';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: { nonChargeableHours: null, totalHours: 0, chargeableHours: null },
        };
        continue;
      }

      // Categorise entries by billing disposition.
      // Precedence: do-not-bill → write-off → internal (no matter) → chargeable → zero-billable
      // "zero-billable" catches entries that are not explicitly excluded (doNotBill=false,
      // writeOff=0) but also have no billable value — ambiguous, treated as non-chargeable.
      let doNotBillHours = 0;
      let writeOffHours = 0;
      let chargeableHours = 0;
      let internalHours = 0;     // entries with no matched matter
      let zeroBillableHours = 0; // doNotBill=false but billable=0 and not internal

      for (const entry of entries) {
        const hours = entry.durationHours ?? 0;
        const doNotBill = boolField(entry, 'doNotBill');
        const writeOff = numField(entry, 'writeOff');

        if (doNotBill) {
          doNotBillHours += hours;
        } else if (writeOff > 0) {
          writeOffHours += hours;
        } else if (!entry.hasMatchedMatter) {
          internalHours += hours;
        } else if (entry.isChargeable) {
          chargeableHours += hours;
        } else {
          // Not explicitly excluded, not chargeable, has a matched matter — zero billable
          zeroBillableHours += hours;
        }
      }

      const nonChargeableHours =
        doNotBillHours + writeOffHours + internalHours + zeroBillableHours;
      const nonChargeablePercent = (nonChargeableHours / totalHours) * 100;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: nonChargeablePercent,
        formattedValue: formatValue(nonChargeablePercent, 'percentage'),
        nullReason: null,
        breakdown: {
          nonChargeableHours,
          chargeableHours,
          totalHours,
          doNotBillHours,
          writeOffHours,
          internalHours,
          zeroBillableHours,
          ...(hasActivityType
            ? { activityTypeBreakdown: buildActivityTypeBreakdown(entries) }
            : {}),
        },
      };
    }

    return {
      formulaId: 'F-TU-03',
      formulaName: 'Non-Chargeable Time Breakdown',
      variantUsed: null,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

/** Build hours-by-activity-type breakdown when activityType field is available. */
function buildActivityTypeBreakdown(
  entries: EnrichedTimeEntry[],
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const entry of entries) {
    const type =
      ((entry as Record<string, unknown>)['activityType'] as string) ?? 'Unknown';
    breakdown[type] = (breakdown[type] ?? 0) + (entry.durationHours ?? 0);
  }
  return breakdown;
}
