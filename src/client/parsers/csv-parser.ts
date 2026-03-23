import Papa from 'papaparse';
import { detectColumnType, coerceValue } from './type-utils.js';
import type { ParseResult, ColumnInfo, ParseError, ParserOptions } from './types.js';

const UTF8_BOM = '\ufeff';

function stripBOM(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

function buildColumnInfo(
  header: string,
  allRows: Record<string, string>[],
  options?: ParserOptions
): ColumnInfo {
  const rawValues = allRows.map(r => r[header] ?? '');
  const nonEmpty = rawValues.filter(v => v.trim() !== '');
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

  const nullCount = rawValues.filter(v => v.trim() === '').length;
  return {
    originalHeader: header,
    detectedType,
    sampleValues,
    nullCount,
    totalCount: rawValues.length,
    nullPercent: rawValues.length === 0 ? 0 : (nullCount / rawValues.length) * 100,
  };
}

export async function parseCSV(
  file: File,
  options?: ParserOptions
): Promise<ParseResult> {
  const maxPreview = options?.maxPreviewRows ?? 10;
  const parseErrors: ParseError[] = [];

  const rawText = await file.text();
  const text = stripBOM(rawText);

  // First pass: keep all rows (including empty) to count what gets skipped
  const allLines = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: false,
    transformHeader: (h: string) => h.trim(),
  });
  const totalBeforeFilter = allLines.data.length;

  // Second pass: skip empty and all-blank rows
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h: string) => h.trim(),
  });

  // Collect PapaParse errors
  for (const err of parsed.errors) {
    parseErrors.push({
      row: err.row,
      message: err.message,
      severity: 'warning',
    });
  }

  const rawRows = parsed.data as Record<string, string>[];

  const skippedEmpty = totalBeforeFilter - rawRows.length;
  if (skippedEmpty > 0) {
    parseErrors.push({
      message: `Skipped ${skippedEmpty} empty row(s)`,
      severity: 'warning',
    });
  }

  const headers = parsed.meta.fields ?? [];

  const columns: ColumnInfo[] = headers.map(h =>
    buildColumnInfo(h, rawRows, options)
  );

  const typeMap = Object.fromEntries(columns.map(c => [c.originalHeader, c.detectedType]));

  const coerceRow = (raw: Record<string, string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const h of headers) {
      const val = raw[h] ?? '';
      out[h] = coerceValue(val, typeMap[h] ?? 'string', options, parseErrors);
    }
    return out;
  };

  const fullRows = rawRows.map(coerceRow);
  const previewRows = fullRows.slice(0, maxPreview);

  return {
    fileType: 'csv',
    originalFilename: file.name,
    rowCount: fullRows.length,
    columns,
    previewRows,
    fullRows,
    parseErrors,
    parsedAt: new Date().toISOString(),
    detectedEncoding: rawText.startsWith(UTF8_BOM) ? 'UTF-8 BOM' : 'UTF-8',
  };
}
