import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) { super(msg); }
  },
}));

vi.mock('../../../src/server/services/dashboard-service.js', () => ({
  getFirmOverviewData: vi.fn(),
  getFeeEarnerPerformanceData: vi.fn(),
  getWipData: vi.fn(),
  getBillingCollectionsData: vi.fn(),
  getMatterAnalysisData: vi.fn(),
  getClientIntelligenceData: vi.fn(),
}));

import { handler } from '../../../src/server/functions/dashboard.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as svc from '../../../src/server/services/dashboard-service.js';

function makeEvent(path: string, qs: Record<string, string> = {}): HandlerEvent {
  return { httpMethod: 'GET', path, headers: { authorization: 'Bearer tok' }, body: null, queryStringParameters: qs, pathParameters: null, multiValueHeaders: {}, multiValueQueryStringParameters: null, isBase64Encoded: false, rawUrl: path, rawQuery: '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u-1', firmId: 'firm-1', role: 'user' });
  vi.mocked(svc.getFirmOverviewData).mockResolvedValue({ kpiCards: {}, wipAgeBands: [], revenueTrend: [], topLeakageRisks: [], utilisationSnapshot: { green: 0, amber: 0, red: 0, feeEarners: [] }, departmentSummary: [], dataQuality: { issueCount: 0, criticalCount: 0 }, lastCalculated: null } as never);
  vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({ alerts: [], feeEarners: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, charts: { utilisationBars: [], chargeableStack: [] }, filters: { departments: [], grades: [], payModels: [] } } as never);
  vi.mocked(svc.getWipData).mockResolvedValue({ headlines: {}, ageBands: [], byDepartment: [], entries: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, writeOffAnalysis: {}, disbursementExposure: { totalExposure: 0, byMatter: [] }, filters: { departments: [], feeEarners: [], caseTypes: [] } } as never);
  vi.mocked(svc.getBillingCollectionsData).mockResolvedValue({ headlines: {}, pipeline: {}, agedDebtors: [], billingTrend: [], invoices: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, slowPayers: null, filters: { departments: [], feeEarners: [] } } as never);
  vi.mocked(svc.getMatterAnalysisData).mockResolvedValue({ mattersAtRisk: [], matters: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, byCaseType: [], byDepartment: [], filters: { departments: [], caseTypes: [], statuses: [], lawyers: [] } } as never);
  vi.mocked(svc.getClientIntelligenceData).mockResolvedValue({ headlines: { totalClients: 0, topClient: null, mostAtRisk: null }, clients: [], pagination: { totalCount: 0, limit: 50, offset: 0 }, topByRevenue: [], topByOutstanding: [], filters: { departments: [], minMattersOptions: [] } } as never);
});

describe('dashboard handler routing', () => {
  it('GET /api/dashboard/firm-overview → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/firm-overview'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFirmOverviewData)).toHaveBeenCalledWith('firm-1');
  });

  it('GET /api/dashboard/fee-earner-performance → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/fee-earner-performance'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith('firm-1', expect.any(Object));
  });

  it('GET /api/dashboard/wip → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/wip'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getWipData)).toHaveBeenCalled();
  });

  it('GET /api/dashboard/billing → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/billing'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('GET /api/dashboard/matters → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/matters'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('GET /api/dashboard/clients → 200', async () => {
    const res = await handler(makeEvent('/api/dashboard/clients'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
  });

  it('returns 404 for unknown route', async () => {
    const res = await handler(makeEvent('/api/dashboard/unknown'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });

  it('returns 405 for non-GET', async () => {
    const event = { ...makeEvent('/api/dashboard/firm-overview'), httpMethod: 'POST' };
    const res = await handler(event, {} as never, () => {});
    expect(res?.statusCode).toBe(405);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(new (AuthError as never)('Unauthorised', 401));
    const res = await handler(makeEvent('/api/dashboard/firm-overview'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });

  it('passes query params as filters to service', async () => {
    const res = await handler(
      makeEvent('/api/dashboard/fee-earner-performance', { department: 'Property', limit: '10', offset: '0' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith(
      'firm-1',
      expect.objectContaining({ department: 'Property', limit: 10, offset: 0 }),
    );
  });

  it('firm isolation: passes firmId from auth to every service call', async () => {
    vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u', firmId: 'firm-99', role: 'user' });
    await handler(makeEvent('/api/dashboard/wip'), {} as never, () => {});
    expect(vi.mocked(svc.getWipData)).toHaveBeenCalledWith('firm-99', expect.any(Object));
  });
});
