/**
 * tests/server/functions/calculate.test.ts
 *
 * Tests for the calculation trigger and status API.
 * All external dependencies are mocked — no MongoDB or Netlify runtime needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) { super(msg); }
  },
}));

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getRecalculationFlag:      vi.fn(),
  getLatestCalculatedKpis:   vi.fn(),
  createHistoricalSnapshot:  vi.fn(),
  getTodayHistoricalSnapshot: vi.fn(),
  setCalculationInProgress:  vi.fn(),
  setCalculationError:       vi.fn(),
}));

vi.mock('../../../src/server/formula-engine/orchestrator.js', () => ({
  CalculationOrchestrator: vi.fn(),
}));

import { handler } from '../../../src/server/functions/calculate.js';
import * as auth  from '../../../src/server/lib/auth-middleware.js';
import * as mongo from '../../../src/server/lib/mongodb-operations.js';
import { CalculationOrchestrator } from '../../../src/server/formula-engine/orchestrator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  qs: Record<string, string> = {},
): HandlerEvent {
  return {
    httpMethod:              method,
    path,
    headers:                 { authorization: 'Bearer tok' },
    body:                    body ? JSON.stringify(body) : null,
    queryStringParameters:   qs,
    pathParameters:          null,
    multiValueHeaders:       {},
    multiValueQueryStringParameters: null,
    isBase64Encoded:         false,
    rawUrl:                  path,
    rawQuery:                '',
  };
}

const CALC_RESULT = {
  firmId:               'firm-1',
  calculatedAt:         '2026-03-25T12:00:00.000Z',
  configVersion:        'cv-1',
  dataVersion:          'dv-1',
  formulaVersionSnapshot: {},
  results:              {},
  snippetResults:       {},
  ragAssignments:       {},
  ragSummary:           { green: 8, amber: 3, red: 1, alertsRed: [], alertsAmber: [] },
  readiness:            {},
  executionPlan:        { formulaOrder: [], skippedFormulas: [], snippetOrder: [] },
  totalExecutionTimeMs: 420,
  formulaCount:         12,
  successCount:         11,
  errorCount:           1,
  errors:               [{ formulaId: 'F-TU-01', error: 'Missing data' }],
};

const STALE_FLAG = {
  firm_id:     'firm-1',
  is_stale:    true,
  stale_since: new Date('2026-03-25T10:00:00.000Z'),
};

const CURRENT_FLAG = {
  firm_id:       'firm-1',
  is_stale:      false,
  stale_since:   new Date('2026-03-25T09:00:00.000Z'),
  is_calculating: false,
};

const KPI_DOC = {
  firm_id:        'firm-1',
  calculated_at:  new Date('2026-03-25T11:00:00.000Z'),
  config_version: 'cv-1',
  data_version:   'dv-1',
  kpis:           {},
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u-1', firmId: 'firm-1', role: 'user' });
  vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(STALE_FLAG as never);
  vi.mocked(mongo.getLatestCalculatedKpis).mockResolvedValue(KPI_DOC as never);
  vi.mocked(mongo.setCalculationInProgress).mockResolvedValue(undefined);
  vi.mocked(mongo.setCalculationError).mockResolvedValue(undefined);
  vi.mocked(mongo.createHistoricalSnapshot).mockResolvedValue(undefined);
  vi.mocked(mongo.getTodayHistoricalSnapshot).mockResolvedValue(null); // no snapshot today yet

  const mockOrchestrator = {
    calculateAll:          vi.fn().mockResolvedValue(CALC_RESULT),
    recalculateAffected:   vi.fn().mockResolvedValue(CALC_RESULT),
  };
  vi.mocked(CalculationOrchestrator).mockImplementation(() => mockOrchestrator as never);
});

// ---------------------------------------------------------------------------
// POST /api/calculate — stale → full recalculation
// ---------------------------------------------------------------------------

describe('POST /api/calculate — recalculation', () => {
  it('returns 200 with status:complete when stale', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('complete');
    expect(body.calculatedAt).toBe(CALC_RESULT.calculatedAt);
  });

  it('includes kpiSummary with formula counts and RAG totals', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.kpiSummary.formulaCount).toBe(12);
    expect(body.kpiSummary.successCount).toBe(11);
    expect(body.kpiSummary.errorCount).toBe(1);
    expect(body.kpiSummary.ragSummaryGreen).toBe(8);
    expect(body.kpiSummary.ragSummaryAmber).toBe(3);
    expect(body.kpiSummary.ragSummaryRed).toBe(1);
  });

  it('sets is_calculating flag before running the orchestrator', async () => {
    await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(vi.mocked(mongo.setCalculationInProgress)).toHaveBeenCalledWith('firm-1');
  });

  it('creates a daily historical snapshot when none exists today', async () => {
    await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(vi.mocked(mongo.getTodayHistoricalSnapshot)).toHaveBeenCalledWith('firm-1');
    expect(vi.mocked(mongo.createHistoricalSnapshot)).toHaveBeenCalledWith(
      'firm-1', 'daily', expect.objectContaining({ firmId: 'firm-1' }),
    );
  });

  it('skips historical snapshot when one already exists today', async () => {
    vi.mocked(mongo.getTodayHistoricalSnapshot).mockResolvedValue({ firm_id: 'firm-1' } as never);
    await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(vi.mocked(mongo.createHistoricalSnapshot)).not.toHaveBeenCalled();
  });

  it('passes firmId from auth to orchestrator, never from request', async () => {
    vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u', firmId: 'firm-99', role: 'user' });
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue({ ...STALE_FLAG, firm_id: 'firm-99' } as never);
    await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    const mockOrch = vi.mocked(CalculationOrchestrator).mock.results[0].value as { calculateAll: ReturnType<typeof vi.fn> };
    expect(mockOrch.calculateAll).toHaveBeenCalledWith('firm-99');
  });
});

// ---------------------------------------------------------------------------
// POST /api/calculate — current (not stale)
// ---------------------------------------------------------------------------

describe('POST /api/calculate — already current', () => {
  beforeEach(() => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(CURRENT_FLAG as never);
  });

  it('returns status:current without running the orchestrator', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('current');
    expect(vi.mocked(CalculationOrchestrator)).not.toHaveBeenCalled();
  });

  it('includes calculatedAt from the KPI doc', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.calculatedAt).toBe('2026-03-25T11:00:00.000Z');
  });

  it('force=true in body triggers recalculation even when current', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate', { force: true }), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('complete');
    expect(vi.mocked(CalculationOrchestrator)).toHaveBeenCalled();
  });

  it('force=true as query string triggers recalculation', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate', undefined, { force: 'true' }), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// POST /api/calculate — no data (empty MongoDB)
// ---------------------------------------------------------------------------

describe('POST /api/calculate — no data', () => {
  it('returns status:complete gracefully when orchestrator returns empty results', async () => {
    const emptyResult = {
      ...CALC_RESULT,
      formulaCount: 0, successCount: 0, errorCount: 0, errors: [],
      ragSummary: { green: 0, amber: 0, red: 0, alertsRed: [], alertsAmber: [] },
      executionPlan: { formulaOrder: [], skippedFormulas: [], snippetOrder: [] },
    };
    const mockOrchestrator = { calculateAll: vi.fn().mockResolvedValue(emptyResult) };
    vi.mocked(CalculationOrchestrator).mockImplementation(() => mockOrchestrator as never);

    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('complete');
    expect(body.kpiSummary.formulaCount).toBe(0);
  });

  it('returns 500 with error details when orchestrator throws, not a crash', async () => {
    const mockOrchestrator = {
      calculateAll: vi.fn().mockRejectedValue(new Error('No enriched data found')),
    };
    vi.mocked(CalculationOrchestrator).mockImplementation(() => mockOrchestrator as never);

    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(res?.statusCode).toBe(500);
    const body = JSON.parse(res!.body!);
    expect(body.error).toBe('Calculation failed');
    expect(body.details.message).toContain('No enriched data found');
  });

  it('records the error in MongoDB when orchestrator throws', async () => {
    const mockOrchestrator = {
      calculateAll: vi.fn().mockRejectedValue(new Error('Pipeline error')),
    };
    vi.mocked(CalculationOrchestrator).mockImplementation(() => mockOrchestrator as never);

    await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(vi.mocked(mongo.setCalculationError)).toHaveBeenCalledWith('firm-1', 'Pipeline error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/calculate/status
// ---------------------------------------------------------------------------

describe('GET /api/calculate/status', () => {
  it('returns status:stale when flag is_stale=true', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(STALE_FLAG as never);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('stale');
    expect(body.staleSince).toBe('2026-03-25T10:00:00.000Z');
  });

  it('returns status:current when flag is_stale=false', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(CURRENT_FLAG as never);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('current');
    expect(body.staleSince).toBeNull();
  });

  it('returns status:calculating when is_calculating=true', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue({
      ...STALE_FLAG, is_calculating: true,
    } as never);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('calculating');
  });

  it('returns status:error when is_stale=true and last_error is set', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue({
      ...STALE_FLAG,
      is_calculating: false,
      last_error: 'Pipeline blew up',
    } as never);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('error');
    expect(body.error).toBe('Pipeline blew up');
  });

  it('returns status:current when no flag document exists', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(null);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.status).toBe('current');
  });

  it('includes lastCalculatedAt from the KPI doc', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(CURRENT_FLAG as never);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.lastCalculatedAt).toBe('2026-03-25T11:00:00.000Z');
  });

  it('returns lastCalculatedAt:null when no KPI doc exists', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(CURRENT_FLAG as never);
    vi.mocked(mongo.getLatestCalculatedKpis).mockResolvedValue(null);
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    const body = JSON.parse(res!.body!);
    expect(body.lastCalculatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth & routing errors
// ---------------------------------------------------------------------------

describe('auth and routing', () => {
  it('returns 401 for unauthenticated POST', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(new (AuthError as never)('Unauthorised', 401));
    const res = await handler(makeEvent('POST', '/api/calculate'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });

  it('returns 401 for unauthenticated GET status', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(new (AuthError as never)('Unauthorised', 401));
    const res = await handler(makeEvent('GET', '/api/calculate/status'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });

  it('returns 405 for GET on /api/calculate (not a status path)', async () => {
    vi.mocked(mongo.getRecalculationFlag).mockResolvedValue(CURRENT_FLAG as never);
    const res = await handler(makeEvent('GET', '/api/calculate'), {} as never, () => {});
    expect(res?.statusCode).toBe(405);
  });

  it('returns 404 for unknown sub-path', async () => {
    const res = await handler(makeEvent('POST', '/api/calculate/unknown'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });
});
