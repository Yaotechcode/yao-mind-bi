import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Supabase mock — hoisted before any imports that use it
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// =============================================================================
// config-service mock — getFirmConfig and updateFirmConfig
// =============================================================================

const { mockGetFirmConfig, mockUpdateFirmConfig } = vi.hoisted(() => ({
  mockGetFirmConfig: vi.fn(),
  mockUpdateFirmConfig: vi.fn(),
}));

vi.mock('../../../src/server/services/config-service.js', () => ({
  getFirmConfig: mockGetFirmConfig,
  updateFirmConfig: mockUpdateFirmConfig,
}));

// =============================================================================
// Service imports (after mock registration)
// =============================================================================

import {
  exportFullConfiguration,
  importFullConfiguration,
} from '../../../src/server/services/config-export-service.js';
import {
  getAuditLog,
  getConfigChangeHistory,
  rollbackConfigChange,
} from '../../../src/server/services/audit-service.js';

// =============================================================================
// Mock builder
// =============================================================================

type MockResponse = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
};

function createMockBuilder(response: MockResponse = {}) {
  const { data = null, error = null, count = 0 } = response;
  const b: Record<string, unknown> = {};

  for (const m of [
    'select', 'eq', 'neq', 'update', 'delete', 'insert', 'upsert',
    'order', 'range', 'gte', 'lte', 'filter', 'in', 'not', 'is', 'limit', 'ilike',
  ]) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  b['single'] = vi.fn().mockResolvedValue({ data, error });
  b['maybeSingle'] = vi.fn().mockResolvedValue({ data, error });

  b['then'] = (
    onfulfilled: ((v: unknown) => unknown) | null,
    _onrejected?: ((v: unknown) => unknown) | null,
  ) => {
    if (typeof onfulfilled === 'function') onfulfilled({ data, error, count });
  };

  return b;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetFirmConfig.mockResolvedValue(BASE_FIRM_CONFIG);
  mockUpdateFirmConfig.mockResolvedValue(BASE_FIRM_CONFIG);
});

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-001';
const USER_ID = 'user-abc';

const BASE_FIRM_CONFIG = {
  firmId: FIRM_ID,
  firmName: 'Test Firm LLP',
  jurisdiction: 'England & Wales',
  currency: 'GBP',
  financialYearStartMonth: 4,
  weekStartDay: 1,
  timezone: 'Europe/London',
  schemaVersion: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-06-01'),
  feeEarnerOverrides: [],
  columnMappingTemplates: [],
  ragThresholds: [],
  customFields: [],
  formulas: [],
  snippets: [],
  entityDefinitions: {},
};

const BUILT_IN_ENTITY = {
  id: 'ent-001',
  firm_id: FIRM_ID,
  entity_key: 'feeEarner',
  is_built_in: true,
  label: 'Fee Earner',
  plural_label: 'Fee Earners',
};

const CUSTOM_ENTITY = {
  id: 'ent-002',
  firm_id: FIRM_ID,
  entity_key: 'officeLocation',
  is_built_in: false,
  label: 'Office Location',
  plural_label: 'Office Locations',
};

const CUSTOM_FIELD_ROW = {
  id: 'cf-001',
  firm_id: FIRM_ID,
  entity_key: 'officeLocation',
  field_key: 'cf_region',
  label: 'Region',
  data_type: 'text',
};

const BUILT_IN_FORMULA = {
  formula_id: 'F-UT-01',
  firm_id: FIRM_ID,
  formula_type: 'built_in',
  name: 'Utilisation Rate',
};

const CUSTOM_FORMULA = {
  formula_id: 'F-CU-01',
  firm_id: FIRM_ID,
  formula_type: 'custom',
  name: 'Custom Score',
};

// =============================================================================
// 1. exportFullConfiguration
// =============================================================================

