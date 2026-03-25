/**
 * wip-leakage.ts — WIP & Leakage formula implementations
 *
 * F-WL-01: WIP Age              (matter-level + firm aggregate)
 * F-WL-02: Write-Off Analysis   (firm + fee-earner + matter levels)
 * F-WL-03: Disbursement Recovery (matter-level + firm aggregate)
 * F-WL-04: Lock-Up Days          (firm-level)
 *
 * Field name reality checks vs the prompt spec:
 *   - EnrichedTimeEntry uses billableValue + writeOffValue (not billable/writeOff)
 *   - AggregatedMatter.invoicedDisbursements (not disbursementTotal)
 *   - EnrichedInvoice.daysOutstanding already computed; outstanding via dynField
 *   - EnrichedDisbursement.firmExposure = outstanding amount
 */

import type { AggregatedMatter, AggregatedFeeEarner } from '../../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '../../../shared/types/enriched.js';
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

function resolveFeeEarnerId(entry: EnrichedTimeEntry): string {
  return entry.lawyerId ?? dynField<string>(entry, 'lawyerName') ?? 'unknown';
}

// =============================================================================
// Age band definitions
// =============================================================================

interface AgeBand {
  label: string;
  min: number;
  max: number;
  recoveryProbability: number;
}

const DEFAULT_AGE_BANDS: AgeBand[] = [
  { label: '0-30',   min: 0,   max: 30,       recoveryProbability: 0.95 },
  { label: '31-60',  min: 31,  max: 60,        recoveryProbability: 0.85 },
  { label: '61-90',  min: 61,  max: 90,        recoveryProbability: 0.70 },
  { label: '91-180', min: 91,  max: 180,       recoveryProbability: 0.50 },
  { label: '180+',   min: 181, max: Infinity,  recoveryProbability: 0.25 },
];

function classifyAge(ageInDays: number, bands: AgeBand[]): AgeBand {
  return bands.find((b) => ageInDays >= b.min && ageInDays <= b.max) ?? bands[bands.length - 1];
}

interface BandAccumulator {
  entryCount: number;
  totalValue: number;
}

/** Build age-band breakdown from a set of entries with valid ageInDays. */
function buildAgeBands(
  entries: EnrichedTimeEntry[],
  bands: AgeBand[],
): {
  ageBands: Array<{
    band: string;
    entryCount: number;
    totalValue: number;
    percentOfTotal: number;
    recoveryProbability: number;
  }>;
  theoreticalRecovery: number;
  atRiskAmount: number;
  totalValue: number;
} {
  const accumulators = new Map<string, BandAccumulator>();
  for (const b of bands) {
    accumulators.set(b.label, { entryCount: 0, totalValue: 0 });
  }

  for (const entry of entries) {
    if (entry.ageInDays == null) continue;
    const band = classifyAge(entry.ageInDays, bands);
    const acc = accumulators.get(band.label)!;
    acc.entryCount += 1;
    acc.totalValue += numDyn(entry, 'billableValue');
  }

  const totalValue = [...accumulators.values()].reduce((s, a) => s + a.totalValue, 0);

  let theoreticalRecovery = 0;
  const ageBands = bands.map((b) => {
    const acc = accumulators.get(b.label)!;
    const percentOfTotal = totalValue > 0 ? (acc.totalValue / totalValue) * 100 : 0;
    theoreticalRecovery += acc.totalValue * b.recoveryProbability;
    return {
      band: b.label,
      entryCount: acc.entryCount,
      totalValue: acc.totalValue,
      percentOfTotal,
      recoveryProbability: b.recoveryProbability,
    };
  });

  return {
    ageBands,
    theoreticalRecovery,
    atRiskAmount: totalValue - theoreticalRecovery,
    totalValue,
  };
}

// =============================================================================
// F-WL-01: WIP Age
// =============================================================================

