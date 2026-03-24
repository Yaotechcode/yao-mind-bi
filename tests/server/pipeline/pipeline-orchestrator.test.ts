import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MappingSet } from '../../../src/shared/mapping/types.js';
import type { ParseResult } from '../../../src/client/parsers/types.js';

// Mock all MongoDB operations before importing the orchestrator
vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getCrossReferenceRegistry: vi.fn().mockResolvedValue(null),
  storeCrossReferenceRegistry: vi.fn().mockResolvedValue(undefined),
  storeNormalisedDataset: vi.fn().mockResolvedValue(undefined),
  getAllNormalisedDatasets: vi.fn().mockResolvedValue({}),
  storeEnrichedEntities: vi.fn().mockResolvedValue(undefined),
  storeCalculatedKpis: vi.fn().mockResolvedValue(undefined),
  updateUploadStatus: vi.fn().mockResolvedValue(undefined),
  setRecalculationFlag: vi.fn().mockResolvedValue(undefined),
  deleteEnrichedEntitiesByType: vi.fn().mockResolvedValue(undefined),
}));

import { runFullPipeline } from '../../../src/server/pipeline/pipeline-orchestrator.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParseResult(rows: Record<string, unknown>[]): ParseResult {
  return {
    fileType: 'json',
    originalFilename: 'test.json',
    rowCount: rows.length,
    columns: [],
    previewRows: rows.slice(0, 3),
    fullRows: rows,
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  };
}

function makeMappingSet(fileType = 'wipJson'): MappingSet {
  return {
    fileType,
    entityKey: 'timeEntry' as any,
    mappings: [
      { rawColumn: 'Matter Number', mappedTo: 'matterNumber', entityKey: 'timeEntry' as any, isRequired: true, confidence: 'auto' },
      { rawColumn: 'Duration Minutes', mappedTo: 'durationMinutes', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
      { rawColumn: 'Lawyer', mappedTo: 'lawyerName', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
      { rawColumn: 'Billable', mappedTo: 'billable', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
    ],
    missingRequiredFields: [],
    unmappedColumns: [],
    customFieldSuggestions: [],
    isComplete: true,
  };
}

const WIP_ROWS = [
  { 'Matter Number': '1001', 'Duration Minutes': 60, Lawyer: 'Alice', Billable: 100 },
  { 'Matter Number': '1002', 'Duration Minutes': 30, Lawyer: 'Bob', Billable: 50 },
  { 'Matter Number': '1003', 'Duration Minutes': 120, Lawyer: 'Alice', Billable: 200 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFullPipeline — dry run', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns preview data without persisting to MongoDB', async () => {
    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: true,
    });

    expect(result.previewData).toBeDefined();
    expect(result.previewData!.normalisedCount).toBeGreaterThan(0);
    // Dry run: nothing persisted
    expect(mongoOps.storeNormalisedDataset).not.toHaveBeenCalled();
    expect(mongoOps.storeEnrichedEntities).not.toHaveBeenCalled();
    expect(mongoOps.setRecalculationFlag).not.toHaveBeenCalled();
  });
});

describe('runFullPipeline — full run', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists normalised dataset and sets recalculation flag on success', async () => {
    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.stagesCompleted).toContain('normalise');
    expect(result.stagesCompleted).toContain('crossReference');
    expect(mongoOps.storeNormalisedDataset).toHaveBeenCalledWith(
      'firm-001',
      'wipJson',
      'timeEntry',
      expect.any(Array),
      'upload-001'
    );
    expect(mongoOps.setRecalculationFlag).toHaveBeenCalledWith('firm-001');
  });

  it('marks upload as error when > 50% of rows are rejected', async () => {
    // Send 3 blank rows — all rejected
    const blankRows = [
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
    ];

    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(blankRows),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.aborted).toBe(true);
    expect(mongoOps.updateUploadStatus).toHaveBeenCalledWith(
      'firm-001',
      'upload-001',
      'error',
      expect.stringContaining('rejected')
    );
    expect(mongoOps.storeNormalisedDataset).not.toHaveBeenCalled();
  });

  it('includes cross-reference and join stages when prior data exists', async () => {
    // Simulate a second upload where fullMattersJson was already uploaded
    vi.mocked(mongoOps.getAllNormalisedDatasets).mockResolvedValue({
      fullMattersJson: {
        fileType: 'matter',
        records: [{ matterId: 'm-001', matterNumber: '1001' }],
        recordCount: 1,
        normalisedAt: new Date().toISOString(),
      },
    });

    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-002',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.stagesCompleted).toContain('join');
    expect(result.stagesCompleted).toContain('enrich');
  });
});
