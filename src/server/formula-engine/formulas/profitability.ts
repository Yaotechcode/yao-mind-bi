/**
 * profitability.ts — Profitability formula implementations
 *
 * F-PR-01: Matter Profitability      (simple / standard / full variants)
 * F-PR-02: Fee Earner Profitability  (salaried vs fee share branching)
 * F-PR-03: Department Profitability  (aggregated over department matters)
 * F-PR-04: Client Profitability      (aggregated over client matters)
 * F-PR-05: Firm Profitability        (top-level firm view)
 *
 * FIRST-CLASS CONCEPT: fee share vs salaried. Every formula branches on payModel.
 *   Salaried: real employment cost from SN-004 (salary+NI+pension+variable)
 *   FeeShare: cost = gross billing × feeSharePercent (no employment cost)
 *
 * Snippet dependency handling:
 *   SN-001 (Fully Loaded Cost Rate), SN-003 (Firm Retain Amount),
 *   SN-004 (Employment Cost Annual), SN-005 (Cost Rate by Pay Model)
 *   All accessed via context.snippetResults. Returns null gracefully if not yet
 *   populated (snippets implemented in 1C-07).
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
} from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry } from '../../../shared/types/enriched.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  EntityFormulaResult,
} from '../types.js';
import { formatValue, summariseResults } from '../result-formatter.js';
import { getEffectiveConfig } from '../context-builder.js';

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

/** Read a pre-computed snippet result for one entity. Returns null when not populated. */
function snippetVal(
  context: FormulaContext,
  snippetId: string,
  entityId: string,
): number | null {
  return context.snippetResults[snippetId]?.[entityId]?.value ?? null;
}

/** Determine the revenue to use for a matter.
 *  Billing source: invoicedNetBilling if invoices exist, else WIP billable. */
