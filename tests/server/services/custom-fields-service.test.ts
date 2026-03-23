import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Supabase mock — hoisted before any imports that use it
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// MongoDB mock — getCollection returns a mock collection
const { mockCollection } = vi.hoisted(() => ({
  mockCollection: {
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
  },
}));

vi.mock('../../../src/server/lib/mongodb.js', () => ({
  getCollection: vi.fn().mockResolvedValue(mockCollection),
}));

// =============================================================================
// Service imports (after mock registration)
// =============================================================================

import {
  getCustomFields,
  createCustomField,
  deleteCustomField,
  updateCustomField,
} from '../../../src/server/services/custom-fields-service.js';

import { validateCustomFieldValue } from '../../../src/shared/validation/custom-field-validators.js';

// =============================================================================
// Mock builder
// =============================================================================
// This builder makes insert/delete/update chainable (returning the builder)
// so patterns like .insert({}).select('*').single() work correctly.

type MockResponse = { data?: unknown; error?: { message: string } | null };

function createMockBuilder(response: MockResponse = {}) {
  const { data = null, error = null } = response;

  const b: Record<string, unknown> = {};

  // All chainable query methods — including insert, update, delete
  for (const m of [
    'select', 'eq', 'neq', 'update', 'delete', 'insert', 'upsert',
    'order', 'range', 'gte', 'lte', 'filter', 'in', 'not', 'is', 'limit',
  ]) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  // Terminal methods
  b['single'] = vi.fn().mockResolvedValue({ data, error });
  b['maybeSingle'] = vi.fn().mockResolvedValue({ data, error });

  // Direct await support (for chained queries without a terminal method)
  b['then'] = (
    onfulfilled: ((v: unknown) => unknown) | null,
    _onrejected?: ((v: unknown) => unknown) | null,
  ) => {
    if (typeof onfulfilled === 'function') onfulfilled({ data, error });
  };

  return b;
}

beforeEach(() => {
  // resetAllMocks clears call history AND the mockImplementationOnce queue,
  // preventing stale entries from contaminating subsequent tests.
  vi.resetAllMocks();
  mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  mockCollection.updateOne.mockResolvedValue({ upsertedCount: 1 });
});

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-001';
const USER_ID = 'user-abc';
const ENTITY_KEY = 'feeEarner';
const FIELD_ID = 'cf-uuid-001';

const VALID_INPUT = {
  entity_key: ENTITY_KEY,
  field_key: 'cf_matter_type',
  label: 'Matter Type',
  data_type: 'text' as const,
  source: 'manual' as const,
  display_config: {},
};

const ENTITY_ROW = {
  entity_key: ENTITY_KEY,
  fields: [],
};

function makeInsertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIELD_ID,
    firm_id: FIRM_ID,
    entity_key: ENTITY_KEY,
    field_key: 'cf_matter_type',
    label: 'Matter Type',
    data_type: 'text',
    select_options: null,
    default_value: null,
    description: null,
    source: 'manual',
    display_config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// 1. getCustomFields
// =============================================================================

describe('getCustomFields', () => {
  it('returns all fields for the firm', async () => {
    const rows = [makeInsertedRow(), makeInsertedRow({ id: 'cf-002', field_key: 'cf_rate' })];
    mockFromFn.mockReturnValue(createMockBuilder({ data: rows }));

    const result = await getCustomFields(FIRM_ID);
    expect(result).toHaveLength(2);
    expect(result[0].firmId).toBe(FIRM_ID);
  });

  it('filters by entityKey when provided', async () => {
    mockFromFn.mockReturnValue(createMockBuilder({ data: [makeInsertedRow()] }));

    const result = await getCustomFields(FIRM_ID, ENTITY_KEY);
    expect(result).toHaveLength(1);
  });

  it('throws on DB error', async () => {
    mockFromFn.mockReturnValue(
      createMockBuilder({ error: { message: 'connection refused' } }),
    );

    await expect(getCustomFields(FIRM_ID)).rejects.toThrow('connection refused');
  });
});

// =============================================================================
// 2. createCustomField
// =============================================================================

