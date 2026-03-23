import { detectColumnType, coerceValue } from './type-utils.js';
import type { ParseResult, ColumnInfo, ParseError, ParserOptions } from './types.js';

export async function parseExcel(
  file: File,
  options?: ParserOptions
): Promise<ParseResult> {
  const maxPreview = options?.maxPreviewRows ?? 10;
  const parseErrors: ParseError[] = [];

  // xlsx is an optional peer dependency (available via CDN in browser / npm install xlsx in server)
  interface XlsxWorkbook {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  }
  interface XlsxModule {
    read: (data: ArrayBuffer, opts: { type: string }) => XlsxWorkbook;
    utils: {
      sheet_to_json: (sheet: unknown, opts?: { defval?: unknown }) => unknown[];
    };
  }

  let XLSX: XlsxModule;
  try {
    // Use indirect import so TypeScript doesn't require xlsx to be installed at build time
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    XLSX = (await dynamicImport('xlsx')) as XlsxModule;
  } catch {
    throw new Error(
      'xlsx package is required for Excel parsing. Install with: npm install xlsx'
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    return {
      fileType: 'excel',
      originalFilename: file.name,
      rowCount: 0,
      columns: [],
      previewRows: [],
      fullRows: [],
      parseErrors: [{ message: `Failed to read file: ${String(err)}`, severity: 'error' }],
      parsedAt: new Date().toISOString(),
    };
  }

  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' }) as Record<string, unknown>[];

  if (rawRows.length === 0) {
    return {
      fileType: 'excel',
      originalFilename: file.name,
      rowCount: 0,
      columns: [],
      previewRows: [],
      fullRows: [],
      parseErrors: [{ message: 'No rows found in Excel sheet', severity: 'warning' }],
      parsedAt: new Date().toISOString(),
    };
  }

  const headerSet = new Set<string>();
  for (const row of rawRows) {
    for (const key of Object.keys(row)) headerSet.add(key);
  }
  const headers = Array.from(headerSet);

  const columns: ColumnInfo[] = headers.map(h => {
    const rawValues = rawRows.map(r => String(r[h] ?? ''));
    const nonEmpty = rawValues.filter(v => v.trim() !== '');
    const detectedType = detectColumnType(nonEmpty, {
      currencySymbols: options?.currencySymbols,
      dateFormats: options?.dateFormats,
    });
    const seen = new Set<string>();
    const sampleValues: string[] = [];
    for (const v of nonEmpty) {
      if (!seen.has(v) && sampleValues.length < 5) { seen.add(v); sampleValues.push(v); }
    }
    const nullCount = rawValues.filter(v => v.trim() === '').length;
    return {
      originalHeader: h,
      detectedType,
      sampleValues,
      nullCount,
      totalCount: rawValues.length,
      nullPercent: rawValues.length === 0 ? 0 : (nullCount / rawValues.length) * 100,
    };
  });

  const typeMap = Object.fromEntries(columns.map(c => [c.originalHeader, c.detectedType]));

  const fullRows: Record<string, unknown>[] = rawRows.map(raw => {
    const out: Record<string, unknown> = {};
    for (const h of headers) {
      out[h] = coerceValue(String(raw[h] ?? ''), typeMap[h] ?? 'string', options, parseErrors);
    }
    return out;
  });

  return {
    fileType: 'excel',
    originalFilename: file.name,
    rowCount: fullRows.length,
    columns,
    previewRows: fullRows.slice(0, maxPreview),
    fullRows,
    parseErrors,
    parsedAt: new Date().toISOString(),
  };
}