export const wipAge: FormulaImplementation = {
  formulaId: 'F-WL-01',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'oldest_entry';
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();
    const bands = DEFAULT_AGE_BANDS;

    // Separate matched vs orphaned entries
    const matchedEntries = context.timeEntries.filter((e) => e.hasMatchedMatter);
    const orphanedEntries = context.timeEntries.filter((e) => !e.hasMatchedMatter);

    // Orphaned WIP totals
    const orphanedWipValue = orphanedEntries.reduce(
      (s, e) => s + numDyn(e, 'billableValue'),
      0,
    );
    const orphanedWipEntryCount = orphanedEntries.length;

    // --- Per-matter results ---
    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);

      const mEntries = matchedEntries.filter((e) => {
        if (matter.matterId && e.matterId) return e.matterId === matter.matterId;
        if (matter.matterNumber && e.matterNumber) return e.matterNumber === matter.matterNumber;
        return false;
      });

      const aged = mEntries.filter((e) => e.ageInDays != null);

      // Matter with no WIP at all: value = 0 (everything billed / nothing recorded)
      if (aged.length === 0 && matter.wipTotalBillable === 0) {
        entityResults[entityId] = {
          entityId,
          entityName,
          value: 0,
          formattedValue: '0 days',
          nullReason: null,
          breakdown: {
            ageBands: bands.map((b) => ({
              band: b.label,
              entryCount: 0,
              totalValue: 0,
              percentOfTotal: 0,
              recoveryProbability: b.recoveryProbability,
            })),
            theoreticalRecovery: 0,
            atRiskAmount: 0,
            orphanedWipValue: 0,
            orphanedWipEntryCount: 0,
          },
        };
        continue;
      }

      // Matter with WIP but no age data in context: use wipAgeInDays from aggregated data
      if (aged.length === 0 && matter.wipAgeInDays != null) {
        const wipValue = matter.wipTotalBillable;
        const band = classifyAge(matter.wipAgeInDays, bands);
        entityResults[entityId] = {
          entityId,
          entityName,
          value: matter.wipAgeInDays,
          formattedValue: `${Math.round(matter.wipAgeInDays)} days`,
          nullReason: null,
          breakdown: {
            ageBands: bands.map((b) => ({
              band: b.label,
              entryCount: b.label === band.label ? 1 : 0,
              totalValue: b.label === band.label ? wipValue : 0,
              percentOfTotal: b.label === band.label ? 100 : 0,
              recoveryProbability: b.recoveryProbability,
            })),
            theoreticalRecovery: wipValue * band.recoveryProbability,
            atRiskAmount: wipValue * (1 - band.recoveryProbability),
            orphanedWipValue: 0,
            orphanedWipEntryCount: 0,
          },
        };
        continue;
      }

      if (aged.length === 0) {
        if (matter.wipTotalBillable > 0) {
          const reason = 'No age data available for WIP entries';
          nullReasons.add(reason);
          entityResults[entityId] = {
            entityId,
            entityName,
            value: null,
            formattedValue: null,
            nullReason: reason,
            breakdown: {
              ageBands: [],
              theoreticalRecovery: null,
              atRiskAmount: null,
              orphanedWipValue: 0,
              orphanedWipEntryCount: 0,
            },
          };
        }
        continue;
      }

      // Compute age value per variant
      let ageValue: number;
      if (activeVariant === 'oldest_entry') {
        ageValue = Math.max(...aged.map((e) => e.ageInDays!));
      } else if (activeVariant === 'weighted_average') {
        const totalVal = aged.reduce((s, e) => s + numDyn(e, 'billableValue'), 0);
        if (totalVal === 0) {
          // Fall back to simple average when all entries have zero billable value
          ageValue = aged.reduce((s, e) => s + e.ageInDays!, 0) / aged.length;
        } else {
          ageValue =
            aged.reduce((s, e) => s + e.ageInDays! * numDyn(e, 'billableValue'), 0) / totalVal;
        }
      } else {
        // average_entry (default fallback)
        ageValue = aged.reduce((s, e) => s + e.ageInDays!, 0) / aged.length;
      }

      const { ageBands, theoreticalRecovery, atRiskAmount } = buildAgeBands(aged, bands);

      entityResults[entityId] = {
        entityId,
        entityName,
        value: ageValue,
        formattedValue: `${Math.round(ageValue)} days`,
        nullReason: null,
        breakdown: {
          ageBands,
          theoreticalRecovery,
          atRiskAmount,
          orphanedWipValue: 0,
          orphanedWipEntryCount: 0,
        },
      };
    }

    // --- Firm-level aggregate ---
    const allAged = matchedEntries.filter((e) => e.ageInDays != null);
    if (allAged.length > 0 || orphanedWipValue > 0) {
      let firmAge: number;
      if (activeVariant === 'oldest_entry') {
        firmAge =
          allAged.length > 0 ? Math.max(...allAged.map((e) => e.ageInDays!)) : 0;
      } else if (activeVariant === 'weighted_average') {
        const totalVal = allAged.reduce((s, e) => s + numDyn(e, 'billableValue'), 0);
        firmAge =
          totalVal > 0
            ? allAged.reduce((s, e) => s + e.ageInDays! * numDyn(e, 'billableValue'), 0) /
              totalVal
            : allAged.length > 0
              ? allAged.reduce((s, e) => s + e.ageInDays!, 0) / allAged.length
              : 0;
      } else {
        firmAge =
          allAged.length > 0
            ? allAged.reduce((s, e) => s + e.ageInDays!, 0) / allAged.length
            : 0;
      }

      const firmBands = buildAgeBands(allAged, bands);

      entityResults['firm'] = {
        entityId: 'firm',
        entityName: 'Firm',
        value: firmAge,
        formattedValue: `${Math.round(firmAge)} days`,
        nullReason: null,
        breakdown: {
          ageBands: firmBands.ageBands,
          theoreticalRecovery: firmBands.theoreticalRecovery,
          atRiskAmount: firmBands.atRiskAmount,
          orphanedWipValue,
          orphanedWipEntryCount,
        },
      };
    }

    return {
      formulaId: 'F-WL-01',
      formulaName: 'WIP Age',
      variantUsed: activeVariant,
      resultType: 'days',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};

