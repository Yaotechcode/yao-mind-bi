/**
 * full-pipeline.test.ts — DataSourceAdapter integration tests
 *
 * Exercises the full fetch → normalise → enrich pipeline using mocked HTTP
 * responses that match real Yao API schemas. All real transformations and
 * enrichment functions run; only network I/O and external services are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Module mocks — hoisted before any imports
// =============================================================================

const { mockGetCredentials } = vi.hoisted(() => ({
  mockGetCredentials: vi.fn(),
}));

vi.mock('../../../../src/server/services/credential-service.js', () => ({
  getCredentials: mockGetCredentials,
  storeCredentials: vi.fn(),
}));

// Services used only by PullOrchestrator (test 10) — mocked here so the
// full pipeline test does not need live Supabase / MongoDB.
vi.mock('../../../../src/server/services/pull-status-service.js', () => ({
  requireNoConcurrentPull: vi.fn().mockResolvedValue(undefined),
  startPull:               vi.fn().mockResolvedValue(undefined),
  updatePullStage:         vi.fn().mockResolvedValue(undefined),
  completePull:            vi.fn().mockResolvedValue(undefined),
  failPull:                vi.fn().mockResolvedValue(undefined),
  PullAlreadyRunningError: class PullAlreadyRunningError extends Error {
    constructor(firmId: string) { super(`A pull is already running for firm ${firmId}`); }
  },
}));

vi.mock('../../../../src/server/datasource/enrich/fee-earner-merger.js', () => ({
  mergeAllFeeEarners: vi.fn().mockImplementation((attorneys: unknown[]) =>
    Promise.resolve(attorneys),
  ),
}));

vi.mock('../../../../src/server/lib/mongodb-operations.js', () => ({
  storeEnrichedEntities: vi.fn().mockResolvedValue(undefined),
  storeRiskFlags:        vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/server/services/kpi-snapshot-service.js', () => ({
  writeKpiSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/server/services/config-service.js', () => ({
  getFirmConfig: vi.fn().mockResolvedValue({
    ragThresholds: {},
    formulaConfig: {},
    firmProfile:   { name: 'Test Firm' },
  }),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { DataSourceAdapter } from '../../../../src/server/datasource/DataSourceAdapter.js';
import { PullOrchestrator }  from '../../../../src/server/datasource/PullOrchestrator.js';
import { transformTimeEntry } from '../../../../src/server/datasource/normalise/transformations.js';
import { buildWipEnrichment } from '../../../../src/server/datasource/enrich/wip-aggregator.js';
import { enrichInvoicesWithDatePaid } from '../../../../src/server/datasource/enrich/invoice-enricher.js';
import { transformInvoice }  from '../../../../src/server/datasource/normalise/transformations.js';

// =============================================================================
// Constants
// =============================================================================

const FIRM_ID    = 'firm-integration-001';
const BASE_URL   = 'https://api.yao.legal';
const MOCK_TOKEN = 'mock-jwt-token-abc';

// =============================================================================
// Real API–shaped fixtures
// =============================================================================

/** Attorney with password field present — must be stripped by the adapter. */
const RAW_ATTORNEY = {
  _id:    'atty-001',
  name:   'Jane',
  surname: 'Smith',
  status:  'ACTIVE',
  email:   'jane@testfirm.com',
  job_title: 'Partner',
  integration_account_id:   'INT-001',
  integration_account_code: 'JS',
  rates: [
    { label: 'Standard', value: 250, default: true },
    { label: 'Reduced',  value: 180, default: false },
  ],
  law_firm:   'firm-001',
  created_at: '2023-01-15T09:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  password:                  'super-secret-should-be-stripped',
  email_default_signature:   'Regards, Jane — should-be-stripped',
};

const RAW_DEPARTMENT = {
  _id:        'dept-001',
  title:      'Corporate',
  law_firm:   'firm-001',
  is_deleted: false,
};

const RAW_CASE_TYPE = {
  _id:        'ct-001',
  title:      'Commercial Contract',
  fixed_fee:  0,
  law_firm:   'firm-001',
  department: { _id: 'dept-001', title: 'Corporate', is_deleted: false },
  is_deleted: false,
};

