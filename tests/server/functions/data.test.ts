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
  getLatestEnrichedEntities: vi.fn(),
  getLatestCalculatedKpis: vi.fn(),
  getUploadHistory: vi.fn(),
  getAllNormalisedDatasets: vi.fn(),
  getRecalculationFlag: vi.fn(),
  setRecalculationFlag: vi.fn(),
}));

import { handler } from '../../../src/server/functions/data.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  path: string,
  qp: Record<string, string> = {},
  method = 'GET'
): HandlerEvent {
  return {
    httpMethod: method,
    path,
    headers: { authorization: 'Bearer test-token' },
    body: null,
    queryStringParameters: qp,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: path,
    rawQuery: '',
  };
}

function mockAuth(firmId: string) {
  vi.mocked(auth.authenticateRequest).mockResolvedValue({
    userId: 'user-1',
    firmId,
    role: 'user',
  });
}

function makeAggregateResult() {
  return {
    feeEarners: [
      { lawyerId: 'fe-1', lawyerName: 'Alice', wipEntryCount: 10, wipTotalHours: 5, wipChargeableHours: 4, wipChargeableValue: 400, wipTotalValue: 500, wipWriteOffValue: 50, wipMatterCount: 3, wipOrphanedHours: 0, wipOrphanedValue: 0, wipOldestEntryDate: null, wipNewestEntryDate: null, recordingGapDays: null, invoicedRevenue: 1000, invoicedOutstanding: 200, invoicedCount: 5 },
    ],
    matters: [
      { matterId: 'mat-1', matterNumber: '1001', wipTotalHours: 3, wipTotalBillable: 300, invoiceCount: 2, invoicedNetBilling: 400, invoicedDisbursements: 50, invoicedTotal: 450, invoicedOutstanding: 100, invoicedPaid: 350, invoicedWrittenOff: 0, wipTotalDurationMinutes: 180, wipTotalWriteOff: 0, wipTotalUnits: 5, wipTotalChargeable: 250, wipTotalNonChargeable: 50, wipChargeableHours: 2.5, wipNonChargeableHours: 0.5, wipOldestEntryDate: null, wipNewestEntryDate: null, wipAgeInDays: null },
      { matterId: 'mat-2', matterNumber: '1002', wipTotalHours: 1, wipTotalBillable: 100, invoiceCount: 0, invoicedNetBilling: 0, invoicedDisbursements: 0, invoicedTotal: 0, invoicedOutstanding: 0, invoicedPaid: 0, invoicedWrittenOff: 0, wipTotalDurationMinutes: 60, wipTotalWriteOff: 0, wipTotalUnits: 2, wipTotalChargeable: 80, wipTotalNonChargeable: 20, wipChargeableHours: 0.8, wipNonChargeableHours: 0.2, wipOldestEntryDate: null, wipNewestEntryDate: null, wipAgeInDays: null },
    ],
    clients: [{ contactId: 'c-1', displayName: 'Acme Corp', matterCount: 2, activeMatterCount: 1, closedMatterCount: 1, totalWipValue: 400, totalInvoiced: 450, totalOutstanding: 100, totalPaid: 350, oldestMatterDate: null }],
    departments: [{ name: 'Litigation', departmentId: 'dept-1', feeEarnerCount: 1, activeFeeEarnerCount: 1, activeMatterCount: 2, totalMatterCount: 2, wipTotalHours: 4, wipChargeableHours: 3.3, wipChargeableValue: 330, invoicedRevenue: 1000, invoicedOutstanding: 200 }],
    firm: { feeEarnerCount: 1, activeFeeEarnerCount: 1, salariedFeeEarnerCount: 0, feeShareFeeEarnerCount: 1, matterCount: 2, activeMatterCount: 1, inProgressMatterCount: 1, completedMatterCount: 1, otherMatterCount: 0, totalWipHours: 4, totalChargeableHours: 3.3, totalWipValue: 400, totalWriteOffValue: 50, totalInvoicedRevenue: 1000, totalOutstanding: 200, totalPaid: 800, orphanedWip: { orphanedWipEntryCount: 0, orphanedWipHours: 0, orphanedWipValue: 0, orphanedWipPercent: 0, orphanedWipNote: '' } },
    dataQuality: { overallScore: 85, filesCoverage: [], entityIssues: [], knownGaps: [], discrepancies: [], recommendations: [] },
  };
}

function makeTimeEntries() {
  return [
    { lawyerId: 'fe-1', matterNumber: '1001', matterId: 'mat-1', hasMatchedMatter: true, isChargeable: true, durationHours: 2, recordedValue: 200, department: 'Litigation' },
    { lawyerId: 'fe-1', matterNumber: null,   matterId: null,    hasMatchedMatter: false, isChargeable: false, durationHours: 0.5, recordedValue: 50, department: 'Litigation' },
    { lawyerId: 'fe-2', matterNumber: '1002', matterId: 'mat-2', hasMatchedMatter: true, isChargeable: true, durationHours: 1, recordedValue: 100, department: 'Corporate' },
  ];
}

