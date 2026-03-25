/**
 * composites.ts — Composite score formula implementations
 *
 * F-CS-01: Recovery Opportunity   (firm-level, combines 3 opportunity types)
 * F-CS-02: Fee Earner Scorecard   (weighted multi-metric score per fee earner)
 * F-CS-03: Matter Health Score    (4-component health score per matter)
 *
 * These formulas read from context.formulaResults and context.snippetResults
 * from prior formula/snippet executions. Each metric degrades gracefully to a
 * neutral value (50) when the upstream result is unavailable.
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
} from '../../../shared/types/pipeline.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  EntityFormulaResult,
} from '../types.js';
import { formatValue, summariseResults } from '../result-formatter.js';

// =============================================================================
// Shared helpers
// =============================================================================

function now(): string {
  return new Date().toISOString();
}

function dynField<T>(obj: object, key: string): T | null {
  const v = (obj as unknown as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  return v as T;
}

function numDyn(obj: object, key: string): number {
  const v = dynField<number>(obj, key);
  return typeof v === 'number' && !isNaN(v) ? v : 0;
}

function resolveMatterId(matter: AggregatedMatter): string {
  return matter.matterId ?? matter.matterNumber ?? 'unknown';
}

function resolveMatterName(matter: AggregatedMatter): string {
  return matter.matterNumber ?? matter.matterId ?? 'Unknown Matter';
}

function resolveFeeEarnerId(fe: AggregatedFeeEarner): string {
  return fe.lawyerId ?? fe.lawyerName ?? 'unknown';
}

function resolveFeeEarnerName(fe: AggregatedFeeEarner): string {
  return fe.lawyerName ?? fe.lawyerId ?? 'Unknown';
}

/** Read an entity value from a prior formula result. */
function priorValue(
  context: FormulaContext,
  formulaId: string,
  entityId: string,
): number | null {
  return context.formulaResults[formulaId]?.entityResults[entityId]?.value ?? null;
}

