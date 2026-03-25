/**
 * built-in-snippets.ts — Built-in snippet implementations
 *
 * SN-001: Fully Loaded Cost Rate      (salaried only; depends on SN-002)
 * SN-002: Available Working Hours     (no dependencies)
 * SN-003: Firm Retain Amount          (modifier — no-op in batch; use helper directly)
 * SN-004: Employment Cost (Annual)    (no dependencies)
 * SN-005: Cost Rate by Pay Model      (depends on SN-001 → SN-002)
 *
 * Dynamic fields (not in AggregatedFeeEarner typed interface) are read via
 * dynField<T>(). All implementations are null-safe and never throw.
 */

import type { AggregatedFeeEarner } from '../../../shared/types/pipeline.js';
import type { FirmConfig } from '../../../shared/types/index.js';
import type { SnippetContext, SnippetImplementation, SnippetResult } from '../types.js';
import { getEffectiveConfig } from '../context-builder.js';

// =============================================================================
// Shared helpers
// =============================================================================

function dynField<T>(obj: object, key: string): T | null {
  const v = (obj as unknown as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  return v as T;
}

function resolveEntityId(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerId ?? feeEarner.lawyerName ?? 'unknown';
}

function getPayModel(feeEarner: AggregatedFeeEarner): string | null {
  return dynField<string>(feeEarner, 'payModel');
}

// =============================================================================
// SN-002: Available Working Hours (no dependencies)
// =============================================================================

/**
 * Calculates total available working hours in a year for a fee earner.
 * Uses the effective config (fee earner override → firm config → system defaults).
 * Always returns a positive value — used as the denominator in utilisation and
 * cost rate calculations.
 */
export const availableWorkingHours: SnippetImplementation = {
  snippetId: 'SN-002',

  execute(context: SnippetContext): SnippetResult {
    const { feeEarner, firmConfig, feeEarnerOverride } = context;
    const entityId = resolveEntityId(feeEarner);

    const config = getEffectiveConfig(feeEarner, firmConfig, feeEarnerOverride);
    const hasOverride =
      feeEarnerOverride != null && Object.keys(feeEarnerOverride).length > 0;

    const workingDaysPerWeek = config.workingDaysPerWeek;   // ≥ 1
    const annualLeave = config.annualLeaveEntitlement;
    const bankHolidays = config.bankHolidaysPerYear;
    const targetWeeklyHours = config.weeklyTargetHours;

    const WEEKS_PER_YEAR = 52;
    const totalWorkingDays =
      WEEKS_PER_YEAR * workingDaysPerWeek - annualLeave - bankHolidays;
    const dailyHours = targetWeeklyHours / workingDaysPerWeek;
    const availableHoursValue = totalWorkingDays * dailyHours;

    return {
      snippetId: 'SN-002',
      entityId,
      value: availableHoursValue,
      nullReason: null,
      breakdown: {
        workingDaysPerWeek,
        annualLeave,
        bankHolidays,
        targetWeeklyHours,
        totalWorkingDays,
        dailyHours,
        availableHours: availableHoursValue,
        sourceNote: `Using ${hasOverride ? 'fee earner override' : 'firm defaults'}`,
      },
    };
  },
};

// =============================================================================
// SN-004: Employment Cost (Annual) (no dependencies)
// =============================================================================

/**
 * Total annual cost of employing a salaried fee earner.
 * Returns null for fee share earners (firm bears no fixed employment cost).
 * Returns null if annualSalary is missing.
 */
export const employmentCostAnnual: SnippetImplementation = {
  snippetId: 'SN-004',

  execute(context: SnippetContext): SnippetResult {
    const { feeEarner } = context;
    const entityId = resolveEntityId(feeEarner);
    const payModel = getPayModel(feeEarner);

    if (payModel === 'FeeShare') {
      return {
        snippetId: 'SN-004',
        entityId,
        value: null,
        nullReason: 'Fee share lawyers have no employment cost to the firm',
      };
    }

    const annualSalary = dynField<number>(feeEarner, 'annualSalary');
    if (annualSalary == null) {
      return {
        snippetId: 'SN-004',
        entityId,
        value: null,
        nullReason: 'Salary data not available',
      };
    }

    const monthlyNI = dynField<number>(feeEarner, 'monthlyEmployerNI') ?? 0;
    const monthlyPension = dynField<number>(feeEarner, 'monthlyPension') ?? 0;
    const monthlyVariable = dynField<number>(feeEarner, 'monthlyVariablePay') ?? 0;

    const totalEmploymentCost =
      annualSalary + (monthlyNI + monthlyPension + monthlyVariable) * 12;

    return {
      snippetId: 'SN-004',
      entityId,
      value: totalEmploymentCost,
      nullReason: null,
      breakdown: {
        annualSalary,
        annualisedNI: monthlyNI * 12,
        annualisedPension: monthlyPension * 12,
        annualisedVariable: monthlyVariable * 12,
        totalEmploymentCost,
      },
    };
  },
};

// =============================================================================
// SN-003: Firm Retain Amount (modifier — no-op in batch)
// =============================================================================

/**
 * Helper for direct programmatic use by profitability formulas.
 * Returns the portion of `amount` that the firm retains.
 *
 * Fee share: amount × firmRetainPercent / 100
 * Salaried: full amount (firm retains 100% of billed revenue)
 *
 * Returns null if payModel is missing.
 */
export function firmRetainAmountHelper(
  amount: number,
  feeEarner: AggregatedFeeEarner,
  firmConfig: FirmConfig,
  override?: Record<string, unknown>,
): number | null {
  const payModel = getPayModel(feeEarner);

  if (payModel == null) return null;

  if (payModel === 'Salaried') {
    return amount; // firm retains 100%
  }

  // FeeShare: firm retains `firmRetainPercent` of the billing
  const firmRetainPercent =
    dynField<number>(feeEarner, 'firmLeadPercent') ??
    (override?.['firmRetainPercent'] as number | undefined) ??
    firmConfig.defaultFirmRetainPercent ??
    40;

  return amount * (firmRetainPercent / 100);
}

/**
 * SN-003 batch implementation is a no-op.
 * This snippet is used as a modifier — call firmRetainAmountHelper() directly.
 */
export const firmRetainAmount: SnippetImplementation = {
  snippetId: 'SN-003',

  execute(context: SnippetContext): SnippetResult {
    return {
      snippetId: 'SN-003',
      entityId: resolveEntityId(context.feeEarner),
      value: null,
      nullReason: 'SN-003 is a modifier — call firmRetainAmountHelper() directly',
    };
  },
};

// =============================================================================
// SN-001: Fully Loaded Cost Rate (depends on SN-002)
// =============================================================================

/**
 * All-in hourly cost rate for a salaried fee earner.
 * totalAnnualCost / availableWorkingHours (from SN-002).
 * Returns null for fee share earners or when salary data is missing.
 */
export const fullyLoadedCostRate: SnippetImplementation = {
  snippetId: 'SN-001',

  execute(context: SnippetContext): SnippetResult {
    const { feeEarner, priorSnippetResults } = context;
    const entityId = resolveEntityId(feeEarner);
    const payModel = getPayModel(feeEarner);

    if (payModel === 'FeeShare') {
      return {
        snippetId: 'SN-001',
        entityId,
        value: null,
        nullReason: 'Fee share lawyers have no employment cost rate',
      };
    }

    const annualSalary = dynField<number>(feeEarner, 'annualSalary');
    if (annualSalary == null) {
      return {
        snippetId: 'SN-001',
        entityId,
        value: null,
        nullReason: 'Salary data not available',
      };
    }

    const monthlyNI = dynField<number>(feeEarner, 'monthlyEmployerNI') ?? 0;
    const monthlyPension = dynField<number>(feeEarner, 'monthlyPension') ?? 0;
    const monthlyVariable = dynField<number>(feeEarner, 'monthlyVariablePay') ?? 0;
    const totalAnnualCost =
      annualSalary + (monthlyNI + monthlyPension + monthlyVariable) * 12;

    // Read available hours from SN-002 (must have run first in the chain)
    const availableHours = priorSnippetResults?.['SN-002']?.value ?? null;
    if (availableHours == null || availableHours === 0) {
      return {
        snippetId: 'SN-001',
        entityId,
        value: null,
        nullReason: 'Cannot compute — available hours unknown',
      };
    }

    const hourlyRate = totalAnnualCost / availableHours;

    return {
      snippetId: 'SN-001',
      entityId,
      value: hourlyRate,
      nullReason: null,
      breakdown: {
        totalAnnualCost,
        availableHours,
        hourlyRate,
      },
    };
  },
};

// =============================================================================
// SN-005: Cost Rate by Pay Model (depends on SN-001 → SN-002)
// =============================================================================

/**
 * Appropriate hourly cost rate based on pay model and firm's costRateMethod.
 *
 * Salaried:
 *   'fully_loaded' → SN-001 result (all-in rate)
 *   'direct'       → annualSalary / SN-002 availableHours (salary only)
 *   'market_rate'  → custom rate from firmConfig or falls back to fully_loaded
 *
 * FeeShare: billingRate × feeSharePercent / 100
 */
export const costRateByPayModel: SnippetImplementation = {
  snippetId: 'SN-005',

  execute(context: SnippetContext): SnippetResult {
    const { feeEarner, firmConfig, feeEarnerOverride, priorSnippetResults } = context;
    const entityId = resolveEntityId(feeEarner);
    const payModel = getPayModel(feeEarner);

    if (payModel == null) {
      return {
        snippetId: 'SN-005',
        entityId,
        value: null,
        nullReason: 'Pay model not set',
      };
    }

    // ---- Fee Share branch ----
    if (payModel === 'FeeShare') {
      const billingRate = dynField<number>(feeEarner, 'rate') ?? 0;
      const feeSharePercent =
        dynField<number>(feeEarner, 'feeSharePercent') ??
        firmConfig.defaultFeeSharePercent ??
        60;
      const costRate = billingRate * (feeSharePercent / 100);

      return {
        snippetId: 'SN-005',
        entityId,
        value: costRate,
        nullReason: null,
        breakdown: {
          method: 'fee_share',
          billingRate,
          feeSharePercent,
          costRate,
          interpretation: 'Cost per hour = billing rate × fee share %',
        },
      };
    }

    // ---- Salaried branch ----
    const config = getEffectiveConfig(feeEarner, firmConfig, feeEarnerOverride);
    const costRateMethod = config.costRateMethod; // 'fully_loaded' | 'direct' | 'market_rate'

    let costRate: number | null = null;

    if (costRateMethod === 'direct') {
      // Salary-only: annualSalary / availableHours
      const annualSalary = dynField<number>(feeEarner, 'annualSalary');
      const availableHours = priorSnippetResults?.['SN-002']?.value ?? null;
      if (annualSalary != null && availableHours != null && availableHours > 0) {
        costRate = annualSalary / availableHours;
      }
    } else if (costRateMethod === 'market_rate') {
      // Custom rate from config, or fall back to fully_loaded
      const customRate = dynField<number>(firmConfig, 'customCostRatePerHour');
      costRate = customRate ?? priorSnippetResults?.['SN-001']?.value ?? null;
    } else {
      // 'fully_loaded' (default)
      costRate = priorSnippetResults?.['SN-001']?.value ?? null;
    }

    if (costRate == null) {
      return {
        snippetId: 'SN-005',
        entityId,
        value: null,
        nullReason: 'Cost rate could not be computed — check salary data and costRateMethod config',
      };
    }

    return {
      snippetId: 'SN-005',
      entityId,
      value: costRate,
      nullReason: null,
      breakdown: {
        method: costRateMethod,
        costRate,
      },
    };
  },
};
