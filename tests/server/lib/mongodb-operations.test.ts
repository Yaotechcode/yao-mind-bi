import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted ensures these variables are initialised before vi.mock's factory
// runs (vi.mock is hoisted to the top of the file by Vitest's transformer).
// ---------------------------------------------------------------------------

const { mockInsertOne, mockReplaceOne, mockFind, mockCollection } = vi.hoisted(() => {
  const mockInsertOne = vi.fn().mockResolvedValue({
    insertedId: { toString: () => 'mock-id-123' },
  });
  const mockReplaceOne = vi.fn().mockResolvedValue({ upsertedId: 'mock-id-456' });

  // find() returns a chainable cursor; individual tests override .toArray() as needed.
  const mockToArray = vi.fn().mockResolvedValue([]);
  const mockCursor = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: mockToArray,
  };
  const mockFind = vi.fn().mockReturnValue(mockCursor);

  const mockCollection = { insertOne: mockInsertOne, replaceOne: mockReplaceOne, find: mockFind };
  return { mockInsertOne, mockReplaceOne, mockFind, mockCollection };
});

vi.mock('@/server/lib/mongodb', () => ({
  getCollection: vi.fn().mockResolvedValue(mockCollection),
}));

// ---------------------------------------------------------------------------
// Import after mock registration
// ---------------------------------------------------------------------------

import {
  storeRawUpload,
  getUploadHistory,
  getLatestEnrichedEntities,
  storeEnrichedEntities,
  getLatestCalculatedKpis,
  storeCalculatedKpis,
  createHistoricalSnapshot,
  getHistoricalSnapshots,
  upsertCustomEntityRecords,
} from '@/server/lib/mongodb-operations';
import { getCollection } from '@/server/lib/mongodb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIRM_A = 'firm-aaa-111';
const FIRM_B = 'firm-bbb-222';

/** Point find().toArray() at a fixed array for the current test. */
function setFindResult(docs: unknown[]): void {
  mockFind.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(docs),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset insertOne default after clearAllMocks wipes mock state
  mockInsertOne.mockResolvedValue({ insertedId: { toString: () => 'mock-id-123' } });
  mockReplaceOne.mockResolvedValue({ upsertedId: 'mock-id-456' });
  setFindResult([]);
});

// ---------------------------------------------------------------------------
// storeRawUpload
// ---------------------------------------------------------------------------

describe('storeRawUpload', () => {
  it('inserts a document with the correct firm_id and returns the inserted id', async () => {
    const id = await storeRawUpload(FIRM_A, 'matters', 'matters.json', [{ a: 1 }], 'user-1');

    expect(id).toBe('mock-id-123');
    expect(mockInsertOne).toHaveBeenCalledOnce();

    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.firm_id).toBe(FIRM_A);
    expect(inserted.file_type).toBe('matters');
    expect(inserted.original_filename).toBe('matters.json');
    expect(inserted.record_count).toBe(1);
    expect(inserted.status).toBe('pending');
  });

  it('does not mix firm ids — firm_id in doc matches the argument', async () => {
    await storeRawUpload(FIRM_B, 'invoices', 'inv.json', [], 'user-2');
    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.firm_id).toBe(FIRM_B);
    expect(inserted.firm_id).not.toBe(FIRM_A);
  });
});

// ---------------------------------------------------------------------------
// getUploadHistory
// ---------------------------------------------------------------------------

describe('getUploadHistory', () => {
  it('queries with firm_id filter and returns documents', async () => {
    const fakeDocs = [{ firm_id: FIRM_A, original_filename: 'x.json' }];
    setFindResult(fakeDocs);

    const result = await getUploadHistory(FIRM_A);
    expect(result).toEqual(fakeDocs);
    expect(mockFind).toHaveBeenCalledWith({ firm_id: FIRM_A });
  });

  it('respects the limit argument', async () => {
    await getUploadHistory(FIRM_A, 5);
    const cursor = mockFind.mock.results[0].value;
    expect(cursor.limit).toHaveBeenCalledWith(5);
  });

  it('firm A query does not bleed into firm B — filter uses correct id', async () => {
    await getUploadHistory(FIRM_A);
    const [filter] = mockFind.mock.calls[0];
    expect(filter.firm_id).toBe(FIRM_A);
    expect(filter.firm_id).not.toBe(FIRM_B);
  });
});

