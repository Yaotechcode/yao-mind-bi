/**
 * PullOrchestrator.test.ts
 *
 * Unit tests for PullOrchestrator.run().
 * All I/O (pull-status, DataSourceAdapter, CalculationOrchestrator, MongoDB,
 * Supabase) is mocked — no network or database access needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Module mocks — hoisted before any imports
// =============================================================================

vi.mock('../../../src/server/services/pull-status-service.js', () => ({
  requireNoConcurrentPull: vi.fn(),
  startPull:               vi.fn(),
  updatePullStage:         vi.fn(),
  completePull:            vi.fn(),
  failPull:                vi.fn(),
  PullAlreadyRunningError: class PullAlreadyRunningError extends Error {
    constructor(firmId: string) {
      super(`A pull is already running for firm ${firmId}`);
      this.name = 'PullAlreadyRunningError';
    }
  },
}));

vi.mock('../../../src/server/datasource/enrich/wip-aggregator.js', () => ({
  buildWipEnrichment: vi.fn().mockReturnValue({ byMatter: {}, byFeeEarner: {}, orphaned: [] }),
}));

vi.mock('../../../src/server/datasource/enrich/invoice-enricher.js', () => ({
  enrichInvoicesWithDatePaid: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/server/datasource/enrich/fee-earner-merger.js', () => ({
  mergeAllFeeEarners: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/server/datasource/enrich/client-profile-builder.js', () => ({
  buildClientProfiles: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/server/datasource/enrich/kpi-snapshot-builder.js', () => ({
  buildSnapshotsFromKpiResults: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/server/datasource/enrich/risk-scanner.js', () => ({
  scanForRiskFlags: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/server/datasource/normalise/transformations.js', () => ({
  transformAttorney:     vi.fn().mockImplementation((x: unknown) => x),
  transformMatter:       vi.fn().mockImplementation((x: unknown) => x),
  transformTimeEntry:    vi.fn().mockImplementation((x: unknown) => x),
  transformInvoice:      vi.fn().mockImplementation((x: unknown) => x),
  transformDisbursement: vi.fn().mockImplementation((x: unknown) => x),
  transformTask:         vi.fn().mockImplementation((x: unknown) => x),
  transformContact:      vi.fn().mockImplementation((x: unknown) => x),
}));

vi.mock('../../../src/server/datasource/normalise/resolver.js', () => ({
  resolveAll: vi.fn().mockImplementation((data: unknown) => data),
}));

vi.mock('../../../src/server/datasource/normalise/stripper.js', () => ({
  stripSensitiveFromArray: vi.fn().mockImplementation((arr: unknown) => arr),
}));

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  storeEnrichedEntities: vi.fn().mockResolvedValue(undefined),
  storeRiskFlags:        vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/server/services/kpi-snapshot-service.js', () => ({
  writeKpiSnapshots: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/server/services/config-service.js', () => ({
  getFirmConfig: vi.fn().mockResolvedValue({ ragThresholds: [] }),
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { PullOrchestrator } from '../../../src/server/datasource/PullOrchestrator.js';
import * as pullStatus from '../../../src/server/services/pull-status-service.js';
import { YaoAuthError, YaoApiError, YaoRateLimitError } from '../../../src/server/datasource/errors.js';

// =============================================================================
// Fixture helpers
// =============================================================================

const FIRM_ID = 'firm-test-001';

/** Build a minimal mock DataSourceAdapter. */
function makeAdapter(overrides: Partial<ReturnType<typeof makeAdapter>> = {}) {
  const base = {
    authenticate:       vi.fn().mockResolvedValue(undefined),
    fetchLookupTables:  vi.fn().mockResolvedValue({
      attorneys:    [{ _id: 'att-1' }],
      departments:  [{ _id: 'dept-1' }],
      caseTypes:    [{ _id: 'ct-1' }],
      attorneyMap:  {},
      departmentMap: {},
      caseTypeMap:   {},
    }),
    fetchMatters:        vi.fn().mockResolvedValue([{ _id: 'm-1' }, { _id: 'm-2' }]),
    fetchTimeEntries:    vi.fn().mockResolvedValue([{ _id: 'te-1' }]),
    fetchInvoices:       vi.fn().mockResolvedValue([{ _id: 'inv-1' }]),
    fetchLedgers:        vi.fn().mockResolvedValue([]),
    fetchTasks:          vi.fn().mockResolvedValue([{ _id: 'task-1' }]),
    fetchContacts:       vi.fn().mockResolvedValue([{ _id: 'con-1' }]),
    fetchInvoiceSummary: vi.fn().mockResolvedValue({ unpaid: 0, paid: 0, total: 0 }),
    routeLedgers:        vi.fn().mockReturnValue({ disbursements: [], invoicePayments: [], disbursementRecoveries: [] }),
    getWarnings:         vi.fn().mockReturnValue([]),
  };
  return { ...base, ...overrides };
}

