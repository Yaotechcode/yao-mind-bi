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
 *   3. normalised full name — attorney.fullName ↔ CSV name field
 *   4. normalised surname only — when surname is unique across both datasets
 *
 * Rules:
 *  - API-sourced fields are never overwritten by CSV data
 *  - Attorneys with no CSV match still appear in output with null cost fields
 *  - Merge stats are logged, including which strategy produced each match
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
  /** Most-frequent department across responsible matters (populated by PullOrchestrator after matters are available) */
  departmentName: string | null;
  /** Total chargeable hours from time entries (populated by PullOrchestrator after time entries are available) */
  wipChargeableHours: number;
  /** Total hours from all time entries (populated by PullOrchestrator after time entries are available) */
  wipTotalHours: number;
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
// Name normalisation
// =============================================================================

/**
 * Normalises a name string for comparison:
 *  - lowercased
 *  - collapsed whitespace
 *  - "(disabled)" suffix stripped
 *  - all other parenthetical groups stripped
 */
export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\(disabled\)/gi, '')
    .replace(/\(.*?\)/g, '')
    .trim();
}

// =============================================================================
// Merge map builder
// =============================================================================

/**
 * Builds a lookup map from CSV fee earner records.
 *
 * Primary key:    integration_account_id (when present and non-empty)
 * Secondary key:  email (lower-cased for case-insensitive matching)
 * Tertiary key:   'n:<normalised name>' — from the record's `name` field
 *
 * Multiple keys may point to the same record — that is intentional.
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

    const name = record['name'];
    if (typeof name === 'string' && name.trim() !== '') {
      map.set('n:' + normaliseName(name), record);
    }
  }

  return map;
}

/**
 * Builds a surname-only lookup map from CSV fee earner records.
 * Only includes surnames that appear exactly once in the CSV list
 * (ambiguous surnames are excluded to prevent false matches).
 *
 * Surname is derived as the last whitespace-delimited token of the
 * normalised `name` field.
 */
export function buildSurnameMergeMap(
  csvFeeEarners: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const counts = new Map<string, number>();
  const records = new Map<string, Record<string, unknown>>();

  for (const record of csvFeeEarners) {
    const name = record['name'];
    if (typeof name !== 'string' || !name.trim()) continue;
    const parts = normaliseName(name).split(' ').filter(Boolean);
    if (parts.length === 0) continue;
    const surname = parts[parts.length - 1];
    counts.set(surname, (counts.get(surname) ?? 0) + 1);
    records.set(surname, record);
  }

  const uniqueMap = new Map<string, Record<string, unknown>>();
  for (const [surname, count] of counts) {
    if (count === 1) uniqueMap.set(surname, records.get(surname)!);
  }
  return uniqueMap;
}

/**
 * Returns the set of normalised surnames that appear exactly once
 * in the given attorney list.  Used to guard against ambiguous surname
 * matches on the API side.
 */
export function buildUniqueApiSurnames(attorneys: NormalisedAttorney[]): Set<string> {
  const counts = new Map<string, number>();
  for (const a of attorneys) {
    const surname = normaliseName(a.lastName);
    counts.set(surname, (counts.get(surname) ?? 0) + 1);
  }
  const unique = new Set<string>();
  for (const [surname, count] of counts) {
    if (count === 1) unique.add(surname);
  }
  return unique;
}

// =============================================================================
// Single-record merge
// =============================================================================

/**
 * Merges a single API attorney with its CSV counterpart (if any).
 * API fields are never overwritten.
 *
 * Match strategies (in order):
 *   1. integrationAccountId
 *   2. email
 *   3. normalised full name
 *   4. normalised surname (only when unique across both datasets)
 */
export function mergeFeeEarnerData(
  apiAttorney: NormalisedAttorney,
  mergeMap: Map<string, Record<string, unknown>>,
  surnameMap?: Map<string, Record<string, unknown>>,
  uniqueApiSurnames?: Set<string>,
): EnrichedFeeEarner {
  let csvRecord: Record<string, unknown> | undefined;
  let matchStrategy: string | undefined;

  // Strategy 1: integrationAccountId
  if (apiAttorney.integrationAccountId) {
    csvRecord = mergeMap.get(apiAttorney.integrationAccountId);
    if (csvRecord) matchStrategy = 'integration_account_id match';
  }

  // Strategy 2: email
  if (!csvRecord && apiAttorney.email) {
    csvRecord = mergeMap.get(apiAttorney.email.toLowerCase());
    if (csvRecord) matchStrategy = 'email match';
  }

  // Strategy 3: normalised full name
  if (!csvRecord && apiAttorney.fullName) {
    csvRecord = mergeMap.get('n:' + normaliseName(apiAttorney.fullName));
    if (csvRecord) matchStrategy = 'name match';
  }

  // Strategy 4: surname (only when unique on both sides)
  if (!csvRecord && surnameMap && uniqueApiSurnames) {
    const normSurname = normaliseName(apiAttorney.lastName);
    if (uniqueApiSurnames.has(normSurname)) {
      csvRecord = surnameMap.get(normSurname);
      if (csvRecord) matchStrategy = 'surname match';
    }
  }

  if (!csvRecord) {
    console.warn(
      `[fee-earner-merger] No CSV match for attorney "${apiAttorney.fullName}" ` +
        `(id=${apiAttorney._id}, integId=${apiAttorney.integrationAccountId ?? 'none'}, ` +
        `email=${apiAttorney.email ?? 'none'})`,
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
      departmentName: null,
      wipChargeableHours: 0,
      wipTotalHours: 0,
    };
  }

  console.log(
    `[fee-earner-merger] Matched "${apiAttorney.fullName}" via ${matchStrategy}`,
  );

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
    departmentName: null,
    wipChargeableHours: 0,
    wipTotalHours: 0,
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
  const snapshot = await getLatestEnrichedEntities(firmId, 'feeEarnerCsv');
  const csvRecords = (snapshot?.records ?? []) as Record<string, unknown>[];

  console.log(
    `[fee-earner-merger] Loaded ${csvRecords.length} CSV fee earner records for firm ${firmId}`,
  );

  const mergeMap = buildFeeEarnerMergeMap(csvRecords);
  const surnameMap = buildSurnameMergeMap(csvRecords);
  const uniqueApiSurnames = buildUniqueApiSurnames(attorneys);

  const result = attorneys.map((a) =>
    mergeFeeEarnerData(a, mergeMap, surnameMap, uniqueApiSurnames),
  );

  const matched = result.filter((r) => r.csvDataPresent).length;
  console.log(
    `[fee-earner-merger] Merged ${matched}/${attorneys.length} attorneys with CSV data ` +
      `(${attorneys.length - matched} unmatched)`,
  );

  return result;
}