function matterRevenue(matter: AggregatedMatter): number {
  return matter.invoiceCount > 0 ? matter.invoicedNetBilling : matter.wipTotalBillable;
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

function resolveClientId(client: AggregatedClient): string {
  return client.contactId ?? client.displayName ?? client.clientName ?? 'unknown';
}

function resolveClientName(client: AggregatedClient): string {
  return client.displayName ?? client.clientName ?? client.contactId ?? 'Unknown Client';
}

/** Get pay model, checking overrides then fee earner dynamic fields. */
function getPayModel(
  fe: AggregatedFeeEarner,
  entityId: string,
  overrides: Record<string, Record<string, unknown>>,
): string | null {
  const fromOverride = overrides[entityId]?.['payModel'];
  if (fromOverride != null) return String(fromOverride);
  return dynField<string>(fe, 'payModel');
}

/** Get SN-005 cost rate for a fee earner, with graceful fallback. */
function getCostRate(context: FormulaContext, entityId: string): number {
  return snippetVal(context, 'SN-005', entityId) ?? 0;
}

/** Overhead rate per hour — read from firmConfig dynamic field, default 0. */
function overheadRatePerHour(context: FormulaContext): number {
  return numDyn(context.firmConfig, 'overheadRatePerHour');
}

/** Per-earner annual fee share overhead — read from firmConfig, default 0. */
function feeShareOverheadPerEarner(context: FormulaContext): number {
  return numDyn(context.firmConfig, 'feeShareOverheadPerEarner');
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

/** Sum unrecovered disbursement outstanding for a specific matter. */
function matterDisbursementOutstanding(
  context: FormulaContext,
  matter: AggregatedMatter,
): number {
  const records = context.disbursements.filter((d) => {
    if (matter.matterId && d.matterId) return d.matterId === matter.matterId;
    if (matter.matterNumber) {
      const dNum = dynField<string>(d, 'matterNumber');
      return dNum === matter.matterNumber;
    }
    return false;
  });
  if (records.length > 0) {
    return records.reduce((s, d) => s + (d.firmExposure ?? numDyn(d, 'outstanding')), 0);
  }
  // Fallback: assume 0 outstanding (no disbursement records in context)
  return 0;
}

/**
 * Group time entries for a matter by lawyerId → { hours, lawyerName, entries }.
 */
interface EarnerGroup {
  lawyerId: string;
  lawyerName: string;
  hours: number;
  entries: EnrichedTimeEntry[];
}

function groupEntriesByEarner(entries: EnrichedTimeEntry[]): EarnerGroup[] {
  const map = new Map<string, EarnerGroup>();
  for (const e of entries) {
    const id = e.lawyerId ?? dynField<string>(e, 'lawyerName') ?? 'unknown';
    const name = dynField<string>(e, 'lawyerName') ?? e.lawyerId ?? 'Unknown';
    if (!map.has(id)) map.set(id, { lawyerId: id, lawyerName: name, hours: 0, entries: [] });
    const g = map.get(id)!;
    g.hours += e.durationHours ?? numDyn(e, 'durationMinutes') / 60;
    g.entries.push(e);
  }
  return [...map.values()];
}

/** Compute labour cost for a set of earner groups using SN-005 rates. */
function computeLabourCost(context: FormulaContext, groups: EarnerGroup[]): number {
  return groups.reduce((sum, g) => sum + g.hours * getCostRate(context, g.lawyerId), 0);
}

/**
 * Compute the firm-net profit for a fee share earner from their gross billing.
 * firmRetain = grossBilling × firmRetainPercent (after overhead)
 */
function feeShareFirmNet(
  fe: AggregatedFeeEarner,
  entityId: string,
  context: FormulaContext,
): { firmRetain: number; lawyerShare: number; firmNetProfit: number; feeSharePct: number; firmRetainPct: number } {
  const override = context.feeEarnerOverrides[entityId];
  const config = getEffectiveConfig(fe, context.firmConfig, override);
  const feeSharePct = config.feeSharePercent;
  const firmRetainPct = config.firmRetainPercent > 0 ? config.firmRetainPercent : 100 - feeSharePct;
  const gross = fe.invoicedRevenue;
  const lawyerShare = gross * (feeSharePct / 100);
  const firmRetain = gross * (firmRetainPct / 100);
  const overhead = feeShareOverheadPerEarner(context);
  return {
    firmRetain,
    lawyerShare,
    firmNetProfit: firmRetain - overhead,
    feeSharePct,
    firmRetainPct,
  };
}

// =============================================================================
// F-PR-01: Matter Profitability
// =============================================================================

export const matterProfitability: FormulaImplementation = {
  formulaId: 'F-PR-01',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'standard';
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    // Compute firm-wide average cost rate for 'simple' variant
    let avgCostRate = 0;
    if (activeVariant === 'simple') {
      const rates = context.feeEarners
        .map((fe) => snippetVal(context, 'SN-005', resolveFeeEarnerId(fe)))
        .filter((v): v is number => v !== null);
      if (rates.length > 0) {
        avgCostRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      }
    }

    const ohRate = activeVariant === 'full' ? overheadRatePerHour(context) : 0;

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);
      const revenue = matterRevenue(matter);
      const hours = matter.wipTotalHours;

      let totalLabourCost: number;
      let disbursementCost: number;
      let overheadAllocation = 0;

      if (activeVariant === 'simple') {
        totalLabourCost = hours * avgCostRate;
        disbursementCost = 0; // simple variant ignores disbursement detail
      } else {
        // standard / full: per-earner costs
        const groups = groupEntriesByEarner(entriesForMatter(context, matter));
        totalLabourCost = computeLabourCost(context, groups);
        disbursementCost = matterDisbursementOutstanding(context, matter);

        if (activeVariant === 'full') {
          overheadAllocation = hours * ohRate;
        }
      }

      const totalCost = totalLabourCost + disbursementCost + overheadAllocation;

      // No financial data at all
      if (revenue === 0 && totalCost === 0) {
        const reason = 'No financial data';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: {},
        };
        continue;
      }

      const profit = revenue - totalCost;
      const margin = revenue > 0 ? (profit / revenue) * 100 : null;

      // Firm-net: adjust for fee share portions not kept by firm
      // For now, firmNetProfit = profit (FeeShare costs already captured in SN-005)
      const firmNetProfit = profit;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: profit,
        formattedValue: formatValue(profit, 'currency'),
        nullReason: null,
        breakdown: {
          revenue,
          totalCost,
          labourCost: totalLabourCost,
          disbursementLeakage: disbursementCost,
          ...(activeVariant === 'full' ? { overheadAllocation } : {}),
          profit,
          margin,
        },
        additionalValues: {
          margin,
          revenue,
          totalCost,
          labourCost: totalLabourCost,
          disbursementLeakage: disbursementCost,
          ...(activeVariant === 'full' ? { overheadAllocation } : {}),
          firmNetProfit,
        },
      };
    }

    if (activeVariant === 'simple' && avgCostRate === 0) {
      warnings.push('SN-005 not available — cost rates defaulted to 0 (all formulas show revenue as profit)');
    }

    return {
      formulaId: 'F-PR-01',
      formulaName: 'Matter Profitability',
      variantUsed: activeVariant,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig', 'snippets'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-PR-02: Fee Earner Profitability
// =============================================================================

export const feeEarnerProfitability: FormulaImplementation = {
  formulaId: 'F-PR-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const warnings: string[] = [];

    for (const fe of context.feeEarners) {
      const entityId = resolveFeeEarnerId(fe);
      const entityName = resolveFeeEarnerName(fe);
      const payModel = getPayModel(fe, entityId, context.feeEarnerOverrides);

      if (payModel === 'FeeShare') {
        // ---- Fee share branch ----
        const { firmRetain, lawyerShare, firmNetProfit, feeSharePct, firmRetainPct } =
          feeShareFirmNet(fe, entityId, context);

        entityResults[entityId] = {
          entityId,
          entityName,
          value: firmNetProfit,
          formattedValue: formatValue(firmNetProfit, 'currency'),
          nullReason: null,
          breakdown: {
            grossBilling: fe.invoicedRevenue,
            lawyerShare,
            firmRetain,
            feeSharePercent: feeSharePct,
            firmRetainPercent: firmRetainPct,
            overheadCost: feeShareOverheadPerEarner(context),
            firmNetProfit,
          },
          additionalValues: {
            grossBilling: fe.invoicedRevenue,
            lawyerShare,
            firmRetain,
            overheadCost: feeShareOverheadPerEarner(context),
            firmNetProfit,
            lawyerPerspectiveProfit: lawyerShare,
            feeSharePercent: feeSharePct,
            firmRetainPercent: firmRetainPct,
          },
        };
      } else {
        // ---- Salaried branch (or unknown — warn and treat as salaried) ----
        if (payModel === null) {
          warnings.push(
            `${entityName}: payModel not set — treating as Salaried for profitability`,
          );
        }

        const annualisedCost = snippetVal(context, 'SN-004', entityId) ?? 0;
        if (annualisedCost === 0) {
          nullReasons.add('SN-004 not available — employment cost defaulted to 0');
        }

        // Period fraction: default 1.0 (full year)
        // TODO: prorate to elapsed fraction of financial year when period tracking added
        const periodFraction = 1.0;
        const periodCost = annualisedCost * periodFraction;

        const revenue = fe.invoicedRevenue;
        const profit = revenue - periodCost;

        const roi = periodCost > 0 ? (profit / periodCost) * 100 : null;
        const revenueMultiple = periodCost > 0 ? revenue / periodCost : null;

        entityResults[entityId] = {
          entityId,
          entityName,
          value: profit,
          formattedValue: formatValue(profit, 'currency'),
          nullReason: null,
          breakdown: {
            revenue,
            annualisedEmploymentCost: annualisedCost,
            periodCost,
            profit,
            roi,
            revenueMultiple,
          },
          additionalValues: {
            roi,
            revenueMultiple,
            revenue,
            employmentCost: periodCost,
            annualisedEmploymentCost: annualisedCost,
          },
        };
      }
    }

    return {
      formulaId: 'F-PR-02',
      formulaName: 'Fee Earner Profitability',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['invoiceData', 'feeEarnerConfig', 'snippets'],
        nullReasons: Array.from(nullReasons),
        warnings,
      },
    };
  },
};