// ---------------------------------------------------------------------------
// GET /api/data/firm-summary
// ---------------------------------------------------------------------------

describe('GET /api/data/firm-summary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns hasFirmData: false when no uploads', async () => {
    mockAuth('firm-a');
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(null);
    vi.mocked(mongoOps.getUploadHistory).mockResolvedValue([]);
    vi.mocked(mongoOps.getAllNormalisedDatasets).mockResolvedValue({});

    const res = await handler(makeEvent('/api/data/firm-summary'), {} as any);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.hasFirmData).toBe(false);
    expect(body.availableEntities).toEqual([]);
    expect(body.aggregatedFirm).toBeNull();
  });

  it('returns firm data when aggregate is present', async () => {
    mockAuth('firm-a');
    const aggregate = makeAggregateResult();
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue({
      firm_id: 'firm-a',
      calculated_at: new Date('2024-01-01'),
      config_version: 'v1',
      data_version: '2024-01-01T00:00:00.000Z',
      kpis: { aggregate },
    } as any);
    vi.mocked(mongoOps.getUploadHistory).mockResolvedValue([
      { upload_date: new Date('2024-01-01'), file_type: 'wipJson', original_filename: 'wip.json', firm_id: 'firm-a', uploaded_by: 'u1', raw_content: [], record_count: 3, status: 'processed' } as any,
    ]);
    vi.mocked(mongoOps.getAllNormalisedDatasets).mockResolvedValue({ wipJson: { fileType: 'timeEntry', records: [], recordCount: 3, normalisedAt: '' } });

    const res = await handler(makeEvent('/api/data/firm-summary'), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.hasFirmData).toBe(true);
    expect(body.aggregatedFirm.feeEarnerCount).toBe(1);
    expect(body.dataQuality.overallScore).toBe(85);
  });
});

// ---------------------------------------------------------------------------
// GET /api/data/fee-earners — firm isolation
// ---------------------------------------------------------------------------

describe('GET /api/data/fee-earners — firm isolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only fee earners for authenticated firm', async () => {
    // Firm A has data
    mockAuth('firm-a');
    const aggregate = makeAggregateResult();
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue({
      firm_id: 'firm-a',
      calculated_at: new Date(),
      config_version: 'v1',
      data_version: 'v1',
      kpis: { aggregate },
    } as any);

    const res = await handler(makeEvent('/api/data/fee-earners', { includeInactive: 'true' }), {} as any);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].lawyerId).toBe('fe-1');
  });

  it('cross-firm: firm B request uses firm B\'s firmId in queries', async () => {
    mockAuth('firm-b');
    // Firm B has no data
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(null);

    const res = await handler(makeEvent('/api/data/fee-earners'), {} as any);
    const body = JSON.parse(res!.body!);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
    // Verify firmId passed to MongoDB is firm-b
    expect(vi.mocked(mongoOps.getLatestCalculatedKpis)).toHaveBeenCalledWith('firm-b');
  });
});

// ---------------------------------------------------------------------------
// GET /api/data/wip — orphanedOnly filter
// ---------------------------------------------------------------------------

describe('GET /api/data/wip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('with orphanedOnly=true returns only entries with hasMatchedMatter: false', async () => {
    mockAuth('firm-a');
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue({
      firm_id: 'firm-a',
      entity_type: 'timeEntry',
      data_version: 'v1',
      source_uploads: ['upload-1'],
      records: makeTimeEntries(),
      record_count: 3,
      created_at: new Date(),
    } as any);

    const res = await handler(makeEvent('/api/data/wip', { orphanedOnly: 'true' }), {} as any);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].hasMatchedMatter).toBe(false);
  });

  it('without orphanedOnly returns all entries', async () => {
    mockAuth('firm-a');
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue({
      firm_id: 'firm-a',
      entity_type: 'timeEntry',
      data_version: 'v1',
      source_uploads: ['upload-1'],
      records: makeTimeEntries(),
      record_count: 3,
      created_at: new Date(),
    } as any);

    const res = await handler(makeEvent('/api/data/wip'), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.total).toBe(3);
  });

  it('returns aggregates including orphaned hours', async () => {
    mockAuth('firm-a');
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue({
      firm_id: 'firm-a',
      entity_type: 'timeEntry',
      data_version: 'v1',
      source_uploads: ['upload-1'],
      records: makeTimeEntries(),
      record_count: 3,
      created_at: new Date(),
    } as any);

    const res = await handler(makeEvent('/api/data/wip'), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.aggregates.totalHours).toBeCloseTo(3.5);
    expect(body.aggregates.orphanedHours).toBeCloseTo(0.5);
    expect(body.aggregates.orphanedValue).toBeCloseTo(50);
  });

  it('firm isolation: passes firmId to getLatestEnrichedEntities', async () => {
    mockAuth('firm-b');
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);

    await handler(makeEvent('/api/data/wip'), {} as any);
    expect(vi.mocked(mongoOps.getLatestEnrichedEntities)).toHaveBeenCalledWith('firm-b', 'timeEntry');
  });
});

