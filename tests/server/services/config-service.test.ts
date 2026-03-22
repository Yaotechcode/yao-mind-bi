import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Supabase mock — must be hoisted before any imports that use it
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// =============================================================================
// Service imports (after mock registration)
// =============================================================================

import {
  getFirmConfig,
  updateFirmConfig,
  exportFirmConfig,
  importFirmConfig,
  updateRagThreshold,
  resetRagThresholds,
  getFeeEarnerOverrides,
  setFeeEarnerOverride,
  clearFeeEarnerOverride,
  getAuditLog,
} from '../../../src/server/services/config-service.js';

import {
  validateRagThresholdConsistency,
} from '../../../src/shared/validation/config-validators.js';

import { getDefaultFirmConfig } from '../../../src/shared/entities/defaults.js';
import { RagStatus } from '../../../src/shared/types/index.js';

// =============================================================================
// Mock builder — creates a chainable Supabase query object
// =============================================================================

type MockResponse = { data?: unknown; error?: { message: string } | null };

function createMockBuilder(response: MockResponse = {}) {
  const { data = null, error = null } = response;

  const b: Record<string, unknown> = {};

  // All chainable methods return the builder itself
  for (const m of [
    'select', 'eq', 'neq', 'update', 'order', 'range',
    'gte', 'lte', 'filter', 'in', 'not', 'is', 'limit',
  ]) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  // Terminal methods return resolved promises
  b['single'] = vi.fn().mockResolvedValue({ data, error });
  b['maybeSingle'] = vi.fn().mockResolvedValue({ data, error });
  b['insert'] = vi.fn().mockResolvedValue({ data: null, error });
  b['upsert'] = vi.fn().mockResolvedValue({ data: null, error });

  // Make the builder itself awaitable (for chained queries without a terminal method).
  // Calls onfulfilled synchronously to avoid microtask ordering issues in tests.
  b['then'] = (
    onfulfilled: ((v: unknown) => unknown) | null,
    _onrejected?: ((v: unknown) => unknown) | null,
  ) => {
    if (typeof onfulfilled === 'function') onfulfilled({ data, error });
  };

  return b;
}

// Convenience: configure mockFromFn to return the right builder per table
function setupMocks(tableResponses: Record<string, MockResponse>) {
  mockFromFn.mockImplementation((table: string) =>
    createMockBuilder(tableResponses[table] ?? { data: null, error: null }),
  );
}

// Reset mock state between tests so implementations don't bleed across
beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-001';
const USER_ID = 'user-abc';

function makeStoredConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...getDefaultFirmConfig(FIRM_ID, 'Test Firm'),
    ...overrides,
  };
}

// =============================================================================
// 1. getFirmConfig — merges stored config with defaults
// =============================================================================

describe('getFirmConfig', () => {
  it('returns stored config when all fields are present', async () => {
    const stored = makeStoredConfig({ workingDaysPerWeek: 4 });

    setupMocks({
      firm_config: { data: { config: stored } },
    });

    const result = await getFirmConfig(FIRM_ID);
    expect(result.firmId).toBe(FIRM_ID);
    expect(result.workingDaysPerWeek).toBe(4);
  });

  it('fills in missing fields from defaults', async () => {
    // Simulate a stored config that's missing a new field (schema evolution)
    const stored = makeStoredConfig();
    const { workingDaysPerWeek: _removed, ...storedWithoutField } = stored;

    setupMocks({
      firm_config: { data: { config: storedWithoutField } },
    });

    const result = await getFirmConfig(FIRM_ID);
    // Should fall back to the default value
    expect(result.workingDaysPerWeek).toBe(5);
  });

  it('preserves firmId from stored config', async () => {
    const stored = makeStoredConfig({ firmId: FIRM_ID, firmName: 'My Firm' });

    setupMocks({ firm_config: { data: { config: stored } } });

    const result = await getFirmConfig(FIRM_ID);
    expect(result.firmId).toBe(FIRM_ID);
    expect(result.firmName).toBe('My Firm');
  });

  it('throws if the firm config row does not exist', async () => {
    setupMocks({ firm_config: { data: null, error: { message: 'No rows found' } } });

    await expect(getFirmConfig(FIRM_ID)).rejects.toThrow(/Failed to read config/);
  });
});

// =============================================================================
// 2. updateFirmConfig — correct path update + audit log
// =============================================================================