// =============================================================================
// F-PR-03: Department Profitability
// =============================================================================

export const departmentProfitability: FormulaImplementation = {
  formulaId: 'F-PR-03',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();

    for (const dept of context.departments) {
      const entityId = dept.departmentId ?? dept.name;
      const entityName = dept.name;

      // Find all matters in this department via dynamic field
      const deptMatters = context.matters.filter(
        (m) => dynField<string>(m, 'department') === dept.name,
      );

      // Use AggregatedDepartment.invoicedRevenue as the authoritative revenue
      // (computed by the aggregator across all dept matters)
      const revenue = dept.invoicedRevenue;

      // Labour cost: sum costs per fee earner for entries on department matters
      const deptEntries = deptMatters.flatMap((m) => entriesForMatter(context, m));
      const groups = groupEntriesByEarner(deptEntries);
      const labourCost = computeLabourCost(context, groups);

      // Disbursement leakage across all department matters
      const disbursementLeakage = deptMatters.reduce(
        (s, m) => s + matterDisbursementOutstanding(context, m),
        0,
      );

      // Overhead: department-level allocation from firmConfig (dynamic field)
      const overheadAllocation = numDyn(context.firmConfig, 'overheadPerDepartment');

      const totalCost = labourCost + disbursementLeakage + overheadAllocation;

      if (revenue === 0 && totalCost === 0) {
        const reason = 'No financial data';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: {},
        };
        continue;
      }

      const profit = revenue - totalCost;
      const margin = revenue > 0 ? (profit / revenue) * 100 : null;
      const feeEarnerCount = dept.feeEarnerCount;
      const matterCount = deptMatters.length;
      const revenuePerFeeEarner = feeEarnerCount > 0 ? revenue / feeEarnerCount : null;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: profit,
        formattedValue: formatValue(profit, 'currency'),
        nullReason: null,
        breakdown: {
          revenue,
          labourCost,
          disbursementLeakage,
          overheadAllocation,
          totalCost,
          profit,
          margin,
          feeEarnerCount,
          matterCount,
          revenuePerFeeEarner,
        },
        additionalValues: {
          margin,
          revenue,
          labourCost,
          disbursementLeakage,
          overheadAllocation,
          feeEarnerCount,
          matterCount: matterCount,
          revenuePerFeeEarner,
        },
      };
    }

    return {
      formulaId: 'F-PR-03',
      formulaName: 'Department Profitability',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig', 'snippets'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};

// =============================================================================
// F-PR-04: Client Profitability
// =============================================================================

export const clientProfitability: FormulaImplementation = {
  formulaId: 'F-PR-04',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();

    for (const client of context.clients) {
      const entityId = resolveClientId(client);
      const entityName = resolveClientName(client);

      // Match matters by dynamic clientName / contactId field on matter
      const clientMatters = context.matters.filter((m) => {
        const mClientName = dynField<string>(m, 'clientName');
        const mClientId = dynField<string>(m, 'clientId');
        if (client.contactId && mClientId && client.contactId === mClientId) return true;
        if (client.clientName && mClientName && client.clientName === mClientName) return true;
        if (client.displayName && mClientName && client.displayName === mClientName) return true;
        return false;
      });

      // Revenue: use AggregatedClient.totalInvoiced as authoritative source
      const revenue = client.totalInvoiced;

      // Labour cost: sum per-earner costs from time entries on client matters
      const clientEntries = clientMatters.flatMap((m) => entriesForMatter(context, m));
      const groups = groupEntriesByEarner(clientEntries);
      const labourCost = computeLabourCost(context, groups);

      // Disbursement leakage across client matters
      const disbursementLeakage = clientMatters.reduce(
        (s, m) => s + matterDisbursementOutstanding(context, m),
        0,
      );

      if (revenue === 0 && labourCost === 0 && disbursementLeakage === 0) {
        const reason = 'No financial data';
        nullReasons.add(reason);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: {},
        };
        continue;
      }

      const totalCost = labourCost + disbursementLeakage;
      const profit = revenue - totalCost;
      const margin = revenue > 0 ? (profit / revenue) * 100 : null;
      const matterCount = clientMatters.length;
      const averageRevenuePerMatter = matterCount > 0 ? revenue / matterCount : null;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: profit,
        formattedValue: formatValue(profit, 'currency'),
        nullReason: null,
        breakdown: {
          revenue,
          labourCost,
          disbursementLeakage,
          totalCost,
          profit,
          margin,
          matterCount,
          averageRevenuePerMatter,
          lifetimeValue: revenue,
        },
        additionalValues: {
          margin,
          revenue,
          labourCost,
          disbursementLeakage,
          matterCount,
          averageRevenuePerMatter,
          lifetimeValue: revenue,
        },
      };
    }

    return {
      formulaId: 'F-PR-04',
      formulaName: 'Client Profitability',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig', 'snippets'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};

// =============================================================================
// F-PR-05: Firm Profitability
// =============================================================================

export const firmProfitability: FormulaImplementation = {
  formulaId: 'F-PR-05',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const warnings: string[] = [];

    // Revenue: prefer invoiced revenue; fall back to WIP if no invoices
    const totalRevenue =
      context.firm.totalInvoicedRevenue > 0
        ? context.firm.totalInvoicedRevenue
        : context.firm.totalWipValue;

    // Labour cost: loop all fee earners, branch on pay model
    let salariedLabourCost = 0;
    let feeShareCost = 0;

    for (const fe of context.feeEarners) {
      const entityId = resolveFeeEarnerId(fe);
      const payModel = getPayModel(fe, entityId, context.feeEarnerOverrides);

      if (payModel === 'FeeShare') {
        const override = context.feeEarnerOverrides[entityId];
        const config = getEffectiveConfig(fe, context.firmConfig, override);
        const feeSharePct = config.feeSharePercent;
        // Cost to firm = what the lawyer takes (the fee share percentage)
        feeShareCost += fe.invoicedRevenue * (feeSharePct / 100);
      } else {
        // Salaried (or unknown) — use SN-004 annual cost
        const annualCost = snippetVal(context, 'SN-004', entityId) ?? 0;
        if (annualCost === 0 && payModel !== null) {
          // Salaried earner with no SN-004 data — will undercount labour cost
          warnings.push(
            `${resolveFeeEarnerName(fe)}: SN-004 not available — employment cost excluded`,
          );
        }
        salariedLabourCost += annualCost;
      }
    }

    const totalLabourCost = salariedLabourCost + feeShareCost;

    // Disbursement leakage across all matters
    const totalDisbursementLeakage = context.disbursements.reduce(
      (s, d) => s + (d.firmExposure ?? numDyn(d, 'outstanding')),
      0,
    );

    // Overhead: firm-level from firmConfig dynamic field
    const totalOverhead = numDyn(context.firmConfig, 'overheadTotal');

    const firmProfit =
      totalRevenue - totalLabourCost - totalDisbursementLeakage - totalOverhead;
    const firmMargin = totalRevenue > 0 ? (firmProfit / totalRevenue) * 100 : null;

    const activeFeeEarnerCount = context.firm.activeFeeEarnerCount;
    const revenuePerFeeEarner =
      activeFeeEarnerCount > 0 ? totalRevenue / activeFeeEarnerCount : null;
    const profitPerFeeEarner =
      activeFeeEarnerCount > 0 ? firmProfit / activeFeeEarnerCount : null;

    const entityResults: Record<string, EntityFormulaResult> = {
      firm: {
        entityId: 'firm',
        entityName: 'Firm',
        value: firmProfit,
        formattedValue: formatValue(firmProfit, 'currency'),
        nullReason: null,
        breakdown: {
          totalRevenue,
          totalLabourCost,
          salariedLabourCost,
          feeShareCost,
          totalDisbursementLeakage,
          totalOverhead,
          firmProfit,
          firmMargin,
          revenuePerFeeEarner,
          profitPerFeeEarner,
        },
        additionalValues: {
          margin: firmMargin,
          totalRevenue,
          totalLabourCost,
          salariedLabourCost,
          feeShareCost,
          totalDisbursementLeakage,
          totalOverhead,
          revenuePerFeeEarner,
          profitPerFeeEarner,
        },
      },
    };

    return {
      formulaId: 'F-PR-05',
      formulaName: 'Firm Profitability',
      variantUsed: null,
      resultType: 'currency',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData', 'feeEarnerConfig', 'snippets'],
        nullReasons: [],
        warnings,
      },
    };
  },
};
