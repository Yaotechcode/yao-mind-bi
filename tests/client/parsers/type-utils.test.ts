import { describe, it, expect } from 'vitest';
import { detectColumnType, coerceValue, parseCurrencyValue } from '../../../src/client/parsers/type-utils.js';
import type { ParseError } from '../../../src/client/parsers/types.js';

describe('detectColumnType', () => {
  it('returns number for a column of all numeric values', () => {
    const values = ['100', '200', '350', '0', '1500'];
    expect(detectColumnType(values)).toBe('number');
  });

  it('returns number when 90%+ are numeric (10% strings)', () => {
    // 9 numbers, 1 string → 90% numeric
    const values = ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'N/A'];
    expect(detectColumnType(values)).toBe('number');
  });

  it('returns date for UK date strings (dd/MM/yyyy)', () => {
    const values = ['01/03/2024', '15/06/2023', '31/12/2022', '07/01/2025'];
    expect(detectColumnType(values)).toBe('date');
  });

  it('returns currency for values containing a currency symbol', () => {
    const values = ['£1,234.56', '£500.00', '£12,000.00', '£0.99'];
    expect(detectColumnType(values)).toBe('currency');
  });

  it('returns string when fewer than 90% match any type', () => {
    const values = ['100', '200', 'foo', 'bar', 'baz', 'qux', '300', 'abc', 'def', 'ghi'];
    expect(detectColumnType(values)).toBe('string');
  });

  it('returns number (not boolean) for a single-value column of "1"', () => {
    expect(detectColumnType(['1'])).toBe('number');
  });

  it('returns number (not boolean) for a column of only 0s and 1s', () => {
    const values = ['0', '1', '0', '1', '1', '0'];
    expect(detectColumnType(values)).toBe('number');
  });

  it('returns boolean for strict true/false values', () => {
    expect(detectColumnType(['true', 'false', 'true', 'false'])).toBe('boolean');
  });

  it('returns boolean for yes/no values', () => {
    expect(detectColumnType(['yes', 'no', 'yes', 'yes', 'no'])).toBe('boolean');
  });
});

describe('coerceValue', () => {
  it('parses a currency string to the correct float', () => {
    expect(coerceValue('£1,234.56', 'currency')).toBe(1234.56);
  });

  it('returns null and logs a warning for an invalid date', () => {
    const errors: ParseError[] = [];
    const result = coerceValue('not-a-date', 'date', undefined, errors);
    expect(result).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].severity).toBe('warning');
  });

  it('parses a boolean string to true', () => {
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('yes', 'boolean')).toBe(true);
    expect(coerceValue('1', 'boolean')).toBe(true);
  });

  it('parses a boolean string to false', () => {
    expect(coerceValue('false', 'boolean')).toBe(false);
    expect(coerceValue('no', 'boolean')).toBe(false);
    expect(coerceValue('0', 'boolean')).toBe(false);
  });

  it('trims and nullifies empty strings by default', () => {
    expect(coerceValue('  ', 'string')).toBeNull();
    expect(coerceValue('hello', 'string')).toBe('hello');
  });
});

describe('parseCurrencyValue', () => {
  it('strips £ and commas and parses to float', () => {
    expect(parseCurrencyValue('£1,234.56')).toBe(1234.56);
  });

  it('strips $ symbol', () => {
    expect(parseCurrencyValue('$500.00')).toBe(500);
  });

  it('returns null for non-numeric input', () => {
    expect(parseCurrencyValue('N/A')).toBeNull();
  });

  it('handles plain numbers with no symbol', () => {
    expect(parseCurrencyValue('999.99')).toBe(999.99);
  });
});
