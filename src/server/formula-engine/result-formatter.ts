/**
 * result-formatter.ts — Value formatting and statistical summaries
 *
 * Pure utility functions used by formula implementations and the engine.
 * No side effects, no imports from other engine modules.
 */

import type { EntityFormulaResult, FormulaResultType, ResultSummary } from './types.js';

// =============================================================================
// Value Formatter
// =============================================================================

/**
 * Format a numeric value according to its result type.
 *
 * Returns null when value is null — callers should never attempt to format
 * a null value themselves.
 *
 * @param value         The numeric value to format (or null).
 * @param resultType    How the value should be interpreted.
 * @param currencySymbol  Override the default £ symbol (default: '£').
 */
export function formatValue(
  value: number | null,
  resultType: FormulaResultType,
  currencySymbol = '£',
): string | null {
  if (value === null) return null;

  switch (resultType) {
    case 'currency':
      return `${currencySymbol}${value.toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    case 'percentage':
      return `${value.toFixed(1)}%`;

    case 'hours':
      return `${value.toFixed(1)} hrs`;

    case 'days':
      return `${Math.round(value)} days`;

    case 'number':
      return value.toLocaleString('en-GB', { maximumFractionDigits: 0 });

    case 'ratio':
      return `${value.toFixed(2)}x`;

    case 'boolean':
      return value !== 0 ? 'Yes' : 'No';

    default: {
      // Exhaustiveness guard — TypeScript should prevent reaching here
      const _exhaustive: never = resultType;
      return String(_exhaustive);
    }
  }
}

// =============================================================================
// Statistical Summary
// =============================================================================

/**
 * Compute statistical summary from a map of entity results.
 *
 * Null values are excluded from all statistical calculations (mean, median,
 * min, max, total) but counted separately in nullCount.
 * count = total entity count (including nulls).
 */
export function summariseResults(
  entityResults: Record<string, EntityFormulaResult>,
): ResultSummary {
  const allResults = Object.values(entityResults);
  const count = allResults.length;
  const nullCount = allResults.filter((r) => r.value === null).length;

  const values = allResults
    .map((r) => r.value)
    .filter((v): v is number => v !== null);

  if (values.length === 0) {
    return { mean: null, median: null, min: null, max: null, total: null, count, nullCount };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((acc, v) => acc + v, 0);
  const mean = total / values.length;

  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

  return {
    mean,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    total,
    count,
    nullCount,
  };
}