// =============================================================================
// F-WL-02: Write-Off Analysis
// =============================================================================

export const writeOffAnalysis: FormulaImplementation = {
  formulaId: 'F-WL-02',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const nullReasons = new Set<string>();

    // Helper to compute write-off result from a set of entries
    function computeWriteOff(
      entityId: string,
      entityName: string,
      entries: EnrichedTimeEntry[],
    ): EntityFormulaResult {
      const totalRecordedValue = entries.reduce(
        (s, e) => s + numDyn(e, 'billableValue') + numDyn(e, 'writeOffValue'),
        0,
      );
      const totalWriteOff = entries.reduce(
        (s, e) => s + numDyn(e, 'writeOffValue'),
        0,
      );

      if (totalRecordedValue === 0) {
        const reason = 'No recorded value';
        nullReasons.add(reason);
        return {
          entityId,
          entityName,
          value: null,
          formattedValue: null,
          nullReason: reason,
          breakdown: { totalRecordedValue: 0, totalWriteOff: 0, totalBilledValue: 0 },
        };
      }

      const writeOffPct = (totalWriteOff / totalRecordedValue) * 100;

      // Grade breakdown if available
      const byGrade: Record<string, { amount: number; count: number }> = {};
      for (const e of entries) {
        const grade = e.lawyerGrade ?? 'unknown';
        const wo = numDyn(e, 'writeOffValue');
        if (wo > 0) {
          if (!byGrade[grade]) byGrade[grade] = { amount: 0, count: 0 };
          byGrade[grade].amount += wo;
          byGrade[grade].count += 1;
        }
      }
      const writeOffByGrade: Record<string, { amount: number; percent: number }> = {};
      for (const [grade, data] of Object.entries(byGrade)) {
        writeOffByGrade[grade] = {
          amount: data.amount,
          percent: totalWriteOff > 0 ? (data.amount / totalWriteOff) * 100 : 0,
        };
      }

      return {
        entityId,
        entityName,
        value: writeOffPct,
        formattedValue: formatValue(writeOffPct, 'percentage'),
        nullReason: null,
        breakdown: {
          totalRecordedValue,
          totalWriteOff,
          totalBilledValue: totalRecordedValue - totalWriteOff,
          ...(Object.keys(writeOffByGrade).length > 0 ? { writeOffByGrade } : {}),
        },
      };
    }

    // --- Firm level ---
    entityResults['firm'] = computeWriteOff('firm', 'Firm', context.timeEntries);

    // --- Per fee earner ---
    const byFeeEarner = new Map<string, { name: string; entries: EnrichedTimeEntry[] }>();
    for (const entry of context.timeEntries) {
      const id = resolveFeeEarnerId(entry);
      const name = dynField<string>(entry, 'lawyerName') ?? entry.lawyerId ?? id;
      if (!byFeeEarner.has(id)) byFeeEarner.set(id, { name, entries: [] });
      byFeeEarner.get(id)!.entries.push(entry);
    }
    for (const [id, { name, entries }] of byFeeEarner) {
      entityResults[id] = computeWriteOff(id, name, entries);
    }

    // --- Per matter ---
    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);
      const mEntries = context.timeEntries.filter((e) => {
        if (matter.matterId && e.matterId) return e.matterId === matter.matterId;
        if (matter.matterNumber && e.matterNumber) return e.matterNumber === matter.matterNumber;
        return false;
      });
      if (mEntries.length > 0) {
        entityResults[entityId] = computeWriteOff(entityId, entityName, mEntries);
      }
    }

    return {
      formulaId: 'F-WL-02',
      formulaName: 'Write-Off Analysis',
      variantUsed: null,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData'],
        nullReasons: Array.from(nullReasons),
        warnings: [],
      },
    };
  },
};