describe('createCustomField', () => {
  it('creates a field and updates entity registry', async () => {
    const insertedRow = makeInsertedRow();

    // Call sequence (5 calls — entity fields come from the existence check, no separate read):
    // 1. entity_registry lookup (.single) — also provides current fields array
    // 2. custom_fields uniqueness check (.maybeSingle → null = no existing)
    // 3. custom_fields insert → .select → .single
    // 4. entity_registry update (awaited via .then)
    // 5. audit_log insert (awaited via .then)
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: ENTITY_ROW }))    // entity_registry lookup
      .mockImplementationOnce(() => createMockBuilder({ data: null }))          // uniqueness check
      .mockImplementationOnce(() => createMockBuilder({ data: insertedRow }))   // insert + select
      .mockImplementationOnce(() => createMockBuilder({ data: null }))          // entity_registry update
      .mockImplementationOnce(() => createMockBuilder({ data: null }));         // audit_log

    const result = await createCustomField(FIRM_ID, VALID_INPUT, USER_ID);

    expect(result.id).toBe(FIELD_ID);
    expect(result.fieldKey).toBe('cf_matter_type');
    expect(result.entityKey).toBe(ENTITY_KEY);
    // entity_registry and custom_fields were both accessed
    expect(mockFromFn).toHaveBeenCalledWith('entity_registry');
    expect(mockFromFn).toHaveBeenCalledWith('custom_fields');
    expect(mockFromFn).toHaveBeenCalledWith('audit_log');
  });

  it('throws when entity_key does not exist in entity_registry', async () => {
    // entity_registry lookup returns an error (not found)
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'no rows' } }),
    );

    await expect(
      createCustomField(FIRM_ID, VALID_INPUT, USER_ID),
    ).rejects.toThrow(`entity_key "${ENTITY_KEY}" does not exist in entity_registry for this firm`);
  });

  it('throws when field_key already exists for this entity', async () => {
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: ENTITY_ROW }))       // entity_registry found
      .mockImplementationOnce(() => createMockBuilder({ data: { id: 'cf-old' } })); // uniqueness → already exists

    await expect(
      createCustomField(FIRM_ID, VALID_INPUT, USER_ID),
    ).rejects.toThrow(`field_key "cf_matter_type" already exists for entity "${ENTITY_KEY}" in this firm`);
  });

  it('throws when field_key does not start with cf_', async () => {
    await expect(
      createCustomField(
        FIRM_ID,
        { ...VALID_INPUT, field_key: 'bad_key' },
        USER_ID,
      ),
    ).rejects.toThrow('cf_');
  });

  it('throws when data_type is select and select_options is empty', async () => {
    await expect(
      createCustomField(
        FIRM_ID,
        { ...VALID_INPUT, data_type: 'select', select_options: [] },
        USER_ID,
      ),
    ).rejects.toThrow('select_options');
  });
});

// =============================================================================
// 3. updateCustomField
// =============================================================================

describe('updateCustomField', () => {
  it('updates the field and syncs entity registry', async () => {
    const currentRow = makeInsertedRow();
    const updatedRow = makeInsertedRow({ label: 'Updated Label' });

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: currentRow }))   // read current
      .mockImplementationOnce(() => createMockBuilder({ data: updatedRow }))   // update + select
      .mockImplementationOnce(() => createMockBuilder({ data: ENTITY_ROW }))   // entity_registry read
      .mockImplementationOnce(() => createMockBuilder({ data: null }))         // entity_registry update
      .mockImplementationOnce(() => createMockBuilder({ data: null }));        // audit_log

    const result = await updateCustomField(
      FIRM_ID,
      FIELD_ID,
      { label: 'Updated Label' },
      USER_ID,
    );

    expect(result.label).toBe('Updated Label');
  });

  it('throws when field not found', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'not found' } }),
    );

    await expect(
      updateCustomField(FIRM_ID, FIELD_ID, { label: 'x' }, USER_ID),
    ).rejects.toThrow(`Custom field "${FIELD_ID}" not found`);
  });

  it('throws when switching to select data_type without providing select_options', async () => {
    const currentRow = makeInsertedRow({ data_type: 'text', select_options: null });

    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: currentRow }));

    await expect(
      updateCustomField(FIRM_ID, FIELD_ID, { data_type: 'select' }, USER_ID),
    ).rejects.toThrow('select_options');
  });
});

