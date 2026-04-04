import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Mocks
// =============================================================================

const { mockGetCredentials } = vi.hoisted(() => ({
  mockGetCredentials: vi.fn(),
}));

vi.mock('../../../src/server/services/credential-service.js', () => ({
  getCredentials: mockGetCredentials,
}));

// =============================================================================
// Imports
// =============================================================================

import { DataSourceAdapter } from '../../../src/server/datasource/DataSourceAdapter.js';
import type { YaoLedger } from '../../../src/server/datasource/types.js';

// =============================================================================
// Helpers
// =============================================================================

const mockFetch = vi.fn();

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let seq = 1;

function makeLedger(overrides: Partial<YaoLedger> = {}): YaoLedger {
  const n = seq++;
  return {
    _id: `ledger-${n}`,
    type: 'OFFICE_PAYMENT',
    value: 500,
    vat: 0,
    vat_percentage: 0,
    subtotal: 500,
    outstanding: 0,
    paid: 500,
    status: 'PAID',
    date: '2024-03-01',
    law_firm: 'firm-1',
    created_at: '2024-03-01T00:00:00Z',
    updated_at: '2024-03-01T00:00:00Z',
    ...overrides,
  };
}

async function authenticatedAdapter(): Promise<DataSourceAdapter> {
  mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
  const adapter = new DataSourceAdapter('firm-1');
  await adapter.authenticate();
  return adapter;
}

beforeEach(() => {
  seq = 1;
  vi.stubGlobal('fetch', mockFetch);
  process.env['YAO_API_BASE_URL'] = 'https://api.yao.legal';
  mockGetCredentials.mockResolvedValue({ email: 'test@firm.com', password: 'secret' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['YAO_API_BASE_URL'];
});

// =============================================================================
// fetchLedgers — pagination + request shape
// =============================================================================

describe('fetchLedgers()', () => {
  it('returns empty array when response is empty', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([]));

    const result = await adapter.fetchLedgers();
    expect(result).toHaveLength(0);
  });

  it('paginates — stops when result.length < size', async () => {
    const adapter = await authenticatedAdapter();
    const fullPage = Array.from({ length: 50 }, () => makeLedger());
    const lastPage = [makeLedger()];

    mockFetch
      .mockResolvedValueOnce(makeResponse(fullPage))
      .mockResolvedValueOnce(makeResponse(lastPage));

    const result = await adapter.fetchLedgers();
    expect(result).toHaveLength(51);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 auth + 2 pages
  });

  it('sends correct types filter in every request body', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([]));

    await adapter.fetchLedgers();

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['types']).toEqual(['OFFICE_PAYMENT', 'CLIENT_TO_OFFICE', 'OFFICE_RECEIPT']);
    expect(body['size']).toBe(50);
    expect(body['page']).toBe(1);
  });

  it('increments page on subsequent requests', async () => {
    const adapter = await authenticatedAdapter();
    const fullPage = Array.from({ length: 50 }, () => makeLedger());
    mockFetch
      .mockResolvedValueOnce(makeResponse(fullPage))
      .mockResolvedValueOnce(makeResponse([]));

    await adapter.fetchLedgers();

    const secondBody = JSON.parse(
      (mockFetch.mock.calls[2] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(secondBody['page']).toBe(2);
  });
});

// =============================================================================
// routeLedgers — routing logic
// =============================================================================

