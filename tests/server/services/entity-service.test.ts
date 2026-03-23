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
    findOne: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  },
}));

vi.mock('../../../src/server/lib/mongodb.js', () => ({
  getCollection: vi.fn().mockResolvedValue(mockCollection),
}));

// =============================================================================
// Service imports (after mock registration)
// =============================================================================

import {
  getEntityRegistry,
  getEntityDefinition,
  createCustomEntity,
  updateCustomEntity,
  deleteCustomEntity,
  getCustomEntityRecords,
  refreshDerivedEntity,
} from '../../../src/server/services/entity-service.js';

import { getCollection } from '../../../src/server/lib/mongodb.js';

// =============================================================================
// Mock builder
// =============================================================================

type MockResponse = { data?: unknown; error?: { message: string } | null };

function createMockBuilder(response: MockResponse = {}) {
  const { data = null, error = null } = response;

  const b: Record<string, unknown> = {};

  for (const m of [
    'select', 'eq', 'neq', 'update', 'delete', 'insert', 'upsert',
    'order', 'range', 'gte', 'lte', 'filter', 'in', 'not', 'is', 'limit',
  ]) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  b['single'] = vi.fn().mockResolvedValue({ data, error });
  b['maybeSingle'] = vi.fn().mockResolvedValue({ data, error });

  b['then'] = (
    onfulfilled: ((v: unknown) => unknown) | null,
    _onrejected?: ((v: unknown) => unknown) | null,
  ) => {
    if (typeof onfulfilled === 'function') onfulfilled({ data, error });
  };

  return b;
}

