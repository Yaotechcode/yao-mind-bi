/**
 * pull-status-service.ts
 *
 * Tracks the lifecycle of a data pull in the Supabase `pull_status` table.
 * One row per firm; upserted on each pull, never deleted.
 *
 * Table columns (firm_id is the primary key / unique key):
 *   firm_id         uuid
 *   status          text    — 'idle' | 'running' | 'complete' | 'failed'
 *   started_at      timestamptz
 *   completed_at    timestamptz
 *   pulled_at       timestamptz   — last successful pull completion
 *   current_stage   text
 *   records_fetched jsonb
 *   error           text
 *
 * Usage pattern in a Background Function:
 *   await startPull(firmId);
 *   await updatePullStage(firmId, 'Fetching matters', { matters: 250 });
 *   ...
 *   await completePull(firmId);
 *   // or on error:
 *   await failPull(firmId, err.message);
 */

import { getServerClient } from '../lib/supabase.js';

// =============================================================================
// Types
// =============================================================================

export type PullStatusValue = 'idle' | 'running' | 'complete' | 'failed';

export interface PullStatus {
  firmId: string;
  status: PullStatusValue;
  startedAt: string | null;
  completedAt: string | null;
  pulledAt: string | null;
  currentStage: string | null;
  recordsFetched: Record<string, number>;
  error: string | null;
}

// =============================================================================
// Errors
// =============================================================================

export class PullAlreadyRunningError extends Error {
  constructor(firmId: string) {
    super(`A pull is already running for firm ${firmId} — try again shortly`);
    this.name = 'PullAlreadyRunningError';
  }
}

// =============================================================================
// Constants
// =============================================================================

/** A pull stuck for longer than this is considered hung and will be auto-failed. */
const STUCK_PULL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

const TABLE = 'pull_status';

// =============================================================================
// Helpers
// =============================================================================

function now(): string {
  return new Date().toISOString();
}

function db() {
  return getServerClient();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Mark a pull as started. Throws PullAlreadyRunningError if a pull is
 * currently running and was started within the last 30 minutes.
 *
 * Call requireNoConcurrentPull first if you want the stuck-pull auto-fail
 * logic to run before attempting to start.
 */
export async function startPull(firmId: string): Promise<void> {
  await requireNoConcurrentPull(firmId);

  const { error } = await db()
    .from(TABLE)
    .upsert({
      firm_id:         firmId,
      status:          'running',
      started_at:      now(),
      completed_at:    null,
      pulled_at:       null,
      current_stage:   null,
      records_fetched: {},
      error:           null,
    }, { onConflict: 'firm_id' });

  if (error) {
    throw new Error(`startPull failed for firm ${firmId}: ${error.message}`);
  }
}

/**
 * Update the current stage label and optionally accumulate records_fetched
 * counts. Non-blocking — errors are logged but not thrown.
 */
export async function updatePullStage(
  firmId: string,
  stage: string,
  recordsFetched?: Record<string, number>,
): Promise<void> {
  const update: Record<string, unknown> = { current_stage: stage };
  if (recordsFetched !== undefined) {
    update['records_fetched'] = recordsFetched;
  }

  const { error } = await db()
    .from(TABLE)
    .update(update)
    .eq('firm_id', firmId);

  if (error) {
    // Non-blocking — log but don't throw
    console.warn(`[pull-status] updatePullStage warning for firm ${firmId}:`, error.message);
  }
}

/**
 * Mark the pull as successfully completed.
 * Sets status='complete', completed_at=now(), pulled_at=now().
 */
export async function completePull(firmId: string): Promise<void> {
  const ts = now();

  const { error } = await db()
    .from(TABLE)
    .update({
      status:        'complete',
      completed_at:  ts,
      pulled_at:     ts,
      current_stage: null,
      error:         null,
    })
    .eq('firm_id', firmId);

  if (error) {
    throw new Error(`completePull failed for firm ${firmId}: ${error.message}`);
  }
}

/**
 * Mark the pull as failed.
 * Sets status='failed', error=message, completed_at=now().
 */
export async function failPull(firmId: string, errorMessage: string): Promise<void> {
  const { error } = await db()
    .from(TABLE)
    .update({
      status:        'failed',
      error:         errorMessage,
      completed_at:  now(),
      current_stage: null,
    })
    .eq('firm_id', firmId);

  if (error) {
    // Best-effort — log but don't mask the original error
    console.error(`[pull-status] failPull could not update status for firm ${firmId}:`, error.message);
  }
}

/**
 * Returns the current pull_status row for the firm, or null if no pull has
 * ever been initiated.
 */
export async function getPullStatus(firmId: string): Promise<PullStatus | null> {
  const { data, error } = await db()
    .from(TABLE)
    .select('firm_id, status, started_at, completed_at, pulled_at, current_stage, records_fetched, error')
    .eq('firm_id', firmId)
    .maybeSingle();

  if (error) {
    throw new Error(`getPullStatus failed for firm ${firmId}: ${error.message}`);
  }

  if (!data) return null;

  const d = data as Record<string, unknown>;

  return {
    firmId:         d['firm_id'] as string,
    status:         (d['status'] as PullStatusValue) ?? 'idle',
    startedAt:      (d['started_at'] as string | null) ?? null,
    completedAt:    (d['completed_at'] as string | null) ?? null,
    pulledAt:       (d['pulled_at'] as string | null) ?? null,
    currentStage:   (d['current_stage'] as string | null) ?? null,
    recordsFetched: (d['records_fetched'] as Record<string, number> | null) ?? {},
    error:          (d['error'] as string | null) ?? null,
  };
}

/**
 * Checks whether a pull is currently in progress.
 *
 * - If status='running' and started_at > 30 minutes ago: auto-fails the stuck
 *   pull and returns (allowing a new pull to proceed).
 * - If status='running' and recent: throws PullAlreadyRunningError.
 * - Otherwise: returns normally.
 */
export async function requireNoConcurrentPull(firmId: string): Promise<void> {
  const current = await getPullStatus(firmId);

  if (!current || current.status !== 'running') return;

  // Check if it's stuck (started more than 30 minutes ago)
  const startedAt = current.startedAt ? new Date(current.startedAt).getTime() : 0;
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > STUCK_PULL_THRESHOLD_MS) {
    // Auto-fail the stuck pull so the next one can proceed
    await failPull(firmId, `Pull auto-failed after ${Math.round(elapsedMs / 60000)} minutes (stuck)`);
    return;
  }

  throw new PullAlreadyRunningError(firmId);
}
