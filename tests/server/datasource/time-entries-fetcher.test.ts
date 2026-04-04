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
import type { YaoTimeEntry } from '../../../src/server/datasource/types.js';

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

function makeEntry(overrides: Partial<YaoTimeEntry & Record<string, unknown>> = {}): YaoTimeEntry & Record<string, unknown> {
  return {
    _id: 'te-1',
    description: 'Drafting',
    do_not_bill: false,
    rate: 250,
    units: 6,
    duration_minutes: 30,
    billable: 125,
    write_off: 0,
    status: 'ACTIVE',
    date: '2024-03-01',
    created_at: '2024-03-01T09:00:00Z',
    updated_at: '2024-03-01T09:00:00Z',
    matter: { _id: 'matter-1', number: 1001, case_name: 'Smith v Jones', law_firm: 'firm-1' },
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

describe('fetchTimeEntries()', () => {
  it('returns empty array when first response has no results', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [] }));

    const result = await adapter.fetchTimeEntries();
    expect(result).toHaveLength(0);
  });

  it('cursor pagination stops when next is absent', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: [makeEntry({ _id: 'te-1' })], next: 100 }))
      .mockResolvedValueOnce(makeResponse({ result: [makeEntry({ _id: 'te-2' })] })); // no next

    const result = await adapter.fetchTimeEntries();
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 auth + 2 pages
  });

  it('cursor pagination stops when next is null', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: [makeEntry()], next: 50 }))
      .mockResolvedValueOnce(makeResponse({ result: [makeEntry({ _id: 'te-2' })], next: null }));

    const result = await adapter.fetchTimeEntries();
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('passes cursor value in next request body', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch
      .mockResolvedValueOnce(makeResponse({ result: [makeEntry()], next: 42 }))
      .mockResolvedValueOnce(makeResponse({ result: [] }));

    await adapter.fetchTimeEntries();

    const secondCall = mockFetch.mock.calls[2] as [string, RequestInit];
    const body = JSON.parse(secondCall[1].body as string) as Record<string, unknown>;
    expect(body['next']).toBe(42);
  });

  it('first request body does not include next', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [] }));

    await adapter.fetchTimeEntries();

    const firstCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(firstCall[1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('next');
    expect(body['size']).toBe(50);
  });

  it('excludes CONSOLIDATED entries', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [
        makeEntry({ _id: 'te-1', status: 'ACTIVE' }),
        makeEntry({ _id: 'te-2', status: 'CONSOLIDATED' }),
        makeEntry({ _id: 'te-3', status: 'ACTIVE' }),
      ],
    }));

    const result = await adapter.fetchTimeEntries();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.status === 'ACTIVE')).toBe(true);
  });

  it('excludes CONSOLIDATION_TARGET entries', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [
        makeEntry({ _id: 'te-1', status: 'ACTIVE' }),
        makeEntry({ _id: 'te-2', status: 'CONSOLIDATION_TARGET' }),
      ],
    }));

    const result = await adapter.fetchTimeEntries();
    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe('te-1');
  });

  it('strips password from assignee', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [
        makeEntry({
          assignee: {
            _id: 'att-1', name: 'Bob', surname: 'Brown',
            password: 'hash-secret',
          } as unknown,
        }),
      ],
    }));

    const result = await adapter.fetchTimeEntries();
    expect(result[0].assignee).not.toHaveProperty('password');
    expect(result[0].assignee?._id).toBe('att-1');
  });

  it('strips email_default_signature from assignee', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [
        makeEntry({
          assignee: {
            _id: 'att-1', name: 'Bob', surname: 'Brown',
            email_default_signature: '<p>Regards</p>',
          } as unknown,
        }),
      ],
    }));

    const result = await adapter.fetchTimeEntries();
    expect(result[0].assignee).not.toHaveProperty('email_default_signature');
  });

  it('handles activity being undefined gracefully', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [makeEntry({ activity: undefined })],
    }));

    const result = await adapter.fetchTimeEntries();
    expect(result[0].activity).toBeUndefined();
  });

  it('handles activity being null gracefully', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      result: [makeEntry({ activity: null })],
    }));

    const result = await adapter.fetchTimeEntries();
    // null comes back as-is — activity field is optional
    expect(result[0].activity == null).toBe(true);
  });

  it('preserves all non-sensitive fields on entries', async () => {
    const adapter = await authenticatedAdapter();
    const entry = makeEntry({
      work_type: 'DRAFTING',
      activity: { _id: 'act-1', title: 'Drafting', measure: 'hours' },
      invoice: 'inv-999',
      do_not_bill: true,
    });
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [entry] }));

    const result = await adapter.fetchTimeEntries();
    expect(result[0].work_type).toBe('DRAFTING');
    expect(result[0].activity?.title).toBe('Drafting');
    expect(result[0].invoice).toBe('inv-999');
    expect(result[0].do_not_bill).toBe(true);
  });
});