// =============================================================================
// 4. deleteCustomField
// =============================================================================

describe('deleteCustomField', () => {
  it('deletes field when not referenced by any formula', async () => {
    const fieldRow = makeInsertedRow();

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: fieldRow }))      // read field
      .mockImplementationOnce(() => createMockBuilder({ data: [] }))            // formula_registry (empty)
      .mockImplementationOnce(() => createMockBuilder({ data: null }))          // delete
      .mockImplementationOnce(() => createMockBuilder({ data: ENTITY_ROW }))    // entity_registry read
      .mockImplementationOnce(() => createMockBuilder({ data: null }))          // entity_registry update
      .mockImplementationOnce(() => createMockBuilder({ data: null }));         // audit_log

    const result = await deleteCustomField(FIRM_ID, FIELD_ID, USER_ID);

    expect(result.warnings).toHaveLength(0);
    // delete was called on custom_fields
    expect(mockFromFn).toHaveBeenCalledWith('custom_fields');
  });

  it('returns warning and does NOT delete when field is referenced by a formula', async () => {
    const fieldRow = makeInsertedRow({ field_key: 'cf_matter_type' });
    const formulas = [
      {
        formula_id: 'F-XX-01',
        name: 'Scope Creep Score',
        modifiers: [{ field: 'cf_matter_type', op: 'equals', value: 'litigation' }],
        depends_on: [],
      },
    ];

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: fieldRow }))    // read field
      .mockImplementationOnce(() => createMockBuilder({ data: formulas }));   // formula_registry

    const result = await deleteCustomField(FIRM_ID, FIELD_ID, USER_ID);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Scope Creep Score');
    expect(result.warnings[0]).toContain('cf_matter_type');
    // Only 2 calls — delete was NOT attempted
    expect(mockFromFn).toHaveBeenCalledTimes(2);
  });

  it('throws when field not found', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'not found' } }),
    );

    await expect(deleteCustomField(FIRM_ID, FIELD_ID, USER_ID)).rejects.toThrow(
      `Custom field "${FIELD_ID}" not found`,
    );
  });
});

// =============================================================================
// 5. validateCustomFieldValue — per data type
// =============================================================================

describe('validateCustomFieldValue', () => {
  it('accepts a valid text value', () => {
    expect(validateCustomFieldValue('text', 'hello')).toEqual({ valid: true });
  });

  it('rejects non-string for text', () => {
    expect(validateCustomFieldValue('text', 42)).toMatchObject({ valid: false });
  });

  it('accepts a valid number', () => {
    expect(validateCustomFieldValue('number', 3.14)).toEqual({ valid: true });
  });

  it('rejects NaN for number', () => {
    expect(validateCustomFieldValue('number', NaN)).toMatchObject({ valid: false });
  });

  it('accepts a valid currency amount', () => {
    expect(validateCustomFieldValue('currency', 1500)).toEqual({ valid: true });
  });

  it('accepts a valid percentage', () => {
    expect(validateCustomFieldValue('percentage', 75.5)).toEqual({ valid: true });
  });

  it('accepts a valid ISO date string', () => {
    expect(validateCustomFieldValue('date', '2025-03-23')).toEqual({ valid: true });
  });

  it('rejects an invalid date string', () => {
    expect(validateCustomFieldValue('date', 'not-a-date')).toMatchObject({ valid: false });
  });

  it('accepts true/false for boolean', () => {
    expect(validateCustomFieldValue('boolean', true)).toEqual({ valid: true });
    expect(validateCustomFieldValue('boolean', false)).toEqual({ valid: true });
  });

  it('rejects a string for boolean', () => {
    expect(validateCustomFieldValue('boolean', 'true')).toMatchObject({ valid: false });
  });

  it('accepts a string for select', () => {
    expect(validateCustomFieldValue('select', 'litigation')).toEqual({ valid: true });
  });

  it('accepts a non-empty string for reference', () => {
    expect(validateCustomFieldValue('reference', 'rec-uuid-123')).toEqual({ valid: true });
  });

  it('rejects empty string for reference', () => {
    expect(validateCustomFieldValue('reference', '')).toMatchObject({ valid: false });
  });
});
