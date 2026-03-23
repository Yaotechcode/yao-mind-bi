import { detectColumnType, coerceValue } from './type-utils.js';
import type { ParseResult, ColumnInfo, ParseError, ParserOptions } from './types.js';

function flattenOne(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      out[key] = JSON.stringify(value);
    } else if (value !== null && typeof value === 'object') {
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(subVal)) {
          out[`${key}.${subKey}`] = JSON.stringify(subVal);
        } else if (subVal !== null && typeof subVal === 'object') {
          out[`${key}.${subKey}`] = JSON.stringify(subVal);
        } else {
          out[`${key}.${subKey}`] = subVal;
        }
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function extractRowArray(parsed: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];

  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // Shape B: { data: [...] }
    if (Array.isArray(obj['data'])) return obj['data'] as Record<string, unknown>[];

    // Shape C: find the largest array property at top level
    let best: Record<string, unknown>[] | null = null;
    for (const val of Object.values(obj)) {
      if (Array.isArray(val) && (best === null || val.length > best.length)) {
        best = val as Record<string, unknown>[];
      }
    }
    return best;
  }

  return null;
}

function buildColumnInfo(
  header: string,
  allRows: Record<string, unknown>[],
  options?: ParserOptions
): ColumnInfo {
  const rawValues = allRows.map(r => String(r[header] ?? ''));
  const nonEmpty = rawValues.filter(v => v.trim() !== '' && v !== 'null' && v !== 'undefined');
  const detectedType = detectColumnType(nonEmpty, {
    currencySymbols: options?.currencySymbols,
    dateFormats: options?.dateFormats,
  });

  const seen = new Set<string>();
  const sampleValues: string[] = [];
  for (const v of nonEmpty) {
    if (!seen.has(v) && sampleValues.length < 5) {
      seen.add(v);
      sampleValues.push(v);
    }
  }

  const nullCount = rawValues.filter(v => v.trim() === '' || v === 'null' || v === 'undefined').length;
  return {
    originalHeader: header,
    detectedType,
    sampleValues,
    nullCount,
    totalCount: rawValues.length,
    nullPercent: rawValues.length === 0 ? 0 : (nullCount / rawValues.length) * 100,
  };
}

export async function parseJSON(
  file: File,
  options?: ParserOptions
): Promise<ParseResult> {
  const maxPreview = options?.maxPreviewRows ?? 10;
  const parseErrors: ParseError[] = [];

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    return {
      fileType: 'json',
      originalFilename: file.name,
      rowCount: 0,
      columns: [],
      previewRows: [],
      fullRows: [],
      parseErrors: [{ message: `Failed to read file: ${String(err)}`, severity: 'error' }],
      parsedAt: new Date().toISOString(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      fileType: 'json',
      originalFilename: file.name,
      rowCount: 0,
      columns: [],
      previewRows: [],
      fullRows: [],
      parseErrors: [{ message: `Invalid JSON: ${String(err)}`, severity: 'error' }],
      parsedAt: new Date().toISOString(),
    };
  }

  const rawRows = extractRowArray(parsed);
  if (!rawRows || rawRows.length === 0) {
    return {
      fileType: 'json',
      originalFilename: file.name,
      rowCount: 0,
      columns: [],
      previewRows: [],
      fullRows: [],
      parseErrors: [{ message: 'No row array found in JSON structure', severity: 'error' }],
      parsedAt: new Date().toISOString(),
    };
  }

  // Flatten one level and serialise arrays
  const flatRows = rawRows.map(r =>
    typeof r === 'object' && r !== null ? flattenOne(r) : {}
  );

  // Collect all headers from all rows (union)
  const headerSet = new Set<string>();
  for (const row of flatRows) {
    for (const key of Object.keys(row)) {
      headerSet.add(key);
    }
  }
  const headers = Array.from(headerSet);

  const columns: ColumnInfo[] = headers.map(h => buildColumnInfo(h, flatRows, options));
  const typeMap = Object.fromEntries(columns.map(c => [c.originalHeader, c.detectedType]));

  const coerceRow = (flat: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const h of headers) {
      const raw = flat[h];
      // Already-serialised arrays or nested objects stay as strings
      if (typeof raw === 'string') {
        out[h] = coerceValue(raw, typeMap[h] ?? 'string', options, parseErrors);
      } else if (raw === null || raw === undefined) {
        out[h] = null;
      } else {
        // number, boolean already typed from JSON — preserve as-is unless type mismatch
        out[h] = raw;
      }
    }
    return out;
  };

  const fullRows = flatRows.map(coerceRow);
  const previewRows = fullRows.slice(0, maxPreview);

  return {
    fileType: 'json',
    originalFilename: file.name,
    rowCount: fullRows.length,
    columns,
    previewRows,
    fullRows,
    parseErrors,
    parsedAt: new Date().toISOString(),
  };
}