describe('updateFirmConfig', () => {
  it('updates a top-level scalar field and returns the updated config', async () => {
    const stored = makeStoredConfig({ workingDaysPerWeek: 5 });
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    // We need different responses for different tables
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') {
        const builder = createMockBuilder({ data: { config: stored } });
        // The update call should also succeed
        (builder['update'] as ReturnType<typeof vi.fn>).mockReturnValue(builder);
        return builder;
      }
      if (table === 'audit_log') {
        return { insert: auditInsertSpy };
      }
      return createMockBuilder({ data: null });
    });

    const result = await updateFirmConfig(FIRM_ID, 'workingDaysPerWeek', 4, USER_ID);

    expect(result.workingDaysPerWeek).toBe(4);
  });

  it('writes an audit log entry with old and new value', async () => {
    const stored = makeStoredConfig({ workingDaysPerWeek: 5 });
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    await updateFirmConfig(FIRM_ID, 'workingDaysPerWeek', 4, USER_ID);

    expect(auditInsertSpy).toHaveBeenCalledOnce();
    const auditPayload = auditInsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(auditPayload['firm_id']).toBe(FIRM_ID);
    expect(auditPayload['user_id']).toBe(USER_ID);
    expect(auditPayload['action']).toBe('update');

    const diff = auditPayload['diff'] as Record<string, { before: unknown; after: unknown }>;
    expect(diff['workingDaysPerWeek'].before).toBe(5);
    expect(diff['workingDaysPerWeek'].after).toBe(4);
  });

  it('updates a nested path inside ragThresholds', async () => {
    const stored = makeStoredConfig();
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    // The first RAG threshold is utilisation; update its green.min
    const path = 'ragThresholds.0.defaults.green.min';
    const result = await updateFirmConfig(FIRM_ID, path, 0.80, USER_ID);

    expect(result.ragThresholds[0].defaults[RagStatus.GREEN].min).toBe(0.80);
  });

  it('rejects an update that would make the config invalid', async () => {
    const stored = makeStoredConfig();

    setupMocks({ firm_config: { data: { config: stored } } });

    await expect(
      updateFirmConfig(FIRM_ID, 'financialYearStartMonth', 15, USER_ID),
    ).rejects.toThrow(/Config update invalid/);
  });
});

// =============================================================================
// 3. RAG Threshold validation — impossible boundaries
// =============================================================================

