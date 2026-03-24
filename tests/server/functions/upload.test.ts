import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// Mock auth and pipeline before importing handler
vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) { super(msg); }
  },
}));

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  storeRawUpload: vi.fn().mockResolvedValue('upload-123'),
  updateUploadStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/server/pipeline/pipeline-orchestrator.js', () => ({
  runFullPipeline: vi.fn().mockResolvedValue({
    uploadId: 'upload-123',
    stagesCompleted: ['normalise', 'crossReference', 'index', 'join', 'enrich', 'aggregate'],
    warnings: [],
    recordsProcessed: 3,
    recordsPersisted: 3,
    duration_ms: 42,
  }),
}));

import { handler } from '../../../src/server/functions/upload.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(body: unknown, method = 'POST'): HandlerEvent {
  return {
    httpMethod: method,
    path: '/api/upload',
    headers: { authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
    queryStringParameters: null,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: '/api/upload',
    rawQuery: '',
  };
}

function makeValidBody() {
  return {
    fileType: 'wipJson',
    originalFilename: 'wip.json',
    parseResult: {
      fileType: 'json',
      originalFilename: 'wip.json',
      rowCount: 3,
      columns: [],
      previewRows: [],
      fullRows: [{ 'Matter Number': '1001', 'Duration Minutes': 60, Lawyer: 'Alice', Billable: 100 }],
      parseErrors: [],
      parsedAt: new Date().toISOString(),
    },
    mappingSet: {
      fileType: 'wipJson',
      entityKey: 'timeEntry',
      mappings: [
        { rawColumn: 'Matter Number', mappedTo: 'matterNumber', entityKey: 'timeEntry', isRequired: true, confidence: 'auto' },
      ],
      missingRequiredFields: [],
      unmappedColumns: [],
      customFieldSuggestions: [],
      isComplete: true,
    },
    runFullPipeline: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/upload — auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when no auth token', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(
      new (AuthError as any)('Missing token', 401)
    );

    const response = await handler(makeEvent(makeValidBody()), {} as any);
    expect(response!.statusCode).toBe(401);
  });
});

describe('POST /api/upload — validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.authenticateRequest).mockResolvedValue({
      userId: 'user-001',
      firmId: 'firm-001',
      role: 'admin',
    });
  });

  it('returns 400 for unknown fileType', async () => {
    const body = { ...makeValidBody(), fileType: 'unknownFileType' };
    const response = await handler(makeEvent(body), {} as any);
    expect(response!.statusCode).toBe(400);
    const parsed = JSON.parse(response!.body!);
    expect(parsed.error).toMatch(/fileType/i);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(null);
    event.body = null;
    const response = await handler(event, {} as any);
    expect(response!.statusCode).toBe(400);
  });
});

describe('POST /api/upload — success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.authenticateRequest).mockResolvedValue({
      userId: 'user-001',
      firmId: 'firm-001',
      role: 'admin',
    });
  });

  it('returns 200 with pipeline stats for a valid upload', async () => {
    const response = await handler(makeEvent(makeValidBody()), {} as any);
    expect(response!.statusCode).toBe(200);
    const body = JSON.parse(response!.body!);
    expect(body.success).toBe(true);
    expect(body.uploadId).toBe('upload-123');
    expect(body.pipeline.stagesCompleted).toContain('normalise');
    expect(mongoOps.storeRawUpload).toHaveBeenCalledWith(
      'firm-001',
      'wipJson',
      'wip.json',
      expect.any(Array),
      'user-001'
    );
  });
});
