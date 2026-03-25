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
  getLatestEnrichedEntities: vi.fn(),
}));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: {
    get server() {
      return mockSupabase;
    },
  },
}));

vi.mock('../../../src/server/services/config-service.js', () => ({
  getFirmConfig: vi.fn(),
}));

vi.mock('../../../src/server/formula-engine/version-manager.js', () => ({
  FormulaVersionManager: vi.fn().mockImplementation(() => mockVersionManager),
}));

vi.mock('../../../src/server/formula-engine/sandbox/formula-sandbox.js', () => ({
  FormulaSandbox: vi.fn().mockImplementation(() => mockSandbox),
}));

// ---------------------------------------------------------------------------
// Shared mock objects
// ---------------------------------------------------------------------------

const mockSupabaseQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  single: vi.fn(),
};

const mockSupabase = {
  from: vi.fn(() => mockSupabaseQuery),
};

const mockVersionManager = {
  getVersionHistory: vi.fn(),
  diffVersions: vi.fn(),
  createFormulaVersionSnapshot: vi.fn(),
  getCurrentVersion: vi.fn(),
};

const mockSandbox = {
  dryRun: vi.fn(),
  diffWithLive: vi.fn(),
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { handler } from '../../../src/server/functions/formula-intelligence.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';
import * as configService from '../../../src/server/services/config-service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(
  path: string,
  method = 'GET',
  body: unknown = null,
  qs: Record<string, string> = {},
): HandlerEvent {
  return {
    httpMethod: method,
    path,
    headers: { authorization: 'Bearer test-token' },
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: qs,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: path,
    rawQuery: '',
  };
}

function mockAuth(firmId = 'firm-1', userId = 'user-1') {
  vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId, firmId, role: 'user' });
}

function makeFirmConfig() {
  return {
    firmId: 'firm-1',
    firmName: 'Test Firm',
    jurisdiction: 'England and Wales',
    currency: 'GBP',
    financialYearStartMonth: 4,
    weekStartDay: 1,
    timezone: 'Europe/London',
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    entityDefinitions: {},
    columnMappingTemplates: [],
    customFields: [],
    ragThresholds: [],
    formulas: [],
    snippets: [],
    feeEarnerOverrides: [],
    weeklyTargetHours: 37.5,
    workingDaysPerWeek: 5,
    annualLeaveEntitlement: 25,
    bankHolidaysPerYear: 8,
  };
}

