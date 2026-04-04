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
import type { YaoMatter } from '../../../src/server/datasource/types.js';

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

function makeMatter(overrides: Partial<YaoMatter & Record<string, unknown>> = {}): YaoMatter & Record<string, unknown> {
  return {
    _id: 'matter-1',
    number: 1001,
    number_string: 'M-1001',
    status: 'IN_PROGRESS',
    case_name: 'Smith v Jones',
    financial_limit: 5000,
    rate: null,
    client_account_balance: 0,
    office_account_balance: 0,
    linked_account_balance: 0,
    clients: [],
    case_contacts: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    law_firm: { _id: 'firm-1', name: 'Acme Law' },
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
// Tests
// =============================================================================

describe('fetchMatters()', () => {
  it('returns empty array when first page has no rows', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const result = await adapter.fetchMatters();
    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 auth + 1 page
  });

  it('returns all matters when response fits in one page', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [makeMatter(), makeMatter({ _id: 'matter-2', number: 1002 })] }));

    const result = await adapter.fetchMatters();
    expect(result).toHaveLength(2);
  });

  it('paginates until rows.length < limit', async () => {
    const adapter = await authenticatedAdapter();

    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeMatter({ _id: `m-${i}`, number: i }),
    );
    const lastPage = [makeMatter({ _id: 'm-last', number: 999 })];

    mockFetch
      .mockResolvedValueOnce(makeResponse({ rows: fullPage }))
      .mockResolvedValueOnce(makeResponse({ rows: lastPage }));

    const result = await adapter.fetchMatters();
    expect(result).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 auth + 2 pages
  });

  it('sends page and limit as query params', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    await adapter.fetchMatters();

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain('page=1');
    expect(url).toContain('limit=100');
  });

  it('handles law_firm as an object', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({ law_firm: { _id: 'firm-1', name: 'Acme Law' } });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    expect(result[0].law_firm).toEqual({ _id: 'firm-1', name: 'Acme Law' });
  });

  it('handles law_firm as a string', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({ law_firm: 'firm-id-string' });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    expect(result[0].law_firm).toBe('firm-id-string');
  });

  it('strips password from nested responsible_lawyer', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({
      responsible_lawyer: {
        _id: 'att-1',
        name: 'Bob',
        surname: 'Brown',
        rates: [],
        password: 'hash-abc',
      } as unknown,
    });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    expect(result[0].responsible_lawyer).not.toHaveProperty('password');
    expect(result[0].responsible_lawyer?._id).toBe('att-1');
  });

  it('strips email_default_signature from nested responsible_supervisor', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({
      responsible_supervisor: {
        _id: 'att-2',
        name: 'Carol',
        surname: 'White',
        rates: [],
        email_default_signature: '<p>Best</p>',
      } as unknown,
    });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    expect(result[0].responsible_supervisor).not.toHaveProperty('email_default_signature');
    expect(result[0].responsible_supervisor?._id).toBe('att-2');
  });

  it('strips sensitive fields from paralegal nested object', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({
      paralegal: {
        _id: 'att-3',
        name: 'Dan',
        surname: 'Green',
        rates: [],
        password: 'hash-xyz',
        email_default_signature: '<p>Regards</p>',
      } as unknown,
    });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    const p = result[0].paralegal;
    expect(p).not.toHaveProperty('password');
    expect(p).not.toHaveProperty('email_default_signature');
    expect(p?._id).toBe('att-3');
  });

  it('preserves all non-sensitive matter fields', async () => {
    const adapter = await authenticatedAdapter();
    const matter = makeMatter({
      status: 'COMPLETED',
      financial_limit: 12500,
      department: { _id: 'dept-1', title: 'Conveyancing' },
    });
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [matter] }));

    const result = await adapter.fetchMatters();
    expect(result[0].status).toBe('COMPLETED');
    expect(result[0].financial_limit).toBe(12500);
    expect(result[0].department).toEqual({ _id: 'dept-1', title: 'Conveyancing' });
  });
});