// =============================================================================
// F-WL-03: Disbursement Recovery
// =============================================================================

export const disbursementRecovery: FormulaImplementation = {
  formulaId: 'F-WL-03',

  execute(context: FormulaContext): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};

    // Group disbursement records by matterId / matterNumber for fast lookup
    const disbByMatter = new Map<string, EnrichedDisbursement[]>();
    for (const d of context.disbursements) {
      const mId = d.matterId ?? dynField<string>(d, 'matterNumber');
      if (mId) {
        if (!disbByMatter.has(mId)) disbByMatter.set(mId, []);
        disbByMatter.get(mId)!.push(d);
      }
    }

    let firmTotal = 0;
    let firmOutstanding = 0;

    for (const matter of context.matters) {
      const entityId = resolveMatterId(matter);
      const entityName = resolveMatterName(matter);

      // Try individual disbursement records first
      const disbRecords =
        disbByMatter.get(matter.matterId ?? '') ??
        disbByMatter.get(matter.matterNumber ?? '') ??
        [];

      let totalDisbursements: number;
      let outstandingDisbursements: number;

      if (disbRecords.length > 0) {
        // Prefer individual records: subtotal = amount, firmExposure = outstanding
        totalDisbursements = disbRecords.reduce((s, d) => s + numDyn(d, 'subtotal'), 0);
        outstandingDisbursements = disbRecords.reduce(
          (s, d) => s + (d.firmExposure ?? numDyn(d, 'outstanding')),
          0,
        );
      } else {
        // Fall back to aggregated matter data — invoicedDisbursements = total billed disbursements
        // Outstanding unknown → assume 0 (conservative, shows 100% recovery)
        totalDisbursements = matter.invoicedDisbursements;
        outstandingDisbursements = 0;
      }

      // Skip matters with no disbursements
      if (totalDisbursements === 0) continue;

      const recoveredDisbursements = totalDisbursements - outstandingDisbursements;
      const recoveryPct = (recoveredDisbursements / totalDisbursements) * 100;

      firmTotal += totalDisbursements;
      firmOutstanding += outstandingDisbursements;

      entityResults[entityId] = {
        entityId,
        entityName,
        value: recoveryPct,
        formattedValue: formatValue(recoveryPct, 'percentage'),
        nullReason: null,
        breakdown: {
          totalDisbursements,
          recoveredDisbursements,
          outstandingDisbursements,
          firmExposure: outstandingDisbursements,
        },
      };
    }

    // Firm-level aggregate
    if (firmTotal > 0) {
      const firmRecovered = firmTotal - firmOutstanding;
      const firmPct = (firmRecovered / firmTotal) * 100;
      entityResults['firm'] = {
        entityId: 'firm',
        entityName: 'Firm',
        value: firmPct,
        formattedValue: formatValue(firmPct, 'percentage'),
        nullReason: null,
        breakdown: {
          totalDisbursements: firmTotal,
          recoveredDisbursements: firmRecovered,
          outstandingDisbursements: firmOutstanding,
          firmExposure: firmOutstanding,
        },
      };
    }

    return {
      formulaId: 'F-WL-03',
      formulaName: 'Disbursement Recovery',
      variantUsed: null,
      resultType: 'percentage',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData'],
        nullReasons: [],
        warnings: [],
      },
    };
  },
};

// =============================================================================
// F-WL-04: Lock-Up Days
// =============================================================================