function makeKpisDoc() {
  return {
    firm_id: 'firm-1',
    calculated_at: new Date(),
    config_version: '2024-01-01',
    data_version: '2024-01-01',
    kpis: {
      aggregate: {
        feeEarners: [{ lawyerId: 'l-1', lawyerName: 'Alice', wipEntryCount: 10 }],
        matters: [{ matterId: 'm-1' }],
        clients: [],
        departments: [],
        firm: { totalWipHours: 100 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth();

  vi.mocked(mongoOps.getLatestCalculatedKpis).mockResolvedValue(makeKpisDoc() as never);
  vi.mocked(mongoOps.getLatestEnrichedEntities).mockResolvedValue(null);
  vi.mocked(configService.getFirmConfig).mockResolvedValue(makeFirmConfig() as never);

  // Reset supabase mock chain to return empty results by default
  mockSupabaseQuery.single.mockResolvedValue({ data: null, error: null });
  mockSupabaseQuery.order.mockResolvedValue({ data: [], error: null });
  mockSupabaseQuery.delete.mockResolvedValue({ error: null });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/readiness
// ---------------------------------------------------------------------------

describe('GET /api/formulas/readiness', () => {
  it('returns readiness map for all built-in formulas', async () => {
    const res = await handler(makeEvent('/api/formulas/readiness'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.readiness).toBeDefined();
    expect(typeof body.readiness).toBe('object');
    // Built-in formula IDs present
    expect(body.readiness).toHaveProperty('F-TU-01');
  });

  it('uses firm config from config-service', async () => {
    await handler(makeEvent('/api/formulas/readiness'), {} as never, () => {});
    expect(vi.mocked(configService.getFirmConfig)).toHaveBeenCalledWith('firm-1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/readiness/:formulaId
// ---------------------------------------------------------------------------

describe('GET /api/formulas/readiness/:formulaId', () => {
  it('returns readiness for a known formula', async () => {
    const res = await handler(makeEvent('/api/formulas/readiness/F-TU-01'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formulaId).toBe('F-TU-01');
    expect(body.readiness).toHaveProperty('readiness');
  });

  it('returns READY for unknown formula (no requirements registered)', async () => {
    const res = await handler(makeEvent('/api/formulas/readiness/F-UNKNOWN-99'), {} as never, () => {});
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.readiness.readiness).toBe('READY');
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/versions/:formulaId
// ---------------------------------------------------------------------------

describe('GET /api/formulas/versions/:formulaId', () => {
  it('returns version history', async () => {
    const versions = [
      { id: 'v1', formulaId: 'F-TU-01', versionNumber: 1, isCurrent: true },
    ];
    mockVersionManager.getVersionHistory.mockResolvedValue(versions);

    const res = await handler(makeEvent('/api/formulas/versions/F-TU-01'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formulaId).toBe('F-TU-01');
    expect(body.versions).toHaveLength(1);
  });

  it('returns empty array when no versions exist', async () => {
    mockVersionManager.getVersionHistory.mockResolvedValue([]);
    const res = await handler(makeEvent('/api/formulas/versions/F-TU-01'), {} as never, () => {});
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.versions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/versions/:formulaId/diff
// ---------------------------------------------------------------------------

describe('GET /api/formulas/versions/:formulaId/diff', () => {
  it('returns diff between two versions', async () => {
    mockVersionManager.diffVersions.mockResolvedValue({
      formulaId: 'F-TU-01', v1: 1, v2: 2,
      changedFields: ['name'], hasBreakingChanges: false,
      summary: '1 field(s) changed: name',
    });

    const res = await handler(
      makeEvent('/api/formulas/versions/F-TU-01/diff', 'GET', null, { from: '1', to: '2' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.diff.changedFields).toContain('name');
  });

  it('returns 400 when from/to params are missing', async () => {
    const res = await handler(
      makeEvent('/api/formulas/versions/F-TU-01/diff'),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(400);
  });

  it('returns 404 when version not found', async () => {
    mockVersionManager.diffVersions.mockRejectedValue(new Error('version 99 not found'));
    const res = await handler(
      makeEvent('/api/formulas/versions/F-TU-01/diff', 'GET', null, { from: '1', to: '99' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/version-snapshot
// ---------------------------------------------------------------------------

describe('GET /api/formulas/version-snapshot', () => {
  it('returns snapshot map', async () => {
    mockVersionManager.createFormulaVersionSnapshot.mockResolvedValue({ 'F-TU-01': 1 });
    const res = await handler(makeEvent('/api/formulas/version-snapshot'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.snapshot).toHaveProperty('F-TU-01');
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/templates
// ---------------------------------------------------------------------------

describe('GET /api/formulas/templates', () => {
  it('returns list of built-in templates', async () => {
    const res = await handler(makeEvent('/api/formulas/templates'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/templates/:id
// ---------------------------------------------------------------------------

describe('GET /api/formulas/templates/:id', () => {
  it('returns a known template', async () => {
    const res = await handler(makeEvent('/api/formulas/templates/TMPL-001'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.template.templateId).toBe('TMPL-001');
  });

  it('returns 404 for unknown template', async () => {
    const res = await handler(makeEvent('/api/formulas/templates/TMPL-FAKE'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/formulas/templates/:id/instantiate
// ---------------------------------------------------------------------------

describe('POST /api/formulas/templates/:id/instantiate', () => {
  it('instantiates a template and returns a FormulaDefinition', async () => {
    // TMPL-001 is the target-hours template — needs a targetHours parameter
    const res = await handler(
      makeEvent('/api/formulas/templates/TMPL-001/instantiate', 'POST', {
        parameters: { targetHours: 37.5 },
      }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formula).toBeDefined();
    expect(body.formula.type).toBe('custom');
  });

  it('returns 400 for invalid parameter value (out of range)', async () => {
    // targetPercentage max is 100 — passing 150 should fail validation
    const res = await handler(
      makeEvent('/api/formulas/templates/TMPL-001/instantiate', 'POST', {
        parameters: { targetPercentage: 150 },
      }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/formulas/translate
// ---------------------------------------------------------------------------

describe('POST /api/formulas/translate', () => {
  it('returns 400 when description is missing', async () => {
    const res = await handler(
      makeEvent('/api/formulas/translate', 'POST', {}),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(400);
  });

  it('returns 503 when ANTHROPIC_API_KEY is not set', async () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const res = await handler(
        makeEvent('/api/formulas/translate', 'POST', { description: 'average chargeable hours per lawyer' }),
        {} as never, () => {},
      );
      expect(res?.statusCode).toBe(503);
    } finally {
      if (original) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/formulas/sandbox/run
// ---------------------------------------------------------------------------

describe('POST /api/formulas/sandbox/run', () => {
  it('returns 400 when formulaDefinition is missing', async () => {
    const res = await handler(
      makeEvent('/api/formulas/sandbox/run', 'POST', {}),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(400);
  });

  it('calls FormulaSandbox.dryRun and returns result', async () => {
    const sandboxResult = { formulaResult: null, readiness: { readiness: 'BLOCKED' }, ragAssignments: {}, executionTimeMs: 5, warnings: [], dataSnapshot: { feeEarnerCount: 0, matterCount: 0, timeEntryCount: 0 } };
    mockSandbox.dryRun.mockResolvedValue(sandboxResult);

    const res = await handler(
      makeEvent('/api/formulas/sandbox/run', 'POST', {
        formulaDefinition: { expression: { type: 'constant', value: 42 } },
        entityType: 'feeEarner',
        resultType: 'number',
      }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.result).toBeDefined();
    expect(mockSandbox.dryRun).toHaveBeenCalledWith('firm-1', expect.any(Object), 'feeEarner', 'number', undefined);
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas (list)
// ---------------------------------------------------------------------------

describe('GET /api/formulas', () => {
  it('returns list of formulas from formula_registry', async () => {
    const formulas = [
      { formula_id: 'F-CUSTOM-01', name: 'My Formula', formula_type: 'custom' },
    ];
    mockSupabaseQuery.order.mockResolvedValue({ data: formulas, error: null });

    const res = await handler(makeEvent('/api/formulas'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formulas).toHaveLength(1);
  });

  it('filters by firm_id (firm isolation)', async () => {
    mockSupabaseQuery.order.mockResolvedValue({ data: [], error: null });
    await handler(makeEvent('/api/formulas'), {} as never, () => {});
    // Verify eq('firm_id', 'firm-1') was called
    expect(mockSupabaseQuery.eq).toHaveBeenCalledWith('firm_id', 'firm-1');
  });
});

// ---------------------------------------------------------------------------
// POST /api/formulas (create)
// ---------------------------------------------------------------------------

describe('POST /api/formulas', () => {
  it('creates a custom formula', async () => {
    const created = { formula_id: 'F-CUSTOM-01', name: 'Test Formula', formula_type: 'custom' };
    mockSupabaseQuery.single.mockResolvedValue({ data: created, error: null });

    const res = await handler(
      makeEvent('/api/formulas', 'POST', {
        formulaId: 'F-CUSTOM-01',
        name: 'Test Formula',
        entityType: 'feeEarner',
        resultType: 'percentage',
        definition: {},
      }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(201);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formula.formula_id).toBe('F-CUSTOM-01');
  });

  it('returns 400 when formulaId or name is missing', async () => {
    const res = await handler(
      makeEvent('/api/formulas', 'POST', { name: 'No ID' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(400);
  });

  it('returns 409 on duplicate formula ID', async () => {
    mockSupabaseQuery.single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    const res = await handler(
      makeEvent('/api/formulas', 'POST', { formulaId: 'F-DUP', name: 'Duplicate' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/formulas/:formulaId — built-in blocked
// ---------------------------------------------------------------------------

describe('DELETE /api/formulas/:formulaId', () => {
  it('returns 403 when deleting a built-in formula', async () => {
    mockSupabaseQuery.single.mockResolvedValue({
      data: { formula_type: 'built_in' },
      error: null,
    });
    const res = await handler(
      makeEvent('/api/formulas/F-TU-01', 'DELETE'),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(403);
  });

  it('deletes a custom formula', async () => {
    mockSupabaseQuery.single.mockResolvedValue({
      data: { formula_type: 'custom' },
      error: null,
    });
    mockSupabaseQuery.delete.mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) });

    const res = await handler(
      makeEvent('/api/formulas/F-CUSTOM-01', 'DELETE'),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.deleted).toBe(true);
  });

  it('returns 404 for non-existent formula', async () => {
    mockSupabaseQuery.single.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = await handler(
      makeEvent('/api/formulas/F-GHOST', 'DELETE'),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/formulas/:formulaId — built-in blocked
// ---------------------------------------------------------------------------

describe('PUT /api/formulas/:formulaId', () => {
  it('returns 403 when updating a built-in formula', async () => {
    mockSupabaseQuery.single.mockResolvedValue({
      data: { formula_type: 'built_in' },
      error: null,
    });
    const res = await handler(
      makeEvent('/api/formulas/F-TU-01', 'PUT', { name: 'Hacked Name' }),
      {} as never, () => {},
    );
    expect(res?.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('Authentication', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(
      new (AuthError as never)('Unauthorised', 401),
    );
    const res = await handler(makeEvent('/api/formulas'), {} as never, () => {});
    expect(res?.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Firm isolation
// ---------------------------------------------------------------------------

describe('Firm isolation', () => {
  it('uses firmId from auth token, not URL', async () => {
    vi.mocked(auth.authenticateRequest).mockResolvedValue({ userId: 'u', firmId: 'firm-2', role: 'user' });
    mockSupabaseQuery.order.mockResolvedValue({ data: [], error: null });

    await handler(makeEvent('/api/formulas'), {} as never, () => {});

    expect(mockSupabaseQuery.eq).toHaveBeenCalledWith('firm_id', 'firm-2');
    expect(mockSupabaseQuery.eq).not.toHaveBeenCalledWith('firm_id', 'firm-1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/formulas/:formulaId
// ---------------------------------------------------------------------------

describe('GET /api/formulas/:formulaId', () => {
  it('returns formula when found', async () => {
    mockSupabaseQuery.single.mockResolvedValue({
      data: { formula_id: 'F-TU-01', name: 'Utilisation', formula_type: 'built_in' },
      error: null,
    });
    const res = await handler(makeEvent('/api/formulas/F-TU-01'), {} as never, () => {});
    expect(res?.statusCode).toBe(200);
    const body = JSON.parse(res?.body ?? '{}');
    expect(body.formula.formula_id).toBe('F-TU-01');
  });

  it('returns 404 when formula not found', async () => {
    mockSupabaseQuery.single.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = await handler(makeEvent('/api/formulas/F-NOPE'), {} as never, () => {});
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Method not allowed
// ---------------------------------------------------------------------------

describe('Method not allowed', () => {
  it('returns 405 for unsupported methods on /api/formulas', async () => {
    const res = await handler(makeEvent('/api/formulas', 'PATCH'), {} as never, () => {});
    expect(res?.statusCode).toBe(405);
  });
});
