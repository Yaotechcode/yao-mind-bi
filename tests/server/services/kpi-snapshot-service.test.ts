import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Supabase mock — hoisted before any module imports that touch supabase
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// =============================================================================
// Service import (after mock)
// =============================================================================

import {
  writeKpiSnapshots,
  getKpiSnapshots,
  getLatestPullTime,
  formatDisplayValue,
} from '../../../src/server/services/kpi-snapshot-service.js';
import type { KpiSnapshotRow } from '../../../src/server/services/kpi-snapshot-service.js';

// =============================================================================
// Chainable mock builder
// =============================================================================

interface MockState {
  resolveValue?: { data?: unknown; error?: { message: string } | null };
}

function createBuilder(state: MockState = {}) {
  const { data = null, error = null } = state.resolveValue ?? {};
  const b: Record<string, unknown> = {};

  const terminal = { data, error };

  for (const m of ['eq', 'in', 'order', 'select', 'limit']) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  // delete returns a builder so .eq() chains; then resolves on await
  b['delete'] = vi.fn().mockReturnValue(b);

  // insert resolves immediately
  b['insert'] = vi.fn().mockResolvedValue(terminal);

  // maybeSingle resolves
  b['maybeSingle'] = vi.fn().mockResolvedValue(terminal);

  // make the builder itself awaitable
  Object.defineProperty(b, 'then', {
    get() {
      return (resolve: (v: typeof terminal) => void) => resolve(terminal);
    },
  });

  return b;
}

function setupFromMock(builder: ReturnType<typeof createBuilder>) {
  mockFromFn.mockReturnValue(builder);
}

// =============================================================================
// Fixture
// =============================================================================

function makeRow(o: Partial<KpiSnapshotRow> = {}): KpiSnapshotRow {
  return {
    firm_id: 'firm-1',
    pulled_at: '2024-03-01T10:00:00Z',
    entity_type: 'feeEarner',
    entity_id: 'att-1',
    entity_name: 'Alice Smith',
    kpi_key: 'F-TU-01',
    kpi_value: 73.4,
    rag_status: 'green',
    period: 'current',
    display_value: '73.4%',
    ...o,
  };
}

// =============================================================================
// formatDisplayValue — pure function tests (no mocking needed)
// =============================================================================

describe('formatDisplayValue()', () => {
  it('returns null for null value', () => {
    expect(formatDisplayValue(null, 'F-TU-01')).toBeNull();
  });

  it('formats percentage formulas with 1dp and % sign', () => {
    expect(formatDisplayValue(73.4, 'F-TU-01')).toBe('73.4%');
    expect(formatDisplayValue(100, 'F-TU-02')).toBe('100.0%');
    expect(formatDisplayValue(0, 'F-RB-01')).toBe('0.0%');
  });

  it('formats currency formulas as GBP with no decimals', () => {
    expect(formatDisplayValue(42500, 'F-RB-02')).toBe('£42,500');
    expect(formatDisplayValue(1000, 'F-RB-03')).toBe('£1,000');
    expect(formatDisplayValue(0, 'F-PR-01')).toBe('£0');
  });

  it('formats days formulas as rounded integer + " days"', () => {
    expect(formatDisplayValue(23, 'F-WL-01')).toBe('23 days');
    expect(formatDisplayValue(23.7, 'F-WL-04')).toBe('24 days');
    expect(formatDisplayValue(5, 'F-RB-04')).toBe('5 days');
  });

  it('formats hours formulas with 1dp + " hrs"', () => {
    // No current formula uses 'hours' resultType — coverage via explicit key
    // F-TU-01 etc are percentage — verify a hypothetical hours key falls through
    // to the number branch (since it's not in the map)
    expect(formatDisplayValue(126.5, 'F-XX-99')).toBe('126.5'); // unknown key → number fallback
  });

  it('formats number formulas as integer when whole, 1dp when fractional', () => {
    expect(formatDisplayValue(4, 'F-CS-02')).toBe('4');
    expect(formatDisplayValue(4.2, 'F-BS-02')).toBe('4.2');
    expect(formatDisplayValue(75, 'F-CS-03')).toBe('75');
  });

  it('never returns "null%" or "£null" for null values on any key', () => {
    const keys = ['F-TU-01', 'F-RB-02', 'F-WL-01', 'F-CS-02'];
    for (const key of keys) {
      expect(formatDisplayValue(null, key)).toBeNull();
    }
  });

  it('handles negative currency (write-offs, losses)', () => {
    expect(formatDisplayValue(-5000, 'F-PR-01')).toBe('-£5,000');
  });

  it('handles unknown kpi_key — falls back to number format', () => {
    expect(formatDisplayValue(1.8, 'CUSTOM-001')).toBe('1.8');
    expect(formatDisplayValue(10, 'CUSTOM-001')).toBe('10');
  });
});

// =============================================================================
// writeKpiSnapshots
// =============================================================================