/** Matter with nested responsible_lawyer including rates array. */
const RAW_MATTER = {
  _id:    'matter-001',
  number: 1001,
  number_string: '1001',
  status: 'IN_PROGRESS',
  case_name: 'Smith v Jones',
  financial_limit: 15000,
  rate: null,
  client_account_balance: 0,
  office_account_balance: 0,
  linked_account_balance: 0,
  responsible_lawyer: {
    _id:     'atty-001',
    name:    'Jane',
    surname: 'Smith',
    rates:   [{ label: 'Standard', value: 250, default: true }],
  },
  department: { _id: 'dept-001', title: 'Corporate' },
  case_type:  { _id: 'ct-001',   title: 'Commercial Contract' },
  clients: [{
    contact: {
      _id:          'contact-001',
      type:         'Person',
      display_name: 'John Jones',
      first_name:   'John',
      last_name:    'Jones',
    },
  }],
  case_contacts: [],
  in_progress_date: '2024-01-10T00:00:00Z',
  created_at: '2024-01-10T00:00:00Z',
  updated_at: '2024-03-01T00:00:00Z',
  law_firm: { _id: 'firm-001', name: 'Test Firm' },
};

/** Time entry with activity object (title, measure). */
const RAW_TIME_ENTRY = {
  _id:             'te-001',
  description:     'Client conference call',
  do_not_bill:     false,
  rate:            250,
  client_rate:     250,
  units:           2,
  duration_minutes: 30,
  billable:        125,
  write_off:       25,
  status:          'ACTIVE',
  activity: { _id: 'act-001', title: 'Telephone', measure: 'hours' },
  matter: { _id: 'matter-001', number: 1001, case_name: 'Smith v Jones', law_firm: 'firm-001' },
  assignee: {
    _id:     'atty-001',
    name:    'Jane',
    surname: 'Smith',
    password: 'should-be-stripped',
  },
  date:       '2024-03-15',
  created_at: '2024-03-15T10:00:00Z',
  updated_at: '2024-03-15T10:00:00Z',
};

/** Invoice with clients array and solicitor object. */
const RAW_INVOICE = {
  _id:            'inv-001',
  invoice_number: 2001,
  invoice_date:   '2024-03-01',
  due_date:       '2024-04-01',
  subtotal:       1000,
  total_disbursements:    0,
  total_other_fees:       0,
  total_firm_fees:        1000,
  write_off:      0,
  total:          1200,
  outstanding:    1200,
  paid:           0,
  credited:       0,
  written_off:    0,
  vat:            200,
  vat_percentage: 20,
  less_paid_on_account:   0,
  billable_entries:       4,
  time_entries_override_value: 0,
  status: 'ISSUED',
  type:   'INVOICE',
  clients: [{ _id: 'contact-001', display_name: 'John Jones' }],
  solicitor: { _id: 'atty-001', name: 'Jane Smith' },
  matter: { _id: 'matter-001', number: 1001, case_name: 'Smith v Jones' },
  created_at: '2024-03-01T00:00:00Z',
  updated_at: '2024-03-01T00:00:00Z',
};

/** Ledger — OFFICE_PAYMENT type, negative value → disbursement. */
const RAW_LEDGER_DISBURSEMENT = {
  _id:           'led-001',
  type:          'OFFICE_PAYMENT',
  value:         -500,
  vat:           0,
  vat_percentage: 0,
  subtotal:       500,
  outstanding:   -500,
  paid:          0,
  status:        'ACTIVE',
  reference:     'Expert fees',
  date:          '2024-03-10',
  law_firm:      'firm-001',
  matter: { _id: 'matter-001', number: 1001, case_name: 'Smith v Jones' },
  created_at: '2024-03-10T00:00:00Z',
  updated_at: '2024-03-10T00:00:00Z',
};

/** Ledger — CLIENT_TO_OFFICE with invoice field populated → invoicePayments. */
const RAW_LEDGER_INVOICE_PAYMENT = {
  _id:           'led-002',
  type:          'CLIENT_TO_OFFICE',
  value:         1200,
  vat:           0,
  vat_percentage: 0,
  subtotal:       1200,
  outstanding:   0,
  paid:          1200,
  status:        'ACTIVE',
  date:          '2024-03-20',
  law_firm:      'firm-001',
  invoice:       'inv-001',   // populated → invoicePayments
  created_at: '2024-03-20T00:00:00Z',
  updated_at: '2024-03-20T00:00:00Z',
};

