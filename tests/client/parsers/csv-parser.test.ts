import { describe, it, expect } from 'vitest';
import { parseCSV } from '../../../src/client/parsers/csv-parser.js';

function makeFile(content: string, filename = 'test.csv'): File {
  return new File([content], filename, { type: 'text/csv' });
}

function makeBomFile(content: string, filename = 'test.csv'): File {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  return new File([bom, content], filename, { type: 'text/csv' });
}

describe('parseCSV', () => {
  it('detects correct ColumnInfo for a fee earner CSV with known columns', async () => {
    const csv = [
      'Name,Rate,Start Date,Is Partner',
      'Jane Smith,150,01/03/2023,yes',
      'John Doe,200,15/06/2022,no',
    ].join('\n');

    const result = await parseCSV(makeFile(csv));

    expect(result.rowCount).toBe(2);
    const nameCol = result.columns.find(c => c.originalHeader === 'Name');
    const rateCol = result.columns.find(c => c.originalHeader === 'Rate');
    const dateCol = result.columns.find(c => c.originalHeader === 'Start Date');
    const boolCol = result.columns.find(c => c.originalHeader === 'Is Partner');

    expect(nameCol?.detectedType).toBe('string');
    expect(rateCol?.detectedType).toBe('number');
    expect(dateCol?.detectedType).toBe('date');
    expect(boolCol?.detectedType).toBe('boolean');
  });

  it('handles currency values (£1,234.56) — detected as currency, value is float', async () => {
    // Real Metabase exports quote currency values that contain commas
    const csv = [
      'Matter Number,Net Billing',
      'M001,"£1,234.56"',
      'M002,£500.00',
      'M003,"£12,000.00"',
    ].join('\n');

    const result = await parseCSV(makeFile(csv));

    const billingCol = result.columns.find(c => c.originalHeader === 'Net Billing');
    expect(billingCol?.detectedType).toBe('currency');

    const firstRow = result.fullRows[0];
    expect(firstRow['Net Billing']).toBe(1234.56);
  });

  it('skips empty rows and logs a ParseError warning', async () => {
    const csv = [
      'Name,Rate',
      'Jane,150',
      ',,',
      '',
      'John,200',
    ].join('\n');

    const result = await parseCSV(makeFile(csv));

    expect(result.rowCount).toBe(2);
    // Empty rows produce a warning
    const warnings = result.parseErrors.filter(e => e.severity === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('strips UTF-8 BOM — no garbage in first column header', async () => {
    const csv = ['Name,Rate', 'Jane,150'].join('\n');
    const result = await parseCSV(makeBomFile(csv));

    const headers = result.columns.map(c => c.originalHeader);
    expect(headers[0]).toBe('Name');
    expect(headers[0].charCodeAt(0)).not.toBe(0xfeff);
  });

  it('limits previewRows to maxPreviewRows option', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `Name${i},${i * 10}`);
    const csv = ['Name,Rate', ...rows].join('\n');

    const result = await parseCSV(makeFile(csv), { maxPreviewRows: 5 });

    expect(result.previewRows.length).toBe(5);
    expect(result.fullRows.length).toBe(20);
  });
});
