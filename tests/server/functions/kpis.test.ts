import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before importing the handler
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
  getLatestCalculatedKpis: vi.fn(),
  getRecalculationFlag: vi.fn(),
}));

import { handler } from '../../../src/server/functions/kpis.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(path: string, method = 'GET'): HandlerEvent {
  return {
    httpMethod: method,
    path,
    headers: { authorization: 'Bearer test-token' },
    body: null,
    queryStringParameters: {},
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

const FORMULA_RESULT = {
  formulaId: 'F-TU-01',
  formulaName: 'Chargeable Utilisation Rate',
  variantUsed: 'strict_chargeable',
  resultType: 'percentage',
  entityResults: {
    'lawyer-1': { entityId: 'lawyer-1', entityName: 'Alice', value: 75.5, formattedValue: '75.5%', nullReason: null },
  },
  summary: { mean: 75.5, median: 75.5, min: 75.5, max: 75.5, total: 75.5, count: 1, nullCount: 0 },
  computedAt: '2024-06-01T12:00:00.000Z',
  metadata: { executionTimeMs: 5, inputsUsed: [], nullReasons: [], warnings: [] },
};

const RAG_ASSIGNMENT = {
  status: 'GREEN',
  value: 75.5,
  thresholdUsed: 'default',
  boundaries: { green: { min: 70, max: 100 }, amber: { min: 50, max: 70 }, red: { min: 0, max: 50 } },
  distanceToNext: 4.5,
};

function makeKpisDoc() {
  return {
    firm_id: 'firm-1',
    calculated_at: new Date('2024-06-01T12:00:00.000Z'),
    config_version: '2024-06-01T00:00:00.000Z',
    data_version: '2024-06-01T00:00:00.000Z',
    kpis: {
      aggregate: { feeEarners: [], matters: [], firm: {} },
      generatedAt: '2024-06-01T00:00:00.000Z',
      formulaResults: { 'F-TU-01': FORMULA_RESULT },
      ragAssignments: { 'F-TU-01': { 'lawyer-1': RAG_ASSIGNMENT } },
      ragSummary: {
        totalAssignments: 1, greenCount: 1, amberCount: 0, redCount: 0, neutralCount: 0,
        alertsRed: [], alertsAmber: [],
      },
      readiness: {
        'F-TU-01': {
          formulaId: 'F-TU-01', readiness: 'BLOCKED',
          requiredInputs: [], optionalInputs: [],
          message: 'Blocked — no WIP data',
          blockedReason: 'No WIP data',
        },
      },
      formulaVersionSnapshot: { 'F-TU-01': 1 },
      calculationMetadata: { totalExecutionTimeMs: 100, formulaCount: 1, successCount: 0, errorCount: 0, errors: [], blockedCount: 1, calculatedAt: '2024-06-01T12:00:00.000Z' },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/kpis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue({ firm_id: 'firm-1', is_stale: false, stale_since: new Date() });
  });

  it('returns 405 for non-GET requests', async () => {
    const res = await handler(makeEvent('/api/kpis', 'POST'), {} as never, () => {});
    expect(res?.statusCode).toBe(405);
  });

  it('returns empty results when no KPI document exists', async () => {
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(null);
    const res = await handler(makeEvent('/api/kpis'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.calculatedAt).toBeNull();
    expect(body.results).toEqual({});
  });

  it('returns formula results from the KPI document', async () => {
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
    const res = await handler(makeEvent('/api/kpis'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.results).toHaveProperty('F-TU-01');
    expect(body.results['F-TU-01'].formulaId).toBe('F-TU-01');
  });

  it('includes ragAssignments and ragSummary', async () => {
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
    const res = await handler(makeEvent('/api/kpis'), {} as never, () => {});
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.ragAssignments).toHaveProperty('F-TU-01');
    expect(body.ragSummary.greenCount).toBe(1);
  });

  it('includes isStale flag from recalculation_flags', async () => {
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue({ firm_id: 'firm-1', is_stale: true, stale_since: new Date() });
    const res = await handler(makeEvent('/api/kpis'), {} as never, () => {});
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.isStale).toBe(true);
  });
});

describe('GET /api/kpis/stale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('returns isStale: true when flag is set', async () => {
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue({ firm_id: 'firm-1', is_stale: true, stale_since: new Date() });
    const res = await handler(makeEvent('/api/kpis/stale'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.isStale).toBe(true);
  });

  it('returns isStale: false when no flag', async () => {
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue(null);
    const res = await handler(makeEvent('/api/kpis/stale'), {} as never, () => {});
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.isStale).toBe(false);
  });
});

describe('GET /api/kpis/rag-summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue(null);
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  });

  it('returns ragSummary with counts and alert lists', async () => {
    const res = await handler(makeEvent('/api/kpis/rag-summary'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.ragSummary).toBeDefined();
    expect(body.ragSummary.greenCount).toBe(1);
    expect(Array.isArray(body.ragSummary.alertsRed)).toBe(true);
  });
});

describe('GET /api/kpis/readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue(null);
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  });

  it('returns readiness map', async () => {
    const res = await handler(makeEvent('/api/kpis/readiness'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.readiness).toHaveProperty('F-TU-01');
    expect(body.readiness['F-TU-01'].readiness).toBe('BLOCKED');
  });
});

describe('GET /api/kpis/formula/:formulaId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue(null);
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  });

  it('returns result for a known formula', async () => {
    const res = await handler(makeEvent('/api/kpis/formula/F-TU-01'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formulaId).toBe('F-TU-01');
    expect(body.result.formulaId).toBe('F-TU-01');
    expect(body.ragAssignments).toHaveProperty('lawyer-1');
  });

  it('returns 404 for unknown formula', async () => {
    const res = await handler(makeEvent('/api/kpis/formula/F-XX-99'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });
});

describe('GET /api/kpis/entity/:entityType/:entityId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(mongoOps.getRecalculationFlag).mockResolvedValue(null);
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  });

  it('returns all KPIs for a known entity', async () => {
    const res = await handler(makeEvent('/api/kpis/entity/feeEarner/lawyer-1'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.entityId).toBe('lawyer-1');
    expect(body.kpis).toHaveProperty('F-TU-01');
    expect(body.ragAssignments).toHaveProperty('F-TU-01');
  });

  it('returns empty kpis for an unknown entity', async () => {
    const res = await handler(makeEvent('/api/kpis/entity/feeEarner/unknown-entity'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.kpis).toEqual({});
  });

  it('enforces firm isolation — firmId always from auth, not path', async () => {
    // The handler only authenticates — firmId comes from auth token, not URL
    vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u', firmId: 'firm-1', role: 'user' });
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
    const res = await handler(makeEvent('/api/kpis/entity/feeEarner/lawyer-1'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    // Verify the MongoDB call used the firmId from auth
    expect(vi.mocked(mongoOps.getLatestCalculatedKpis)).toHaveBeenCalledWith('firm-1');
  });
});

describe('Authentication', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(
      new (AuthError as never)('Unauthorised', 401),
    );
    const res = await handler(makeEvent('/api/kpis'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });
});
