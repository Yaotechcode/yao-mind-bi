/**
 * fee-earner-merger.ts — Merges API attorney records with fee earner CSV data.
 *
 * Source A: NormalisedAttorney records from the Yao API (identity + rates).
 * Source B: enriched_entities feeEarner records from the legacy upload pipeline
 *           (payModel, salary, cost components, billing targets).
 *
 * Join keys (in priority order):
 *   1. integrationAccountId (attorney) ↔ integration_account_id (CSV)
 *   2. email (attorney) ↔ email (CSV)
 *
 * Rules:
 *  - API-sourced fields are never overwritten by CSV data
 *  - Attorneys with no CSV match still appear in output with null cost fields
 *  - Merge stats are logged
 */

import { getLatestEnrichedEntities } from '../../lib/mongodb-operations.js';
import type { NormalisedAttorney } from '../normalise/types.js';

// =============================================================================
// Types
// =============================================================================

export interface EnrichedFeeEarner extends NormalisedAttorney {
  payModel: 'Salaried' | 'FeeShare' | null;
  annualSalary: number | null;
  monthlySalary: number | null;
  monthlyPension: number | null;
  monthlyEmployerNI: number | null;
  monthlyVariablePay: number | null;
  annualTarget: number | null;
  targetWeeklyHours: number | null;
  chargeableWeeklyTarget: number | null;
  annualLeaveEntitlement: number | null;
  feeSharePercent: number | null;
  firmLeadPercent: number | null;
  /** true if CSV data was found and merged for this attorney */
  csvDataPresent: boolean;
}

// =============================================================================
// Null-safe field helpers
// =============================================================================

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function payModelOrNull(v: unknown): 'Salaried' | 'FeeShare' | null {
  if (v === 'Salaried' || v === 'FeeShare') return v;
  return null;
}

// =============================================================================
// Merge map builder
// =============================================================================

/**
 * Builds a lookup map from CSV fee earner records.
 *
 * Primary key:   integration_account_id (when present and non-empty)
 * Secondary key: email (lower-cased for case-insensitive matching)
 *
 * Both keys may point to the same record — that is intentional.
 */
export function buildFeeEarnerMergeMap(
  csvFeeEarners: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();

  for (const record of csvFeeEarners) {
    const integId = record['integration_account_id'] ?? record['integrationAccountId'];
    if (typeof integId === 'string' && integId.trim() !== '') {
      map.set(integId.trim(), record);
    }

    const email = record['email'];
    if (typeof email === 'string' && email.trim() !== '') {
      map.set(email.trim().toLowerCase(), record);
    }
  }

  return map;
}

// =============================================================================
// Single-record merge
// =============================================================================

/**
 * Merges a single API attorney with its CSV counterpart (if any).
 * API fields are never overwritten.
 */
export function mergeFeeEarnerData(
  apiAttorney: NormalisedAttorney,
  mergeMap: Map<string, Record<string, unknown>>,
): EnrichedFeeEarner {
  // Lookup by integrationAccountId first, then by email
  let csvRecord: Record<string, unknown> | undefined;

  if (apiAttorney.integrationAccountId) {
    csvRecord = mergeMap.get(apiAttorney.integrationAccountId);
  }
  if (!csvRecord && apiAttorney.email) {
    csvRecord = mergeMap.get(apiAttorney.email.toLowerCase());
  }

  if (!csvRecord) {
    console.warn(
      `[fee-earner-merger] No CSV match for attorney "${apiAttorney.fullName}" ` +
        `(id=${apiAttorney._id}, integId=${apiAttorney.integrationAccountId ?? 'none'}, ` +
        `email=${apiAttorney.email})`,
    );
    return {
      ...apiAttorney,
      payModel: null,
      annualSalary: null,
      monthlySalary: null,
      monthlyPension: null,
      monthlyEmployerNI: null,
      monthlyVariablePay: null,
      annualTarget: null,
      targetWeeklyHours: null,
      chargeableWeeklyTarget: null,
      annualLeaveEntitlement: null,
      feeSharePercent: null,
      firmLeadPercent: null,
      csvDataPresent: false,
    };
  }

  return {
    ...apiAttorney,
    payModel: payModelOrNull(csvRecord['payModel']),
    annualSalary: numOrNull(csvRecord['annualSalary']),
    monthlySalary: numOrNull(csvRecord['monthlySalary']),
    monthlyPension: numOrNull(csvRecord['monthlyPension']),
    monthlyEmployerNI: numOrNull(csvRecord['monthlyEmployerNI']),
    monthlyVariablePay: numOrNull(csvRecord['monthlyVariablePay']),
    annualTarget: numOrNull(csvRecord['annualTarget']),
    targetWeeklyHours: numOrNull(csvRecord['targetWeeklyHours']),
    chargeableWeeklyTarget: numOrNull(csvRecord['chargeableWeeklyTarget']),
    annualLeaveEntitlement: numOrNull(csvRecord['annualLeaveEntitlement']),
    feeSharePercent: numOrNull(csvRecord['feeSharePercent']),
    firmLeadPercent: numOrNull(csvRecord['firmLeadPercent']),
    csvDataPresent: true,
  };
}

// =============================================================================
// Bulk merge (loads from MongoDB)
// =============================================================================

/**
 * Loads the latest feeEarner enriched entities from MongoDB, builds the merge
 * map, and merges every attorney. Logs match stats.
 */
export async function mergeAllFeeEarners(
  attorneys: NormalisedAttorney[],
  firmId: string,
): Promise<EnrichedFeeEarner[]> {
  const snapshot = await getLatestEnrichedEntities(firmId, 'feeEarner');
  const csvRecords = (snapshot?.records ?? []) as Record<string, unknown>[];

  console.log(
    `[fee-earner-merger] Loaded ${csvRecords.length} CSV fee earner records for firm ${firmId}`,
  );

  const mergeMap = buildFeeEarnerMergeMap(csvRecords);
  const result = attorneys.map((a) => mergeFeeEarnerData(a, mergeMap));

  const matched = result.filter((r) => r.csvDataPresent).length;
  console.log(
    `[fee-earner-merger] Merged ${matched}/${attorneys.length} attorneys with CSV data ` +
      `(${attorneys.length - matched} unmatched)`,
  );

  return result;
}
