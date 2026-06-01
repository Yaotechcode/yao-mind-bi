/**
 * yao-sync-api.ts — Client helpers for the Yao data pull / sync flow.
 *
 * The backend currently returns a camelCase `pull_status` row (see
 * dashboard-kpis.ts → getPullStatusRow). We expose a stable typed shape to
 * the rest of the frontend regardless of any future snake_case alias.
 */

import { supabase } from '@/integrations/supabase/client';
import { ApiError } from '@/lib/api-client';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/.netlify/functions';

export type PullStatusValue = 'idle' | 'running' | 'complete' | 'failed' | 'error';

export interface PullStats {
  matters?: number;
  timeEntries?: number;
  invoices?: number;
  feeEarners?: number;
  tasks?: number;
  disbursements?: number;
  kpiSnapshotsWritten?: number;
  [key: string]: number | undefined;
}

export interface PullStatus {
  status: PullStatusValue;
  currentStage: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastPullAt: string | null;
  stats: PullStats;
}

export interface TriggerPullResult {
  status: 'running' | 'already_running';
  message: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Normalise both camelCase and snake_case responses into PullStatus. */
function normaliseStatus(raw: Record<string, unknown>): PullStatus {
  const get = <T,>(...keys: string[]): T | undefined => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null) return raw[k] as T;
    }
    return undefined;
  };

  const rawStatus = (get<string>('status') ?? 'idle') as PullStatusValue;
  const status: PullStatusValue = rawStatus === 'failed' ? 'error' : rawStatus;

  return {
    status,
    currentStage: get<string>('currentStage', 'current_stage') ?? null,
    error: get<string>('error') ?? null,
    startedAt: get<string>('startedAt', 'started_at') ?? null,
    completedAt: get<string>('completedAt', 'completed_at') ?? null,
    lastPullAt: get<string>('pulledAt', 'pulled_at', 'lastPullAt', 'last_pull_at') ?? null,
    stats: (get<PullStats>('recordsFetched', 'records_fetched', 'stats') ?? {}) as PullStats,
  };
}

export async function fetchPullStatus(): Promise<PullStatus> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/dashboard-kpis/pull-status`, { headers });

  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }
  if (res.status === 403) {
    throw new ApiError('Not permitted', 403);
  }
  if (!res.ok) {
    throw new ApiError(`Failed to load sync status (${res.status})`, res.status);
  }

  const body = (await res.json()) as Record<string, unknown>;
  return normaliseStatus(body);
}

export async function triggerPull(): Promise<TriggerPullResult> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/yao-pull`, {
    method: 'POST',
    headers,
  });

  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }
  if (res.status === 403) {
    throw new ApiError('You do not have permission to start a sync', 403);
  }
  if (res.status === 409) {
    return { status: 'already_running', message: 'A sync is already running' };
  }
  if (res.status !== 202 && !res.ok) {
    const body = await res.json().catch(() => null);
    const message = (body as { error?: string } | null)?.error ?? `Failed to start sync (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return { status: 'running', message: 'Sync started' };
}