// ---------------------------------------------------------------------------
// getLatestEnrichedEntities
// ---------------------------------------------------------------------------

describe('getLatestEnrichedEntities', () => {
  it('returns null when no documents exist', async () => {
    setFindResult([]);
    const result = await getLatestEnrichedEntities(FIRM_A, 'feeEarner');
    expect(result).toBeNull();
  });

  it('queries with firm_id AND entity_type', async () => {
    setFindResult([]);
    await getLatestEnrichedEntities(FIRM_A, 'feeEarner');
    expect(mockFind).toHaveBeenCalledWith({ firm_id: FIRM_A, entity_type: 'feeEarner' });
  });

  it('returns the first element from the sorted cursor', async () => {
    const doc = { firm_id: FIRM_A, entity_type: 'matter', data_version: '2024-01-02T00:00:00.000Z' };
    setFindResult([doc]);
    const result = await getLatestEnrichedEntities(FIRM_A, 'matter');
    expect(result).toEqual(doc);
  });

  it('firm A query uses firm A id — not firm B', async () => {
    await getLatestEnrichedEntities(FIRM_A, 'matter');
    const [filter] = mockFind.mock.calls[0];
    expect(filter.firm_id).toBe(FIRM_A);
    expect(filter.firm_id).not.toBe(FIRM_B);
  });
});

// ---------------------------------------------------------------------------
// storeEnrichedEntities
// ---------------------------------------------------------------------------

describe('storeEnrichedEntities', () => {
  it('inserts with correct firm_id, entity_type, and record_count', async () => {
    const records = [{ id: '1' }, { id: '2' }];
    await storeEnrichedEntities(FIRM_A, 'matter', records, ['upload-1'], undefined);

    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.firm_id).toBe(FIRM_A);
    expect(inserted.entity_type).toBe('matter');
    expect(inserted.record_count).toBe(2);
    expect(inserted.source_uploads).toEqual(['upload-1']);
    expect(typeof inserted.data_version).toBe('string');
  });

  it('stores the optional data_quality object', async () => {
    const dq = { quality_score: 95, issue_count: 1, issues: [] };
    await storeEnrichedEntities(FIRM_A, 'matter', [], [], dq);
    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.data_quality).toEqual(dq);
  });
});

// ---------------------------------------------------------------------------
// getLatestCalculatedKpis
// ---------------------------------------------------------------------------

describe('getLatestCalculatedKpis', () => {
  it('returns null when no KPIs exist', async () => {
    setFindResult([]);
    const result = await getLatestCalculatedKpis(FIRM_A);
    expect(result).toBeNull();
  });

  it('queries with firm_id only', async () => {
    setFindResult([{ firm_id: FIRM_A, calculated_at: new Date() }]);
    await getLatestCalculatedKpis(FIRM_A);
    expect(mockFind).toHaveBeenCalledWith({ firm_id: FIRM_A });
  });

  it('firm A query does not use firm B id', async () => {
    await getLatestCalculatedKpis(FIRM_A);
    const [filter] = mockFind.mock.calls[0];
    expect(filter.firm_id).toBe(FIRM_A);
    expect(filter.firm_id).not.toBe(FIRM_B);
  });
});

// ---------------------------------------------------------------------------
// storeCalculatedKpis
// ---------------------------------------------------------------------------

