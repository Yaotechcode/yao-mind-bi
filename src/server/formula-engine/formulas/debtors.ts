/**
 * debtors.ts — Debtor formula implementations
 *
 * F-DM-01: Aged Debtor Analysis
 *
 * Aggregates unpaid invoices (outstanding > 0) into age bands, computes
 * weighted average debtor days at client and firm level.
 *
 * EnrichedInvoice.daysOutstanding is pre-computed by the pipeline enricher.
 * EnrichedInvoice.ageBand uses: '0-30'|'31-60'|'61-90'|'91-120'|'120+'
 * This formula defines its own bands matching the prompt spec.
 */

import type { EnrichedInvoice } from '../../../shared/types/enriched.js';
import type {
  FormulaContext,
  FormulaResult,
  FormulaImplementation,
  EntityFormulaResult,
} from '../types.js';
import { summariseResults } from '../result-formatter.js';

// =============================================================================
// Helpers
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

/** Outstanding amount on an invoice. */
function invoiceOutstanding(inv: EnrichedInvoice): number {
  return numDyn(inv, 'outstanding');
}

// Age band labels used by this formula (aligned with prompt spec)
const BANDS = ['current', '31-60', '61-90', '91-180', '180+'] as const;
type BandLabel = (typeof BANDS)[number];

function classifyDays(days: number): BandLabel {
  if (days <= 30)  return 'current';
  if (days <= 60)  return '31-60';
  if (days <= 90)  return '61-90';
  if (days <= 180) return '91-180';
  return '180+';
}

interface BandAcc {
  invoiceCount: number;
  totalValue: number;
}

function emptyBands(): Record<BandLabel, BandAcc> {
  return {
    current: { invoiceCount: 0, totalValue: 0 },
    '31-60': { invoiceCount: 0, totalValue: 0 },
    '61-90': { invoiceCount: 0, totalValue: 0 },
    '91-180': { invoiceCount: 0, totalValue: 0 },
    '180+': { invoiceCount: 0, totalValue: 0 },
  };
}

function bandResultList(
  bands: Record<BandLabel, BandAcc>,
  totalOutstanding: number,
): Array<{ band: string; invoiceCount: number; totalValue: number; percentOfTotal: number }> {
  return BANDS.map((label) => ({
    band: label,
    invoiceCount: bands[label].invoiceCount,
    totalValue: bands[label].totalValue,
    percentOfTotal: totalOutstanding > 0 ? (bands[label].totalValue / totalOutstanding) * 100 : 0,
  }));
}

function weightedAvgAge(invoices: Array<{ days: number; outstanding: number }>): number {
  const totalVal = invoices.reduce((s, i) => s + i.outstanding, 0);
  if (totalVal === 0) return 0;
  return invoices.reduce((s, i) => s + i.days * i.outstanding, 0) / totalVal;
}

// =============================================================================
// F-DM-01: Aged Debtor Analysis
// =============================================================================

export const agedDebtorAnalysis: FormulaImplementation = {
  formulaId: 'F-DM-01',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};

    // --- Identify unpaid invoices ---
    const unpaid = context.invoices.filter((inv) => invoiceOutstanding(inv) > 0);

    if (unpaid.length === 0) {
      entityResults['firm'] = {
        entityId: 'firm',
        entityName: 'Firm',
        value: 0,
        formattedValue: '0 days',
        nullReason: null,
        breakdown: {
          ageBands: bandResultList(emptyBands(), 0),
          totalOutstanding: 0,
          weightedAverageAge: 0,
          longestOutstanding: 0,
          topDebtors: [],
        },
      };
      return {
        formulaId: 'F-DM-01',
        formulaName: 'Aged Debtor Analysis',
        variantUsed: null,
        resultType: 'days',
        entityResults,
        summary: summariseResults(entityResults),
        computedAt: now(),
        metadata: {
          executionTimeMs: Date.now() - startTime,
          inputsUsed: ['invoiceData'],
          nullReasons: [],
          warnings: [],
        },
      };
    }

    // --- Group by client ---
    const clientMap = new Map<
      string,
      { name: string; invoices: Array<{ days: number; outstanding: number }> }
    >();

    const allDaysPairs: Array<{ days: number; outstanding: number }> = [];
    let firmBands = emptyBands();
    let firmTotal = 0;
    let longestOutstanding = 0;

    for (const inv of unpaid) {
      const outstanding = invoiceOutstanding(inv);
      const days = inv.daysOutstanding ?? 0;
      const band = classifyDays(days);

      firmBands[band].invoiceCount += 1;
      firmBands[band].totalValue += outstanding;
      firmTotal += outstanding;
      allDaysPairs.push({ days, outstanding });
      if (days > longestOutstanding) longestOutstanding = days;

      // Client grouping
      const clientName =
        inv.clientName ??
        dynField<string>(inv, 'clientName') ??
        dynField<string>(inv, 'contactId') ??
        'Unknown Client';

      if (!clientMap.has(clientName)) {
        clientMap.set(clientName, { name: clientName, invoices: [] });
      }
      clientMap.get(clientName)!.invoices.push({ days, outstanding });
    }

    const firmWtAvg = weightedAvgAge(allDaysPairs);

    // --- Per-client entity results ---
    const clientOutstandings: Array<{ name: string; outstanding: number }> = [];

    for (const [clientId, data] of clientMap) {
      const clientTotal = data.invoices.reduce((s, i) => s + i.outstanding, 0);
      const clientWtAvg = weightedAvgAge(data.invoices);
      const clientBands = emptyBands();
      for (const inv of data.invoices) {
        const b = classifyDays(inv.days);
        clientBands[b].invoiceCount += 1;
        clientBands[b].totalValue += inv.outstanding;
      }

      clientOutstandings.push({ name: clientId, outstanding: clientTotal });

      entityResults[clientId] = {
        entityId: clientId,
        entityName: data.name,
        value: clientWtAvg,
        formattedValue: `${Math.round(clientWtAvg)} days`,
        nullReason: null,
        breakdown: {
          ageBands: bandResultList(clientBands, clientTotal),
          totalOutstanding: clientTotal,
          weightedAverageAge: clientWtAvg,
          invoiceCount: data.invoices.length,
        },
      };
    }

    // Top 5 debtors by outstanding amount
    const topDebtors = clientOutstandings
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 5)
      .map((c) => ({ clientName: c.name, outstanding: c.outstanding }));

    // --- Firm-level result ---
    entityResults['firm'] = {
      entityId: 'firm',
      entityName: 'Firm',
      value: firmWtAvg,
      formattedValue: `${Math.round(firmWtAvg)} days`,
      nullReason: null,
      breakdown: {
        ageBands: bandResultList(firmBands, firmTotal),
        totalOutstanding: firmTotal,
        weightedAverageAge: firmWtAvg,
        longestOutstanding,
        topDebtors,
      },
    };

    return {
      formulaId: 'F-DM-01',
      formulaName: 'Aged Debtor Analysis',
      variantUsed: null,
      resultType: 'days',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['invoiceData'],
        nullReasons: [],
        warnings: [],
      },
    };
  },
};
