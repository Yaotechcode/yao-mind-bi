/**
 * tests/server/functions/dashboard-kpis.test.ts
 *
 * Tests for GET /api/dashboard-kpis and GET /api/dashboard-kpis/pull-status.
 * All external dependencies are mocked — no Supabase or Netlify runtime needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any module imports
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) {
      super(msg);
    }
  },
}));

vi.mock('../../../src/server/services/kpi-snapshot-service.js', () => ({
  getKpiSnapshots: vi.fn(),
  getLatestPullTime: vi.fn(),
}));

// Supabase mock — chainable builder
const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handler } from '../../../src/server/functions/dashboard-kpis.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as kpiService from '../../../src/server/services/kpi-snapshot-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  path: string,
  qs: Record<string, string> = {},
  method = 'GET',
): HandlerEvent {
  return {
    httpMethod: method,
    path,
    headers: { authorization: 'Bearer test-token' },
    body: null,
    queryStringParameters: qs,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: path,
    rawQuery: '',
  };
}

function mockAuth(firmId = 'firm-1') {
  vi.mocked(auth.authenticateRequest).mockResolvedValue({
    userId: 'user-1',
    firmId,
    role: 'user',
  });
}

function mockAuthError() {
  const { AuthError } = vi.mocked(auth) as unknown as {
    AuthError: new (msg: string, code: number) => Error & { statusCode: number };
  };
  vi.mocked(auth.authenticateRequest).mockRejectedValue(
    new AuthError('Unauthorised', 401),
  );
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    firm_id: 'firm-1',
    pulled_at: '2024-03-15T10:00:00Z',
    entity_type: 'feeEarner',
    entity_id: 'att-1',
    entity_name: 'Alice Smith',
    kpi_key: 'F-TU-01',
    kpi_value: 73.4,
    rag_status: 'green',
    period: 'current',
    display_value: '73.4%',
    ...overrides,
  };
}

/** Build a simple chainable Supabase builder for pull_status. */
function makePullStatusBuilder(data: unknown, error: { message: string } | null = null) {
  const builder: Record<string, unknown> = {};
  const terminal = { data, error };
  for (const m of ['select', 'eq']) {
    builder[m] = vi.fn().mockReturnValue(builder);
  }
  builder['maybeSingle'] = vi.fn().mockResolvedValue(terminal);
  return builder;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([]);
  vi.mocked(kpiService.getLatestPullTime).mockResolvedValue(null);
  mockFromFn.mockReturnValue(makePullStatusBuilder(null));
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Authentication', () => {
  it('returns 401 when no auth token is provided', async () => {
    mockAuthError();
    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);
    expect(res!.statusCode).toBe(401);
  });

  it('returns 405 for non-GET requests', async () => {
    mockAuth();
    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }, 'POST'), {} as never);
    expect(res!.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis — parameter validation
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis — parameter validation', () => {
  it('returns 400 when entityType is missing', async () => {
    mockAuth();
    const res = await handler(makeEvent('/api/dashboard-kpis'), {} as never);
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body ?? '{}')).toMatchObject({ error: expect.stringContaining('entityType') });
  });

  it('returns 400 for an invalid entityType', async () => {
    mockAuth();
    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'banana' }), {} as never);
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body ?? '{}')).toMatchObject({ error: expect.stringContaining('Invalid entityType') });
  });

  it('returns 404 for an unknown sub-path', async () => {
    mockAuth();
    const res = await handler(makeEvent('/api/dashboard-kpis/unknown'), {} as never);
    expect(res!.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis — firm isolation
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis — firm isolation', () => {
  it('only returns this firm\'s snapshots — passes firmId to getKpiSnapshots', async () => {
    mockAuth('firm-A');
    vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([makeRow({ firm_id: 'firm-A' })]);

    await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    const [calledFirmId] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(calledFirmId).toBe('firm-A');
  });

  it('does not return another firm\'s data — firmId from auth, not request', async () => {
    mockAuth('firm-A');
    vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([makeRow({ firm_id: 'firm-A' })]);

    // Even if an attacker passes firm-B in the query string it is ignored
    const res = await handler(
      makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner', firmId: 'firm-B' }),
      {} as never,
    );
    const [calledFirmId] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(calledFirmId).toBe('firm-A');
    expect(calledFirmId).not.toBe('firm-B');
    expect(res!.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis — entityType filter
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis — entityType filter', () => {
  it('passes entityType to getKpiSnapshots', async () => {
    mockAuth();
    await handler(makeEvent('/api/dashboard-kpis', { entityType: 'matter' }), {} as never);

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.entityType).toBe('matter');
  });

  it('accepts all valid entityType values', async () => {
    const validTypes = ['feeEarner', 'matter', 'invoice', 'disbursement', 'department', 'client', 'firm'];
    for (const et of validTypes) {
      vi.clearAllMocks();
      mockAuth();
      vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([]);
      vi.mocked(kpiService.getLatestPullTime).mockResolvedValue(null);
      mockFromFn.mockReturnValue(makePullStatusBuilder(null));

      const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: et }), {} as never);
      expect(res!.statusCode).toBe(200);
    }
  });

  it('passes period to getKpiSnapshots (defaults to current)', async () => {
    mockAuth();
    await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.period).toBe('current');
  });

  it('passes custom period to getKpiSnapshots', async () => {
    mockAuth();
    await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner', period: 'ytd' }), {} as never);

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.period).toBe('ytd');
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis — kpiKeys filter
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis — kpiKeys filter', () => {
  it('passes kpiKeys array to getKpiSnapshots when provided', async () => {
    mockAuth();
    await handler(
      makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner', kpiKeys: 'F-TU-01,F-RB-01' }),
      {} as never,
    );

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.kpiKeys).toEqual(['F-TU-01', 'F-RB-01']);
  });

  it('trims whitespace from comma-separated kpiKeys', async () => {
    mockAuth();
    await handler(
      makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner', kpiKeys: ' F-TU-01 , F-RB-01 ' }),
      {} as never,
    );

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.kpiKeys).toEqual(['F-TU-01', 'F-RB-01']);
  });

  it('does not pass kpiKeys when absent', async () => {
    mockAuth();
    await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.kpiKeys).toBeUndefined();
  });

  it('passes entityId as entityIds array when provided', async () => {
    mockAuth();
    await handler(
      makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner', entityId: 'att-1' }),
      {} as never,
    );

    const [, opts] = vi.mocked(kpiService.getKpiSnapshots).mock.calls[0];
    expect(opts?.entityIds).toEqual(['att-1']);
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis — response shape
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis — response shape', () => {
  it('returns 200 with correct shape when snapshots exist', async () => {
    mockAuth('firm-1');
    const rows = [makeRow(), makeRow({ entity_id: 'att-2', entity_name: 'Bob' })];
    vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue(rows);
    vi.mocked(kpiService.getLatestPullTime).mockResolvedValue('2024-03-15T10:00:00Z');

    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.firmId).toBe('firm-1');
    expect(body.entityType).toBe('feeEarner');
    expect(body.period).toBe('current');
    expect(body.snapshots).toHaveLength(2);
    expect(body.meta.totalRows).toBe(2);
    expect(body.meta.lastPulledAt).toBe('2024-03-15T10:00:00Z');
    expect(body.meta.pullStatus).toBe('complete');
  });

  it('returns pullStatus idle when no snapshots exist', async () => {
    mockAuth();
    vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([]);

    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    const body = JSON.parse(res!.body ?? '{}');
    expect(body.meta.pullStatus).toBe('idle');
    expect(body.snapshots).toHaveLength(0);
  });

  it('pulledAt is null when no snapshots have ever been written', async () => {
    mockAuth();
    vi.mocked(kpiService.getKpiSnapshots).mockResolvedValue([]);
    vi.mocked(kpiService.getLatestPullTime).mockResolvedValue(null);

    const res = await handler(makeEvent('/api/dashboard-kpis', { entityType: 'feeEarner' }), {} as never);

    const body = JSON.parse(res!.body ?? '{}');
    expect(body.pulledAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard-kpis/pull-status
// ---------------------------------------------------------------------------

describe('GET /api/dashboard-kpis/pull-status', () => {
  it('returns 401 without auth', async () => {
    mockAuthError();
    const res = await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);
    expect(res!.statusCode).toBe(401);
  });

  it('returns correct shape for an existing pull_status row', async () => {
    mockAuth('firm-1');
    const statusData = {
      status: 'complete',
      started_at: '2024-03-15T09:50:00Z',
      completed_at: '2024-03-15T10:00:00Z',
      pulled_at: '2024-03-15T10:00:00Z',
      current_stage: null,
      records_fetched: { matters: 250, timeEntries: 1800 },
      error: null,
    };
    mockFromFn.mockReturnValue(makePullStatusBuilder(statusData));

    const res = await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);

    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.status).toBe('complete');
    expect(body.startedAt).toBe('2024-03-15T09:50:00Z');
    expect(body.completedAt).toBe('2024-03-15T10:00:00Z');
    expect(body.pulledAt).toBe('2024-03-15T10:00:00Z');
    expect(body.currentStage).toBeNull();
    expect(body.recordsFetched).toEqual({ matters: 250, timeEntries: 1800 });
    expect(body.error).toBeNull();
  });

  it('returns idle status with nulls when no pull_status row exists', async () => {
    mockAuth('firm-1');
    mockFromFn.mockReturnValue(makePullStatusBuilder(null));

    const res = await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);

    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.status).toBe('idle');
    expect(body.startedAt).toBeNull();
    expect(body.completedAt).toBeNull();
    expect(body.pulledAt).toBeNull();
    expect(body.currentStage).toBeNull();
    expect(body.recordsFetched).toEqual({});
    expect(body.error).toBeNull();
  });

  it('queries pull_status filtered by firmId from auth (not request)', async () => {
    mockAuth('firm-A');
    const builder = makePullStatusBuilder(null);
    mockFromFn.mockReturnValue(builder);

    await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);

    expect(mockFromFn).toHaveBeenCalledWith('pull_status');
    expect(builder['eq']).toHaveBeenCalledWith('firm_id', 'firm-A');
  });

  it('returns 500 when Supabase query fails', async () => {
    mockAuth();
    mockFromFn.mockReturnValue(makePullStatusBuilder(null, { message: 'connection refused' }));

    const res = await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);

    expect(res!.statusCode).toBe(500);
  });

  it('returns status running with currentStage when a pull is in progress', async () => {
    mockAuth('firm-1');
    const statusData = {
      status: 'running',
      started_at: '2024-03-15T10:00:00Z',
      completed_at: null,
      pulled_at: null,
      current_stage: 'Fetching time entries',
      records_fetched: { matters: 250 },
      error: null,
    };
    mockFromFn.mockReturnValue(makePullStatusBuilder(statusData));

    const res = await handler(makeEvent('/api/dashboard-kpis/pull-status'), {} as never);

    const body = JSON.parse(res!.body ?? '{}');
    expect(body.status).toBe('running');
    expect(body.currentStage).toBe('Fetching time entries');
  });
});