beforeEach(() => {
  vi.resetAllMocks();
  // Restore getCollection after resetAllMocks clears its implementation
  vi.mocked(getCollection).mockResolvedValue(mockCollection as unknown as Awaited<ReturnType<typeof getCollection>>);
  mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
  mockCollection.findOne.mockResolvedValue(null);
  mockCollection.updateOne.mockResolvedValue({ upsertedCount: 1 });
  mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-001';
const USER_ID = 'user-abc';
const ENTITY_KEY = 'officeLocation';

const VALID_FIELDS = [
  { key: 'name', label: 'Name', type: 'string', required: true },
];

const BASE_ENTITY_ROW = {
  id: 'ent-uuid-001',
  firm_id: FIRM_ID,
  entity_key: ENTITY_KEY,
  is_built_in: false,
  label: 'Office Location',
  plural_label: 'Office Locations',
  icon: null,
  description: null,
  fields: VALID_FIELDS,
  relationships: [],
  data_source: null,
  derived_from: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const BUILT_IN_ROW = {
  ...BASE_ENTITY_ROW,
  entity_key: 'feeEarner',
  is_built_in: true,
};

// =============================================================================
// 1. getEntityRegistry
// =============================================================================

describe('getEntityRegistry', () => {
  it('returns all entities for the firm', async () => {
    mockFromFn.mockReturnValue(createMockBuilder({ data: [BASE_ENTITY_ROW, BUILT_IN_ROW] }));

    const result = await getEntityRegistry(FIRM_ID);

    expect(result).toHaveLength(2);
    expect(result[0].firmId).toBe(FIRM_ID);
    expect(result[0].entityKey).toBe(ENTITY_KEY);
  });

  it('throws on DB error', async () => {
    mockFromFn.mockReturnValue(
      createMockBuilder({ error: { message: 'connection refused' } }),
    );

    await expect(getEntityRegistry(FIRM_ID)).rejects.toThrow('connection refused');
  });
});

// =============================================================================
// 2. getEntityDefinition
// =============================================================================

describe('getEntityDefinition', () => {
  it('returns the entity when found', async () => {
    mockFromFn.mockReturnValue(createMockBuilder({ data: BASE_ENTITY_ROW }));

    const result = await getEntityDefinition(FIRM_ID, ENTITY_KEY);

    expect(result).not.toBeNull();
    expect(result!.entityKey).toBe(ENTITY_KEY);
    expect(result!.isBuiltIn).toBe(false);
  });

  it('returns null when not found', async () => {
    mockFromFn.mockReturnValue(createMockBuilder({ data: null }));

    const result = await getEntityDefinition(FIRM_ID, 'nonexistent');

    expect(result).toBeNull();
  });
});

// =============================================================================
// 3. createCustomEntity
// =============================================================================

describe('createCustomEntity', () => {
  it('creates entity "Office" derived from feeEarner.costsCentre', async () => {
    const officeEntity = {
      ...BASE_ENTITY_ROW,
      entity_key: 'office',
      label: 'Office',
      plural_label: 'Offices',
      data_source: 'derived',
      derived_from: { sourceEntityKey: 'feeEarner', sourceFieldKey: 'costsCentre' },
    };

    const feeEarnerRow = {
      entity_key: 'feeEarner',
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'costsCentre', label: 'Costs Centre', type: 'string', required: false },
      ],
    };

    // Call sequence:
    // 1. uniqueness check (.maybeSingle → null = no existing)
    // 2. derived_from source entity lookup (.single → feeEarnerRow)
    // 3. insert + select (.single → officeEntity)
    // 4. audit_log insert (awaited via .then)
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: null }))          // uniqueness check
      .mockImplementationOnce(() => createMockBuilder({ data: feeEarnerRow }))  // derived_from source
      .mockImplementationOnce(() => createMockBuilder({ data: officeEntity }))  // insert
      .mockImplementationOnce(() => createMockBuilder({ data: null }));          // audit_log

    const result = await createCustomEntity(
      FIRM_ID,
      {
        entityKey: 'office',
        label: 'Office',
        pluralLabel: 'Offices',
        fields: VALID_FIELDS,
        relationships: [],
        dataSource: 'derived',
        derivedFrom: { sourceEntityKey: 'feeEarner', sourceFieldKey: 'costsCentre' },
      },
      USER_ID,
    );

    expect(result.entityKey).toBe('office');
    expect(result.isBuiltIn).toBe(false);
    expect(result.derivedFrom?.sourceEntityKey).toBe('feeEarner');
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1); // MongoDB record init
  });

  it('throws when entity_key already exists', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: { entity_key: ENTITY_KEY } }),
    );

    await expect(
      createCustomEntity(
        FIRM_ID,
        {
          entityKey: ENTITY_KEY,
          label: 'Office Location',
          pluralLabel: 'Office Locations',
          fields: VALID_FIELDS,
          relationships: [],
        },
        USER_ID,
      ),
    ).rejects.toThrow(`entity_key "${ENTITY_KEY}" already exists`);
  });

  it('throws when entity_key has invalid format', async () => {
    await expect(
      createCustomEntity(
        FIRM_ID,
        {
          entityKey: 'Office-Location', // uppercase + hyphens — invalid
          label: 'Office Location',
          pluralLabel: 'Office Locations',
          fields: VALID_FIELDS,
          relationships: [],
        },
        USER_ID,
      ),
    ).rejects.toThrow('entity_key must be lowercase');
  });

  it('throws when relationship target does not exist', async () => {
    // uniqueness check passes (no existing), then relationship target lookup fails
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: null }))  // uniqueness check
      .mockImplementationOnce(() => createMockBuilder({ data: null })); // target lookup

    await expect(
      createCustomEntity(
        FIRM_ID,
        {
          entityKey: 'office',
          label: 'Office',
          pluralLabel: 'Offices',
          fields: VALID_FIELDS,
          relationships: [
            {
              key: 'staff',
              type: 'hasMany',
              targetEntityKey: 'nonexistentEntity',
              localKey: 'id',
              foreignKey: 'officeId',
            },
          ],
        },
        USER_ID,
      ),
    ).rejects.toThrow('Relationship target entity "nonexistentEntity" does not exist');
  });

  it('throws when no required field is present', async () => {
    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: null })); // uniqueness

    await expect(
      createCustomEntity(
        FIRM_ID,
        {
          entityKey: 'office',
          label: 'Office',
          pluralLabel: 'Offices',
          fields: [{ key: 'name', label: 'Name', type: 'string', required: false }],
          relationships: [],
        },
        USER_ID,
      ),
    ).rejects.toThrow('at least one field with required: true');
  });
});

// =============================================================================
// 4. updateCustomEntity
// =============================================================================