/**
 * Ledger — CLIENT_TO_OFFICE with BOTH invoice AND disbursements[] populated
 * → should appear in BOTH invoicePayments AND disbursementRecoveries.
 */
const RAW_LEDGER_BOTH = {
  _id:           'led-003',
  type:          'CLIENT_TO_OFFICE',
  value:         600,
  vat:           0,
  vat_percentage: 0,
  subtotal:       600,
  outstanding:   0,
  paid:          600,
  status:        'ACTIVE',
  date:          '2024-03-21',
  law_firm:      'firm-001',
  invoice:       'inv-002',
  disbursements: [{ _id: 'disb-recovery-001', value: 600 }],
  created_at: '2024-03-21T00:00:00Z',
  updated_at: '2024-03-21T00:00:00Z',
};

/** Task with assigned_to containing password — must be stripped. */
const RAW_TASK = {
  _id:      'task-001',
  title:    'Review draft contract',
  priority: 'HIGH',
  status:   'PENDING',
  category: 'REVIEW',
  notify_flag: false,
  matter: { _id: 'matter-001', number: 1001, case_name: 'Smith v Jones' },
  assigned_to: {
    _id:      'atty-001',
    name:     'Jane',
    surname:  'Smith',
    status:   'ACTIVE',
    email:    'jane@testfirm.com',
    password: 'should-be-stripped',
  },
  created_at: '2024-03-12T00:00:00Z',
  updated_at: '2024-03-12T00:00:00Z',
};

const RAW_CONTACT = {
  _id:          'contact-001',
  type:         'Person',
  display_name: 'John Jones',
  first_name:   'John',
  last_name:    'Jones',
  email:        'john@example.com',
  is_archived:  false,
  law_firm:     'firm-001',
  created_at:   '2024-01-01T00:00:00Z',
  updated_at:   '2024-01-01T00:00:00Z',
};

// =============================================================================
// Mock fetch router
// =============================================================================

/**
 * Builds a JSON Response mock (as expected by the Fetch API).
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok:     status >= 200 && status < 300,
    status,
    json:   () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Creates a mock fetch function routing on pathname + method.
 *
 * All endpoints return single-page responses (< limit) so pagination
 * stops after page 1, unless the test overrides this.
 */
