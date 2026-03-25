import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FormulaVersionManager } from '../../../src/server/formula-engine/version-manager.js';
import type {
  FormulaVersion,
  FormulaVersionSnapshot,
} from '../../../src/server/formula-engine/version-manager.js';
import type { BuiltInFormulaDefinition } from '../../../src/shared/formulas/types.js';
import { EntityType } from '../../../src/shared/types/index.js';

// =============================================================================
// Mock helpers
// =============================================================================

type MockResult = { data: unknown; error: { message: string } | null };

/**
 * Create a Supabase-style query builder chain that resolves to `result`.
 * All builder methods return `this` so the chain can be arbitrarily deep.
 * The chain is directly awaitable AND supports .single().
 */
function makeChain(result: MockResult) {
  // We use a real Promise so the chain is properly thenable.
  const resolvedPromise = Promise.resolve(result);

  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    then: resolvedPromise.then.bind(resolvedPromise),
    catch: resolvedPromise.catch.bind(resolvedPromise),
  };

  return chain;
}

/**
 * Build a mock Supabase client whose `from()` calls return chains in sequence.
 * Pass results in the order that `from()` will be called during the test.
 */
function makeMockClient(...results: MockResult[]) {
  const from = vi.fn();
  results.forEach((result) => {
    from.mockReturnValueOnce(makeChain(result));
  });
  return { from } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Test data helpers
// =============================================================================

function makeFormulaDef(
  formulaId = 'F-TU-01',
  overrides: Partial<BuiltInFormulaDefinition> = {},
): BuiltInFormulaDefinition {
  return {
    formulaId,
    name: 'Test Formula',
    description: 'A formula for testing',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach: 'billableHours / targetHours',
      nullHandling: 'return null',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: { name: 'Default', description: 'Standard', logic: 'std' },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: { dashboard: 'fee-earner' },
    ...overrides,
  };
}

/**
 * Build a database row that represents a stored FormulaVersion.
 * Used as the `data` payload returned by mock Supabase queries.
 */
function makeVersionRow(
  formulaId = 'F-TU-01',
  versionNumber = 1,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `uuid-${formulaId}-v${versionNumber}`,
    firm_id: 'firm-001',
    formula_id: formulaId,
    version_number: versionNumber,
    is_current: true,
    name: 'Test Formula',
    description: 'A formula for testing',
    category: 'utilisation',
    formula_type: 'built_in',
    entity_type: 'FEE_EARNER',
    result_type: 'percentage',
    definition: {
      approach: 'billableHours / targetHours',
      nullHandling: 'return null',
      aggregationLevel: 'feeEarner',
    },
    active_variant: 'default',
    variants: {
      default: { name: 'Default', description: 'Standard', logic: 'std' },
    },
    modifiers: [],
    depends_on: [],
    display_config: { dashboard: 'fee-earner' },
    change_summary: null,
    changed_by: 'user-001',
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

const FIRM_ID = 'firm-001';
const USER_ID = 'user-001';

// =============================================================================
// createVersion
// =============================================================================

describe('createVersion', () => {
  it('assigns version_number 1 when no previous version exists', async () => {
    const insertedRow = makeVersionRow('F-TU-01', 1);
    const client = makeMockClient(
      // from() call 1: select max version_number → empty (no prior versions)
      { data: [], error: null },
      // from() call 2: insert new version → returns the inserted row
      { data: insertedRow, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    const version = await mgr.createVersion(FIRM_ID, USER_ID, def);

    expect(version.versionNumber).toBe(1);
    expect(version.isCurrent).toBe(true);
    expect(version.formulaId).toBe('F-TU-01');
    expect(version.firmId).toBe(FIRM_ID);
  });

  it('increments version_number when a previous version exists', async () => {
    const insertedRow = makeVersionRow('F-TU-01', 2, { version_number: 2 });
    const client = makeMockClient(
      // from() call 1: select max version_number → existing version 1
      { data: [{ version_number: 1 }], error: null },
      // from() call 2: update old version → success
      { data: null, error: null },
      // from() call 3: insert new version
      { data: insertedRow, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    const version = await mgr.createVersion(FIRM_ID, USER_ID, def);

    expect(version.versionNumber).toBe(2);
  });

  it('does NOT call the update step when no prior version exists', async () => {
    const insertedRow = makeVersionRow('F-TU-01', 1);
    const from = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [], error: null }))    // select
      .mockReturnValueOnce(makeChain({ data: insertedRow, error: null })); // insert
    const client = { from } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    await mgr.createVersion(FIRM_ID, USER_ID, def);

    // Only 2 from() calls: select + insert (no update)
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('calls the update step when a prior version exists', async () => {
    const insertedRow = makeVersionRow('F-TU-01', 2, { version_number: 2 });
    const from = vi.fn()
      .mockReturnValueOnce(makeChain({ data: [{ version_number: 1 }], error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: null })) // update
      .mockReturnValueOnce(makeChain({ data: insertedRow, error: null })); // insert
    const client = { from } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    await mgr.createVersion(FIRM_ID, USER_ID, def);

    // 3 from() calls: select + update + insert
    expect(from).toHaveBeenCalledTimes(3);
  });

  it('maps all fields correctly from the inserted row', async () => {
    const insertedRow = makeVersionRow('F-TU-01', 1, {
      change_summary: 'Initial version',
      changed_by: USER_ID,
    });
    const client = makeMockClient(
      { data: [], error: null },
      { data: insertedRow, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    const version = await mgr.createVersion(FIRM_ID, USER_ID, def, 'Initial version');

    expect(version.changeSummary).toBe('Initial version');
    expect(version.changedBy).toBe(USER_ID);
    expect(version.name).toBe('Test Formula');
    expect(version.formulaType).toBe('built_in');
    expect(version.entityType).toBe('FEE_EARNER');
  });

  it('throws when the INSERT fails', async () => {
    const client = makeMockClient(
      { data: [], error: null },
      { data: null, error: { message: 'unique constraint violation' } },
    );
    const mgr = new FormulaVersionManager(client);
    const def = makeFormulaDef('F-TU-01');
    await expect(mgr.createVersion(FIRM_ID, USER_ID, def)).rejects.toThrow(
      'Failed to create formula version',
    );
  });

  it('handles snippet definitions (uses snippetId as formulaId)', async () => {
    const snippetRow = {
      ...makeVersionRow('SN-001', 1),
      formula_id: 'SN-001',
      formula_type: 'snippet',
      category: null,
      active_variant: null,
      variants: null,
      display_config: null,
    };
    const client = makeMockClient(
      { data: [], error: null },
      { data: snippetRow, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snippetDef = {
      snippetId: 'SN-001',
      name: 'Test Snippet',
      description: 'A snippet',
      entityType: EntityType.FEE_EARNER,
      resultType: 'number' as const,
      definition: {
        approach: 'targetHours calculation',
        nullHandling: 'return null',
        aggregationLevel: 'feeEarner' as const,
      },
      dependsOn: [],
    };
    const version = await mgr.createVersion(FIRM_ID, USER_ID, snippetDef);

    expect(version.formulaId).toBe('SN-001');
    expect(version.formulaType).toBe('snippet');
  });
});

// =============================================================================
// getCurrentVersion
// =============================================================================

describe('getCurrentVersion', () => {
  it('returns the current version when one exists', async () => {
    const row = makeVersionRow('F-TU-01', 3, { version_number: 3 });
    const client = makeMockClient({ data: row, error: null });
    const mgr = new FormulaVersionManager(client);
    const version = await mgr.getCurrentVersion(FIRM_ID, 'F-TU-01');

    expect(version).not.toBeNull();
    expect(version!.versionNumber).toBe(3);
    expect(version!.isCurrent).toBe(true);
  });

  it('returns null when no version exists (Supabase PGRST116 not-found error)', async () => {
    const client = makeMockClient({
      data: null,
      error: { message: 'JSON object requested, multiple (or no) rows returned' },
    });
    const mgr = new FormulaVersionManager(client);
    const version = await mgr.getCurrentVersion(FIRM_ID, 'F-UNKNOWN');

    expect(version).toBeNull();
  });

  it('returns null on any Supabase error', async () => {
    const client = makeMockClient({ data: null, error: { message: 'connection error' } });
    const mgr = new FormulaVersionManager(client);
    const version = await mgr.getCurrentVersion(FIRM_ID, 'F-TU-01');

    expect(version).toBeNull();
  });
});

// =============================================================================
// getVersionHistory
// =============================================================================

describe('getVersionHistory', () => {
  it('returns versions in descending order (newest first)', async () => {
    const rows = [
      makeVersionRow('F-TU-01', 3, { version_number: 3, is_current: true }),
      makeVersionRow('F-TU-01', 2, { version_number: 2, is_current: false }),
      makeVersionRow('F-TU-01', 1, { version_number: 1, is_current: false }),
    ];
    const client = makeMockClient({ data: rows, error: null });
    const mgr = new FormulaVersionManager(client);
    const history = await mgr.getVersionHistory(FIRM_ID, 'F-TU-01');

    expect(history).toHaveLength(3);
    expect(history[0].versionNumber).toBe(3);
    expect(history[1].versionNumber).toBe(2);
    expect(history[2].versionNumber).toBe(1);
  });

  it('returns empty array when no versions exist', async () => {
    const client = makeMockClient({ data: [], error: null });
    const mgr = new FormulaVersionManager(client);
    const history = await mgr.getVersionHistory(FIRM_ID, 'F-TU-01');

    expect(history).toHaveLength(0);
  });

  it('returns empty array on query error', async () => {
    const client = makeMockClient({ data: null, error: { message: 'db error' } });
    const mgr = new FormulaVersionManager(client);
    const history = await mgr.getVersionHistory(FIRM_ID, 'F-TU-01');

    expect(history).toHaveLength(0);
  });
});

// =============================================================================
// getVersion
// =============================================================================

describe('getVersion', () => {
  it('returns the requested version when found', async () => {
    const row = makeVersionRow('F-TU-01', 2, { version_number: 2, is_current: false });
    const client = makeMockClient({ data: row, error: null });
    const mgr = new FormulaVersionManager(client);
    const version = await mgr.getVersion(FIRM_ID, 'F-TU-01', 2);

    expect(version).not.toBeNull();
    expect(version!.versionNumber).toBe(2);
    expect(version!.isCurrent).toBe(false);
  });

  it('returns null when the requested version does not exist', async () => {
    const client = makeMockClient({
      data: null,
      error: { message: 'no rows found' },
    });
    const mgr = new FormulaVersionManager(client);
    const version = await mgr.getVersion(FIRM_ID, 'F-TU-01', 99);

    expect(version).toBeNull();
  });
});

// =============================================================================
// diffVersions
// =============================================================================

describe('diffVersions', () => {
  it('reports no changes when both versions are identical', async () => {
    const rowV1 = makeVersionRow('F-TU-01', 1, { version_number: 1 });
    const rowV2 = makeVersionRow('F-TU-01', 2, { version_number: 2 });
    // Both rows have identical content fields → no diff
    const client = makeMockClient(
      { data: rowV1, error: null }, // getVersion(1)
      { data: rowV2, error: null }, // getVersion(2)
    );
    const mgr = new FormulaVersionManager(client);
    const diff = await mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2);

    expect(diff.changedFields).toHaveLength(0);
    expect(diff.hasBreakingChanges).toBe(false);
    expect(diff.summary).toBe('No changes detected');
  });

  it('detects a name change as non-breaking', async () => {
    const rowV1 = makeVersionRow('F-TU-01', 1, { name: 'Old Name' });
    const rowV2 = makeVersionRow('F-TU-01', 2, { version_number: 2, name: 'New Name' });
    const client = makeMockClient(
      { data: rowV1, error: null },
      { data: rowV2, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const diff = await mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2);

    expect(diff.changedFields).toContain('name');
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it('flags a definition change as breaking', async () => {
    const rowV1 = makeVersionRow('F-TU-01', 1, {
      definition: { approach: 'A', nullHandling: 'return null', aggregationLevel: 'feeEarner' },
    });
    const rowV2 = makeVersionRow('F-TU-01', 2, {
      version_number: 2,
      definition: { approach: 'B', nullHandling: 'return null', aggregationLevel: 'feeEarner' },
    });
    const client = makeMockClient(
      { data: rowV1, error: null },
      { data: rowV2, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const diff = await mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2);

    expect(diff.changedFields).toContain('definition');
    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.summary).toContain('(breaking)');
  });

  it('flags a dependsOn change as breaking', async () => {
    const rowV1 = makeVersionRow('F-TU-01', 1, { depends_on: [] });
    const rowV2 = makeVersionRow('F-TU-01', 2, {
      version_number: 2,
      depends_on: ['SN-001'],
    });
    const client = makeMockClient(
      { data: rowV1, error: null },
      { data: rowV2, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const diff = await mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2);

    expect(diff.changedFields).toContain('dependsOn');
    expect(diff.hasBreakingChanges).toBe(true);
  });

  it('throws when v1 does not exist', async () => {
    const client = makeMockClient(
      { data: null, error: { message: 'not found' } }, // getVersion(1) → null
      { data: makeVersionRow('F-TU-01', 2, { version_number: 2 }), error: null },
    );
    const mgr = new FormulaVersionManager(client);
    await expect(mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2)).rejects.toThrow(
      'version 1 not found',
    );
  });

  it('throws when v2 does not exist', async () => {
    const client = makeMockClient(
      { data: makeVersionRow('F-TU-01', 1), error: null },
      { data: null, error: { message: 'not found' } }, // getVersion(2) → null
    );
    const mgr = new FormulaVersionManager(client);
    await expect(mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 2)).rejects.toThrow(
      'version 2 not found',
    );
  });

  it('includes v1, v2, and formulaId in the result', async () => {
    const rowV1 = makeVersionRow('F-TU-01', 1);
    const rowV2 = makeVersionRow('F-TU-01', 3, { version_number: 3 });
    const client = makeMockClient(
      { data: rowV1, error: null },
      { data: rowV2, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const diff = await mgr.diffVersions(FIRM_ID, 'F-TU-01', 1, 3);

    expect(diff.formulaId).toBe('F-TU-01');
    expect(diff.v1).toBe(1);
    expect(diff.v2).toBe(3);
  });
});

// =============================================================================
// createFormulaVersionSnapshot
// =============================================================================

describe('createFormulaVersionSnapshot', () => {
  it('maps formulaIds to their current version numbers', async () => {
    const rowA = makeVersionRow('F-A', 2, { formula_id: 'F-A', version_number: 2 });
    const rowB = makeVersionRow('F-B', 5, { formula_id: 'F-B', version_number: 5 });
    // getCurrentVersion makes one from() call per formulaId
    const client = makeMockClient(
      { data: rowA, error: null },
      { data: rowB, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snapshot = await mgr.createFormulaVersionSnapshot(FIRM_ID, ['F-A', 'F-B']);

    expect(snapshot['F-A']).toBe(2);
    expect(snapshot['F-B']).toBe(5);
  });

  it('omits formulas that have no version yet', async () => {
    const client = makeMockClient(
      { data: null, error: { message: 'not found' } }, // F-A has no version
      { data: makeVersionRow('F-B', 1, { formula_id: 'F-B' }), error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snapshot = await mgr.createFormulaVersionSnapshot(FIRM_ID, ['F-A', 'F-B']);

    expect(Object.keys(snapshot)).not.toContain('F-A');
    expect(snapshot['F-B']).toBe(1);
  });

  it('returns an empty snapshot for an empty formulaIds array', async () => {
    const client = makeMockClient(); // no calls expected
    const mgr = new FormulaVersionManager(client);
    const snapshot = await mgr.createFormulaVersionSnapshot(FIRM_ID, []);

    expect(Object.keys(snapshot)).toHaveLength(0);
  });
});

// =============================================================================
// hasFormulasChanged
// =============================================================================

describe('hasFormulasChanged', () => {
  it('returns false when all formulas are at their snapshotted versions', async () => {
    const rowA = makeVersionRow('F-A', 1, { formula_id: 'F-A', version_number: 1 });
    const rowB = makeVersionRow('F-B', 2, { formula_id: 'F-B', version_number: 2 });
    const client = makeMockClient(
      { data: rowA, error: null },
      { data: rowB, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snapshot: FormulaVersionSnapshot = { 'F-A': 1, 'F-B': 2 };
    const changed = await mgr.hasFormulasChanged(FIRM_ID, snapshot);

    expect(changed).toBe(false);
  });

  it('returns true when a formula has been updated since the snapshot', async () => {
    // Snapshot says F-A was at v1, but current version is v2
    const rowA = makeVersionRow('F-A', 2, { formula_id: 'F-A', version_number: 2 });
    const rowB = makeVersionRow('F-B', 1, { formula_id: 'F-B', version_number: 1 });
    const client = makeMockClient(
      { data: rowA, error: null },
      { data: rowB, error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snapshot: FormulaVersionSnapshot = { 'F-A': 1, 'F-B': 1 };
    const changed = await mgr.hasFormulasChanged(FIRM_ID, snapshot);

    expect(changed).toBe(true);
  });

  it('returns true when a formula has no current version (was removed)', async () => {
    const client = makeMockClient(
      { data: null, error: { message: 'not found' } }, // F-A missing
      { data: makeVersionRow('F-B', 3, { formula_id: 'F-B', version_number: 3 }), error: null },
    );
    const mgr = new FormulaVersionManager(client);
    const snapshot: FormulaVersionSnapshot = { 'F-A': 1, 'F-B': 3 };
    const changed = await mgr.hasFormulasChanged(FIRM_ID, snapshot);

    expect(changed).toBe(true);
  });

  it('returns false for an empty snapshot', async () => {
    const client = makeMockClient(); // no DB calls expected
    const mgr = new FormulaVersionManager(client);
    const changed = await mgr.hasFormulasChanged(FIRM_ID, {});

    expect(changed).toBe(false);
  });
});