/** Build a minimal mock CalculationOrchestrator. */
function makeCalcOrchestrator() {
  return {
    calculateAll: vi.fn().mockResolvedValue({
      firmId: FIRM_ID,
      calculatedAt: new Date().toISOString(),
      results: {},
      ragAssignments: {},
      formulaCount: 5,
      successCount: 5,
      errorCount: 0,
      errors: [],
    }),
  };
}

/** Create a PullOrchestrator wired with injectable mocks. */
function makeOrchestrator(adapterOverrides = {}) {
  const adapter = makeAdapter(adapterOverrides);
  const calcOrchestrator = makeCalcOrchestrator();
  const orchestrator = new PullOrchestrator(FIRM_ID, {
    createAdapter:          () => adapter,
    createCalcOrchestrator: () => calcOrchestrator,
  });
  return { orchestrator, adapter, calcOrchestrator };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all pull-status functions resolve successfully
  vi.mocked(pullStatus.requireNoConcurrentPull).mockResolvedValue(undefined);
  vi.mocked(pullStatus.startPull).mockResolvedValue(undefined);
  vi.mocked(pullStatus.updatePullStage).mockResolvedValue(undefined);
  vi.mocked(pullStatus.completePull).mockResolvedValue(undefined);
  vi.mocked(pullStatus.failPull).mockResolvedValue(undefined);
});

// =============================================================================
// Happy path
// =============================================================================

describe('happy path', () => {
  it('returns success=true on full happy path', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();
    expect(result.success).toBe(true);
  });

  it('returns stats matching fetched record counts', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();
    expect(result.stats.attorneys).toBe(1);
    expect(result.stats.matters).toBe(2);
    expect(result.stats.timeEntries).toBe(1);
    expect(result.stats.invoices).toBe(1);
    expect(result.stats.tasks).toBe(1);
    // contacts always 0 while contacts fetch is disabled
    expect(result.stats.contacts).toBe(0);
  });

  it('errors array is empty on success', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();
    expect(result.errors).toHaveLength(0);
  });

  it('completePull is called on success', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    expect(pullStatus.completePull).toHaveBeenCalledWith(FIRM_ID);
  });

  it('failPull is NOT called on success', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    expect(pullStatus.failPull).not.toHaveBeenCalled();
  });

  it('pulledAt is a valid ISO timestamp', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();
    expect(new Date(result.pulledAt).getTime()).toBeGreaterThan(0);
  });
});

// =============================================================================
// Pull status stage tracking
// =============================================================================

describe('pull status stage tracking', () => {
  it('calls requireNoConcurrentPull before startPull', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();

    const calls = vi.mocked(pullStatus.requireNoConcurrentPull).mock.invocationCallOrder;
    const startCalls = vi.mocked(pullStatus.startPull).mock.invocationCallOrder;
    expect(calls[0]).toBeLessThan(startCalls[0]);
  });

  it('calls startPull with firmId', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    expect(pullStatus.startPull).toHaveBeenCalledWith(FIRM_ID);
  });

  it('updates stage to Authenticating', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Authenticating');
  });

  it('updates stage to Fetching lookup tables', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Fetching lookup tables');
  });

  it('updates stage to Fetching matters', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Fetching matters');
  });

  it('updates stage to Processing matters', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Processing matters');
  });

  it('updates stage to Fetching time entries', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Fetching time entries');
  });

  it('updates stage to Fetching invoices', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Fetching invoices');
  });

  it('updates stage to Fetching tasks', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Fetching tasks');
  });

  it('does NOT update stage to Fetching contacts (disabled — inline data used instead)', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).not.toContain('Fetching contacts');
  });

  it('does NOT emit parallel fetch stage or old Normalising/Enriching/Storing stages', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).not.toContain('Fetching time entries, invoices, tasks, contacts');
    expect(stages).not.toContain('Normalising');
    expect(stages).not.toContain('Enriching');
    expect(stages).not.toContain('Storing enriched data');
  });

  it('does NOT update stage to Fetching ledgers (disabled pending API type filter)', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).not.toContain('Fetching ledgers');
  });

  it('updates stage to Calculating KPIs', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Calculating KPIs');
  });

  it('updates stage to Writing snapshots', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Writing snapshots');
  });

  it('updates stage to Scanning for risks', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const stages = vi.mocked(pullStatus.updatePullStage).mock.calls.map((c) => c[1]);
    expect(stages).toContain('Scanning for risks');
  });

  it('records_fetched included in stage update after fetching matters', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    const matterUpdate = vi.mocked(pullStatus.updatePullStage).mock.calls.find(
      (c) => c[1] === 'Fetching matters' && c[2] !== undefined,
    );
    expect(matterUpdate).toBeDefined();
    expect(matterUpdate![2]).toMatchObject({ matters: 2 });
  });
});

// =============================================================================
// Concurrent pull rejection
// =============================================================================