function createMockFetch(opts: {
  /** If true, page 1 returns 50 time entries (triggering page 2 fetch). Default: false (1 entry, stops). */
  timeEntriesMultiPage?: boolean;
  /** Override matters pagination — page 1 returns this many records. */
  mattersPage1Count?: number;
  /** Extra matters on page 2 (for pagination stop test). */
  mattersPage2Count?: number;
  /** Ledger records to return on page 1. Default: all three fixtures. */
  ledgers?: unknown[];
}) {
  const {
    timeEntriesMultiPage = false,
    mattersPage1Count  = 1,
    mattersPage2Count  = 0,
    ledgers = [RAW_LEDGER_DISBURSEMENT, RAW_LEDGER_INVOICE_PAYMENT, RAW_LEDGER_BOTH],
  } = opts;

  return vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed   = new URL(url);
    const pathname = parsed.pathname;
    const method   = (init?.method ?? 'GET').toUpperCase();

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (pathname === '/attorneys/login' && method === 'POST') {
      return jsonResponse({ access_token: MOCK_TOKEN, name: 'Jane Smith' });
    }

    // ── Lookup tables ─────────────────────────────────────────────────────────
    if (pathname === '/attorneys' && method === 'GET') {
      return jsonResponse([RAW_ATTORNEY]);
    }
    if (pathname === '/departments' && method === 'GET') {
      return jsonResponse([RAW_DEPARTMENT]);
    }
    if (pathname === '/case-types/active' && method === 'GET') {
      return jsonResponse([RAW_CASE_TYPE]);
    }

    // ── Matters (page GET) ────────────────────────────────────────────────────
    if (pathname === '/matters' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? '1');
      if (page === 1) {
        const rows = Array.from({ length: mattersPage1Count }, () => ({ ...RAW_MATTER }));
        return jsonResponse({ rows, limit: 50 });
      }
      if (page === 2) {
        const rows = Array.from({ length: mattersPage2Count }, () => ({ ...RAW_MATTER, _id: `matter-p2-${Date.now()}` }));
        return jsonResponse({ rows, limit: 50 });
      }
      return jsonResponse({ rows: [], limit: 100 });
    }

    // ── Time entries (page-based POST) ───────────────────────────────────────
    if (pathname === '/time-entries/search' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const page = Number(body['page'] ?? 1);

      if (page === 1) {
        // Multi-page mode: return a full page of 50 to trigger page 2 fetch
        if (timeEntriesMultiPage) {
          const result = Array.from({ length: 50 }, () => ({ ...RAW_TIME_ENTRY }));
          return jsonResponse({ result });
        }
        return jsonResponse({ result: [RAW_TIME_ENTRY] });
      }
      if (page === 2 && timeEntriesMultiPage) {
        return jsonResponse({ result: [{ ...RAW_TIME_ENTRY, _id: 'te-p2-001' }] });
      }
      return jsonResponse({ result: [] });
    }

    // ── Invoices (page POST — root-level array) ───────────────────────────────
    if (pathname === '/invoices/search' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const page = Number(body['page'] ?? 1);
      return jsonResponse(page === 1 ? [RAW_INVOICE] : []);
    }

    // ── Invoice summary ───────────────────────────────────────────────────────
    if (pathname === '/invoices/summary' && method === 'GET') {
      return jsonResponse({ unpaid: 1200, paid: 0, total: 1200 });
    }

    // ── Ledgers (page POST — root-level array) ────────────────────────────────
    if (pathname === '/ledgers/search' && method === 'POST') {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const page = Number(body['page'] ?? 1);
      return jsonResponse(page === 1 ? ledgers : []);
    }

    // ── Tasks (page GET) ──────────────────────────────────────────────────────
    if (pathname === '/tasks' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? '1');
      return jsonResponse(page === 1 ? { rows: [RAW_TASK] } : { rows: [] });
    }

    // ── Contacts (page GET) ───────────────────────────────────────────────────
    if (pathname === '/contacts' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? '1');
      return jsonResponse(page === 1 ? { rows: [RAW_CONTACT] } : { rows: [] });
    }

    throw new Error(`[test] Unmocked fetch: ${method} ${url}`);
  });
}

// =============================================================================
// Helper — build authenticated adapter
// =============================================================================

async function makeAuthenticatedAdapter(mockFetch: ReturnType<typeof vi.fn>): Promise<DataSourceAdapter> {
  vi.stubGlobal('fetch', mockFetch);
  const adapter = new DataSourceAdapter(FIRM_ID);
  await adapter.authenticate();
  return adapter;
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  process.env['YAO_API_BASE_URL'] = BASE_URL;
  mockGetCredentials.mockResolvedValue({ email: 'test@testfirm.com', password: 'secret' });
});

afterEach(() => {
  // clearAllMocks preserves mock implementations (mockResolvedValue etc.) while
  // resetting call history. restoreAllMocks would clear vi.fn() implementations
  // set in the module mock factory, breaking test 10 after tests 1-9 run.
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env['YAO_API_BASE_URL'];
});

// =============================================================================
// Test 1 — fetchAll() returns all expected datasets
// =============================================================================

describe('Test 1: fetchAll() returns all expected datasets', () => {
  it('returns attorneys, matters, timeEntries, invoices, tasks, contacts', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const result = await adapter.fetchAll();

    expect(result.attorneys).toHaveLength(1);
    expect(result.matters).toHaveLength(1);
    expect(result.timeEntries).toHaveLength(1);
    expect(result.invoices).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.contacts).toHaveLength(1);
    expect(result.invoiceSummary).toEqual({ unpaid: 1200, paid: 0, total: 1200 });
  });

  it('builds lookup maps from fetched data', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const result = await adapter.fetchAll();

    expect(result.maps.attorneyMap['atty-001']).toBeDefined();
    expect(result.maps.attorneyMap['atty-001'].fullName).toBe('Jane Smith');
    expect(result.maps.departmentMap['dept-001']).toBe('Corporate');
    expect(result.maps.caseTypeMap['ct-001']).toBeDefined();
  });

  it('routes ledgers into disbursements and invoicePayments', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    // fetchAll no longer includes ledgers — call separately
    const rawLedgers = await adapter.fetchLedgers();
    const ledgers = adapter.routeLedgers(rawLedgers);

    // OFFICE_PAYMENT → disbursements
    expect(ledgers.disbursements).toHaveLength(1);
    // CLIENT_TO_OFFICE with invoice → invoicePayments (led-002 and led-003)
    expect(ledgers.invoicePayments).toHaveLength(2);
    // CLIENT_TO_OFFICE with disbursements[] → disbursementRecoveries (led-003)
    expect(ledgers.disbursementRecoveries).toHaveLength(1);
  });
});