describe('updateCustomEntity', () => {
  it('updates label and pluralLabel', async () => {
    const updatedRow = { ...BASE_ENTITY_ROW, label: 'Branch Office', plural_label: 'Branch Offices' };

    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: BASE_ENTITY_ROW })) // read current
      .mockImplementationOnce(() => createMockBuilder({ data: updatedRow }))      // update
      .mockImplementationOnce(() => createMockBuilder({ data: null }));           // audit_log

    const result = await updateCustomEntity(
      FIRM_ID,
      ENTITY_KEY,
      { label: 'Branch Office', pluralLabel: 'Branch Offices' },
      USER_ID,
    );

    expect(result.label).toBe('Branch Office');
    expect(result.pluralLabel).toBe('Branch Offices');
  });

  it('throws when entity not found', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'not found' } }),
    );

    await expect(
      updateCustomEntity(FIRM_ID, ENTITY_KEY, { label: 'x' }, USER_ID),
    ).rejects.toThrow(`Entity "${ENTITY_KEY}" not found`);
  });

  it('throws when attempting to update a built-in entity', async () => {
    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: BUILT_IN_ROW }));

    await expect(
      updateCustomEntity(FIRM_ID, 'feeEarner', { label: 'Solicitor' }, USER_ID),
    ).rejects.toThrow('Cannot update built-in entity');
  });
});

// =============================================================================
// 5. deleteCustomEntity
// =============================================================================

describe('deleteCustomEntity', () => {
  it('deletes entity when not referenced by any formula or other entity', async () => {
    // Call sequence:
    // 1. read entity to verify + check is_built_in (.single)
    // 2. formula_registry scan (.eq('entity_type', entityKey)) → empty
    // 3. all other entities' relationships scan (.neq) → empty
    // 4. delete entity_registry row
    // 5. delete custom_fields for this entity
    // 6. audit_log
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: BASE_ENTITY_ROW })) // read entity
      .mockImplementationOnce(() => createMockBuilder({ data: [] }))              // formula_registry
      .mockImplementationOnce(() => createMockBuilder({ data: [] }))              // other entities
      .mockImplementationOnce(() => createMockBuilder({ data: null }))            // delete entity
      .mockImplementationOnce(() => createMockBuilder({ data: null }))            // delete custom_fields
      .mockImplementationOnce(() => createMockBuilder({ data: null }));           // audit_log

    const result = await deleteCustomEntity(FIRM_ID, ENTITY_KEY, USER_ID);

    expect(result.warnings).toHaveLength(0);
    expect(mockCollection.deleteOne).toHaveBeenCalledWith({ firmId: FIRM_ID, entityKey: ENTITY_KEY });
  });

  it('returns warning and does NOT delete when entity is referenced by a formula', async () => {
    const formulas = [{ formula_id: 'F-UT-01', name: 'Office Utilisation' }];

    // Call sequence:
    // 1. read entity row
    // 2. formula_registry scan → returns referencing formula
    // 3. other entities' relationships scan → empty (all warnings collected before early return)
    mockFromFn
      .mockImplementationOnce(() => createMockBuilder({ data: BASE_ENTITY_ROW })) // read entity
      .mockImplementationOnce(() => createMockBuilder({ data: formulas }))        // formula_registry
      .mockImplementationOnce(() => createMockBuilder({ data: [] }));             // other entities

    const result = await deleteCustomEntity(FIRM_ID, ENTITY_KEY, USER_ID);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Office Utilisation');
    // Only 3 Supabase calls — delete was NOT attempted
    expect(mockFromFn).toHaveBeenCalledTimes(3);
    expect(mockCollection.deleteOne).not.toHaveBeenCalled();
  });

  it('throws when entity not found', async () => {
    mockFromFn.mockImplementationOnce(() =>
      createMockBuilder({ data: null, error: { message: 'not found' } }),
    );

    await expect(deleteCustomEntity(FIRM_ID, ENTITY_KEY, USER_ID)).rejects.toThrow(
      `Entity "${ENTITY_KEY}" not found`,
    );
  });

  it('throws when attempting to delete a built-in entity', async () => {
    mockFromFn.mockImplementationOnce(() => createMockBuilder({ data: BUILT_IN_ROW }));

    await expect(deleteCustomEntity(FIRM_ID, 'feeEarner', USER_ID)).rejects.toThrow(
      'Cannot delete built-in entity',
    );
  });
});