describe('concurrent pull rejection', () => {
  it('returns success=false when a concurrent pull is running', async () => {
    const { PullAlreadyRunningError } = vi.mocked(pullStatus) as unknown as {
      PullAlreadyRunningError: new (id: string) => Error;
    };
    vi.mocked(pullStatus.requireNoConcurrentPull).mockRejectedValue(
      new PullAlreadyRunningError(FIRM_ID),
    );

    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('does NOT call startPull when concurrent guard rejects', async () => {
    vi.mocked(pullStatus.requireNoConcurrentPull).mockRejectedValue(new Error('already running'));
    const { orchestrator } = makeOrchestrator();
    await orchestrator.run();
    expect(pullStatus.startPull).not.toHaveBeenCalled();
  });
});

// =============================================================================
// YaoAuthError
// =============================================================================

describe('YaoAuthError handling', () => {
  it('returns success=false with informative credentials error message', async () => {
    const { orchestrator } = makeOrchestrator({
      authenticate: vi.fn().mockRejectedValue(new YaoAuthError('Invalid credentials')),
    });
    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('credentials');
    expect(result.errors[0]).toContain('Settings');
  });

  it('calls failPull with the error message', async () => {
    const { orchestrator } = makeOrchestrator({
      authenticate: vi.fn().mockRejectedValue(new YaoAuthError('Bad login')),
    });
    await orchestrator.run();
    expect(pullStatus.failPull).toHaveBeenCalledWith(
      FIRM_ID,
      expect.stringContaining('credentials'),
    );
  });

  it('does NOT call completePull on auth failure', async () => {
    const { orchestrator } = makeOrchestrator({
      authenticate: vi.fn().mockRejectedValue(new YaoAuthError('Bad login')),
    });
    await orchestrator.run();
    expect(pullStatus.completePull).not.toHaveBeenCalled();
  });
});

// =============================================================================
// YaoApiError handling
// =============================================================================

describe('YaoApiError handling', () => {
  it('returns success=false with status code in error message', async () => {
    const { orchestrator } = makeOrchestrator({
      fetchMatters: vi.fn().mockRejectedValue(new YaoApiError('Server error', 503)),
    });
    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('503');
  });

  it('calls failPull with the error', async () => {
    const { orchestrator } = makeOrchestrator({
      fetchMatters: vi.fn().mockRejectedValue(new YaoApiError('Not found', 404)),
    });
    await orchestrator.run();
    expect(pullStatus.failPull).toHaveBeenCalledWith(FIRM_ID, expect.stringContaining('404'));
  });
});

// =============================================================================
// YaoRateLimitError handling
// =============================================================================

describe('YaoRateLimitError handling', () => {
  it('returns success=false with rate limit message', async () => {
    const { orchestrator } = makeOrchestrator({
      fetchTimeEntries: vi.fn().mockRejectedValue(new YaoRateLimitError('/time-entries/search')),
    });
    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(result.errors[0].toLowerCase()).toContain('rate limit');
  });
});

// =============================================================================
// Non-fatal warnings
// =============================================================================

describe('non-fatal warnings', () => {
  it('adds warning when fee earner CSV merge fails, pull still succeeds', async () => {
    const { mergeAllFeeEarners } = await import('../../../src/server/datasource/enrich/fee-earner-merger.js');
    vi.mocked(mergeAllFeeEarners).mockRejectedValue(new Error('no CSV found'));

    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes('fee earner'))).toBe(true);
  });

  it('adds warning when writeKpiSnapshots fails, pull still succeeds', async () => {
    const { writeKpiSnapshots } = await import('../../../src/server/services/kpi-snapshot-service.js');
    vi.mocked(writeKpiSnapshots).mockRejectedValue(new Error('Supabase unavailable'));

    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('kpi_snapshots'))).toBe(true);
  });

  it('adds warning when storeRiskFlags fails, pull still succeeds', async () => {
    const { storeRiskFlags } = await import('../../../src/server/lib/mongodb-operations.js');
    vi.mocked(storeRiskFlags).mockRejectedValue(new Error('MongoDB timeout'));

    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('risk_flags'))).toBe(true);
  });
});

// =============================================================================
// Fatal errors mid-sequence
// =============================================================================

describe('fatal error mid-sequence', () => {
  it('returns success=false and calls failPull when calculateAll throws', async () => {
    const calcOrchestrator = { calculateAll: vi.fn().mockRejectedValue(new Error('DB write failed')) };
    const adapter = makeAdapter();
    const orchestrator = new PullOrchestrator(FIRM_ID, {
      createAdapter:          () => adapter,
      createCalcOrchestrator: () => calcOrchestrator,
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(pullStatus.failPull).toHaveBeenCalled();
  });

  it('returns success=false when storeEnrichedEntities throws', async () => {
    const { storeEnrichedEntities } = await import('../../../src/server/lib/mongodb-operations.js');
    vi.mocked(storeEnrichedEntities).mockRejectedValue(new Error('MongoDB connection lost'));

    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(pullStatus.failPull).toHaveBeenCalled();
  });
});