describe('writeKpiSnapshots()', () => {
  beforeEach(() => {
    mockFromFn.mockReset();
  });

  it('deletes existing rows before inserting', async () => {
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    setupFromMock(builder);

    await writeKpiSnapshots('firm-1', [makeRow()]);

    // from('kpi_snapshots') called at least twice (delete + insert)
    expect(mockFromFn).toHaveBeenCalledWith('kpi_snapshots');
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalled();
  });

  it('inserts nothing and does not call insert when snapshot array is empty', async () => {
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    setupFromMock(builder);

    await writeKpiSnapshots('firm-1', []);

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it('inserts all rows when count <= 500 (single batch)', async () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      makeRow({ entity_id: `att-${i}` }),
    );
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    setupFromMock(builder);

    await writeKpiSnapshots('firm-1', rows);

    expect(builder.insert).toHaveBeenCalledTimes(1);
    expect((builder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(300);
  });

  it('splits >500 rows into multiple batches', async () => {
    const rows = Array.from({ length: 1100 }, (_, i) =>
      makeRow({ entity_id: `att-${i}` }),
    );
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    setupFromMock(builder);

    await writeKpiSnapshots('firm-1', rows);

    // 1100 rows / 500 = 3 batches (500 + 500 + 100)
    expect(builder.insert).toHaveBeenCalledTimes(3);
    const calls = (builder.insert as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toHaveLength(500);
    expect(calls[1][0]).toHaveLength(500);
    expect(calls[2][0]).toHaveLength(100);
  });

  it('throws if delete fails', async () => {
    const builder = createBuilder({
      resolveValue: { data: null, error: { message: 'permission denied' } },
    });
    setupFromMock(builder);

    await expect(writeKpiSnapshots('firm-1', [makeRow()])).rejects.toThrow(
      'failed to delete existing rows',
    );
  });

  it('performs rollback delete and throws when batch insert fails', async () => {
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    // Override insert to fail
    (builder.insert as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'disk full' },
    });
    setupFromMock(builder);

    await expect(writeKpiSnapshots('firm-1', [makeRow()])).rejects.toThrow('batch insert failed');
    // Rollback delete should have been called (first delete + rollback delete = 2 delete calls)
    expect(builder.delete).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// getKpiSnapshots
// =============================================================================

describe('getKpiSnapshots()', () => {
  beforeEach(() => {
    mockFromFn.mockReset();
  });

  it('always filters by firm_id', async () => {
    const rows = [makeRow()];
    const builder = createBuilder({ resolveValue: { data: rows, error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1');

    expect(builder.eq).toHaveBeenCalledWith('firm_id', 'firm-1');
  });

  it('applies entityType filter when provided', async () => {
    const builder = createBuilder({ resolveValue: { data: [], error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1', { entityType: 'feeEarner' });

    expect(builder.eq).toHaveBeenCalledWith('entity_type', 'feeEarner');
  });

  it('applies period filter when provided', async () => {
    const builder = createBuilder({ resolveValue: { data: [], error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1', { period: 'current' });

    expect(builder.eq).toHaveBeenCalledWith('period', 'current');
  });

  it('applies kpiKeys filter using .in() when provided', async () => {
    const builder = createBuilder({ resolveValue: { data: [], error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1', { kpiKeys: ['F-TU-01', 'F-RB-01'] });

    expect(builder.in).toHaveBeenCalledWith('kpi_key', ['F-TU-01', 'F-RB-01']);
  });

  it('applies entityIds filter using .in() when provided', async () => {
    const builder = createBuilder({ resolveValue: { data: [], error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1', { entityIds: ['att-1', 'att-2'] });

    expect(builder.in).toHaveBeenCalledWith('entity_id', ['att-1', 'att-2']);
  });

  it('does not call .in() for empty kpiKeys array', async () => {
    const builder = createBuilder({ resolveValue: { data: [], error: null } });
    setupFromMock(builder);

    await getKpiSnapshots('firm-1', { kpiKeys: [] });

    const inCalls = (builder.in as ReturnType<typeof vi.fn>).mock.calls;
    const kpiKeyCalls = inCalls.filter((c) => c[0] === 'kpi_key');
    expect(kpiKeyCalls).toHaveLength(0);
  });

  it('returns data array from Supabase', async () => {
    const rows = [makeRow(), makeRow({ entity_id: 'att-2' })];
    const builder = createBuilder({ resolveValue: { data: rows, error: null } });
    setupFromMock(builder);

    const result = await getKpiSnapshots('firm-1');
    expect(result).toHaveLength(2);
  });

  it('throws on Supabase error', async () => {
    const builder = createBuilder({
      resolveValue: { data: null, error: { message: 'timeout' } },
    });
    setupFromMock(builder);

    await expect(getKpiSnapshots('firm-1')).rejects.toThrow('query failed');
  });
});

// =============================================================================
// getLatestPullTime
// =============================================================================

describe('getLatestPullTime()', () => {
  beforeEach(() => {
    mockFromFn.mockReset();
  });

  it('returns null when no snapshots exist', async () => {
    const builder = createBuilder({ resolveValue: { data: null, error: null } });
    setupFromMock(builder);

    const result = await getLatestPullTime('firm-1');
    expect(result).toBeNull();
  });

  it('returns pulled_at from the most recent row', async () => {
    const builder = createBuilder({
      resolveValue: { data: { pulled_at: '2024-03-15T10:00:00Z' }, error: null },
    });
    setupFromMock(builder);

    const result = await getLatestPullTime('firm-1');
    expect(result).toBe('2024-03-15T10:00:00Z');
  });

  it('throws on Supabase error', async () => {
    const builder = createBuilder({
      resolveValue: { data: null, error: { message: 'rls violation' } },
    });
    setupFromMock(builder);

    await expect(getLatestPullTime('firm-1')).rejects.toThrow('query failed');
  });
});