// =============================================================================
// 6. getCustomEntityRecords
// =============================================================================

describe('getCustomEntityRecords', () => {
  it('returns records from MongoDB', async () => {
    const records = [{ name: 'London' }, { name: 'Manchester' }];
    mockCollection.findOne.mockResolvedValue({ firmId: FIRM_ID, entityKey: ENTITY_KEY, records });

    const result = await getCustomEntityRecords(FIRM_ID, ENTITY_KEY);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'London' });
  });

  it('returns empty array when no document exists', async () => {
    mockCollection.findOne.mockResolvedValue(null);

    const result = await getCustomEntityRecords(FIRM_ID, ENTITY_KEY);

    expect(result).toEqual([]);
  });
});

// =============================================================================
// 7. refreshDerivedEntity
// =============================================================================

describe('refreshDerivedEntity', () => {
  const DERIVED_ROW = {
    data_source: 'derived',
    derived_from: { sourceEntityKey: 'feeEarner', sourceFieldKey: 'costsCentre' },
  };

  it('returns existing records unchanged when pipeline data does not exist yet ([])', async () => {
    const existingRecords = [{ costsCentre: 'London' }];

    mockFromFn.mockReturnValue(createMockBuilder({ data: DERIVED_ROW }));
    mockCollection.findOne.mockResolvedValue({
      firmId: FIRM_ID,
      entityKey: ENTITY_KEY,
      records: existingRecords,
    });
    // Enriched collection returns empty array — pipeline not run yet
    mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

    const result = await refreshDerivedEntity(FIRM_ID, ENTITY_KEY, USER_ID);

    expect(result).toEqual(existingRecords);
    // updateOne should NOT be called — no merge needed
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it('appends new unique values discovered in enriched pipeline data', async () => {
    const enrichedDocs = [
      { firmId: FIRM_ID, costsCentre: 'London' },
      { firmId: FIRM_ID, costsCentre: 'Manchester' },
      { firmId: FIRM_ID, costsCentre: 'London' }, // duplicate — should be deduplicated
    ];

    mockFromFn.mockReturnValue(createMockBuilder({ data: DERIVED_ROW }));
    // No existing records
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue(enrichedDocs) });

    const result = await refreshDerivedEntity(FIRM_ID, ENTITY_KEY, USER_ID);

    // 2 unique values: London, Manchester
    expect(result).toHaveLength(2);
    const values = result.map((r) => r['costsCentre']);
    expect(values).toContain('London');
    expect(values).toContain('Manchester');
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
  });

  it('flags records whose source value is no longer present in enriched data', async () => {
    const existingRecords = [
      { costsCentre: 'London' },
      { costsCentre: 'Bristol' }, // Bristol no longer in pipeline
    ];
    const enrichedDocs = [
      { firmId: FIRM_ID, costsCentre: 'London' },
    ];

    mockFromFn.mockReturnValue(createMockBuilder({ data: DERIVED_ROW }));
    mockCollection.findOne.mockResolvedValue({
      firmId: FIRM_ID,
      entityKey: ENTITY_KEY,
      records: existingRecords,
    });
    mockCollection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue(enrichedDocs) });

    const result = await refreshDerivedEntity(FIRM_ID, ENTITY_KEY, USER_ID);

    const bristol = result.find((r) => r['costsCentre'] === 'Bristol');
    expect(bristol).toBeDefined();
    expect(bristol!['_flagged']).toBe(true);

    const london = result.find((r) => r['costsCentre'] === 'London');
    expect(london!['_flagged']).toBeUndefined();
  });

  it('throws when entity is not a derived entity', async () => {
    const nonDerivedRow = { data_source: null, derived_from: null };
    mockFromFn.mockReturnValue(createMockBuilder({ data: nonDerivedRow }));

    await expect(refreshDerivedEntity(FIRM_ID, ENTITY_KEY, USER_ID)).rejects.toThrow(
      `Entity "${ENTITY_KEY}" is not a derived entity`,
    );
  });
});
