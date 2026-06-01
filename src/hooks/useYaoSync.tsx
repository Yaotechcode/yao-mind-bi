/**
 * useYaoSync — Provider + hook coordinating the Yao data pull lifecycle.
 *
 * Responsibilities:
 *  - Poll GET /api/dashboard-kpis/pull-status (4s interval while running)
 *  - Track elapsed time during a running pull (updated every second)
 *  - Expose triggerSync() which calls POST /api/yao-pull
 *  - Surface drawer open state for the progress panel
 *  - Show toast notifications on success / failure
 *  - Invalidate dashboard queries when a pull completes
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  fetchPullStatus,
  triggerPull,
  type PullStatus,
  type PullStatusValue,
} from '@/lib/yao-sync-api';

const POLL_INTERVAL_MS = 4000;
const SYNC_ROLES = new Set(['owner', 'admin']);

interface SyncContextValue {
  /** Whether the current user may see/use sync UI. */
  canSync: boolean;
  /** Latest known pull status, or null while we have not yet polled. */
  status: PullStatus | null;
  /** True while we are POSTing to /api/yao-pull. */
  isTriggering: boolean;
  /** Seconds since the running pull started (0 when not running). */
  elapsedSeconds: number;
  /** Drawer open state for the progress panel. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** Trigger a sync. Safe to call even when one is already running (will simply open the drawer). */
  triggerSync: () => Promise<void>;
  /** Force-refresh the status (used on mount / when drawer opens). */
  refresh: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | undefined>(undefined);

export function YaoSyncProvider({ children }: { children: ReactNode }) {
  const { profile, user, loading, roleLoading } = useAuth();
  const queryClient = useQueryClient();

  const canSync = !!profile && SYNC_ROLES.has(profile.role);

  const [status, setStatus] = useState<PullStatus | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Track the previous status across renders so we can detect transitions
  // (running → complete, running → error) and react with toasts / refresh.
  const prevStatusRef = useRef<PullStatusValue | null>(null);
  // Tracks whether the user was present (drawer ever opened) for this pull,
  // so we can show a different message if the pull completed in the background.
  const sawRunningRef = useRef(false);

  // ── Polling ────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!canSync) return;
    try {
      const next = await fetchPullStatus();
      setStatus(next);
    } catch {
      // Silent — the indicator simply stays on its previous state.
    }
  }, [canSync]);

  // Initial fetch when user becomes available.
  useEffect(() => {
    if (loading || roleLoading) return;
    if (!user || !canSync) {
      setStatus(null);
      return;
    }
    void refresh();
  }, [user, canSync, loading, roleLoading, refresh]);

  // Active polling whenever a pull is running.
  useEffect(() => {
    if (!canSync) return;
    if (status?.status !== 'running') return;

    const id = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [canSync, status?.status, refresh]);

  // Elapsed-time ticker (1s) only while running.
  useEffect(() => {
    if (status?.status !== 'running' || !status.startedAt) {
      setElapsedSeconds(0);
      return;
    }
    const startedAtMs = new Date(status.startedAt).getTime();
    const tick = () => {
      const diff = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      setElapsedSeconds(diff);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [status?.status, status?.startedAt]);

  // Transition detection — toasts, drawer close, dashboard refresh.
  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = status?.status ?? null;

    if (curr === 'running' && prev !== 'running') {
      sawRunningRef.current = true;
    }

    if (prev === 'running' && curr === 'complete') {
      const s = status?.stats ?? {};
      const parts: string[] = [];
      if (typeof s.matters === 'number') parts.push(`${s.matters.toLocaleString('en-GB')} matters`);
      if (typeof s.timeEntries === 'number') parts.push(`${s.timeEntries.toLocaleString('en-GB')} time entries`);
      if (typeof s.invoices === 'number') parts.push(`${s.invoices.toLocaleString('en-GB')} invoices`);
      const detail = parts.length
        ? `${parts.join(', ')} updated`
        : 'Your dashboards are now up to date';

      toast.success('Sync complete', { description: detail });
      setDrawerOpen(false);
      sawRunningRef.current = false;

      // Tell every dashboard to refetch.
      void queryClient.invalidateQueries();
    }

    if (prev === 'running' && curr === 'error') {
      toast.error('Sync failed', {
        description: status?.error ?? 'Something went wrong while syncing Yao data.',
      });
      setDrawerOpen(true);
      sawRunningRef.current = false;
    }

    prevStatusRef.current = curr;
  }, [status, queryClient]);

  // ── Actions ────────────────────────────────────────────────────────────

  const triggerSync = useCallback(async () => {
    if (!canSync || isTriggering) return;
    if (status?.status === 'running') {
      setDrawerOpen(true);
      return;
    }

    setIsTriggering(true);
    try {
      const result = await triggerPull();
      setDrawerOpen(true);
      // Optimistically flip to 'running' so the UI doesn't flicker between
      // 'idle' and the first poll response.
      setStatus((s) => ({
        status: 'running',
        currentStage: result.status === 'already_running' ? (s?.currentStage ?? 'Resuming…') : 'Starting…',
        error: null,
        startedAt: s?.startedAt ?? new Date().toISOString(),
        completedAt: null,
        lastPullAt: s?.lastPullAt ?? null,
        stats: s?.stats ?? {},
      }));
      // Kick a poll immediately so the real status takes over quickly.
      void refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start sync';
      toast.error('Could not start sync', { description: message });
    } finally {
      setIsTriggering(false);
    }
  }, [canSync, isTriggering, status?.status, refresh]);

  const value = useMemo<SyncContextValue>(
    () => ({
      canSync,
      status,
      isTriggering,
      elapsedSeconds,
      drawerOpen,
      setDrawerOpen,
      triggerSync,
      refresh,
    }),
    [canSync, status, isTriggering, elapsedSeconds, drawerOpen, triggerSync, refresh],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useYaoSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useYaoSync must be used within a YaoSyncProvider');
  return ctx;
}

// ── Helpers exposed for components ───────────────────────────────────────

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));

  if (diffSec < 45) return 'Just now';
  if (diffSec < 90) return '1 minute ago';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minutes ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr === 1 ? '1 hour ago' : `${diffHr} hours ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay === 1 ? 'Yesterday' : `${diffDay} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}