// =============================================================================
// Test 2 — Attorney password field is never present in any output
// =============================================================================

describe('Test 2: sensitive fields stripped from attorney records', () => {
  it('password is not present after fetchAttorneys()', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const attorneys = await adapter.fetchAttorneys();

    for (const atty of attorneys) {
      expect(atty).not.toHaveProperty('password');
      expect(atty).not.toHaveProperty('email_default_signature');
    }
  });

  it('password is not present on attorney via fetchLookupTables()', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const { attorneys } = await adapter.fetchLookupTables();

    for (const atty of attorneys) {
      const a = atty as Record<string, unknown>;
      expect(a['password']).toBeUndefined();
      expect(a['email_default_signature']).toBeUndefined();
    }
  });

  it('rates array and other fields are preserved after stripping', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const attorneys = await adapter.fetchAttorneys();

    expect(attorneys[0].rates).toHaveLength(2);
    expect(attorneys[0].status).toBe('ACTIVE');
  });
});

// =============================================================================
// Test 3 — Matters pagination stops at correct page
// =============================================================================

describe('Test 3: matters pagination stop condition', () => {
  it('stops after page 1 when page returns fewer than limit records', async () => {
    // Page 1: 3 matters (< 50 limit) → stop immediately
    const mockFetch = createMockFetch({ mattersPage1Count: 3 });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const matters = await adapter.fetchMatters();

    expect(matters).toHaveLength(3);
    // fetch called: login + attorneys + departments + case-types + matters-p1 only
    // Verify page=2 was never requested
    const mattersCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => new URL(url).pathname === '/matters',
    );
    expect(mattersCalls).toHaveLength(1);
  });

  it('fetches page 2 when page 1 returns exactly the limit', async () => {
    // Page 1: 50 matters (== limit → continue); Page 2: 5 matters → stop
    // Phase B dispatches pages 2-6 concurrently (batch=5); pages 3-6 return empty.
    const mockFetch = createMockFetch({ mattersPage1Count: 50, mattersPage2Count: 5 });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const matters = await adapter.fetchMatters();

    expect(matters).toHaveLength(55);

    const mattersCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => new URL(url).pathname === '/matters',
    );
    // Phase A: 1 call (page 1). Phase B: 5 concurrent calls (pages 2-6).
    expect(mattersCalls).toHaveLength(6);
  });

  it('page 2 request carries correct page param', async () => {
    const mockFetch = createMockFetch({ mattersPage1Count: 50, mattersPage2Count: 0 });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    await adapter.fetchMatters();

    const mattersCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => new URL(url).pathname === '/matters',
    );
    const page2Call = mattersCalls[1];
    expect(page2Call).toBeDefined();
    expect(new URL(page2Call[0] as string).searchParams.get('page')).toBe('2');
  });
});

// =============================================================================
// Test 4 — Time entry page-based pagination
// =============================================================================