describe('exportFullConfiguration', () => {
  it('returns all sections with correct structure', async () => {
    // Call sequence:
    // 1. entity_registry read (parallel Promise.all call 1)
    // 2. custom_fields read  (parallel Promise.all call 2)
    // 3. formula_registry read (parallel Promise.all call 3)
    // 4. audit_log insert (export log) — .insert().select('id').single()
    mockFromFn
      .mockImplementationOnce(() =>
        createMockBuilder({ data: [BUILT_IN_ENTITY, CUSTOM_ENTITY] }),
      ) // entity_registry
      .mockImplementationOnce(() => createMockBuilder({ data: [CUSTOM_FIELD_ROW] })) // custom_fields
      .mockImplementationOnce(() =>
        createMockBuilder({ data: [BUILT_IN_FORMULA, CUSTOM_FORMULA] }),
      ) // formula_registry
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'audit-export-001' } })); // audit_log

    const result = await exportFullConfiguration(FIRM_ID, USER_ID);

    // All 7 top-level sections present
    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('firmConfig');
    expect(result).toHaveProperty('entityRegistry');
    expect(result).toHaveProperty('customFields');
    expect(result).toHaveProperty('formulaRegistry');
    expect(result).toHaveProperty('feeEarnerOverrides');
    expect(result).toHaveProperty('columnMappingTemplates');

    // Metadata fields
    expect(result.metadata.firmId).toBe(FIRM_ID);
    expect(result.metadata.firmName).toBe('Test Firm LLP');
    expect(typeof result.metadata.exportDate).toBe('string');
    expect(result.metadata.yaomindVersion).toBe('0.1.0');

    // Entity counts
    expect(result.metadata.entityCounts.builtInEntities).toBe(1);
    expect(result.metadata.entityCounts.customEntities).toBe(1);
    expect(result.metadata.entityCounts.customFields).toBe(1);
    expect(result.metadata.entityCounts.builtInFormulas).toBe(1);
    expect(result.metadata.entityCounts.customFormulas).toBe(1);

    // Data sections
    expect(result.entityRegistry).toHaveLength(2);
    expect(result.customFields).toHaveLength(1);
    expect(result.formulaRegistry).toHaveLength(2);
    expect(result.feeEarnerOverrides).toHaveLength(0);
  });

  it('throws when entity_registry read fails', async () => {
    mockFromFn
      .mockImplementationOnce(() =>
        createMockBuilder({ error: { message: 'connection refused' } }),
      )
      .mockImplementationOnce(() => createMockBuilder({ data: [] }))
      .mockImplementationOnce(() => createMockBuilder({ data: [] }));

    await expect(exportFullConfiguration(FIRM_ID, USER_ID)).rejects.toThrow(
      'entity_registry read failed',
    );
  });
});

// =============================================================================
// 2. importFullConfiguration — built-in entities and formulas are skipped
// =============================================================================