describe('storeCalculatedKpis', () => {
  it('inserts with correct firm_id, config_version, and data_version', async () => {
    await storeCalculatedKpis(FIRM_A, { revenue: 100000 }, 'cfg-v1', 'data-v2');
    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.firm_id).toBe(FIRM_A);
    expect(inserted.config_version).toBe('cfg-v1');
    expect(inserted.data_version).toBe('data-v2');
    expect(inserted.kpis).toEqual({ revenue: 100000 });
    expect(inserted.calculated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// createHistoricalSnapshot
// ---------------------------------------------------------------------------

describe('createHistoricalSnapshot', () => {
  it('inserts with correct firm_id, period, and firm_summary', async () => {
    const summary = { totalRevenue: 500000 };
    await createHistoricalSnapshot(FIRM_A, 'monthly', summary);
    const inserted = mockInsertOne.mock.calls[0][0];
    expect(inserted.firm_id).toBe(FIRM_A);
    expect(inserted.period).toBe('monthly');
    expect(inserted.firm_summary).toEqual(summary);
    expect(inserted.snapshot_date).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// getHistoricalSnapshots
// ---------------------------------------------------------------------------

describe('getHistoricalSnapshots', () => {
  it('filters by firm_id and period', async () => {
    await getHistoricalSnapshots(FIRM_A, 'weekly');
    expect(mockFind).toHaveBeenCalledWith({ firm_id: FIRM_A, period: 'weekly' });
  });

  it('adds a date range filter when provided', async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2024-03-31');
    await getHistoricalSnapshots(FIRM_A, 'monthly', { from, to });
    const [filter] = mockFind.mock.calls[0];
    expect(filter.snapshot_date).toEqual({ $gte: from, $lte: to });
  });

  it('firm A query uses firm A id — not firm B', async () => {
    await getHistoricalSnapshots(FIRM_A, 'quarterly');
    const [filter] = mockFind.mock.calls[0];
    expect(filter.firm_id).toBe(FIRM_A);
    expect(filter.firm_id).not.toBe(FIRM_B);
  });
});

// ---------------------------------------------------------------------------
// upsertCustomEntityRecords
// ---------------------------------------------------------------------------

describe('upsertCustomEntityRecords', () => {
  it('calls replaceOne with upsert:true and correct firm_id', async () => {
    const records = [{ name: 'Acme Ltd' }];
    await upsertCustomEntityRecords(FIRM_A, 'client', records);

    expect(mockReplaceOne).toHaveBeenCalledOnce();
    const [filter, replacement, options] = mockReplaceOne.mock.calls[0];
    expect(filter).toEqual({ firm_id: FIRM_A, entity_type: 'client' });
    expect(replacement.firm_id).toBe(FIRM_A);
    expect(replacement.records).toEqual(records);
    expect(options).toEqual({ upsert: true });
  });

  it('does not use firm B id when called for firm A', async () => {
    await upsertCustomEntityRecords(FIRM_A, 'client', []);
    const [filter] = mockReplaceOne.mock.calls[0];
    expect(filter.firm_id).not.toBe(FIRM_B);
  });
});

// ---------------------------------------------------------------------------
// Cross-collection: getCollection is called with the right collection name
// ---------------------------------------------------------------------------

describe('getCollection routing', () => {
  it('routes storeRawUpload to raw_uploads', async () => {
    await storeRawUpload(FIRM_A, 'matters', 'f.json', [], 'u');
    expect(getCollection).toHaveBeenCalledWith('raw_uploads');
  });

  it('routes getLatestEnrichedEntities to enriched_entities', async () => {
    await getLatestEnrichedEntities(FIRM_A, 'matter');
    expect(getCollection).toHaveBeenCalledWith('enriched_entities');
  });

  it('routes storeCalculatedKpis to calculated_kpis', async () => {
    await storeCalculatedKpis(FIRM_A, {}, 'v1', 'v2');
    expect(getCollection).toHaveBeenCalledWith('calculated_kpis');
  });

  it('routes createHistoricalSnapshot to historical_snapshots', async () => {
    await createHistoricalSnapshot(FIRM_A, 'annual', {});
    expect(getCollection).toHaveBeenCalledWith('historical_snapshots');
  });

  it('routes upsertCustomEntityRecords to custom_entity_records', async () => {
    await upsertCustomEntityRecords(FIRM_A, 'client', []);
    expect(getCollection).toHaveBeenCalledWith('custom_entity_records');
  });
});
