import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) {
      super(msg);
    }
  },
}));

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getRiskFlags: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handler } from '../../../src/server/functions/risk-flags.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongo from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(qs: Record<string, string> = {}, method = 'GET'): HandlerEvent {
  return {
    httpMethod: method,
    path: '/api/risk-flags',
    headers: { authorization: 'Bearer test-token' },
    body: null,
    queryStringParameters: qs,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: '/api/risk-flags',
    rawQuery: '',
  };
}

function mockAuth(firmId = 'firm-1', role = 'partner') {
  vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'user-1', firmId, role });
}

function mockAuthError(statusCode = 401) {
  const { AuthError } = vi.mocked(auth) as unknown as {
    AuthError: new (msg: string, code: number) => Error & { statusCode: number };
  };
  vi.mocked(auth.authenticateRequest).mockRejectedValue(
    new AuthError('Unauthorised', statusCode),
  );
}

function makeFlag(
  severity: 'high' | 'medium' | 'low' = 'high',
  flagType = 'WIP_AGE_HIGH',
  entityType = 'matter',
) {
  return {
    firm_id:     'firm-1',
    flagged_at:  new Date('2024-03-15T10:00:00Z'),
    entity_type: entityType,
    entity_id:   `${entityType}-1`,
    entity_name: `Test ${entityType}`,
    flag_type:   flagType,
    severity,
    detail:      'Test detail',
    kpi_value:   45,
    threshold:   30,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mongo.getRiskFlags).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Authentication', () => {
  it('returns 401 when no auth token is provided', async () => {
    mockAuthError(401);
    const res = await handler(makeEvent(), {} as never);
    expect(res!.statusCode).toBe(401);
  });

  it('returns 405 for non-GET requests', async () => {
    mockAuth();
    const res = await handler(makeEvent({}, 'POST'), {} as never);
    expect(res!.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Role guard
// ---------------------------------------------------------------------------

describe('Role guard — partner and above only', () => {
  const ALLOWED_ROLES = ['owner', 'admin', 'partner', 'department_head'];
  const DENIED_ROLES  = ['fee_earner', 'viewer'];

  for (const role of ALLOWED_ROLES) {
    it(`allows role: ${role}`, async () => {
      mockAuth('firm-1', role);
      const res = await handler(makeEvent(), {} as never);
      expect(res!.statusCode).toBe(200);
    });
  }

  for (const role of DENIED_ROLES) {
    it(`denies role: ${role} with 403`, async () => {
      mockAuth('firm-1', role);
      const res = await handler(makeEvent(), {} as never);
      expect(res!.statusCode).toBe(403);
    });
  }
});

// ---------------------------------------------------------------------------
// Firm isolation
// ---------------------------------------------------------------------------

describe('Firm isolation', () => {
  it('passes firmId from auth (not request) to getRiskFlags', async () => {
    mockAuth('firm-A');
    await handler(makeEvent(), {} as never);
    const [calledFirmId] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(calledFirmId).toBe('firm-A');
  });

  it('firmId in response matches auth firmId', async () => {
    mockAuth('firm-A');
    const res = await handler(makeEvent(), {} as never);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.firmId).toBe('firm-A');
  });
});

// ---------------------------------------------------------------------------
// Query parameter filters
// ---------------------------------------------------------------------------

describe('Query parameter filters', () => {
  it('passes severity filter to getRiskFlags', async () => {
    mockAuth();
    await handler(makeEvent({ severity: 'high' }), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.severity).toBe('high');
  });

  it('passes entityType filter as entity_type to getRiskFlags', async () => {
    mockAuth();
    await handler(makeEvent({ entityType: 'matter' }), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.entity_type).toBe('matter');
  });

  it('passes flagType filter as flag_type to getRiskFlags', async () => {
    mockAuth();
    await handler(makeEvent({ flagType: 'BAD_DEBT_RISK' }), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.flag_type).toBe('BAD_DEBT_RISK');
  });

  it('defaults limit to 50 when not provided', async () => {
    mockAuth();
    await handler(makeEvent(), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.limit).toBe(50);
  });

  it('passes custom limit to getRiskFlags', async () => {
    mockAuth();
    await handler(makeEvent({ limit: '10' }), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.limit).toBe(10);
  });

  it('clamps limit to 1 minimum', async () => {
    mockAuth();
    await handler(makeEvent({ limit: '0' }), {} as never);
    const [, opts] = vi.mocked(mongo.getRiskFlags).mock.calls[0];
    expect(opts?.limit).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 for invalid severity value', async () => {
    mockAuth();
    const res = await handler(makeEvent({ severity: 'critical' }), {} as never);
    expect(res!.statusCode).toBe(400);
    expect(JSON.parse(res!.body ?? '{}')).toMatchObject({ error: expect.stringContaining('severity') });
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('Response shape', () => {
  it('returns correct shape with empty flags', async () => {
    mockAuth('firm-1');
    vi.mocked(mongo.getRiskFlags).mockResolvedValue([]);

    const res = await handler(makeEvent(), {} as never);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body).toMatchObject({
      firmId:      'firm-1',
      flaggedAt:   null,
      totalCount:  0,
      highCount:   0,
      mediumCount: 0,
      lowCount:    0,
      flags:       [],
    });
  });

  it('counts severities correctly', async () => {
    mockAuth();
    vi.mocked(mongo.getRiskFlags).mockResolvedValue([
      makeFlag('high'),
      makeFlag('high'),
      makeFlag('medium'),
      makeFlag('low'),
    ] as never);

    const res = await handler(makeEvent(), {} as never);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.totalCount).toBe(4);
    expect(body.highCount).toBe(2);
    expect(body.mediumCount).toBe(1);
    expect(body.lowCount).toBe(1);
  });

  it('sets flaggedAt to the most recent flagged_at across all flags', async () => {
    mockAuth();
    vi.mocked(mongo.getRiskFlags).mockResolvedValue([
      { ...makeFlag('high'), flagged_at: new Date('2024-03-10T00:00:00Z') },
      { ...makeFlag('medium'), flagged_at: new Date('2024-03-15T10:00:00Z') },
      { ...makeFlag('low'), flagged_at: new Date('2024-03-12T00:00:00Z') },
    ] as never);

    const res = await handler(makeEvent(), {} as never);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.flaggedAt).toBe('2024-03-15T10:00:00.000Z');
  });

  it('flaggedAt is null when no flags exist', async () => {
    mockAuth();
    vi.mocked(mongo.getRiskFlags).mockResolvedValue([]);
    const res = await handler(makeEvent(), {} as never);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.flaggedAt).toBeNull();
  });

  it('flags array contains all returned flag objects', async () => {
    mockAuth();
    const flags = [makeFlag('high'), makeFlag('medium')];
    vi.mocked(mongo.getRiskFlags).mockResolvedValue(flags as never);

    const res = await handler(makeEvent(), {} as never);
    const body = JSON.parse(res!.body ?? '{}');
    expect(body.flags).toHaveLength(2);
  });

  it('returns 500 on unexpected MongoDB error', async () => {
    mockAuth();
    vi.mocked(mongo.getRiskFlags).mockRejectedValue(new Error('connection timeout'));

    const res = await handler(makeEvent(), {} as never);
    expect(res!.statusCode).toBe(500);
  });
});
