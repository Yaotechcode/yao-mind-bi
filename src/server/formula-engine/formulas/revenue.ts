/**
 * revenue.ts — Revenue & Billing formula implementations
 *
 * F-RB-01: Realisation Rate           (matter-level)
 * F-RB-02: Effective Hourly Rate      (fee-earner-level)
 * F-RB-03: Revenue per Fee Earner     (fee-earner-level, pay-model aware)
 * F-RB-04: Billing Velocity           (matter-level)
 *
 * Field name reality checks vs the prompt spec:
 *   - AggregatedFeeEarner.invoicedRevenue  (not invoicedNetBilling)
 *   - AggregatedFeeEarner.wipChargeableValue (not wipTotalBillable)
 *   - payModel, feeSharePercent, rate → accessed dynamically (not in typed interface)
 *   - AggregatedMatter.isFixedFee → accessed dynamically (not in typed interface)
 *   - AggregatedMatter.wipTotalBillable + invoicedNetBilling ✓ (exist in type)
 */

import type { AggregatedFeeEarner, AggregatedMatter } from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../shared/types/enriched.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  EntityFormulaResult,
} from '../types.js';
import { formatValue, summariseResults } from '../result-formatter.js';
import { getEffectiveConfig } from '../context-builder.js';
import { deriveMatterBillingType } from '../../datasource/enrich/invoice-enricher.js';

// =============================================================================
// Private Helpers
// =============================================================================

function resolveFeeEarnerId(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerId ?? feeEarner.lawyerName ?? 'unknown';
}

function resolveFeeEarnerName(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerName ?? feeEarner.lawyerId ?? 'Unknown';
}

function resolveMatterId(matter: AggregatedMatter): string {
  return matter.matterId ?? matter.matterNumber ?? 'unknown';
}

function resolveMatterName(matter: AggregatedMatter): string {
  return matter.matterNumber ?? matter.matterId ?? 'Unknown Matter';
}

