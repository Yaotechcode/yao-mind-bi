import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Supabase mock — hoisted before any module imports
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  getServerClient: () => ({ from: mockFromFn }),
}));

// =============================================================================
// Imports (after mock)
// =============================================================================

import {
  startPull,
  updatePullStage,
  completePull,
  failPull,
  getPullStatus,
  requireNoConcurrentPull,
  PullAlreadyRunningError,
} from '../../../src/server/services/pull-status-service.js';

// =============================================================================
// Chainable Supabase builder factory
// =============================================================================

interface BuilderOptions {
  data?: unknown;
  error?: { message: string } | null;
}

function createBuilder(opts: BuilderOptions = {}) {
  const { data = null, error = null } = opts;
  const terminal = { data, error };
  const b: Record<string, unknown> = {};

  // Chainable methods — each returns `b` so chains work
  for (const m of ['select', 'eq', 'update', 'upsert']) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  // Awaitable terminal (configurable so tests can override per-builder)
  Object.defineProperty(b, 'then', {
    configurable: true,
    get() {
      return (resolve: (v: typeof terminal) => void) => resolve(terminal);
    },
  });

  // maybeSingle resolves to terminal
  b['maybeSingle'] = vi.fn().mockResolvedValue(terminal);

  return b;
}

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID = 'firm-test-001';