describe('importFullConfiguration', () => {
  /** Builds a minimal valid config JSON string for import tests. */
  function buildImportJson(overrides: Record<string, unknown> = {}) {
    const config = {
      metadata: {
        exportDate: new Date().toISOString(),
        exportedBy: 'test-user',
        yaomindVersion: '0.1.0',
        firmId: 'firm-other',
        firmName: 'Other Firm LLP',
      },
      firmConfig: {
        workingDaysPerWeek: 5,
        dailyTargetHours: 7,
      },
      entityRegistry: [CUSTOM_ENTITY],
      customFields: [CUSTOM_FIELD_ROW],
      formulaRegistry: [CUSTOM_FORMULA, BUILT_IN_FORMULA],
      feeEarnerOverrides: [],
      columnMappingTemplates: [],
      ...overrides,
    };
    return JSON.stringify(config);
  }

  function setupImportMocks() {
    // Mock sequence for importFullConfiguration with 1 custom entity:
    // 1. writeAuditEntry (backup) → audit_log.insert().select('id').single()
    // 2. firm_config.update() → awaited via then
    // 3. entity_registry.upsert() → awaited via then (1 custom entity)
    // 4. custom_fields.delete() for 'officeLocation' → awaited via then
    // 5. custom_fields.insert() → awaited via then
    // 6. formula_registry.upsert() → awaited via then (1 custom formula)
    // 7. writeAuditEntry (import log) → audit_log.insert().select('id').single()
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'backup-001' } })) // backup audit
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // firm_config update
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // entity_registry upsert
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // custom_fields delete
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // custom_fields insert
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // formula_registry upsert
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'audit-002' } })); // import audit
  }

  it('imports custom entities and formulas, skips built-in ones', async () => {
    setupImportMocks();

    const result = await importFullConfiguration(FIRM_ID, buildImportJson(), USER_ID);

    expect(result.success).toBe(true);
    expect(result.imported.customEntities).toBe(1);
    expect(result.imported.customFields).toBe(1);
    expect(result.imported.customFormulas).toBe(1);
    // Built-in formula was in import but should be skipped
    expect(result.skipped.builtInFormulas).toBe(1);
    expect(result.skipped.builtInEntities).toBe(0);
  });

  it('skips built-in entities and does NOT upsert them', async () => {
    // Config with both built-in and custom entities.
    // importedEntityKeys includes both → 2 custom_fields delete calls (one per entity key).
    const configWithBuiltIns = buildImportJson({
      entityRegistry: [BUILT_IN_ENTITY, CUSTOM_ENTITY],
    });

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'backup-001' } })) // backup audit
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // firm_config update
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // entity_registry upsert (custom only)
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // delete feeEarner fields
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // delete officeLocation fields
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // custom_fields insert
      .mockImplementationOnce(() => createMockBuilder({ data: null }))                 // formula_registry upsert
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'audit-002' } })); // import audit

    const result = await importFullConfiguration(FIRM_ID, configWithBuiltIns, USER_ID);

    expect(result.skipped.builtInEntities).toBe(1);
    expect(result.imported.customEntities).toBe(1);
  });

  it('creates a backup in audit_log before any import write', async () => {
    setupImportMocks();

    const result = await importFullConfiguration(FIRM_ID, buildImportJson(), USER_ID);

    // Backup ID comes from the first audit_log insert (backup entry)
    expect(result.backup).toBe('backup-001');

    // The first from() call should be to audit_log (backup)
    const firstCall = mockFromFn.mock.calls[0]?.[0];
    expect(firstCall).toBe('audit_log');
  });

  it('warns when custom fields reference entities not in the import', async () => {
    // Field references 'unknownEntity' which is not in entityRegistry
    const orphanedField = { ...CUSTOM_FIELD_ROW, entity_key: 'unknownEntity' };
    const config = buildImportJson({
      entityRegistry: [CUSTOM_ENTITY], // only officeLocation
      customFields: [orphanedField],   // field refers to unknownEntity
    });

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'backup-001' } }))
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // firm_config update
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // entity_registry upsert
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // delete officeLocation fields
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // delete unknownEntity fields
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // custom_fields insert
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // formula_registry upsert
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'audit-002' } }));

    const result = await importFullConfiguration(FIRM_ID, config, USER_ID);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('unknownEntity');
  });

  it('throws on invalid JSON', async () => {
    await expect(
      importFullConfiguration(FIRM_ID, 'not-valid-json', USER_ID),
    ).rejects.toThrow('Invalid JSON');
  });

  it('throws on schema validation failure', async () => {
    const badConfig = JSON.stringify({ metadata: {}, firmConfig: 'not-an-object' });

    await expect(
      importFullConfiguration(FIRM_ID, badConfig, USER_ID),
    ).rejects.toThrow('Import validation failed');
  });

  it('throws on version incompatibility', async () => {
    const v2Config = buildImportJson({
      metadata: {
        exportDate: new Date().toISOString(),
        yaomindVersion: '2.0.0', // major version mismatch
        firmId: 'firm-other',
      },
    });

    await expect(
      importFullConfiguration(FIRM_ID, v2Config, USER_ID),
    ).rejects.toThrow('Version incompatible');
  });
});

// =============================================================================
// 3. getAuditLog
// =============================================================================

