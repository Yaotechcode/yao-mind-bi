/**
 * context-builder.ts — Formula execution context assembly
 *
 * Assembles the FormulaContext from pipeline output and firm configuration.
 * NO database calls — all data is provided by the caller (the orchestrator
 * loads from MongoDB and passes it in).
 *
 * Also provides getEffectiveConfig which merges firm-level config with
 * per-fee-earner overrides.
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
  AggregatedFirm,
} from '../../shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedInvoice,
  EnrichedDisbursement,
} from '../../shared/types/enriched.js';
import type { FirmConfig } from '../../shared/types/index.js';
import type { FormulaContext, EffectiveConfig } from './types.js';

// =============================================================================
// Context Builder
// =============================================================================

/**
 * Assemble a FormulaContext from pipeline output and configuration.
 *
 * @param _firmId  Used by the caller for audit / logging — not needed inside
 *                 the context itself since firmId is implicit in the data.
 * @param firmConfig  Full firm configuration from Supabase.
 * @param feeEarnerOverrides  Per-fee-earner overrides keyed by fee earner ID.
 *                            Convert FirmConfig.feeEarnerOverrides array to
 *                            a keyed record before calling this function.
 * @param enrichedData  All aggregated entities from the pipeline.
 * @param referenceDate  Reference date for age calculations (defaults to now).
 */
export function buildFormulaContext(
  _firmId: string,
  firmConfig: FirmConfig,
  feeEarnerOverrides: Record<string, Record<string, unknown>>,
  enrichedData: {
    feeEarners: AggregatedFeeEarner[];
    matters: AggregatedMatter[];
    invoices: EnrichedInvoice[];
    timeEntries: EnrichedTimeEntry[];
    disbursements: EnrichedDisbursement[];
    departments: AggregatedDepartment[];
    clients: AggregatedClient[];
    firm: AggregatedFirm;
  },
  referenceDate?: Date,
): FormulaContext {
  return {
    feeEarners: enrichedData.feeEarners,
    matters: enrichedData.matters,
    invoices: enrichedData.invoices,
    timeEntries: enrichedData.timeEntries,
    disbursements: enrichedData.disbursements,
    departments: enrichedData.departments,
    clients: enrichedData.clients,
    firm: enrichedData.firm,
    firmConfig,
    feeEarnerOverrides,
    snippetResults: {},
    formulaResults: {},
    referenceDate: referenceDate ?? new Date(),
  };
}

// =============================================================================
// Effective Config
// =============================================================================

/** System-level defaults — applied when neither firm config nor override set a value. */
const CONFIG_DEFAULTS: Readonly<Omit<EffectiveConfig, 'overrides'>> = {
  costRateMethod: 'fully_loaded',
  feeSharePercent: 0,
  firmRetainPercent: 0,
  utilisationApproach: 'assume_fulltime',
  workingDaysPerWeek: 5,
  weeklyTargetHours: 37.5,
  chargeableWeeklyTarget: 30,
  annualLeaveEntitlement: 25,
  bankHolidaysPerYear: 8,
  currency: 'GBP',
};

/**
 * Resolve a single config value with three-level priority:
 *   1. Fee earner override (highest)
 *   2. Firm config value
 *   3. System default (lowest)
 */
function resolveValue<T>(
  key: string,
  override: Record<string, unknown>,
  firmValue: T | undefined | null,
  defaultValue: T,
): T {
  const overrideValue = override[key];
  if (overrideValue !== undefined && overrideValue !== null) {
    return overrideValue as T;
  }
  if (firmValue !== undefined && firmValue !== null) {
    return firmValue;
  }
  return defaultValue;
}

/**
 * Merge firm-level config with per-fee-earner overrides.
 *
 * Priority order (highest → lowest):
 *   1. Fee earner override values
 *   2. Firm config values
 *   3. System defaults
 *
 * Returns a complete EffectiveConfig — no undefined values.
 * The feeEarner parameter is available for formula implementations that need
 * entity-level data (grade, payModel, rate) alongside the merged config.
 */
export function getEffectiveConfig(
  feeEarner: AggregatedFeeEarner,
  firmConfig: FirmConfig,
  feeEarnerOverride?: Record<string, unknown>,
): EffectiveConfig {
  const override = feeEarnerOverride ?? {};

  // feeEarner is available here for implementations that extend this function
  // to include earner-specific fields (grade, payModel, rate) in EffectiveConfig.
  void feeEarner;

  return {
    costRateMethod: resolveValue<'fully_loaded' | 'direct' | 'market_rate'>(
      'costRateMethod',
      override,
      firmConfig.costRateMethod,
      CONFIG_DEFAULTS.costRateMethod,
    ),
    feeSharePercent: resolveValue<number>(
      'feeSharePercent',
      override,
      firmConfig.defaultFeeSharePercent,
      CONFIG_DEFAULTS.feeSharePercent,
    ),
    firmRetainPercent: resolveValue<number>(
      'firmRetainPercent',
      override,
      firmConfig.defaultFirmRetainPercent,
      CONFIG_DEFAULTS.firmRetainPercent,
    ),
    utilisationApproach: resolveValue<'assume_fulltime' | 'fte_adjusted'>(
      'utilisationApproach',
      override,
      firmConfig.utilisationApproach,
      CONFIG_DEFAULTS.utilisationApproach,
    ),
    workingDaysPerWeek: resolveValue<number>(
      'workingDaysPerWeek',
      override,
      firmConfig.workingDaysPerWeek,
      CONFIG_DEFAULTS.workingDaysPerWeek,
    ),
    weeklyTargetHours: resolveValue<number>(
      'weeklyTargetHours',
      override,
      firmConfig.weeklyTargetHours,
      CONFIG_DEFAULTS.weeklyTargetHours,
    ),
    chargeableWeeklyTarget: resolveValue<number>(
      'chargeableWeeklyTarget',
      override,
      firmConfig.chargeableWeeklyTarget,
      CONFIG_DEFAULTS.chargeableWeeklyTarget,
    ),
    annualLeaveEntitlement: resolveValue<number>(
      'annualLeaveEntitlement',
      override,
      firmConfig.annualLeaveEntitlement,
      CONFIG_DEFAULTS.annualLeaveEntitlement,
    ),
    bankHolidaysPerYear: resolveValue<number>(
      'bankHolidaysPerYear',
      override,
      firmConfig.bankHolidaysPerYear,
      CONFIG_DEFAULTS.bankHolidaysPerYear,
    ),
    currency: resolveValue<string>(
      'currency',
      override,
      firmConfig.currency,
      CONFIG_DEFAULTS.currency,
    ),
    overrides: override,
  };
}
