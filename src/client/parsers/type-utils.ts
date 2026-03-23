import { parse, isValid } from 'date-fns';
import type { ParseError, ParserOptions } from './types.js';

const DEFAULT_CURRENCY_SYMBOLS = ['£', '$', '€', ','];

const BOOLEAN_VALUES = new Set([
  'true', 'false', 'yes', 'no',
  'TRUE', 'FALSE', 'YES', 'NO',
]);

export const DEFAULT_DATE_FORMATS = [
  'dd/MM/yyyy',
  'dd-MM-yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
  'dd/MM/yyyy HH:mm:ss',
  "yyyy-MM-dd'T'HH:mm:ssxxx",
  'dd MMM yyyy',
  'MMM dd yyyy',
];

const REFERENCE_DATE = new Date(2000, 0, 1);

export function parseCurrencyValue(
  value: string,
  symbols: string[] = DEFAULT_CURRENCY_SYMBOLS
): number | null {
  let stripped = value;
  for (const sym of symbols) {
    stripped = stripped.split(sym).join('');
  }
  stripped = stripped.trim();
  const num = parseFloat(stripped);
  return isNaN(num) ? null : num;
}

function hasCurrencySymbol(value: string, symbols: string[] = DEFAULT_CURRENCY_SYMBOLS): boolean {
  // Only treat £, $, € as currency indicators (not comma which is a number separator)
  const currencyIndicators = symbols.filter(s => s !== ',');
  return currencyIndicators.some(s => value.includes(s));
}

function isNumericString(value: string, symbols: string[] = DEFAULT_CURRENCY_SYMBOLS): boolean {
  const stripped = symbols.reduce((s, sym) => s.split(sym).join(''), value).trim();
  return stripped !== '' && !isNaN(parseFloat(stripped)) && isFinite(Number(stripped));
}

function isDateString(value: string, formats: string[] = DEFAULT_DATE_FORMATS): boolean {
  for (const fmt of formats) {
    const parsed = parse(value.trim(), fmt, REFERENCE_DATE);
    if (isValid(parsed)) return true;
  }
  return false;
}

function isBooleanString(value: string): boolean {
  return BOOLEAN_VALUES.has(value.trim());
}

/**
 * Given a sample of non-null string values, returns the most likely column type.
 * If 90%+ of values match a type, that type is returned. Otherwise 'string'.
 */
export function detectColumnType(
  values: string[],
  options?: Pick<ParserOptions, 'currencySymbols' | 'dateFormats'>
): 'string' | 'number' | 'currency' | 'date' | 'boolean' {
  const nonEmpty = values.filter(v => v !== null && v !== undefined && v.trim() !== '');
  if (nonEmpty.length === 0) return 'string';

  const threshold = 0.9;
  const total = nonEmpty.length;
  const symbols = options?.currencySymbols ?? DEFAULT_CURRENCY_SYMBOLS;
  const dateFormats = options?.dateFormats ?? DEFAULT_DATE_FORMATS;

  const countMatching = (predicate: (v: string) => boolean) =>
    nonEmpty.filter(predicate).length;

  // Boolean: ALL values must be in the boolean set (strict)
  if (countMatching(isBooleanString) / total >= threshold) return 'boolean';

  // Currency: has symbol AND is numeric
  if (countMatching(v => hasCurrencySymbol(v, symbols) && isNumericString(v, symbols)) / total >= threshold)
    return 'currency';

  // Number: numeric after stripping
  if (countMatching(v => isNumericString(v, symbols)) / total >= threshold) return 'number';

  // Date
  if (countMatching(v => isDateString(v, dateFormats)) / total >= threshold) return 'date';

  return 'string';
}

/**
 * Converts a raw string value to the detected type.
 * Optionally pushes a ParseError to the errors array on failure.
 */
export function coerceValue(
  value: string,
  type: string,
  options?: ParserOptions,
  errors?: ParseError[]
): unknown {
  const trimStrings = options?.trimStrings ?? true;
  const emptyAsNull = options?.emptyStringAsNull ?? true;
  const symbols = options?.currencySymbols ?? DEFAULT_CURRENCY_SYMBOLS;
  const dateFormats = options?.dateFormats ?? DEFAULT_DATE_FORMATS;

  const trimmed = trimStrings ? value.trim() : value;

  if (emptyAsNull && trimmed === '') return null;

  switch (type) {
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      return lower === 'true' || lower === 'yes' || lower === '1';
    }

    case 'currency':
    case 'number': {
      const num = parseCurrencyValue(trimmed, symbols);
      if (num === null && errors) {
        errors.push({
          message: `Cannot parse "${trimmed}" as ${type}`,
          severity: 'warning',
          rawValue: value,
        });
      }
      return num;
    }

    case 'date': {
      for (const fmt of dateFormats) {
        const parsed = parse(trimmed, fmt, REFERENCE_DATE);
        if (isValid(parsed)) return parsed.toISOString();
      }
      if (errors) {
        errors.push({
          message: `Cannot parse "${trimmed}" as date (tried ${dateFormats.length} formats)`,
          severity: 'warning',
          rawValue: value,
        });
      }
      return null;
    }

    case 'string':
    default:
      return trimmed === '' && emptyAsNull ? null : trimmed;
  }
}