// ---------------------------------------------------------------------------
// GET /api/data/matters — status filter
// ---------------------------------------------------------------------------

describe('GET /api/data/matters', () => {
  beforeEach(() => vi.clearAllMocks());

  it('with status=IN_PROGRESS returns only matching matters', async () => {
    mockAuth('firm-a');
    const aggregate = makeAggregateResult();
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue({
      firm_id: 'firm-a',
      calculated_at: new Date(),
      config_version: 'v1',
      data_version: 'v1',
      kpis: { aggregate },
    } as any);
    // Enriched matters with matterStatus
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue({
      firm_id: 'firm-a',
      entity_type: 'matter',
      data_version: 'v1',
      source_uploads: ['u1'],
      records: [
        { matterId: 'mat-1', matterNumber: '1001', matterStatus: 'IN_PROGRESS' },
        { matterId: 'mat-2', matterNumber: '1002', matterStatus: 'COMPLETE' },
      ],
      record_count: 2,
      created_at: new Date(),
    } as any);

    const res = await handler(makeEvent('/api/data/matters', { status: 'IN_PROGRESS' }), {} as any);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].matterNumber).toBe('1001');
    expect(body.total).toBe(1);
  });

  it('no filter returns all matters with pagination', async () => {
    mockAuth('firm-a');
    const aggregate = makeAggregateResult();
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue({
      firm_id: 'firm-a',
      calculated_at: new Date(),
      config_version: 'v1',
      data_version: 'v1',
      kpis: { aggregate },
    } as any);
    vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);

    const res = await handler(makeEvent('/api/data/matters'), {} as any);
    const body = JSON.parse(res!.body!);
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/data/data-quality — matches stored report
// ---------------------------------------------------------------------------

describe('GET /api/data/data-quality', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the data quality report from stored aggregate', async () => {
    mockAuth('firm-a');
    const aggregate = makeAggregateResult();
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue({
      firm_id: 'firm-a',
      calculated_at: new Date(),
      config_version: 'v1',
      data_version: 'v1',
      kpis: { aggregate },
    } as any);

    const res = await handler(makeEvent('/api/data/data-quality'), {} as any);
    expect(res!.statusCode).toBe(200);
    const body = JSON.parse(res!.body!);
    expect(body.overallScore).toBe(85);
    expect(Array.isArray(body.entityIssues)).toBe(true);
  });

  it('returns null when no data exists', async () => {
    mockAuth('firm-a');
    vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(null);

    const res = await handler(makeEvent('/api/data/data-quality'), {} as any);
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth — 401 on missing token
// ---------------------------------------------------------------------------

describe('Auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when unauthenticated', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(
      new (AuthError as any)('Missing token', 401)
    );
    const res = await handler(makeEvent('/api/data/firm-summary'), {} as any);
    expect(res!.statusCode).toBe(401);
  });

  it('returns 405 for non-GET requests', async () => {
    mockAuth('firm-a');
    const res = await handler(makeEvent('/api/data/firm-summary', {}, 'POST'), {} as any);
    expect(res!.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Cross-firm isolation — explicit test
// ---------------------------------------------------------------------------

describe('Cross-firm isolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('firm A request never receives firm B data', async () => {
    // Firm A has data
    vi.mocked(auth.authenticateRequest).mockImplementation((event) => {
      const token = (event.headers as Record<string, string>)['authorization'];
      const firmId = token?.includes('firm-a') ? 'firm-a' : 'firm-b';
      return Promise.resolve({ userId: 'user-1', firmId, role: 'user' });
    });

    const firmAAggregate = makeAggregateResult();
    const firmBAggregate = {
      ...makeAggregateResult(),
      feeEarners: [{ lawyerId: 'fe-b-1', lawyerName: 'Bob', wipEntryCount: 5 }],
      firm: { ...makeAggregateResult().firm, feeEarnerCount: 99 },
    };

    vi.mocked(mongoOps.getLatestCalculatedKpis).mockImplementation((firmId) =>
      Promise.resolve({
        firm_id: firmId,
        calculated_at: new Date(),
        config_version: 'v1',
        data_version: 'v1',
        kpis: { aggregate: firmId === 'firm-a' ? firmAAggregate : firmBAggregate },
      } as any)
    );

    // Request from firm A
    const eventA = makeEvent('/api/data/fee-earners', { includeInactive: 'true' });
    (eventA.headers as Record<string, string>)['authorization'] = 'Bearer firm-a-token';
    const resA = await handler(eventA, {} as any);
    const bodyA = JSON.parse(resA!.body!);

    expect(bodyA[0].lawyerId).toBe('fe-1');     // firm A's data
    expect(bodyA[0].lawyerId).not.toBe('fe-b-1'); // NOT firm B's data

    // Verify MongoDB was called with firm-a's ID
    expect(vi.mocked(mongoOps.getLatestCalculatedKpis)).toHaveBeenCalledWith('firm-a');
    expect(vi.mocked(mongoOps.getLatestCalculatedKpis)).not.toHaveBeenCalledWith('firm-b');
  });
});
