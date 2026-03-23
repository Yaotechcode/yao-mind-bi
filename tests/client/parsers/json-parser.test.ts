import { describe, it, expect } from 'vitest';
import { parseJSON } from '../../../src/client/parsers/json-parser.js';

function makeJsonFile(data: unknown, filename = 'test.json'): File {
  return new File([JSON.stringify(data)], filename, { type: 'application/json' });
}

describe('parseJSON', () => {
  it('parses Shape A (flat array) — correct row count and columns', async () => {
    const data = [
      { matterId: 'M001', status: 'Active', netBilling: 1500 },
      { matterId: 'M002', status: 'Closed', netBilling: 2300 },
      { matterId: 'M003', status: 'Active', netBilling: 800 },
    ];

    const result = await parseJSON(makeJsonFile(data));

    expect(result.rowCount).toBe(3);
    expect(result.columns.map(c => c.originalHeader)).toEqual(
      expect.arrayContaining(['matterId', 'status', 'netBilling'])
    );
  });

  it('parses Shape B ({ data: [...] }) — data array is extracted', async () => {
    const data = {
      meta: { exportedAt: '2024-01-01', totalRows: 2 },
      data: [
        { invoiceId: 'INV001', total: 500 },
        { invoiceId: 'INV002', total: 750 },
      ],
    };

    const result = await parseJSON(makeJsonFile(data));

    expect(result.rowCount).toBe(2);
    const headers = result.columns.map(c => c.originalHeader);
    expect(headers).toContain('invoiceId');
    expect(headers).toContain('total');
  });

  it('flattens nested objects one level deep', async () => {
    const data = [
      { matterId: 'M001', client: { id: '123', name: 'Acme Ltd' }, status: 'Active' },
    ];

    const result = await parseJSON(makeJsonFile(data));

    const headers = result.columns.map(c => c.originalHeader);
    expect(headers).toContain('client.id');
    expect(headers).toContain('client.name');
    expect(headers).not.toContain('client');
  });

  it('returns a fatal ParseError and zero rows for invalid JSON', async () => {
    const file = new File(['{ this is not valid json '], 'bad.json', {
      type: 'application/json',
    });

    const result = await parseJSON(file);

    expect(result.rowCount).toBe(0);
    expect(result.fullRows).toHaveLength(0);
    const fatal = result.parseErrors.find(e => e.severity === 'error');
    expect(fatal).toBeDefined();
  });

  it('serialises array fields within rows to JSON strings', async () => {
    // WIP entries can have arrays (e.g. clientIds)
    const data = [
      { matterId: 'M001', clientIds: ['C001', 'C002'], status: 'Active' },
    ];

    const result = await parseJSON(makeJsonFile(data));

    const row = result.fullRows[0];
    expect(typeof row['clientIds']).toBe('string');
    expect(row['clientIds']).toBe('["C001","C002"]');
  });
});
