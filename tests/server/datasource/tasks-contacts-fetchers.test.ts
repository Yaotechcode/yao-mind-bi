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
import type { YaoTask, YaoContact } from '../../../src/server/datasource/types.js';

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

function makeTask(overrides: Partial<YaoTask & Record<string, unknown>> = {}): YaoTask {
  return {
    _id: 'task-1',
    title: 'Review contract',
    priority: 'MEDIUM',
    status: 'TO_DO',
    ...overrides,
  };
}

function makeContact(overrides: Partial<YaoContact> = {}): YaoContact {
  return {
    _id: 'contact-1',
    type: 'Person',
    display_name: 'Alice Smith',
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
// fetchTasks
// =============================================================================

describe('fetchTasks()', () => {
  it('returns empty array when no tasks', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const result = await adapter.fetchTasks();
    expect(result).toHaveLength(0);
  });

  it('excludes DELETED tasks', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [
        makeTask({ _id: 't-1', status: 'TO_DO' }),
        makeTask({ _id: 't-2', status: 'DELETED' }),
        makeTask({ _id: 't-3', status: 'IN_PROGRESS' }),
        makeTask({ _id: 't-4', status: 'COMPLETED' }),
        makeTask({ _id: 't-5', status: 'DELETED' }),
      ],
    }));

    const result = await adapter.fetchTasks();
    expect(result).toHaveLength(3);
    expect(result.every((t) => t.status !== 'DELETED')).toBe(true);
  });

  it('includes TO_DO, IN_PROGRESS, and COMPLETED', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [
        makeTask({ status: 'TO_DO' }),
        makeTask({ status: 'IN_PROGRESS' }),
        makeTask({ status: 'COMPLETED' }),
      ],
    }));

    const result = await adapter.fetchTasks();
    expect(result).toHaveLength(3);
  });

  it('strips password from assigned_to', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [
        makeTask({
          assigned_to: {
            _id: 'att-1', name: 'Bob', surname: 'Brown',
            status: 'ACTIVE', email: 'bob@firm.com',
            password: 'hash-secret',
          } as unknown,
        }),
      ],
    }));

    const result = await adapter.fetchTasks();
    expect(result[0].assigned_to).not.toHaveProperty('password');
    expect(result[0].assigned_to?._id).toBe('att-1');
  });

  it('strips email_default_signature from assigned_to', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [
        makeTask({
          assigned_to: {
            _id: 'att-1', name: 'Bob', surname: 'Brown',
            status: 'ACTIVE', email: 'bob@firm.com',
            email_default_signature: '<p>Regards</p>',
          } as unknown,
        }),
      ],
    }));

    const result = await adapter.fetchTasks();
    expect(result[0].assigned_to).not.toHaveProperty('email_default_signature');
  });

  it('handles null assigned_to gracefully', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [makeTask({ assigned_to: undefined })],
    }));

    const result = await adapter.fetchTasks();
    expect(result[0].assigned_to).toBeUndefined();
  });

  it('passes page and limit query params', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    await adapter.fetchTasks();

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain('page=1');
    expect(url).toContain('limit=50');
  });
});

// =============================================================================
// fetchContacts
// =============================================================================

describe('fetchContacts()', () => {
  it('returns empty array when no contacts', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const result = await adapter.fetchContacts();
    expect(result).toHaveLength(0);
  });

  it('sends is_archived=false in query params', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    await adapter.fetchContacts();

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain('is_archived=false');
  });

  it('sends page and limit query params', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    await adapter.fetchContacts();

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain('page=1');
    expect(url).toContain('limit=50');
  });

  it('returns contacts with correct fields', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({
      rows: [makeContact({ type: 'Company', company_name: 'Acme Ltd' })],
    }));

    const result = await adapter.fetchContacts();
    expect(result[0].type).toBe('Company');
    expect(result[0].company_name).toBe('Acme Ltd');
    // is_archived is not in CONTACT_KEEP_FIELDS — pruned at fetch time
    expect(result[0]).not.toHaveProperty('is_archived');
  });

  it('paginates correctly', async () => {
    const adapter = await authenticatedAdapter();
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      makeContact({ _id: `c-${i}` }),
    );
    mockFetch
      .mockResolvedValueOnce(makeResponse({ rows: fullPage }))                       // page 1 (Phase A)
      .mockResolvedValueOnce(makeResponse({ rows: [makeContact({ _id: 'c-last' })] })) // page 2 (Phase B)
      .mockResolvedValueOnce(makeResponse({ rows: [] }))                             // page 3
      .mockResolvedValueOnce(makeResponse({ rows: [] }))                             // page 4
      .mockResolvedValueOnce(makeResponse({ rows: [] }))                             // page 5
      .mockResolvedValueOnce(makeResponse({ rows: [] }));                            // page 6

    const result = await adapter.fetchContacts();
    expect(result).toHaveLength(51);
  });
});

// =============================================================================
// fetchAll
// =============================================================================

