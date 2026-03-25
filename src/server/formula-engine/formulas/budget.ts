/**
 * budget.ts — Budget & Scope formula implementations
 *
 * F-BS-01: Budget Burn Rate      (by_value / by_hours variants)
 * F-BS-02: Scope Creep Indicator (burn vs billing progress)
 *
 * `budget` is not in the AggregatedMatter typed interface — it is a
 * dynamic field populated from the full matters export column mapping.
 * Access via dynField(matter, 'budget').
 */

import type { AggregatedMatter } from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../shared/types/enriched.js';
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

/** Get budget for a matter. 0 = no budget set. */
function getMatterBudget(matter: AggregatedMatter): number {
  return numDyn(matter, 'budget');
}

/** Get time entries for a specific matter. */
function entriesForMatter(
  context: FormulaContext,
  matter: AggregatedMatter,
): EnrichedTimeEntry[] {
  return context.timeEntries.filter((e) => {
    if (matter.matterId && e.matterId) return e.matterId === matter.matterId;
    if (matter.matterNumber && e.matterNumber) return e.matterNumber === matter.matterNumber;
    return false;
  });
}

/** Weighted average billing rate from time entries (billableValue / durationHours). */
function computeAverageRate(entries: EnrichedTimeEntry[]): number | null {
  const totalHours = entries.reduce((s, e) => s + (e.durationHours ?? 0), 0);
  const totalValue = entries.reduce((s, e) => s + numDyn(e, 'billableValue'), 0);
  if (totalHours === 0) return null;
  return totalValue / totalHours;
}

// =============================================================================
// F-BS-01: Budget Burn Rate
// =============================================================================

export const budgetBurnRate: FormulaImplementation = {
  formulaId: 'F-BS-01',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'by_value';
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);
      const budget = getMatterBudget(matter);

      if (budget <= 0) {
        const reason = 'No budget set';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: { budget: 0 },
        };
        continue;
      }

      if (activeVariant === 'by_hours') {
        // Estimate budget hours from budget ÷ average rate of fee earners on this matter
        const entries = entriesForMatter(context, matter);
        const avgRate = computeAverageRate(entries) ?? (matter.wipTotalHours > 0
          ? matter.wipTotalBillable / matter.wipTotalHours
          : null);

        if (avgRate === null || avgRate === 0) {
          warnings.push(`${entityName}: Cannot compute by_hours — no rate data available`);
          entityResults[entityId] = {
            entityId,
            entityName,
            value: null,
            formattedValue: null,
            nullReason: 'No rate data to convert budget to hours',
            breakdown: { budget, totalHours: matter.wipTotalHours },
          };
          continue;
        }

        const budgetHours = budget / avgRate;
        const totalHours = matter.wipTotalHours;
        const burnRate = (totalHours / budgetHours) * 100;
        const remainingHours = budgetHours - totalHours;

        entityResults[entityId] = {
          entityId,
          entityName,
          value: burnRate,
          formattedValue: formatValue(burnRate, 'percentage'),
          nullReason: null,
          breakdown: {
            budget,
            averageRate: avgRate,
            budgetHours,
            totalHours,
            remainingHours,
            isOverBudget: totalHours > budgetHours,
          },
        };
      } else {
        // by_value (default)
        const totalSpend = matter.wipTotalBillable;
        const burnRate = (totalSpend / budget) * 100;
        const remaining = budget - totalSpend;

        entityResults[entityId] = {
          entityId,
          entityName,
          value: burnRate,
          formattedValue: formatValue(burnRate, 'percentage'),
          nullReason: null,
          breakdown: {
            budget,
            totalSpend,
            remaining,
            isOverBudget: totalSpend > budget,
          },
        };
      }
    }

    return {
      formulaId: 'F-BS-01',
      formulaName: 'Budget Burn Rate',
      variantUsed: activeVariant,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'matterConfig'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-BS-02: Scope Creep Indicator
// =============================================================================

function interpretScopeCreep(creep: number): string {
  if (creep >= 20) return 'High scope creep risk';
  if (creep >= 10) return 'Moderate scope creep';
  if (creep > 0)   return 'Slight scope creep';
  return 'On track or ahead';
}

export const scopeCreepIndicator: FormulaImplementation = {
  formulaId: 'F-BS-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();

    // Prefer F-BS-01 results from prior execution; recompute inline if not available
    const burnResults = context.formulaResults['F-BS-01']?.entityResults ?? {};

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);
      const budget = getMatterBudget(matter);

      if (budget <= 0) {
        nullReasons.add('No budget set');
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: 'No budget set',
          breakdown: {},
        };
        continue;
      }

      // Budget burn %: prefer pre-computed F-BS-01, else compute inline
      let budgetBurnPercent: number;
      if (burnResults[entityId]?.value != null) {
        budgetBurnPercent = burnResults[entityId].value as number;
      } else {
        budgetBurnPercent = (matter.wipTotalBillable / budget) * 100;
      }

      // Billing progress: how much of budget has been invoiced
      const revenue = matter.invoiceCount > 0 ? matter.invoicedNetBilling : 0;
      const billingProgressPercent = (revenue / budget) * 100;

      const scopeCreep = Math.round((budgetBurnPercent - billingProgressPercent) * 100) / 100;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: scopeCreep,
        formattedValue: formatValue(scopeCreep, 'percentage'),
        nullReason: null,
        breakdown: {
          budgetBurnPercent,
          billingProgressPercent,
          interpretation: interpretScopeCreep(scopeCreep),
        },
      };
    }

    return {
      formulaId: 'F-BS-02',
      formulaName: 'Scope Creep Indicator',
      variantUsed: null,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'matterConfig'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};
