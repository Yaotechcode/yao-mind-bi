/**
 * dashboard-kpis.ts — Netlify Function
 *
 * Serves pre-computed KPI data from the Supabase kpi_snapshots table.
 * Dashboards MUST read exclusively from this endpoint — never from MongoDB,
 * never triggering formula calculations.
 *
 *   GET /api/dashboard-kpis            → snapshot rows for a given entity type
 *   GET /api/dashboard-kpis/pull-status → current pull_status row for this firm
 *
 * Query parameters (GET /api/dashboard-kpis):
 *   entityType (required) : feeEarner | matter | invoice | disbursement |
 *                           department | client | firm
 *   period     (optional, default 'current')
 *   entityId   (optional) : filter to a single entity
 *   kpiKeys    (optional) : comma-separated formula IDs
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import { getKpiSnapshots, getLatestPullTime } from '../services/kpi-snapshot-service.js';
import { db } from '../lib/supabase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = new Set([
  'feeEarner',
  'matter',
  'invoice',
  'disbursement',
  'department',
  'client',
  'firm',
]);

type PullStatus = 'idle' | 'running' | 'complete' | 'failed';

interface PullStatusRow {
  status: PullStatus;
  startedAt: string | null;
  completedAt: string | null;
  pulledAt: string | null;
  currentStage: string | null;
  recordsFetched: Record<string, unknown>;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const BASE = '/api/dashboard-kpis';

function segment(path: string): string {
  const clean = path.replace(/\/$/, '');
  const netlifyMatch = clean.match(/\/\.netlify\/functions\/dashboard-kpis\/?(.*)$/);
  if (netlifyMatch) return netlifyMatch[1] ?? '';
  if (clean.startsWith(BASE)) return clean.slice(BASE.length + 1);
  return '';
}

// ---------------------------------------------------------------------------
// pull_status helper
// ---------------------------------------------------------------------------

async function getPullStatusRow(firmId: string): Promise<PullStatusRow> {
  const { data, error } = await db.server
    .from('pull_status')
    .select('status, started_at, completed_at, pulled_at, current_stage, records_fetched, error')
    .eq('firm_id', firmId)
    .maybeSingle();

  if (error) {
    throw new Error(`pull_status query failed: ${error.message}`);
  }

  if (!data) {
    return {
      status: 'idle',
      startedAt: null,
      completedAt: null,
      pulledAt: null,
      currentStage: null,
      recordsFetched: {},
      error: null,
    };
  }

  return {
    status: (data['status'] as PullStatus) ?? 'idle',
    startedAt: (data['started_at'] as string | null) ?? null,
    completedAt: (data['completed_at'] as string | null) ?? null,
    pulledAt: (data['pulled_at'] as string | null) ?? null,
    currentStage: (data['current_stage'] as string | null) ?? null,
    recordsFetched: (data['records_fetched'] as Record<string, unknown> | null) ?? {},
    error: (data['error'] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const seg = segment(event.path ?? '');
    const qs = event.queryStringParameters ?? {};

    // -----------------------------------------------------------------------
    // GET /api/dashboard-kpis/pull-status
    // -----------------------------------------------------------------------
    if (seg === 'pull-status') {
      const statusRow = await getPullStatusRow(firmId);
      return successResponse(statusRow);
    }

    // -----------------------------------------------------------------------
    // GET /api/dashboard-kpis
    // -----------------------------------------------------------------------
    if (seg !== '') {
      return errorResponse('Not found', 404);
    }

    const entityType = qs['entityType'];
    if (!entityType) {
      return errorResponse('entityType query parameter is required', 400);
    }
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return errorResponse(
        `Invalid entityType '${entityType}'. Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`,
        400,
      );
    }

    const period = qs['period'] ?? 'current';
    const entityId = qs['entityId'];
    const kpiKeysRaw = qs['kpiKeys'];
    const kpiKeys = kpiKeysRaw
      ? kpiKeysRaw.split(',').map((k) => k.trim()).filter(Boolean)
      : undefined;

    const [snapshots, lastPulledAt] = await Promise.all([
      getKpiSnapshots(firmId, {
        entityType,
        period,
        ...(entityId ? { entityIds: [entityId] } : {}),
        ...(kpiKeys?.length ? { kpiKeys } : {}),
      }),
      getLatestPullTime(firmId),
    ]);

    // Derive a coarse pull status from snapshot availability
    const pullStatus: PullStatus = snapshots.length > 0 ? 'complete' : 'idle';

    return successResponse({
      firmId,
      pulledAt: lastPulledAt,
      entityType,
      period,
      snapshots,
      meta: {
        totalRows: snapshots.length,
        lastPulledAt,
        pullStatus,
      },
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[dashboard-kpis]', err);
    return errorResponse('Internal server error', 500);
  }
};