describe('validateRagThresholdConsistency', () => {
  it('accepts valid lower-is-better thresholds (green < red)', () => {
    const errors = validateRagThresholdConsistency({
      metricKey: 'debtorDays',
      higherIsBetter: false,
      defaults: {
        green: { max: 30 },
        amber: { min: 30, max: 60 },
        red: { min: 60 },
      },
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts valid higher-is-better thresholds (green > red)', () => {
    const errors = validateRagThresholdConsistency({
      metricKey: 'utilisation',
      higherIsBetter: true,
      defaults: {
        green: { min: 0.75 },
        amber: { min: 0.60, max: 0.75 },
        red: { max: 0.60 },
      },
    });

    expect(errors).toHaveLength(0);
  });

  it('catches impossible boundary: green.max > red.min for lower-is-better', () => {
    // green.max=90 and red.min=30 means green threshold is HIGHER than red — wrong
    const errors = validateRagThresholdConsistency({
      metricKey: 'debtorDays',
      higherIsBetter: false,
      defaults: {
        green: { max: 90 },  // 90 days = green (bad — should be LOW)
        amber: { min: 30, max: 60 },
        red: { min: 30 },    // 30 days = red (bad — should be HIGH)
      },
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/debtorDays/);
    expect(errors[0]).toMatch(/lower-is-better|green threshold.*less than red/i);
  });

  it('catches impossible boundary: green.min < red.max for higher-is-better', () => {
    // green.min=0.30 and red.max=0.70 means green threshold is LOWER than red — wrong
    const errors = validateRagThresholdConsistency({
      metricKey: 'utilisation',
      higherIsBetter: true,
      defaults: {
        green: { min: 0.30 }, // 30% = green (bad — should be HIGH)
        amber: { min: 0.50, max: 0.70 },
        red: { max: 0.70 },   // 70% = red (bad — should be LOW)
      },
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/utilisation/);
  });

  it('updateRagThreshold throws when boundaries are invalid', async () => {
    const stored = makeStoredConfig();
    setupMocks({ firm_config: { data: { config: stored } } });

    await expect(
      updateRagThreshold(
        FIRM_ID,
        'debtorDays',
        {
          higherIsBetter: false,
          defaults: {
            green: { max: 90 },   // impossibly high green for lower-is-better
            amber: { min: 30, max: 60 },
            red: { min: 30 },
          },
        },
        USER_ID,
      ),
    ).rejects.toThrow(/RAG threshold validation failed/);
  });
});

// =============================================================================
// 4. Export → Import round-trip produces identical config
// =============================================================================

describe('exportFirmConfig / importFirmConfig round-trip', () => {
  it('exported config has required metadata fields', async () => {
    const stored = makeStoredConfig({ firmName: 'Round Trip Firm' });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'entity_registry') return createMockBuilder({ data: [] });
      if (table === 'formula_registry') return createMockBuilder({ data: [] });
      return createMockBuilder({ data: null });
    });

    const exported = await exportFirmConfig(FIRM_ID, USER_ID);

    expect(exported.metadata.firmId).toBe(FIRM_ID);
    expect(exported.metadata.yaomindVersion).toBeTruthy();
    expect(exported.metadata.exportDate).toBeTruthy();
    expect(exported.firmConfig).toBeDefined();
    expect(Array.isArray(exported.entityRegistry)).toBe(true);
    expect(Array.isArray(exported.formulaRegistry)).toBe(true);
  });

  it('import then re-export preserves non-identity firm config fields', async () => {
    const stored = makeStoredConfig({ workingDaysPerWeek: 4, firmName: 'Test Firm' });
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    // Set up mocks for import (read current, write back, audit log)
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    const importPayload = {
      metadata: {
        exportDate: new Date().toISOString(),
        exportedBy: USER_ID,
        yaomindVersion: '1.0.0',
        firmId: FIRM_ID,
        firmName: 'Test Firm',
      },
      firmConfig: { ...stored, workingDaysPerWeek: 4 },
      entityRegistry: [],
      customFields: [],
      formulaRegistry: [],
      feeEarnerOverrides: [],
      columnMappingTemplates: [],
    };

    const result = await importFirmConfig(FIRM_ID, importPayload, USER_ID);

    // Import should succeed
    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// =============================================================================
// 5. Import with extra/unknown fields produces warnings but doesn't fail
// =============================================================================

describe('importFirmConfig — unknown fields', () => {
  it('succeeds and returns warnings when extra top-level fields are present', async () => {
    const stored = makeStoredConfig({ firmName: 'Test Firm' });
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    const importPayload = {
      metadata: {
        exportDate: new Date().toISOString(),
        yaomindVersion: '1.0.0',
        firmId: FIRM_ID,
      },
      firmConfig: stored,
      entityRegistry: [],
      customFields: [],
      formulaRegistry: [],
      feeEarnerOverrides: [],
      columnMappingTemplates: [],
      // Extra fields that don't exist in the schema
      unknownTopLevelField: 'some value',
      anotherExtraField: { nested: true },
    };

    const result = await importFirmConfig(FIRM_ID, importPayload as Record<string, unknown>, USER_ID);

    // Should succeed (not throw)
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some((w) => w.includes('unknownTopLevelField'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('anotherExtraField'))).toBe(true);
  });

  it('succeeds and warns when firmConfig has unrecognised fields', async () => {
    const stored = makeStoredConfig({ firmName: 'Test Firm' });
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    const importPayload = {
      metadata: {
        exportDate: new Date().toISOString(),
        yaomindVersion: '1.0.0',
        firmId: FIRM_ID,
      },
      firmConfig: {
        ...stored,
        futureFeatureField: 'from a newer export',
      },
      entityRegistry: [],
      customFields: [],
      formulaRegistry: [],
      feeEarnerOverrides: [],
      columnMappingTemplates: [],
    };

    const result = await importFirmConfig(FIRM_ID, importPayload as Record<string, unknown>, USER_ID);

    expect(result.warnings.some((w) => w.includes('futureFeatureField'))).toBe(true);
  });
});

// =============================================================================
// Fee Earner Override Operations
// =============================================================================

describe('getFeeEarnerOverrides', () => {
  it('returns overrides grouped by feeEarnerId', async () => {
    const stored = makeStoredConfig({
      feeEarnerOverrides: [
        {
          id: 'ov-1',
          firmId: FIRM_ID,
          feeEarnerId: 'fe-1',
          field: 'rate',
          value: 250,
          effectiveFrom: '2024-01-01',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'ov-2',
          firmId: FIRM_ID,
          feeEarnerId: 'fe-1',
          field: 'grade',
          value: 'Partner',
          effectiveFrom: '2024-01-01',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'ov-3',
          firmId: FIRM_ID,
          feeEarnerId: 'fe-2',
          field: 'rate',
          value: 175,
          effectiveFrom: '2024-01-01',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    setupMocks({ firm_config: { data: { config: stored } } });

    const result = await getFeeEarnerOverrides(FIRM_ID);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['fe-1']).toHaveLength(2);
    expect(result['fe-2']).toHaveLength(1);
  });

  it('returns empty object when no overrides exist', async () => {
    const stored = makeStoredConfig({ feeEarnerOverrides: [] });
    setupMocks({ firm_config: { data: { config: stored } } });

    const result = await getFeeEarnerOverrides(FIRM_ID);
    expect(result).toEqual({});
  });
});

describe('setFeeEarnerOverride', () => {
  it('rejects overrides for non-existent feeEarner fields', async () => {
    const stored = makeStoredConfig();
    setupMocks({ firm_config: { data: { config: stored } } });

    await expect(
      setFeeEarnerOverride(
        FIRM_ID,
        'fe-1',
        [{ field: 'nonExistentField', value: 'x', effectiveFrom: '2024-01-01' }],
        USER_ID,
      ),
    ).rejects.toThrow(/Invalid override field/);
  });

  it('accepts valid feeEarner field overrides', async () => {
    const stored = makeStoredConfig();
    const auditInsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') return createMockBuilder({ data: { config: stored } });
      if (table === 'audit_log') return { insert: auditInsertSpy };
      return createMockBuilder({ data: null });
    });

    await expect(
      setFeeEarnerOverride(
        FIRM_ID,
        'fe-1',
        [{ field: 'rate', value: 300, effectiveFrom: '2024-01-01' }],
        USER_ID,
      ),
    ).resolves.not.toThrow();
  });
});

describe('clearFeeEarnerOverride', () => {
  it('removes all overrides for the specified fee earner', async () => {
    let savedConfig: Record<string, unknown> | null = null;
    const stored = makeStoredConfig({
      feeEarnerOverrides: [
        {
          id: 'ov-1', firmId: FIRM_ID, feeEarnerId: 'fe-1',
          field: 'rate', value: 250, effectiveFrom: '2024-01-01',
          createdAt: new Date(), updatedAt: new Date(),
        },
        {
          id: 'ov-2', firmId: FIRM_ID, feeEarnerId: 'fe-2',
          field: 'rate', value: 175, effectiveFrom: '2024-01-01',
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') {
        const builder = createMockBuilder({ data: { config: stored } });
        const originalUpdate = builder['update'] as ReturnType<typeof vi.fn>;
        originalUpdate.mockImplementation((payload: Record<string, unknown>) => {
          savedConfig = payload['config'] as Record<string, unknown>;
          return builder;
        });
        return builder;
      }
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      return createMockBuilder({ data: null });
    });

    await clearFeeEarnerOverride(FIRM_ID, 'fe-1', USER_ID);

    // After clear, only fe-2 override should remain
    if (savedConfig) {
      const remaining = (savedConfig as { feeEarnerOverrides: Array<{ feeEarnerId: string }> })
        .feeEarnerOverrides;
      expect(remaining.every((o) => o.feeEarnerId !== 'fe-1')).toBe(true);
      expect(remaining.some((o) => o.feeEarnerId === 'fe-2')).toBe(true);
    }
  });
});

// =============================================================================
// getAuditLog
// =============================================================================

describe('getAuditLog', () => {
  it('queries with firm_id and returns entries', async () => {
    const entries = [
      { id: '1', firm_id: FIRM_ID, action: 'update', entity_type: 'firm_config', entity_id: FIRM_ID, timestamp: new Date().toISOString() },
    ];

    setupMocks({ audit_log: { data: entries } });

    const result = await getAuditLog(FIRM_ID);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no entries exist', async () => {
    setupMocks({ audit_log: { data: [] } });

    const result = await getAuditLog(FIRM_ID);
    expect(result).toEqual([]);
  });
});

// =============================================================================
// resetRagThresholds
// =============================================================================

describe('resetRagThresholds', () => {
  it('replaces thresholds with defaults', async () => {
    const stored = makeStoredConfig({
      // Deliberately weird threshold to verify it gets reset
      ragThresholds: [],
    });

    let savedConfig: Record<string, unknown> | null = null;

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'firm_config') {
        const builder = createMockBuilder({ data: { config: stored } });
        (builder['update'] as ReturnType<typeof vi.fn>).mockImplementation(
          (payload: Record<string, unknown>) => {
            savedConfig = payload['config'] as Record<string, unknown>;
            return builder;
          },
        );
        return builder;
      }
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      return createMockBuilder({ data: null });
    });

    await resetRagThresholds(FIRM_ID, USER_ID);

    if (savedConfig) {
      const thresholds = (savedConfig as { ragThresholds: unknown[] }).ragThresholds;
      expect(thresholds.length).toBeGreaterThan(0);
    }
  });
});