describe('getAuditLog', () => {
  it('returns entries with total count', async () => {
    const entries = [
      {
        id: 'entry-001',
        firm_id: FIRM_ID,
        user_id: USER_ID,
        action: 'update',
        entity_type: 'firm_config',
        entity_id: FIRM_ID,
        description: 'Config updated',
        created_at: new Date().toISOString(),
      },
    ];

    // Count query (head: true) → awaited via then with count
    // Data query → awaited via then with data
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ count: 1 }))     // count query
      .mockImplementationOnce(() => createMockBuilder({ data: entries })); // data query

    const result = await getAuditLog(FIRM_ID, { limit: 10, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('update');
    expect(result.entries[0].firmId).toBe(FIRM_ID);
  });

  it('throws on DB error', async () => {
    mockFromFn
      .mockImplementationOnce(() =>
        createMockBuilder({ error: { message: 'query failed' }, count: 0 }),
      );

    await expect(getAuditLog(FIRM_ID)).rejects.toThrow('getAuditLog count failed');
  });
});

// =============================================================================
// 4. getConfigChangeHistory
// =============================================================================

describe('getConfigChangeHistory', () => {
  it('returns history entries for the given config path', async () => {
    const historyEntries = [
      {
        id: 'h-001',
        firm_id: FIRM_ID,
        user_id: USER_ID,
        action: 'update',
        entity_type: 'firm_config',
        entity_id: FIRM_ID,
        description: JSON.stringify({ path: 'ragThresholds.utilisation', before: 0.7, after: 0.75 }),
        created_at: new Date().toISOString(),
      },
    ];

    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: historyEntries }));

    const result = await getConfigChangeHistory(FIRM_ID, 'ragThresholds.utilisation');

    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe('firm_config');
  });
});

// =============================================================================
// 5. rollbackConfigChange
// =============================================================================

describe('rollbackConfigChange', () => {
  const AUDIT_ENTRY_ID = 'audit-entry-001';

  it('restores the old value by calling updateFirmConfig with the before value', async () => {
    const rollbackPayload = {
      path: 'workingDaysPerWeek',
      before: 4,
      after: 5,
    };
    const auditEntry = {
      id: AUDIT_ENTRY_ID,
      firm_id: FIRM_ID,
      user_id: USER_ID,
      action: 'update',
      entity_type: 'firm_config',
      entity_id: FIRM_ID,
      description: JSON.stringify(rollbackPayload),
      created_at: new Date().toISOString(),
    };

    // Sequence:
    // 1. audit_log read → returns the entry
    // 2. updateFirmConfig call (mocked — doesn't hit DB)
    // 3. audit_log insert (rollback log) → awaited via then
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: auditEntry })) // audit entry read
      .mockImplementationOnce(() => createMockBuilder({ data: null }));       // rollback log insert

    await rollbackConfigChange(FIRM_ID, AUDIT_ENTRY_ID, USER_ID);

    // updateFirmConfig should have been called with the old value
    expect(mockUpdateFirmConfig).toHaveBeenCalledWith(
      FIRM_ID,
      'workingDaysPerWeek',
      4,     // the "before" value
      USER_ID,
    );
  });

  it('throws when audit entry is not found', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'not found' } }),
    );

    await expect(
      rollbackConfigChange(FIRM_ID, AUDIT_ENTRY_ID, USER_ID),
    ).rejects.toThrow(`Audit entry "${AUDIT_ENTRY_ID}" not found`);
  });

  it('throws when trying to roll back a non-config entry', async () => {
    const nonConfigEntry = {
      id: AUDIT_ENTRY_ID,
      firm_id: FIRM_ID,
      action: 'create',
      entity_type: 'custom_fields',
      entity_id: 'cf-001',
      description: 'Custom field created',
      created_at: new Date().toISOString(),
    };

    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: nonConfigEntry }));

    await expect(
      rollbackConfigChange(FIRM_ID, AUDIT_ENTRY_ID, USER_ID),
    ).rejects.toThrow('only supported for firm_config update entries');
  });

  it('throws when description is not valid rollback JSON', async () => {
    const badEntry = {
      id: AUDIT_ENTRY_ID,
      firm_id: FIRM_ID,
      action: 'update',
      entity_type: 'firm_config',
      entity_id: FIRM_ID,
      description: 'Configuration exported by user user-abc', // plain text, not JSON
      created_at: new Date().toISOString(),
    };

    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: badEntry }));

    await expect(
      rollbackConfigChange(FIRM_ID, AUDIT_ENTRY_ID, USER_ID),
    ).rejects.toThrow('not valid JSON');
  });
});