/** Read a field from a typed struct that may carry extra dynamic properties. */
function dynField<T>(obj: object, key: string): T | null {
  const v = (obj as unknown as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  return v as T;
}

function numDyn(obj: object, key: string): number | null {
  const v = dynField<number>(obj, key);
  if (typeof v === 'number' && !isNaN(v)) return v;
  return null;
}

/** Returns the billing type for a matter. Uses deriveMatterBillingType for forward-compat. */
function getMatterBillingType(matter: AggregatedMatter): 'fixed_fee' | 'hourly' | 'unknown' {
  return deriveMatterBillingType(matter as unknown as Record<string, unknown>);
}

/** True when this fee earner is a system/internal account. */
function isSystemAccount(feeEarner: AggregatedFeeEarner): boolean {
  return dynField<boolean>(feeEarner, 'isSystemAccount') === true;
}

/**
 * Get pay model for a fee earner.
 * Priority: feeEarnerOverrides → dynamic field on the struct.
 * Returns the string value or null if not set.
 */
function getPayModel(
  feeEarner: AggregatedFeeEarner,
  entityId: string,
  overrides: Record<string, Record<string, unknown>>,
): string | null {
  const fromOverride = overrides[entityId]?.['payModel'];
  if (fromOverride !== undefined && fromOverride !== null) return String(fromOverride);
  return dynField<string>(feeEarner, 'payModel');
}

/** Get the standard charge-out rate for a fee earner. */
function getChargeOutRate(
  feeEarner: AggregatedFeeEarner,
  entityId: string,
  overrides: Record<string, Record<string, unknown>>,
): number | null {
  const fromOverride = overrides[entityId]?.['rate'];
  if (typeof fromOverride === 'number') return fromOverride;
  return numDyn(feeEarner, 'rate');
}

/** Filter time entries for a specific matter by matterId or matterNumber. */
function getEntriesForMatter(
  timeEntries: EnrichedTimeEntry[],
  matter: AggregatedMatter,
): EnrichedTimeEntry[] {
  const id = matter.matterId;
  const num = matter.matterNumber;
  return timeEntries.filter((entry) => {
    if (id && entry.matterId) return entry.matterId === id;
    if (num && entry.matterNumber) return entry.matterNumber === num;
    return false;
  });
}

function now(): string {
  return new Date().toISOString();
}

// =============================================================================
// F-RB-01: Realisation Rate
// =============================================================================

export const realisationRate: FormulaImplementation = {
  formulaId: 'F-RB-01',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'time_billed_only';
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);
      const billingType = getMatterBillingType(matter);
      const isFixedFee = billingType === 'fixed_fee';

      // Variant-based inclusion rules
      if (activeVariant === 'time_billed_only' && isFixedFee) continue;

      // adjusted_fixed_fee: fixed-fee matters auto-realise at 100%
      if (activeVariant === 'adjusted_fixed_fee' && isFixedFee) {
        entityResults[entityId] = {
          entityId,
          entityName,
          value: 100,
          formattedValue: '100.0%',
          nullReason: null,
          breakdown: {
            recordedValue: matter.wipTotalBillable,
            billedValue: matter.invoicedNetBilling,
            writeOffValue: matter.wipTotalWriteOff,
            matterCount: 1,
            billingType,
          },
        };
        continue;
      }

      const recordedValue = matter.wipTotalBillable;
      const billedValue = matter.invoicedNetBilling;
      const writeOffValue = matter.wipTotalWriteOff;

      // Skip matters with no WIP (no recorded potential)
      if (recordedValue === 0) continue;

      // Has WIP but no invoices → billed nothing yet → realisation = 0
      if (billedValue === 0 && matter.invoiceCount === 0) {
        entityResults[entityId] = {
          entityId,
          entityName,
          value: 0,
          formattedValue: '0.0%',
          nullReason: null,
          breakdown: {
            recordedValue,
            billedValue: 0,
            writeOffValue,
            matterCount: 1,
          },
        };
        continue;
      }

      const realisation = (billedValue / recordedValue) * 100;

      // Surface WIP vs invoice discrepancy if significant
      const discrepancyNote =
        matter.discrepancy?.hasMajorDiscrepancy === true
          ? `Major billing discrepancy: WIP ${recordedValue.toFixed(0)} vs invoiced ${billedValue.toFixed(0)} (${matter.discrepancy.billingDifferencePercent.toFixed(1)}%)`
          : undefined;
      if (discrepancyNote) warnings.push(`${entityName}: ${discrepancyNote}`);

      entityResults[entityId] = {
        entityId,
        entityName,
        value: realisation,
        formattedValue: formatValue(realisation, 'percentage'),
        nullReason: null,
        breakdown: {
          recordedValue,
          billedValue,
          writeOffValue,
          matterCount: 1,
          ...(discrepancyNote ? { discrepancyNote } : {}),
        },
      };
    }

    return {
      formulaId: 'F-RB-01',
      formulaName: 'Realisation Rate',
      variantUsed: activeVariant,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-RB-02: Effective Hourly Rate
// =============================================================================

export const effectiveHourlyRate: FormulaImplementation = {
  formulaId: 'F-RB-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    const effectiveRateBase = context.firmConfig?.billingMethodConfig?.effectiveRateBase ?? 'chargeable_hours';

    for (const feeEarner of context.feeEarners) {
      if (isSystemAccount(feeEarner)) continue;

      const entityId = resolveFeeEarnerId(feeEarner);
      const entityName = resolveFeeEarnerName(feeEarner);

      // Revenue attributed to this fee earner (pipeline-computed)
      const attributedRevenue = feeEarner.invoicedRevenue;

      // Denominator: selected by effectiveRateBase config
      let denomHours: number;
      let denomLabel: string;
      if (effectiveRateBase === 'total_hours') {
        denomHours = (feeEarner as unknown as Record<string, unknown>)['wipTotalHours'] as number ?? 0;
        denomLabel = 'total hours';
      } else {
        // 'chargeable_hours' (default) and 'billable_hours' (no separate pre-aggregation — use chargeable)
        denomHours = feeEarner.wipChargeableHours ?? 0;
        denomLabel = effectiveRateBase === 'billable_hours' ? 'billable hours (using chargeable)' : 'chargeable hours';
      }

      // Standard charge-out rate for comparison
      const chargeOutRate = getChargeOutRate(feeEarner, entityId, context.feeEarnerOverrides);

      if (denomHours === 0) {
        const reason = `No ${denomLabel} recorded`;
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: { attributedRevenue, chargeableHours: 0 },
        };
        continue;
      }

      // Revenue = 0 with chargeable hours → billed nothing yet but worked
      if (attributedRevenue === 0) {
        entityResults[entityId] = {
          entityId,
          entityName,
          value: 0,
          formattedValue: formatValue(0, 'currency'),
          nullReason: null,
          breakdown: { attributedRevenue: 0, chargeableHours: denomHours },
          ...(chargeOutRate !== null
            ? { additionalValues: { chargeOutRate, rateCapture: 0 } }
            : {}),
        };
        continue;
      }

      const effectiveRate = attributedRevenue / denomHours;

      const breakdown: Record<string, unknown> = {
        attributedRevenue,
        chargeableHours: denomHours,
        effectiveRate,
        effectiveRateBase,
      };

      let additionalValues: Record<string, number | null> | undefined;
      if (chargeOutRate !== null && chargeOutRate > 0) {
        const rateCapture = (effectiveRate / chargeOutRate) * 100;
        breakdown['chargeOutRate'] = chargeOutRate;
        breakdown['rateCapture'] = rateCapture;
        additionalValues = { chargeOutRate, rateCapture };
      } else if (chargeOutRate !== null) {
        warnings.push(`${entityName}: chargeOutRate is 0 — rateCapture cannot be computed`);
      }

      entityResults[entityId] = {
        entityId,
        entityName,
        value: effectiveRate,
        formattedValue: formatValue(effectiveRate, 'currency'),
        nullReason: null,
        breakdown,
        ...(additionalValues ? { additionalValues } : {}),
      };
    }

    return {
      formulaId: 'F-RB-02',
      formulaName: 'Effective Hourly Rate',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-RB-03: Revenue per Fee Earner
// =============================================================================

export const revenuePerFeeEarner: FormulaImplementation = {
  formulaId: 'F-RB-03',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const warnings: string[] = [];

    for (const feeEarner of context.feeEarners) {
      if (isSystemAccount(feeEarner)) continue;

      const entityId = resolveFeeEarnerId(feeEarner);
      const entityName = resolveFeeEarnerName(feeEarner);
      const grossBilling = feeEarner.invoicedRevenue;
      const payModel = getPayModel(feeEarner, entityId, context.feeEarnerOverrides);
      const override = context.feeEarnerOverrides[entityId];
      const config = getEffectiveConfig(feeEarner, context.firmConfig, override);

      if (payModel === 'FeeShare') {
        // Fee share: split gross billing into lawyer share and firm retain
        const feeSharePercent = config.feeSharePercent;
        const firmRetainPercent =
          config.firmRetainPercent > 0
            ? config.firmRetainPercent
            : 100 - feeSharePercent;

        const lawyerShare = grossBilling * (feeSharePercent / 100);
        const firmRetain = grossBilling * (firmRetainPercent / 100);

        entityResults[entityId] = {
          entityId,
          entityName,
          value: firmRetain, // primary value = firm perspective
          formattedValue: formatValue(firmRetain, 'currency'),
          nullReason: null,
          breakdown: {
            grossBilling,
            lawyerShare,
            firmRetain,
            feeSharePercent,
            firmRetainPercent,
            perspective: 'firm',
          },
          additionalValues: {
            lawyerPerspectiveRevenue: lawyerShare,
            grossBilling,
          },
        };
      } else {
        // Salaried (or unknown pay model): firm keeps all revenue
        if (payModel === null) {
          warnings.push(
            `${entityName}: payModel not set — treating as Salaried for revenue attribution`,
          );
        }

        entityResults[entityId] = {
          entityId,
          entityName,
          value: grossBilling,
          formattedValue: formatValue(grossBilling, 'currency'),
          nullReason: null,
          breakdown: {
            grossRevenue: grossBilling,
            perspective: 'firm',
          },
        };
      }
    }

    return {
      formulaId: 'F-RB-03',
      formulaName: 'Revenue per Fee Earner',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['invoiceData', 'feeEarnerConfig'],
        nullReasons: [],
        warnings,
      },
    };
  },
};

