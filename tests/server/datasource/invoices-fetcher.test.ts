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
import type { YaoInvoice } from '../../../src/server/datasource/types.js';

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

let invoiceSeq = 1;

function makeInvoice(overrides: Partial<YaoInvoice> = {}): YaoInvoice {
  const n = invoiceSeq++;
  return {
    _id: `inv-${n}`,
    invoice_number: n,
    invoice_date: '2024-03-01',
    due_date: '2024-04-01',
    subtotal: 1000,
    total_disbursements: 0,
    total_other_fees: 0,
    total_firm_fees: 1000,
    write_off: 0,
    total: 1200,
    outstanding: 1200,
    paid: 0,
    credited: 0,
    written_off: 0,
    vat: 200,
    vat_percentage: 20,
    less_paid_on_account: 0,
    billable_entries: 4,
    time_entries_override_value: 0,
    status: 'ISSUED',
    type: 'TAX',
    clients: [{ _id: 'c-1', display_name: 'Alice Smith' }],
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
  invoiceSeq = 1;
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
// fetchInvoices
// =============================================================================

describe('fetchInvoices()', () => {
  it('returns empty array when response is empty', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([]));

    const result = await adapter.fetchInvoices();
    expect(result).toHaveLength(0);
  });

  it('returns all invoices when they fit in one page', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice(), makeInvoice()]));

    const result = await adapter.fetchInvoices();
    expect(result).toHaveLength(2);
  });

  it('paginates correctly — stops when result.length < size', async () => {
    const adapter = await authenticatedAdapter();
    const fullPage = Array.from({ length: 100 }, () => makeInvoice());
    const lastPage = [makeInvoice()];

    mockFetch
      .mockResolvedValueOnce(makeResponse(fullPage))
      .mockResolvedValueOnce(makeResponse(lastPage));

    const result = await adapter.fetchInvoices();
    expect(result).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 auth + 2 pages
  });

  it('increments page number in successive requests', async () => {
    const adapter = await authenticatedAdapter();
    const fullPage = Array.from({ length: 100 }, () => makeInvoice());
    mockFetch
      .mockResolvedValueOnce(makeResponse(fullPage))
      .mockResolvedValueOnce(makeResponse([]));

    await adapter.fetchInvoices();

    const firstBody = JSON.parse(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    const secondBody = JSON.parse(
      (mockFetch.mock.calls[2] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;

    expect(firstBody['page']).toBe(1);
    expect(secondBody['page']).toBe(2);
    expect(firstBody['size']).toBe(100);
  });

  it('includes DRAFT invoices', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice({ status: 'DRAFT' })]));

    const result = await adapter.fetchInvoices();
    expect(result[0].status).toBe('DRAFT');
  });

  it('includes PAID invoices', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice({ status: 'PAID' })]));

    const result = await adapter.fetchInvoices();
    expect(result[0].status).toBe('PAID');
  });

  it('includes CREDITED invoices', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice({ status: 'CREDITED' })]));

    const result = await adapter.fetchInvoices();
    expect(result[0].status).toBe('CREDITED');
  });

  it('includes WRITTEN_OFF invoices', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice({ status: 'WRITTEN_OFF' })]));

    const result = await adapter.fetchInvoices();
    expect(result[0].status).toBe('WRITTEN_OFF');
  });

  it('includes CANCELED invoices', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeInvoice({ status: 'CANCELED' })]));

    const result = await adapter.fetchInvoices();
    expect(result[0].status).toBe('CANCELED');
  });

  it('handles missing solicitor gracefully', async () => {
    const adapter = await authenticatedAdapter();
    const invoice = makeInvoice();
    delete invoice.solicitor;
    mockFetch.mockResolvedValueOnce(makeResponse([invoice]));

    const result = await adapter.fetchInvoices();
    expect(result[0].solicitor).toBeUndefined();
  });

  it('handles missing matter gracefully', async () => {
    const adapter = await authenticatedAdapter();
    const invoice = makeInvoice();
    delete invoice.matter;
    mockFetch.mockResolvedValueOnce(makeResponse([invoice]));

    const result = await adapter.fetchInvoices();
    expect(result[0].matter).toBeUndefined();
  });

  it('preserves all financial fields', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([
      makeInvoice({
        subtotal: 5000,
        total: 6000,
        outstanding: 3000,
        paid: 3000,
        vat: 1000,
        write_off: 500,
      }),
    ]));

    const result = await adapter.fetchInvoices();
    expect(result[0].subtotal).toBe(5000);
    expect(result[0].total).toBe(6000);
    expect(result[0].outstanding).toBe(3000);
    expect(result[0].paid).toBe(3000);
    expect(result[0].vat).toBe(1000);
    expect(result[0].write_off).toBe(500);
  });
});

// =============================================================================
// fetchInvoiceSummary
// =============================================================================

describe('fetchInvoiceSummary()', () => {
  it('returns unpaid, paid, and total', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(
      makeResponse({ unpaid: 42500, paid: 187000, total: 229500 }),
    );

    const result = await adapter.fetchInvoiceSummary();
    expect(result.unpaid).toBe(42500);
    expect(result.paid).toBe(187000);
    expect(result.total).toBe(229500);
  });

  it('calls GET /invoices/summary', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ unpaid: 0, paid: 0, total: 0 }));

    await adapter.fetchInvoiceSummary();

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/invoices/summary');
    expect(init.method).toBe('GET');
  });

  it('is a single request with no pagination', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ unpaid: 0, paid: 0, total: 0 }));

    await adapter.fetchInvoiceSummary();
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 auth + 1 summary
  });
});
