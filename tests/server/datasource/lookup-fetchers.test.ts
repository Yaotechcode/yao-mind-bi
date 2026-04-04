import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// credential-service mock
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
import type {
  YaoAttorney,
  YaoDepartment,
  YaoCaseType,
} from '../../../src/server/datasource/types.js';

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

function makeAttorney(overrides: Partial<YaoAttorney & { password?: string; email_default_signature?: string }> = {}): YaoAttorney & { password?: string; email_default_signature?: string } {
  return {
    _id: 'att-1',
    name: 'Alice',
    surname: 'Smith',
    status: 'ACTIVE',
    email: 'alice@firm.com',
    law_firm: 'firm-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    rates: [
      { label: 'Standard', value: 250, default: true },
      { label: 'Discounted', value: 200, default: false },
    ],
    ...overrides,
  };
}

function makeDepartment(overrides: Partial<YaoDepartment> = {}): YaoDepartment {
  return {
    _id: 'dept-1',
    title: 'Conveyancing',
    law_firm: 'firm-1',
    is_deleted: false,
    ...overrides,
  };
}

function makeCaseType(overrides: Partial<YaoCaseType> = {}): YaoCaseType {
  return {
    _id: 'ct-1',
    title: 'Residential Purchase',
    law_firm: 'firm-1',
    fixed_fee: 0,
    department: { _id: 'dept-1', title: 'Conveyancing', is_deleted: false },
    is_deleted: false,
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
// buildAttorneyMap
// =============================================================================

describe('buildAttorneyMap()', () => {
  it('sets fullName from name + surname', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([makeAttorney()]);
    expect(map['att-1'].fullName).toBe('Alice Smith');
    expect(map['att-1'].firstName).toBe('Alice');
    expect(map['att-1'].lastName).toBe('Smith');
  });

  it('picks the default rate as defaultRate', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([makeAttorney()]);
    expect(map['att-1'].defaultRate).toBe(250);
  });

  it('returns null for defaultRate when no default rate exists', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const attorney = makeAttorney({
      rates: [{ label: 'Standard', value: 300, default: false }],
    });
    const map = adapter.buildAttorneyMap([attorney]);
    expect(map['att-1'].defaultRate).toBeNull();
  });

  it('returns null for defaultRate when rates array is empty', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([makeAttorney({ rates: [] })]);
    expect(map['att-1'].defaultRate).toBeNull();
  });

  it('maps integrationAccountId and integrationAccountCode', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([
      makeAttorney({ integration_account_id: 'IAI-99', integration_account_code: 'CODE-1' }),
    ]);
    expect(map['att-1'].integrationAccountId).toBe('IAI-99');
    expect(map['att-1'].integrationAccountCode).toBe('CODE-1');
  });

  it('sets integrationAccountId to null when absent', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([makeAttorney()]);
    expect(map['att-1'].integrationAccountId).toBeNull();
  });

  it('maps multiple attorneys by _id', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildAttorneyMap([
      makeAttorney({ _id: 'att-1', name: 'Alice', surname: 'Smith' }),
      makeAttorney({ _id: 'att-2', name: 'Bob', surname: 'Jones' }),
    ]);
    expect(Object.keys(map)).toHaveLength(2);
    expect(map['att-2'].fullName).toBe('Bob Jones');
  });
});

// =============================================================================
// fetchAttorneys — strips sensitive fields
// =============================================================================

describe('fetchAttorneys()', () => {
  it('strips password from returned attorneys', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(
      makeResponse([makeAttorney({ password: 'hash123' })]),
    );
    const attorneys = await adapter.fetchAttorneys();
    expect(attorneys[0]).not.toHaveProperty('password');
  });

  it('strips email_default_signature from returned attorneys', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(
      makeResponse([makeAttorney({ email_default_signature: '<p>Regards</p>' })]),
    );
    const attorneys = await adapter.fetchAttorneys();
    expect(attorneys[0]).not.toHaveProperty('email_default_signature');
  });

  it('preserves all other attorney fields', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse([makeAttorney()]));
    const attorneys = await adapter.fetchAttorneys();
    expect(attorneys[0]._id).toBe('att-1');
    expect(attorneys[0].email).toBe('alice@firm.com');
    expect(attorneys[0].rates).toHaveLength(2);
  });
});