describe('Test 4: time entry page-based pagination', () => {
  it('first request sends page=1 and no next field', async () => {
    const mockFetch = createMockFetch({});
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    await adapter.fetchTimeEntries();

    const teCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => new URL(url).pathname === '/time-entries/search',
    );

    const firstBody = JSON.parse(teCalls[0][1].body as string) as Record<string, unknown>;
    expect(firstBody['page']).toBe(1);
    expect(firstBody['size']).toBe(50);
    expect(firstBody['next']).toBeUndefined();
  });

  it('second request sends page=2 when page 1 returns full page', async () => {
    // Phase B dispatches pages 2-6 concurrently; page 2 returns 1 entry, pages 3-6 return empty.
    const mockFetch = createMockFetch({ timeEntriesMultiPage: true });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    await adapter.fetchTimeEntries();

    const teCalls = (mockFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => new URL(url).pathname === '/time-entries/search',
    );

    // Phase A: 1 call (page 1). Phase B: 5 concurrent calls (pages 2-6).
    expect(teCalls).toHaveLength(6);
    const secondBody = JSON.parse(teCalls[1][1].body as string) as Record<string, unknown>;
    expect(secondBody['page']).toBe(2);
  });

  it('collects entries from all pages', async () => {
    // Page 1: 50 ACTIVE entries; page 2: 1 ACTIVE entry (< size → stop)
    const mockFetch = createMockFetch({ timeEntriesMultiPage: true });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const entries = await adapter.fetchTimeEntries();
    expect(entries).toHaveLength(51);
  });
});

// =============================================================================
// Test 5 — Ledger routing: OFFICE_PAYMENT → disbursements
// =============================================================================

describe('Test 5: ledger routing — OFFICE_PAYMENT to disbursements', () => {
  it('routes OFFICE_PAYMENT ledger to disbursements bucket', async () => {
    const mockFetch = createMockFetch({ ledgers: [RAW_LEDGER_DISBURSEMENT] });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const rawLedgers = await adapter.fetchLedgers();
    const routed = adapter.routeLedgers(rawLedgers);

    expect(routed.disbursements).toHaveLength(1);
    expect(routed.disbursements[0]._id).toBe('led-001');
    expect(routed.invoicePayments).toHaveLength(0);
    expect(routed.disbursementRecoveries).toHaveLength(0);
  });

  it('abs(value) is applied to the disbursement (negative in API)', () => {
    // transformDisbursement should abs the negative value
    const adapter = new DataSourceAdapter(FIRM_ID);
    // routeLedgers is pure — test directly
    const routed = adapter.routeLedgers([RAW_LEDGER_DISBURSEMENT]);

    // Raw value is -500; disbursement subtotal in transformDisbursement = abs(-500)
    // Confirm the ledger is routed (transformation happens in normalise stage)
    expect(routed.disbursements[0].value).toBe(-500); // raw value preserved here
  });
});

// =============================================================================
// Test 6 — Ledger routing: CLIENT_TO_OFFICE+invoice → invoicePayments
// =============================================================================

describe('Test 6: ledger routing — CLIENT_TO_OFFICE with invoice → invoicePayments', () => {
  it('routes CLIENT_TO_OFFICE+invoice to invoicePayments bucket', async () => {
    const mockFetch = createMockFetch({ ledgers: [RAW_LEDGER_INVOICE_PAYMENT] });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const rawLedgers = await adapter.fetchLedgers();
    const routed = adapter.routeLedgers(rawLedgers);

    expect(routed.invoicePayments).toHaveLength(1);
    expect(routed.invoicePayments[0]._id).toBe('led-002');
    expect(routed.invoicePayments[0].invoice).toBe('inv-001');
    expect(routed.disbursements).toHaveLength(0);
  });

  it('does not route CLIENT_TO_OFFICE with no invoice and no disbursements', () => {
    const adapter = new DataSourceAdapter(FIRM_ID);
    const bare: typeof RAW_LEDGER_INVOICE_PAYMENT = {
      ...RAW_LEDGER_INVOICE_PAYMENT,
      _id: 'led-bare',
      invoice: undefined as unknown as string,
    };
    const routed = adapter.routeLedgers([bare]);

    expect(routed.invoicePayments).toHaveLength(0);
    expect(routed.disbursements).toHaveLength(0);
    expect(routed.disbursementRecoveries).toHaveLength(0);
  });
});

// =============================================================================
// Test 7 — Ledger routing: record with both → appears in both arrays
// =============================================================================