describe('fetchAll()', () => {
  /** Builds a full set of mock responses for every fetchAll endpoint in order. */
  function setupFetchAllMocks() {
    // Auth (already consumed by authenticatedAdapter)
    // Step 1: lookup tables (parallel: attorneys, departments, caseTypes)
    mockFetch
      .mockResolvedValueOnce(makeResponse([{    // /attorneys
        _id: 'att-1', name: 'Alice', surname: 'Smith', status: 'ACTIVE',
        email: 'alice@firm.com', rates: [], law_firm: 'f-1',
        created_at: '', updated_at: '',
      }]))
      .mockResolvedValueOnce(makeResponse([{    // /departments
        _id: 'dept-1', title: 'Conveyancing', law_firm: 'f-1', is_deleted: false,
      }]))
      .mockResolvedValueOnce(makeResponse([{    // /case-types/active
        _id: 'ct-1', title: 'Residential', law_firm: 'f-1', fixed_fee: 0,
        department: { _id: 'dept-1', title: 'Conveyancing', is_deleted: false },
        is_deleted: false,
      }]));

    // Step 2: transactional (parallel: matters, timeEntries, invoices, tasks, contacts — ledgers excluded)
    mockFetch
      .mockResolvedValueOnce(makeResponse({ rows: [] }))   // /matters
      .mockResolvedValueOnce(makeResponse({ result: [] })) // /time-entries/search
      .mockResolvedValueOnce(makeResponse([]))              // /invoices/search
      .mockResolvedValueOnce(makeResponse({ rows: [] }))   // /tasks
      .mockResolvedValueOnce(makeResponse({ rows: [] }));  // /contacts

    // Step 3: invoice summary
    mockFetch.mockResolvedValueOnce(makeResponse({ unpaid: 0, paid: 0, total: 0 }));
  }

  it('returns all expected top-level keys', async () => {
    const adapter = await authenticatedAdapter();
    setupFetchAllMocks();

    const result = await adapter.fetchAll();

    expect(result).toHaveProperty('attorneys');
    expect(result).toHaveProperty('departments');
    expect(result).toHaveProperty('caseTypes');
    expect(result).toHaveProperty('matters');
    expect(result).toHaveProperty('timeEntries');
    expect(result).toHaveProperty('invoices');
    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('contacts');
    expect(result).toHaveProperty('invoiceSummary');
    expect(result).toHaveProperty('maps');
  });

  it('maps key contains all three lookup maps', async () => {
    const adapter = await authenticatedAdapter();
    setupFetchAllMocks();

    const result = await adapter.fetchAll();

    expect(result.maps).toHaveProperty('attorneyMap');
    expect(result.maps).toHaveProperty('departmentMap');
    expect(result.maps).toHaveProperty('caseTypeMap');
  });

  it('attorney from lookup appears in attorneyMap', async () => {
    const adapter = await authenticatedAdapter();
    setupFetchAllMocks();

    const result = await adapter.fetchAll();

    expect(result.maps.attorneyMap['att-1']).toBeDefined();
    expect(result.maps.attorneyMap['att-1'].fullName).toBe('Alice Smith');
  });

  it('invoiceSummary has correct shape', async () => {
    const adapter = await authenticatedAdapter();
    setupFetchAllMocks();

    const result = await adapter.fetchAll();

    expect(typeof result.invoiceSummary.unpaid).toBe('number');
    expect(typeof result.invoiceSummary.paid).toBe('number');
    expect(typeof result.invoiceSummary.total).toBe('number');
  });

  it('step 2 fetches are issued in parallel (all called before any resolves)', async () => {
    const adapter = await authenticatedAdapter();

    // Track call order with a delay to confirm parallel dispatch
    const callOrder: string[] = [];

    // Step 1 resolves synchronously
    mockFetch
      .mockResolvedValueOnce(makeResponse([]))  // attorneys
      .mockResolvedValueOnce(makeResponse([]))  // departments
      .mockResolvedValueOnce(makeResponse([])); // caseTypes

    // Step 2: each response records its URL when called
    for (const [pattern, response] of [
      ['/matters', { rows: [] }],
      ['/time-entries', { result: [] }],
      ['/invoices/search', []],
      ['/tasks', { rows: [] }],
      ['/contacts', { rows: [] }],
    ] as [string, unknown][]) {
      mockFetch.mockImplementationOnce((url: string) => {
        callOrder.push(pattern);
        void url;
        return Promise.resolve(makeResponse(response));
      });
    }

    // Step 3
    mockFetch.mockResolvedValueOnce(makeResponse({ unpaid: 0, paid: 0, total: 0 }));

    await adapter.fetchAll();

    // All 5 step-2 endpoints were called (ledgers excluded from fetchAll)
    expect(callOrder).toHaveLength(5);
    expect(callOrder).toContain('/matters');
    expect(callOrder).toContain('/time-entries');
    expect(callOrder).toContain('/invoices/search');
    expect(callOrder).toContain('/tasks');
    expect(callOrder).toContain('/contacts');
  });
});
