import { parseCSV } from './csv-parser.js';
import { parseJSON } from './json-parser.js';
import { parseExcel } from './excel-parser.js';
import type { ParseResult, ParserOptions } from './types.js';

export { parseCSV } from './csv-parser.js';
export { parseJSON } from './json-parser.js';
export { parseExcel } from './excel-parser.js';
export * from './types.js';

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Routes a File to the correct parser based on extension / MIME type.
 * Unknown extensions: attempt JSON first, then fall back to CSV.
 */
export async function parseFile(
  file: File,
  options?: ParserOptions
): Promise<ParseResult> {
  const ext = getExtension(file.name);
  const mime = file.type.toLowerCase();

  if (ext === 'csv' || mime === 'text/csv') {
    return parseCSV(file, options);
  }

  if (ext === 'json' || mime === 'application/json') {
    return parseJSON(file, options);
  }

  if (ext === 'xlsx' || ext === 'xls' || mime.includes('spreadsheetml')) {
    return parseExcel(file, options);
  }

  // Unknown extension: try JSON first
  const text = await file.text();
  try {
    JSON.parse(text);
    return parseJSON(file, options);
  } catch {
    return parseCSV(file, options);
  }
}