/** Build a pull_status row with sensible defaults. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    firm_id:         FIRM_ID,
    status:          'idle',
    started_at:      null,
    completed_at:    null,
    pulled_at:       null,
    current_stage:   null,
    records_fetched: {},
    error:           null,
    ...overrides,
  };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// getPullStatus
// =============================================================================

describe('getPullStatus()', () => {
  it('returns null when no row exists', async () => {
    mockFromFn.mockReturnValue(createBuilder({ data: null }));
    const result = await getPullStatus(FIRM_ID);
    expect(result).toBeNull();
  });

  it('returns mapped PullStatus when row exists', async () => {
    mockFromFn.mockReturnValue(createBuilder({
      data: makeRow({
        status:        'complete',
        started_at:    '2024-03-15T09:00:00Z',
        completed_at:  '2024-03-15T09:10:00Z',
        pulled_at:     '2024-03-15T09:10:00Z',
        current_stage: null,
        records_fetched: { matters: 250 },
        error:         null,
      }),
    }));

    const result = await getPullStatus(FIRM_ID);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('complete');
    expect(result!.startedAt).toBe('2024-03-15T09:00:00Z');
    expect(result!.completedAt).toBe('2024-03-15T09:10:00Z');
    expect(result!.pulledAt).toBe('2024-03-15T09:10:00Z');
    expect(result!.recordsFetched).toEqual({ matters: 250 });
  });

  it('throws when Supabase returns an error', async () => {
    const builder = createBuilder({ error: { message: 'connection error' } });
    // maybeSingle returns error
    (builder['maybeSingle'] as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'connection error' },
    });
    mockFromFn.mockReturnValue(builder);

    await expect(getPullStatus(FIRM_ID)).rejects.toThrow('getPullStatus failed');
  });

  it('queries the pull_status table filtered by firm_id', async () => {
    const builder = createBuilder({ data: null });
    mockFromFn.mockReturnValue(builder);

    await getPullStatus(FIRM_ID);

    expect(mockFromFn).toHaveBeenCalledWith('pull_status');
    expect(builder['eq']).toHaveBeenCalledWith('firm_id', FIRM_ID);
  });
});

// =============================================================================
// requireNoConcurrentPull
// =============================================================================

describe('requireNoConcurrentPull()', () => {
  it('returns normally when no row exists (never pulled)', async () => {
    mockFromFn.mockReturnValue(createBuilder({ data: null }));
    await expect(requireNoConcurrentPull(FIRM_ID)).resolves.toBeUndefined();
  });

  it('returns normally when status is complete', async () => {
    mockFromFn.mockReturnValue(createBuilder({ data: makeRow({ status: 'complete' }) }));
    await expect(requireNoConcurrentPull(FIRM_ID)).resolves.toBeUndefined();
  });

  it('returns normally when status is failed', async () => {
    mockFromFn.mockReturnValue(createBuilder({ data: makeRow({ status: 'failed' }) }));
    await expect(requireNoConcurrentPull(FIRM_ID)).resolves.toBeUndefined();
  });

  it('throws PullAlreadyRunningError when status is running and recent', async () => {
    // started_at = now (well within 30 min window)
    const recentStart = new Date().toISOString();
    mockFromFn.mockReturnValue(createBuilder({
      data: makeRow({ status: 'running', started_at: recentStart }),
    }));

    await expect(requireNoConcurrentPull(FIRM_ID)).rejects.toThrow(PullAlreadyRunningError);
  });

  it('PullAlreadyRunningError message contains firmId', async () => {
    const recentStart = new Date().toISOString();
    mockFromFn.mockReturnValue(createBuilder({
      data: makeRow({ status: 'running', started_at: recentStart }),
    }));

    await expect(requireNoConcurrentPull(FIRM_ID)).rejects.toThrow(FIRM_ID);
  });

  it('auto-fails stuck pull (started > 30 min ago) and returns normally', async () => {
    const stuckStart = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // 31 min ago
    const getBuilder = createBuilder({ data: makeRow({ status: 'running', started_at: stuckStart }) });
    const updateBuilder = createBuilder({ data: null, error: null });

    // First call = getPullStatus (maybeSingle), second call = failPull (update+eq chain)
    mockFromFn
      .mockReturnValueOnce(getBuilder)   // getPullStatus select
      .mockReturnValueOnce(updateBuilder); // failPull update

    await expect(requireNoConcurrentPull(FIRM_ID)).resolves.toBeUndefined();
  });

  it('stuck pull auto-fail calls failPull (update on pull_status)', async () => {
    const stuckStart = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const getBuilder    = createBuilder({ data: makeRow({ status: 'running', started_at: stuckStart }) });
    const updateBuilder = createBuilder({ data: null, error: null });

    mockFromFn
      .mockReturnValueOnce(getBuilder)
      .mockReturnValueOnce(updateBuilder);

    await requireNoConcurrentPull(FIRM_ID);

    // The update call should have been made with status='failed'
    expect(updateBuilder['update']).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('exactly 30 min old pull is NOT auto-failed (threshold is > 30 min)', async () => {
    // exactly 30 minutes — should still throw (not yet stuck)
    const exactBoundary = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockFromFn.mockReturnValue(createBuilder({
      data: makeRow({ status: 'running', started_at: exactBoundary }),
    }));

    await expect(requireNoConcurrentPull(FIRM_ID)).rejects.toThrow(PullAlreadyRunningError);
  });
});

// =============================================================================
// startPull
// =============================================================================

describe('startPull()', () => {
  it('upserts a running row when no existing pull', async () => {
    // requireNoConcurrentPull: getPullStatus returns null
    const getBuilder    = createBuilder({ data: null });
    const upsertBuilder = createBuilder({ data: null, error: null });

    mockFromFn
      .mockReturnValueOnce(getBuilder)    // getPullStatus
      .mockReturnValueOnce(upsertBuilder); // upsert

    await startPull(FIRM_ID);

    expect(upsertBuilder['upsert']).toHaveBeenCalledWith(
      expect.objectContaining({ firm_id: FIRM_ID, status: 'running' }),
      expect.objectContaining({ onConflict: 'firm_id' }),
    );
  });

  it('throws PullAlreadyRunningError when status is already running and recent', async () => {
    const recentStart = new Date().toISOString();
    mockFromFn.mockReturnValue(createBuilder({
      data: makeRow({ status: 'running', started_at: recentStart }),
    }));

    await expect(startPull(FIRM_ID)).rejects.toThrow(PullAlreadyRunningError);
  });

  it('clears error, completed_at and current_stage on the new row', async () => {
    const getBuilder    = createBuilder({ data: null });
    const upsertBuilder = createBuilder({ data: null, error: null });

    mockFromFn
      .mockReturnValueOnce(getBuilder)
      .mockReturnValueOnce(upsertBuilder);

    await startPull(FIRM_ID);

    const [upsertPayload] = (upsertBuilder['upsert'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(upsertPayload.completed_at).toBeNull();
    expect(upsertPayload.error).toBeNull();
    expect(upsertPayload.current_stage).toBeNull();
  });

  it('throws when Supabase upsert fails', async () => {
    const getBuilder    = createBuilder({ data: null });
    const upsertBuilder = createBuilder({ error: { message: 'upsert failed' } });
    // upsert resolves with error through the awaitable 'then'
    Object.defineProperty(upsertBuilder, 'then', {
      get() {
        return (resolve: (v: unknown) => void) => resolve({ error: { message: 'upsert failed' } });
      },
    });

    mockFromFn
      .mockReturnValueOnce(getBuilder)
      .mockReturnValueOnce(upsertBuilder);

    await expect(startPull(FIRM_ID)).rejects.toThrow('startPull failed');
  });
});

// =============================================================================
// updatePullStage
// =============================================================================

describe('updatePullStage()', () => {
  it('updates current_stage', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await updatePullStage(FIRM_ID, 'Fetching matters');

    expect(builder['update']).toHaveBeenCalledWith(
      expect.objectContaining({ current_stage: 'Fetching matters' }),
    );
  });

  it('includes records_fetched when provided', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await updatePullStage(FIRM_ID, 'Fetching time entries', { matters: 250, timeEntries: 1800 });

    expect(builder['update']).toHaveBeenCalledWith(
      expect.objectContaining({ records_fetched: { matters: 250, timeEntries: 1800 } }),
    );
  });

  it('does not include records_fetched when undefined', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await updatePullStage(FIRM_ID, 'Calculating');

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).not.toHaveProperty('records_fetched');
  });

  it('does not throw when Supabase returns an error (non-blocking)', async () => {
    const builder = createBuilder({ error: { message: 'update failed' } });
    Object.defineProperty(builder, 'then', {
      get() {
        return (resolve: (v: unknown) => void) => resolve({ error: { message: 'update failed' } });
      },
    });
    mockFromFn.mockReturnValue(builder);

    // Should resolve without throwing
    await expect(updatePullStage(FIRM_ID, 'Some stage')).resolves.toBeUndefined();
  });
});

// =============================================================================
// completePull
// =============================================================================

describe('completePull()', () => {
  it('updates status to complete', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await completePull(FIRM_ID);

    expect(builder['update']).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete' }),
    );
  });

  it('sets pulled_at to a non-null timestamp', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await completePull(FIRM_ID);

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.pulled_at).toBeTruthy();
    expect(typeof payload.pulled_at).toBe('string');
  });

  it('sets completed_at to a non-null timestamp', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await completePull(FIRM_ID);

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.completed_at).toBeTruthy();
  });

  it('clears current_stage and error', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await completePull(FIRM_ID);

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.current_stage).toBeNull();
    expect(payload.error).toBeNull();
  });

  it('filters update by firm_id', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await completePull(FIRM_ID);

    expect(builder['eq']).toHaveBeenCalledWith('firm_id', FIRM_ID);
  });

  it('throws when Supabase update fails', async () => {
    const builder = createBuilder({ error: { message: 'disk full' } });
    Object.defineProperty(builder, 'then', {
      get() {
        return (resolve: (v: unknown) => void) => resolve({ error: { message: 'disk full' } });
      },
    });
    mockFromFn.mockReturnValue(builder);

    await expect(completePull(FIRM_ID)).rejects.toThrow('completePull failed');
  });
});

// =============================================================================
// failPull
// =============================================================================

describe('failPull()', () => {
  it('updates status to failed', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await failPull(FIRM_ID, 'network timeout');

    expect(builder['update']).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('stores the error message', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await failPull(FIRM_ID, 'API returned 503');

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.error).toBe('API returned 503');
  });

  it('sets completed_at', async () => {
    const builder = createBuilder({ data: null, error: null });
    mockFromFn.mockReturnValue(builder);

    await failPull(FIRM_ID, 'some error');

    const [payload] = (builder['update'] as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.completed_at).toBeTruthy();
  });

  it('does not throw when Supabase returns an error (best-effort)', async () => {
    const builder = createBuilder({ error: { message: 'write failed' } });
    Object.defineProperty(builder, 'then', {
      get() {
        return (resolve: (v: unknown) => void) => resolve({ error: { message: 'write failed' } });
      },
    });
    mockFromFn.mockReturnValue(builder);

    await expect(failPull(FIRM_ID, 'original error')).resolves.toBeUndefined();
  });
});