/** Read a prior formula breakdown field. */
function priorBreakdown<T>(
  context: FormulaContext,
  formulaId: string,
  entityId: string,
  field: string,
): T | null {
  const r = context.formulaResults[formulaId]?.entityResults[entityId]?.breakdown;
  if (!r) return null;
  const v = r[field];
  if (v === undefined || v === null) return null;
  return v as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// =============================================================================
// F-CS-01: Recovery Opportunity
// =============================================================================

export const recoveryOpportunity: FormulaImplementation = {
  formulaId: 'F-CS-01',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const warnings: string[] = [];

    // ----------------------------------------------------------------
    // 1. Utilisation opportunity
    // ----------------------------------------------------------------
    let utilisationOpportunity = 0;
    const chargeableTarget = context.firmConfig.chargeableWeeklyTarget ?? 30;
    // Approximate annual available chargeable hours per earner
    const weeklyTarget = context.firmConfig.weeklyTargetHours ?? 37.5;
    const weeksWorked =
      52 -
      ((context.firmConfig.annualLeaveEntitlement ?? 25) +
        (context.firmConfig.bankHolidaysPerYear ?? 8)) /
        (context.firmConfig.workingDaysPerWeek ?? 5);
    const annualAvailableHours = weeklyTarget * weeksWorked;
    const annualChargeableTarget = chargeableTarget * weeksWorked;

    for (const fe of context.feeEarners) {
      const entityId = resolveFeeEarnerId(fe);
      // Get utilisation from F-TU-01 or compute inline
      const utilisationPct =
        priorValue(context, 'F-TU-01', entityId) ??
        (annualChargeableTarget > 0
          ? (fe.wipChargeableHours / annualChargeableTarget) * 100
          : null);

      if (utilisationPct === null || utilisationPct >= 100) continue;

      // How many more chargeable hours could this earner work?
      const utilisationFraction = utilisationPct / 100;
      const actualChargeableHours = utilisationFraction * annualAvailableHours;
      const gapHours = annualChargeableTarget - actualChargeableHours;
      if (gapHours <= 0) continue;

      // Effective rate from F-RB-02 or inline
      const effectiveRate =
        priorValue(context, 'F-RB-02', entityId) ??
        (fe.wipChargeableHours > 0 ? fe.invoicedRevenue / fe.wipChargeableHours : null);

      if (effectiveRate === null || effectiveRate === 0) continue;

      utilisationOpportunity += gapHours * effectiveRate;
    }

    // ----------------------------------------------------------------
    // 2. Realisation opportunity
    // ----------------------------------------------------------------
    // totalUnrealisedValue = totalWipValue × (1 - firmRealisationRate/100)
    let realisationOpportunity = 0;
    const firmRealisationRate = priorValue(context, 'F-RB-01', 'firm');
    const totalWipValue = context.firm.totalWipValue;

    if (firmRealisationRate !== null && totalWipValue > 0) {
      const unrealised = totalWipValue * (1 - firmRealisationRate / 100);
      realisationOpportunity = Math.max(0, unrealised);
    } else {
      // Fallback: use (wipValue - invoicedRevenue) if available
      const invoiced = context.firm.totalInvoicedRevenue;
      if (totalWipValue > invoiced) {
        realisationOpportunity = totalWipValue - invoiced;
      }
      if (firmRealisationRate === null) {
        warnings.push('F-RB-01 not available — using WIP vs invoiced gap for realisation opportunity');
      }
    }

    // ----------------------------------------------------------------
    // 3. WIP recovery opportunity
    // ----------------------------------------------------------------
    // atRiskAmount from F-WL-01 firm breakdown
    const atRiskAmount =
      priorBreakdown<number>(context, 'F-WL-01', 'firm', 'atRiskAmount') ?? 0;
    const wipRecoveryOpportunity = atRiskAmount;

    if (atRiskAmount === 0 && !context.formulaResults['F-WL-01']) {
      warnings.push('F-WL-01 not available — WIP recovery opportunity set to 0');
    }

    // ----------------------------------------------------------------
    // Total
    // ----------------------------------------------------------------
    const total = utilisationOpportunity + realisationOpportunity + wipRecoveryOpportunity;

    // Build top opportunities list
    const topOpportunities: Array<{ type: string; amount: number; description: string }> = [
      {
        type: 'utilisation',
        amount: utilisationOpportunity,
        description: 'Increase chargeable hours for underperforming fee earners',
      },
      {
        type: 'realisation',
        amount: realisationOpportunity,
        description: 'Convert unbilled WIP to invoices',
      },
      {
        type: 'wipRecovery',
        amount: wipRecoveryOpportunity,
        description: 'Bill aged WIP before it becomes unrecoverable',
      },
    ]
      .filter((o) => o.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const entityResults: Record<string, EntityFormulaResult> = {
      firm: {
        entityId: 'firm',
        entityName: 'Firm',
        value: total,
        formattedValue: formatValue(total, 'currency'),
        nullReason: null,
        breakdown: {
          utilisationOpportunity,
          realisationOpportunity,
          wipRecoveryOpportunity,
          total,
          topOpportunities,
        },
      },
    };

    return {
      formulaId: 'F-CS-01',
      formulaName: 'Recovery Opportunity',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'snippets', 'formulaResults'],
        nullReasons: [],
        warnings,
      },
    };
  },
};

// =============================================================================
// F-CS-02: Fee Earner Scorecard
// =============================================================================

interface ScorecardWeights {
  utilisationWeight: number;
  realisationWeight: number;
  recordingWeight: number;
  writeOffWeight: number;
  revenueWeight: number;
  wipAgeWeight: number;
}

const DEFAULT_WEIGHTS: ScorecardWeights = {
  utilisationWeight: 25,
  realisationWeight: 20,
  recordingWeight: 15,
  writeOffWeight: 15,
  revenueWeight: 15,
  wipAgeWeight: 10,
};

function getScorecardWeights(context: FormulaContext): ScorecardWeights {
  const raw = dynField<Partial<ScorecardWeights>>(context.firmConfig, 'scorecardWeights');
  if (!raw) return DEFAULT_WEIGHTS;
  return {
    utilisationWeight: raw.utilisationWeight ?? DEFAULT_WEIGHTS.utilisationWeight,
    realisationWeight: raw.realisationWeight ?? DEFAULT_WEIGHTS.realisationWeight,
    recordingWeight: raw.recordingWeight ?? DEFAULT_WEIGHTS.recordingWeight,
    writeOffWeight: raw.writeOffWeight ?? DEFAULT_WEIGHTS.writeOffWeight,
    revenueWeight: raw.revenueWeight ?? DEFAULT_WEIGHTS.revenueWeight,
    wipAgeWeight: raw.wipAgeWeight ?? DEFAULT_WEIGHTS.wipAgeWeight,
  };
}