// =============================================================================
// F-RB-04: Billing Velocity
// =============================================================================

export const billingVelocity: FormulaImplementation = {
  formulaId: 'F-RB-04',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);

      // Get all time entries for this matter
      const entries = getEntriesForMatter(context.timeEntries, matter);

      // Determine unbilled entries:
      //   - If matter has no invoices: all entries are unbilled
      //   - If matter has invoices: use matter.wipAgeInDays as the pipeline-computed age,
      //     or fall back to entry-level ageInDays for matters with partial billing
      const hasInvoices = matter.invoiceCount > 0;

      if (entries.length === 0) {
        // No time entries in context — use pre-computed wipAgeInDays if available
        if (matter.wipAgeInDays !== null && matter.wipAgeInDays !== undefined) {
          if (hasInvoices && matter.wipTotalBillable === 0) {
            // Fully billed — no outstanding WIP
            entityResults[entityId] = buildVelocityResult(
              entityId,
              entityName,
              0,
              0,
              0,
              0,
            );
          } else {
            entityResults[entityId] = buildVelocityResult(
              entityId,
              entityName,
              matter.wipAgeInDays,
              0, // entry count not known from aggregated data
              matter.wipTotalBillable,
              matter.wipAgeInDays,
            );
          }
        } else if (hasInvoices && matter.wipTotalBillable === 0) {
          entityResults[entityId] = buildVelocityResult(entityId, entityName, 0, 0, 0, 0);
        } else {
          // No entries, no aggregated age data, and no WIP — skip
          if (matter.wipTotalBillable > 0) {
            const reason = 'No time entries or age data available';
            nullReasons.add(reason);
            entityResults[entityId] = {
              entityId,
              entityName,
              value: null,
              formattedValue: null,
              nullReason: reason,
              breakdown: { unbilledEntryCount: 0, totalUnbilledValue: matter.wipTotalBillable, averageAge: null, oldestEntry: null },
            };
          }
        }
        continue;
      }

      // For matters with entries: compute average ageInDays of the WIP
      // "Unbilled" = all entries for this matter if no invoices exist,
      //              or entries where ageInDays is set (best available proxy)
      const unbilledEntries = entries.filter((e) => e.ageInDays !== null && e.ageInDays !== undefined);

      if (unbilledEntries.length === 0) {
        // All entries lack age data
        if (hasInvoices && matter.wipTotalBillable === 0) {
          entityResults[entityId] = buildVelocityResult(entityId, entityName, 0, 0, 0, 0);
        } else {
          const reason = 'Entry ages not available';
          nullReasons.add(reason);
          entityResults[entityId] = {
            entityId,
            entityName,
            value: null,
            formattedValue: null,
            nullReason: reason,
            breakdown: { unbilledEntryCount: entries.length, totalUnbilledValue: matter.wipTotalBillable, averageAge: null, oldestEntry: null },
          };
        }
        continue;
      }

      const ages = unbilledEntries.map((e) => e.ageInDays!);
      const averageAge = ages.reduce((a, b) => a + b, 0) / ages.length;
      const oldestAge = Math.max(...ages);
      const totalUnbilledValue = unbilledEntries.reduce(
        (sum, e) => sum + ((e as Record<string, unknown>)['billable'] as number ?? 0),
        0,
      );

      entityResults[entityId] = buildVelocityResult(
        entityId,
        entityName,
        averageAge,
        unbilledEntries.length,
        totalUnbilledValue,
        oldestAge,
      );
    }

    // Firm-level weighted average velocity (weighted by unbilled value)
    const matterResults = Object.values(entityResults);
    const weightedTotal = matterResults.reduce((sum, r) => {
      if (r.value === null) return sum;
      const unbilledVal = (r.breakdown?.['totalUnbilledValue'] as number) ?? 0;
      return sum + r.value * unbilledVal;
    }, 0);
    const totalUnbilledWeight = matterResults.reduce((sum, r) => {
      if (r.value === null) return sum;
      return sum + ((r.breakdown?.['totalUnbilledValue'] as number) ?? 0);
    }, 0);

    if (totalUnbilledWeight > 0) {
      const firmVelocity = weightedTotal / totalUnbilledWeight;
      entityResults['firm'] = {
        entityId: 'firm',
        entityName: 'Firm (weighted average)',
        value: firmVelocity,
        formattedValue: `${Math.round(firmVelocity)} days`,
        nullReason: null,
        breakdown: { weightedAverageAge: firmVelocity, totalUnbilledValue: totalUnbilledWeight },
      };
    }

    return {
      formulaId: 'F-RB-04',
      formulaName: 'Billing Velocity',
      variantUsed: null,
      resultType: 'days',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};

function buildVelocityResult(
  entityId: string,
  entityName: string,
  averageAge: number,
  unbilledEntryCount: number,
  totalUnbilledValue: number,
  oldestAge: number,
): EntityFormulaResult {
  return {
    entityId,
    entityName,
    value: averageAge,
    formattedValue: averageAge === 0 ? '0 days' : `${Math.round(averageAge)} days`,
    nullReason: null,
    breakdown: {
      unbilledEntryCount,
      totalUnbilledValue,
      averageAge,
      oldestEntry: oldestAge,
    },
  };
}