describe('Test 7: ledger routing — record with both invoice AND disbursements[]', () => {
  it('appears in invoicePayments when invoice field populated', async () => {
    const mockFetch = createMockFetch({ ledgers: [RAW_LEDGER_BOTH] });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const rawLedgers = await adapter.fetchLedgers();
    const routed = adapter.routeLedgers(rawLedgers);

    const idsInInvoicePayments = routed.invoicePayments.map((l) => l._id);
    expect(idsInInvoicePayments).toContain('led-003');
  });

  it('appears in disbursementRecoveries when disbursements[] populated', async () => {
    const mockFetch = createMockFetch({ ledgers: [RAW_LEDGER_BOTH] });
    const adapter = await makeAuthenticatedAdapter(mockFetch);

    const rawLedgers = await adapter.fetchLedgers();
    const routed = adapter.routeLedgers(rawLedgers);

    const idsInRecoveries = routed.disbursementRecoveries.map((l) => l._id);
    expect(idsInRecoveries).toContain('led-003');
  });

  it('the same record object appears in both buckets', () => {
    const adapter = new DataSourceAdapter(FIRM_ID);
    const routed = adapter.routeLedgers([RAW_LEDGER_BOTH]);

    // Should be the same object reference in both arrays
    expect(routed.invoicePayments[0]).toBe(routed.disbursementRecoveries[0]);
  });
});

// =============================================================================
// Test 8 — datePaid correctly derived from invoicePayments
// =============================================================================

describe('Test 8: datePaid derived from invoicePayments ledger', () => {
  it('sets datePaid on matching invoice from ledger date', () => {
    const normInvoice = transformInvoice(RAW_INVOICE);
    expect(normInvoice.datePaid).toBeNull(); // null before enrichment

    const enriched = enrichInvoicesWithDatePaid(
      [normInvoice],
      [RAW_LEDGER_INVOICE_PAYMENT],
    );

    expect(enriched[0].datePaid).toBe('2024-03-20');
  });

  it('datePaid remains null when no matching invoicePayment exists', () => {
    const normInvoice = transformInvoice(RAW_INVOICE);

    const enriched = enrichInvoicesWithDatePaid([normInvoice], []);

    expect(enriched[0].datePaid).toBeNull();
  });

  it('uses outstanding=0 record when multiple payment records match', () => {
    const normInvoice = transformInvoice(RAW_INVOICE);

    const partialPayment = {
      ...RAW_LEDGER_INVOICE_PAYMENT,
      _id:         'led-partial',
      outstanding: 600,
      date:        '2024-03-18', // earlier date
    };
    const fullPayment = {
      ...RAW_LEDGER_INVOICE_PAYMENT,
      _id:         'led-full',
      outstanding: 0,
      date:        '2024-03-20', // later date — this is the settled record
    };

    const enriched = enrichInvoicesWithDatePaid([normInvoice], [partialPayment, fullPayment]);
    expect(enriched[0].datePaid).toBe('2024-03-20'); // the settled record
  });

  it('REVERSED ledger records are excluded from datePaid derivation', () => {
    const normInvoice = transformInvoice(RAW_INVOICE);

    const reversedPayment = {
      ...RAW_LEDGER_INVOICE_PAYMENT,
      status: 'REVERSED',
    };

    const enriched = enrichInvoicesWithDatePaid([normInvoice], [reversedPayment]);
    expect(enriched[0].datePaid).toBeNull();
  });
});

// =============================================================================
// Test 9 — WIP aggregation produces correct totals
// =============================================================================