export const feeEarnerScorecard: FormulaImplementation = {
  formulaId: 'F-CS-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const allWarnings: string[] = [];
    const weights = getScorecardWeights(context);

    const chargeableTarget = context.firmConfig.chargeableWeeklyTarget ?? 30;
    const weeklyTarget = context.firmConfig.weeklyTargetHours ?? 37.5;
    const weeksWorked =
      52 -
      ((context.firmConfig.annualLeaveEntitlement ?? 25) +
        (context.firmConfig.bankHolidaysPerYear ?? 8)) /
        (context.firmConfig.workingDaysPerWeek ?? 5);
    const annualChargeableTarget = chargeableTarget * weeksWorked;

    for (const fe of context.feeEarners) {
      const entityId = resolveFeeEarnerId(fe);
      const entityName = resolveFeeEarnerName(fe);
      const warnings: string[] = [];

      // ---- Utilisation score ----
      let utilisationRaw: number | null =
        priorValue(context, 'F-TU-01', entityId);
      if (utilisationRaw === null) {
        utilisationRaw =
          annualChargeableTarget > 0
            ? (fe.wipChargeableHours / annualChargeableTarget) * 100
            : null;
      }
      const utilisationScore =
        utilisationRaw !== null
          ? clamp((utilisationRaw / (chargeableTarget > 0 ? 100 : 1)) * 100, 0, 100)
          : (warnings.push(`${entityName}: utilisation unavailable — using neutral score`), 50);

      // When utilisation is already a % of target (F-TU-01 returns %),
      // cap at 100 directly
      const utilisationScoreFinal =
        utilisationRaw !== null ? clamp(utilisationRaw, 0, 100) : utilisationScore;

      // ---- Realisation score ----
      // Use F-RB-01 firm-level realisation as proxy (per-earner not computed)
      const realisationRaw: number | null =
        priorValue(context, 'F-RB-01', 'firm') ??
        (fe.wipChargeableHours > 0 && fe.invoicedRevenue >= 0
          ? null
          : null);
      const realisationScore =
        realisationRaw !== null
          ? clamp(realisationRaw, 0, 100)
          : (warnings.push(`${entityName}: realisation unavailable — using neutral score`), 50);

      // ---- Recording consistency score ----
      const recordingGap = fe.recordingGapDays ?? null;
      const recordingScore =
        recordingGap !== null
          ? clamp(100 - recordingGap * 10, 0, 100)
          : (warnings.push(`${entityName}: recording gap unavailable — using neutral score`), 50);

      // ---- Write-off rate score ----
      const writeOffRaw: number | null = priorValue(context, 'F-WL-02', entityId);
      const writeOffScore =
        writeOffRaw !== null
          ? clamp(100 - writeOffRaw * 2, 0, 100)
          : (warnings.push(`${entityName}: write-off rate unavailable — using neutral score`), 50);

      // ---- Revenue score ----
      // Compare revenue to an expected target: annualChargeableTarget × effective rate
      // If F-RB-03 available, use that; else use invoicedRevenue directly
      const revenueRaw: number | null = priorValue(context, 'F-RB-03', entityId);
      const revenueTarget = numDyn(fe, 'revenueTarget'); // dynamic per-earner target
      let revenueScore: number;
      if (revenueTarget > 0 && revenueRaw !== null) {
        revenueScore = clamp((revenueRaw / revenueTarget) * 100, 0, 100);
      } else if (revenueRaw !== null || fe.invoicedRevenue > 0) {
        // No target — treat any positive revenue as moderate (70)
        revenueScore = fe.invoicedRevenue > 0 ? 70 : 50;
      } else {
        warnings.push(`${entityName}: revenue metric unavailable — using neutral score`);
        revenueScore = 50;
      }

      // ---- WIP age score ----
      // Use F-WL-01 firm-level average age as proxy (per-earner WIP age not computed)
      const wipAgeRaw: number | null = priorValue(context, 'F-WL-01', 'firm');
      const wipAgeScore =
        wipAgeRaw !== null
          ? clamp(100 - wipAgeRaw * 0.5, 0, 100)
          : (warnings.push(`${entityName}: WIP age unavailable — using neutral score`), 50);

      // ---- Weighted score ----
      const totalWeight =
        weights.utilisationWeight +
        weights.realisationWeight +
        weights.recordingWeight +
        weights.writeOffWeight +
        weights.revenueWeight +
        weights.wipAgeWeight;

      const weightedScore =
        (utilisationScoreFinal * weights.utilisationWeight +
          realisationScore * weights.realisationWeight +
          recordingScore * weights.recordingWeight +
          writeOffScore * weights.writeOffWeight +
          revenueScore * weights.revenueWeight +
          wipAgeScore * weights.wipAgeWeight) /
        totalWeight;

      allWarnings.push(...warnings);

      entityResults[entityId] = {
        entityId,
        entityName,
        value: Math.round(weightedScore),
        formattedValue: `${Math.round(weightedScore)}`,
        nullReason: null,
        breakdown: {
          components: {
            utilisation: {
              score: utilisationScoreFinal,
              weight: weights.utilisationWeight,
              raw: utilisationRaw,
            },
            realisation: {
              score: realisationScore,
              weight: weights.realisationWeight,
              raw: realisationRaw,
            },
            recording: {
              score: recordingScore,
              weight: weights.recordingWeight,
              raw: recordingGap,
            },
            writeOff: {
              score: writeOffScore,
              weight: weights.writeOffWeight,
              raw: writeOffRaw,
            },
            revenue: {
              score: revenueScore,
              weight: weights.revenueWeight,
              raw: revenueRaw ?? fe.invoicedRevenue,
            },
            wipAge: {
              score: wipAgeScore,
              weight: weights.wipAgeWeight,
              raw: wipAgeRaw,
            },
          },
          weightedScore,
          warnings,
        },
      };
    }

    return {
      formulaId: 'F-CS-02',
      formulaName: 'Fee Earner Scorecard',
      variantUsed: null,
      resultType: 'number',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig', 'snippets', 'formulaResults'],
        nullReasons: [],
        warnings: allWarnings,
      },
    };
  },
};