// =============================================================================
// buildDepartmentMap
// =============================================================================

describe('buildDepartmentMap()', () => {
  it('excludes deleted departments', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildDepartmentMap([
      makeDepartment({ _id: 'dept-1', title: 'Conveyancing', is_deleted: false }),
      makeDepartment({ _id: 'dept-2', title: 'Archived', is_deleted: true }),
    ]);
    expect(map).toHaveProperty('dept-1');
    expect(map).not.toHaveProperty('dept-2');
  });

  it('maps id to title', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildDepartmentMap([makeDepartment()]);
    expect(map['dept-1']).toBe('Conveyancing');
  });

  it('returns empty map when all departments are deleted', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildDepartmentMap([
      makeDepartment({ is_deleted: true }),
    ]);
    expect(Object.keys(map)).toHaveLength(0);
  });
});

// =============================================================================
// buildCaseTypeMap
// =============================================================================

describe('buildCaseTypeMap()', () => {
  it('sets isFixedFee = false when fixed_fee is 0', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildCaseTypeMap([makeCaseType({ fixed_fee: 0 })]);
    expect(map['ct-1'].isFixedFee).toBe(false);
  });

  it('sets isFixedFee = true when fixed_fee > 0', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildCaseTypeMap([makeCaseType({ fixed_fee: 1500 })]);
    expect(map['ct-1'].isFixedFee).toBe(true);
    expect(map['ct-1'].fixedFeeValue).toBe(1500);
  });

  it('sets isFixedFee = false when fixed_fee is absent', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const ct = makeCaseType();
    delete ct.fixed_fee;
    const map = adapter.buildCaseTypeMap([ct]);
    expect(map['ct-1'].isFixedFee).toBe(false);
    expect(map['ct-1'].fixedFeeValue).toBeNull();
  });

  it('includes department info from nested object', () => {
    const adapter = new DataSourceAdapter('firm-1');
    const map = adapter.buildCaseTypeMap([makeCaseType()]);
    expect(map['ct-1'].departmentId).toBe('dept-1');
    expect(map['ct-1'].departmentTitle).toBe('Conveyancing');
  });
});

// =============================================================================
// fetchLookupTables — parallel fetching
// =============================================================================

describe('fetchLookupTables()', () => {
  it('calls all three fetchers and returns populated maps', async () => {
    const adapter = await authenticatedAdapter();

    mockFetch
      .mockResolvedValueOnce(makeResponse([makeAttorney()]))           // /attorneys
      .mockResolvedValueOnce(makeResponse([makeDepartment()]))         // /departments
      .mockResolvedValueOnce(makeResponse([makeCaseType()]));          // /case-types/active

    const result = await adapter.fetchLookupTables();

    expect(result.attorneys).toHaveLength(1);
    expect(result.departments).toHaveLength(1);
    expect(result.caseTypes).toHaveLength(1);
    expect(result.attorneyMap['att-1'].fullName).toBe('Alice Smith');
    expect(result.departmentMap['dept-1']).toBe('Conveyancing');
    expect(result.caseTypeMap['ct-1'].isFixedFee).toBe(false);
  });

  it('issues all three API calls (in parallel)', async () => {
    const adapter = await authenticatedAdapter();
    const fetchOrder: string[] = [];

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/attorneys')) {
        fetchOrder.push('attorneys');
        return Promise.resolve(makeResponse([makeAttorney()]));
      }
      if (url.includes('/departments')) {
        fetchOrder.push('departments');
        return Promise.resolve(makeResponse([makeDepartment()]));
      }
      if (url.includes('/case-types/active')) {
        fetchOrder.push('caseTypes');
        return Promise.resolve(makeResponse([makeCaseType()]));
      }
      return Promise.resolve(makeResponse([]));
    });

    await adapter.fetchLookupTables();

    // All three were called (order may vary due to parallelism)
    expect(fetchOrder).toContain('attorneys');
    expect(fetchOrder).toContain('departments');
    expect(fetchOrder).toContain('caseTypes');
    expect(fetchOrder).toHaveLength(3);
  });
});