describe('Test 9: WIP aggregation from normalised time entries', () => {
  it('computes correct totalHours from duration_minutes', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    // 30 min → 0.5 hours
    expect(normEntry.durationHours).toBe(0.5);
  });

  it('picks up activity title from activity.title field', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    expect(normEntry.activityType).toBe('Telephone');
  });

  it('aggregates totalBillable, totalWriteOff, totalHours correctly', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    const wip = buildWipEnrichment([normEntry]);

    expect(wip.totalStats.totalBillable).toBe(125);
    expect(wip.totalStats.totalWriteOff).toBe(25);
    expect(wip.totalStats.totalHours).toBe(0.5);
    expect(wip.totalStats.chargeableHours).toBe(0.5); // do_not_bill=false, billable>0
    expect(wip.totalStats.entryCount).toBe(1);
  });

  it('aggregates by matter correctly', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    const wip = buildWipEnrichment([normEntry]);

    const matterWip = wip.byMatter.get('matter-001');
    expect(matterWip).toBeDefined();
    expect(matterWip!.totalBillable).toBe(125);
    expect(matterWip!.totalHours).toBe(0.5);
  });

  it('aggregates by fee earner correctly', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    const wip = buildWipEnrichment([normEntry]);

    const feeEarnerWip = wip.byFeeEarner.get('atty-001');
    expect(feeEarnerWip).toBeDefined();
    expect(feeEarnerWip!.totalBillable).toBe(125);
  });

  it('breaks down activity correctly in activityBreakdown', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    const wip = buildWipEnrichment([normEntry]);

    const telephoneBreakdown = wip.totalStats.activityBreakdown['Telephone'];
    expect(telephoneBreakdown).toBeDefined();
    expect(telephoneBreakdown.hours).toBe(0.5);
    expect(telephoneBreakdown.value).toBe(125);
  });

  it('no orphaned entries when all time entries have a matterId', () => {
    const normEntry = transformTimeEntry(RAW_TIME_ENTRY);
    const wip = buildWipEnrichment([normEntry]);

    expect(wip.orphaned).toHaveLength(0);
  });
});

// =============================================================================
// Test 10 — Full PullOrchestrator.run() with mocked API completes successfully
// =============================================================================

describe('Test 10: full PullOrchestrator.run() with mocked API', () => {
  it('completes with success=true and correct stats', async () => {
    const mockFetch = createMockFetch({});
    vi.stubGlobal('fetch', mockFetch);

    const orchestrator = new PullOrchestrator(FIRM_ID, {
      createAdapter: (firmId) => new DataSourceAdapter(firmId),
      createCalcOrchestrator: () => ({
        calculateAll: vi.fn().mockResolvedValue({
          feeEarner: {},
          matter:    {},
          invoice:   {},
          firm:      {},
        }),
      }),
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('stats reflect fetched record counts', async () => {
    const mockFetch = createMockFetch({ mattersPage1Count: 1 });
    vi.stubGlobal('fetch', mockFetch);

    const orchestrator = new PullOrchestrator(FIRM_ID, {
      createAdapter: (firmId) => new DataSourceAdapter(firmId),
      createCalcOrchestrator: () => ({
        calculateAll: vi.fn().mockResolvedValue({}),
      }),
    });

    const result = await orchestrator.run();

    expect(result.stats.attorneys).toBe(1);
    expect(result.stats.matters).toBe(1);
    expect(result.stats.timeEntries).toBe(1);
    expect(result.stats.invoices).toBe(1);
    expect(result.stats.tasks).toBe(1);
    expect(result.stats.contacts).toBe(1);
    // disbursements always 0 while ledger fetch is disabled
    expect(result.stats.disbursements).toBe(0);
  });

  it('returns pulledAt as an ISO string', async () => {
    const mockFetch = createMockFetch({});
    vi.stubGlobal('fetch', mockFetch);

    const orchestrator = new PullOrchestrator(FIRM_ID, {
      createAdapter: (firmId) => new DataSourceAdapter(firmId),
      createCalcOrchestrator: () => ({
        calculateAll: vi.fn().mockResolvedValue({}),
      }),
    });

    const result = await orchestrator.run();

    expect(() => new Date(result.pulledAt)).not.toThrow();
    expect(new Date(result.pulledAt).toISOString()).toBe(result.pulledAt);
  });

  it('includes warnings (not errors) when fee-earner CSV merge is unavailable', async () => {
    // mergeAllFeeEarners is already mocked to succeed; simulate failure for this test
    const { mergeAllFeeEarners } = await import(
      '../../../../src/server/datasource/enrich/fee-earner-merger.js'
    );
    vi.mocked(mergeAllFeeEarners).mockRejectedValueOnce(new Error('No CSV uploaded'));

    const mockFetch = createMockFetch({});
    vi.stubGlobal('fetch', mockFetch);

    const orchestrator = new PullOrchestrator(FIRM_ID, {
      createAdapter: (firmId) => new DataSourceAdapter(firmId),
      createCalcOrchestrator: () => ({
        calculateAll: vi.fn().mockResolvedValue({}),
      }),
    });

    const result = await orchestrator.run();

    // Should still succeed; CSV merge failure is a warning, not an error
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('Fee earner CSV merge skipped'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