describe('routeLedgers()', () => {
  it('routes OFFICE_PAYMENT to disbursements', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'OFFICE_PAYMENT' });

    const result = adapter.routeLedgers([ledger]);

    expect(result.disbursements).toHaveLength(1);
    expect(result.disbursements[0]._id).toBe(ledger._id);
    expect(result.invoicePayments).toHaveLength(0);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });

  it('routes CLIENT_TO_OFFICE with invoice to invoicePayments', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'CLIENT_TO_OFFICE', invoice: 'inv-1' });

    const result = adapter.routeLedgers([ledger]);

    expect(result.invoicePayments).toHaveLength(1);
    expect(result.invoicePayments[0]._id).toBe(ledger._id);
    expect(result.disbursements).toHaveLength(0);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });

  it('routes OFFICE_RECEIPT with invoice to invoicePayments', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'OFFICE_RECEIPT', invoice: 'inv-2' });

    const result = adapter.routeLedgers([ledger]);

    expect(result.invoicePayments).toHaveLength(1);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });

  it('routes CLIENT_TO_OFFICE with disbursements[] to disbursementRecoveries', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({
      type: 'CLIENT_TO_OFFICE',
      disbursements: [{ _id: 'disb-1', value: 200 }],
    });

    const result = adapter.routeLedgers([ledger]);

    expect(result.disbursementRecoveries).toHaveLength(1);
    expect(result.disbursementRecoveries[0]._id).toBe(ledger._id);
    expect(result.invoicePayments).toHaveLength(0);
  });

  it('routes OFFICE_RECEIPT with disbursements[] to disbursementRecoveries', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({
      type: 'OFFICE_RECEIPT',
      disbursements: [{ _id: 'disb-2', value: 150 }],
    });

    const result = adapter.routeLedgers([ledger]);

    expect(result.disbursementRecoveries).toHaveLength(1);
    expect(result.invoicePayments).toHaveLength(0);
  });

  it('record with both invoice and disbursements[] appears in BOTH invoicePayments and disbursementRecoveries', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({
      type: 'CLIENT_TO_OFFICE',
      invoice: 'inv-3',
      disbursements: [{ _id: 'disb-3', value: 300 }],
    });

    const result = adapter.routeLedgers([ledger]);

    expect(result.invoicePayments).toHaveLength(1);
    expect(result.disbursementRecoveries).toHaveLength(1);
    // Same record object in both
    expect(result.invoicePayments[0]._id).toBe(ledger._id);
    expect(result.disbursementRecoveries[0]._id).toBe(ledger._id);
    expect(result.disbursements).toHaveLength(0);
  });

  it('discards CLIENT_TO_OFFICE with neither invoice nor disbursements', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'CLIENT_TO_OFFICE' });
    // Ensure no invoice or disbursements
    delete ledger.invoice;
    delete ledger.disbursements;

    const result = adapter.routeLedgers([ledger]);

    expect(result.disbursements).toHaveLength(0);
    expect(result.invoicePayments).toHaveLength(0);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });

  it('discards OFFICE_RECEIPT with neither invoice nor disbursements', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'OFFICE_RECEIPT' });
    delete ledger.invoice;
    delete ledger.disbursements;

    const result = adapter.routeLedgers([ledger]);

    expect(result.invoicePayments).toHaveLength(0);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });

  it('discards record with empty disbursements array and no invoice', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledger = makeLedger({ type: 'CLIENT_TO_OFFICE', disbursements: [] });
    delete ledger.invoice;

    const result = adapter.routeLedgers([ledger]);

    expect(result.disbursementRecoveries).toHaveLength(0);
    expect(result.invoicePayments).toHaveLength(0);
  });

  it('handles a mixed batch correctly', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ledgers = [
      makeLedger({ type: 'OFFICE_PAYMENT' }),
      makeLedger({ type: 'OFFICE_PAYMENT' }),
      makeLedger({ type: 'CLIENT_TO_OFFICE', invoice: 'inv-10' }),
      makeLedger({ type: 'OFFICE_RECEIPT', disbursements: [{ _id: 'd-1', value: 100 }] }),
      makeLedger({ type: 'CLIENT_TO_OFFICE', invoice: 'inv-11', disbursements: [{ _id: 'd-2', value: 50 }] }),
      makeLedger({ type: 'CLIENT_TO_OFFICE' }), // discarded
    ];

    const result = adapter.routeLedgers(ledgers);

    expect(result.disbursements).toHaveLength(2);
    expect(result.invoicePayments).toHaveLength(2);        // inv-10 + split record
    expect(result.disbursementRecoveries).toHaveLength(2); // office receipt + split record
  });

  it('returns empty buckets for empty input', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const result = adapter.routeLedgers([]);

    expect(result.disbursements).toHaveLength(0);
    expect(result.invoicePayments).toHaveLength(0);
    expect(result.disbursementRecoveries).toHaveLength(0);
  });
});