// =============================================================================
// F-CS-03: Matter Health Score
// =============================================================================

export const matterHealthScore: FormulaImplementation = {
  formulaId: 'F-CS-03',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const allWarnings: string[] = [];

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);

      const budget = numDyn(matter, 'budget');
      const hasBudget = budget > 0;

      // ---- WIP age score ----
      const wipAgeRaw = priorValue(context, 'F-WL-01', entityId) ?? matter.wipAgeInDays;
      const wipAgeScore =
        wipAgeRaw !== null ? clamp(100 - wipAgeRaw * 0.5, 0, 100) : 50;

      // ---- Budget score ----
      let budgetRaw: number | null = null;
      let budgetScore: number;
      if (!hasBudget) {
        budgetScore = 50; // neutral — no budget to assess
      } else {
        budgetRaw = priorValue(context, 'F-BS-01', entityId);
        if (budgetRaw === null) {
          // Compute inline
          budgetRaw = matter.wipTotalBillable > 0 ? (matter.wipTotalBillable / budget) * 100 : 0;
        }
        budgetScore = clamp(100 - Math.max(0, budgetRaw - 80) * 2, 0, 100);
      }

      // ---- Realisation score ----
      const realisationRaw = priorValue(context, 'F-RB-01', entityId);
      const realisationScore =
        realisationRaw !== null ? clamp(realisationRaw, 0, 100) : 50;

      // ---- Disbursement recovery score ----
      const disbursementRaw = priorValue(context, 'F-WL-03', entityId);
      const disbursementScore =
        disbursementRaw !== null ? clamp(disbursementRaw, 0, 100) : 50;

      const components = [wipAgeScore, budgetScore, realisationScore, disbursementScore];
      const healthScore = components.reduce((a, b) => a + b, 0) / components.length;

      // Risk flags
      const riskFlags: string[] = [];
      if (hasBudget && budgetRaw !== null && budgetRaw > 100) riskFlags.push('Over budget');
      if (wipAgeRaw !== null && wipAgeRaw > 90) riskFlags.push('Aged WIP at risk');
      if (realisationRaw !== null && realisationRaw < 60) riskFlags.push('Low realisation');
      if (disbursementRaw !== null && disbursementRaw < 50) riskFlags.push('Low disbursement recovery');

      entityResults[entityId] = {
        entityId,
        entityName,
        value: Math.round(healthScore),
        formattedValue: `${Math.round(healthScore)}`,
        nullReason: null,
        breakdown: {
          components: {
            wipAge: { score: wipAgeScore, raw: wipAgeRaw },
            budget: { score: budgetScore, raw: budgetRaw, hasBudget },
            realisation: { score: realisationScore, raw: realisationRaw },
            disbursement: { score: disbursementScore, raw: disbursementRaw },
          },
          healthScore,
          riskFlags,
        },
      };
    }

    return {
      formulaId: 'F-CS-03',
      formulaName: 'Matter Health Score',
      variantUsed: null,
      resultType: 'number',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'matterConfig', 'formulaResults'],
        nullReasons: [],
        warnings: allWarnings,
      },
    };
  },
};