export const lockUpDays: FormulaImplementation = {
  formulaId: 'F-WL-04',

  execute(context: FormulaContext, variant?: string): FormulaResult {
    const startTime = Date.now();
    const activeVariant = variant ?? 'from_due_date';
    const warnings: string[] = [];

    // ---- WIP lock-up: average ageInDays of ALL matched time entries ----
    const agedEntries = context.timeEntries.filter(
      (e) => e.hasMatchedMatter && e.ageInDays != null,
    );
    const wipLockUpDays =
      agedEntries.length > 0
        ? agedEntries.reduce((s, e) => s + e.ageInDays!, 0) / agedEntries.length
        : 0;

    // ---- Debtor lock-up: average days outstanding on unpaid invoices ----
    const unpaidInvoices = context.invoices.filter(
      (inv) => numDyn(inv, 'outstanding') > 0,
    );
    const unpaidCount = unpaidInvoices.length;
    const totalOutstanding = unpaidInvoices.reduce(
      (s, inv) => s + numDyn(inv, 'outstanding'),
      0,
    );

    let debtorLockUpDays = 0;

    if (activeVariant === 'from_payment_date') {
      // Check if datePaid is available on any invoice
      const hasDatPaid = context.invoices.some(
        (inv) => dynField<unknown>(inv, 'datePaid') !== null,
      );
      if (!hasDatPaid) {
        warnings.push(
          'datePaid field not available — falling back to from_due_date variant for debtor days',
        );
        // Fall through to from_due_date logic
        debtorLockUpDays = computeDebtorDays(unpaidInvoices, 'daysOutstanding');
      } else {
        // For resolved invoices use actual payment days; unpaid use daysOutstanding
        debtorLockUpDays = computeDebtorDays(unpaidInvoices, 'daysOutstanding');
      }
    } else if (activeVariant === 'from_invoice_date') {
      // daysOutstanding computed from invoice date in the pipeline
      // We fall back to the same field since daysOutstanding is from due date
      // For from_invoice_date, use dynamic 'daysFromInvoiceDate' if available,
      // otherwise compute from invoiceDate field
      debtorLockUpDays = computeDebtorDaysFromDate(
        unpaidInvoices,
        context.referenceDate,
        'invoiceDate',
      );
    } else {
      // from_due_date (default) — use daysOutstanding which is aged from due date
      debtorLockUpDays = computeDebtorDays(unpaidInvoices, 'daysOutstanding');
    }

    const totalLockUpDays = wipLockUpDays + debtorLockUpDays;

    const entityResults: Record<string, EntityFormulaResult> = {
      firm: {
        entityId: 'firm',
        entityName: 'Firm',
        value: totalLockUpDays,
        formattedValue: `${Math.round(totalLockUpDays)} days`,
        nullReason: null,
        breakdown: {
          wipLockUpDays,
          debtorLockUpDays,
          totalLockUpDays,
          unpaidInvoiceCount: unpaidCount,
          totalOutstanding,
        },
      },
    };

    return {
      formulaId: 'F-WL-04',
      formulaName: 'Lock-Up Days',
      variantUsed: activeVariant,
      resultType: 'days',
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: now(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: ['wipData', 'invoiceData'],
        nullReasons: [],
        warnings,
      },
    };
  },
};

function computeDebtorDays(invoices: EnrichedInvoice[], field: string): number {
  const withData = invoices.filter((inv) => {
    const v = dynField<number>(inv, field);
    return v !== null && v > 0;
  });
  if (withData.length === 0) return 0;
  return withData.reduce((s, inv) => s + (dynField<number>(inv, field) ?? 0), 0) / withData.length;
}

function computeDebtorDaysFromDate(
  invoices: EnrichedInvoice[],
  referenceDate: Date,
  dateField: string,
): number {
  const refMs = referenceDate.getTime();
  const days: number[] = [];
  for (const inv of invoices) {
    const raw = dynField<unknown>(inv, dateField);
    if (!raw) continue;
    const d = raw instanceof Date ? raw : new Date(String(raw));
    if (isNaN(d.getTime())) continue;
    const diff = Math.max(0, Math.floor((refMs - d.getTime()) / 86_400_000));
    days.push(diff);
  }
  if (days.length === 0) return 0;
  return days.reduce((a, b) => a + b, 0) / days.length;
}
