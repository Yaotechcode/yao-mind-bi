/**
 * SyncStatus — header indicator + slide-in progress drawer for the Yao
 * data sync. Visible to owner/admin only; renders nothing otherwise.
 */

import { useEffect } from 'react';
import { Loader2, RefreshCw, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  useYaoSync,
  formatRelativeTime,
  formatElapsed,
} from '@/hooks/useYaoSync';

// ── Indicator (header) ───────────────────────────────────────────────────

export function SyncStatusIndicator() {
  const { canSync, status, isTriggering, triggerSync, setDrawerOpen } = useYaoSync();

  // Re-render every 30s so the relative time stays fresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      // Forcing a tick via no-op state isn't needed — relative time uses
      // Date.now() on each render, and the polling already triggers renders
      // while running. We still nudge for the idle case.
      window.dispatchEvent(new Event('yaomind:sync-tick'));
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!canSync) return null;

  const running = status?.status === 'running';
  const errored = status?.status === 'error';
  const lastPullAt = status?.lastPullAt ?? null;

  const onClick = () => {
    if (running) {
      setDrawerOpen(true);
      return;
    }
    void triggerSync();
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card">
      <div className="flex-1 min-w-0">
        {running ? (
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
            <span className="font-semibold text-foreground">Sync in progress</span>
            <span className="text-muted-foreground truncate">
              {status?.currentStage ?? 'Starting…'}
            </span>
          </div>
        ) : errored ? (
          <div className="flex items-center gap-2 text-xs">
            <AlertCircle className="w-3.5 h-3.5 text-destructive" />
            <span className="font-semibold text-destructive">Last sync failed</span>
            <span className="text-muted-foreground truncate">{status?.error}</span>
          </div>
        ) : lastPullAt ? (
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
            <span className="text-muted-foreground">Last synced</span>
            <span className="font-semibold text-foreground">{formatRelativeTime(lastPullAt)}</span>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Never synced — click Sync to pull your data
          </div>
        )}
      </div>

      <Button
        size="sm"
        variant={running ? 'outline' : 'default'}
        onClick={onClick}
        disabled={isTriggering}
      >
        {isTriggering ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Starting…
          </>
        ) : running ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            View progress
          </>
        ) : (
          <>
            <RefreshCw className="w-3.5 h-3.5" />
            Sync now
          </>
        )}
      </Button>
    </div>
  );
}

// ── Drawer (progress panel) ──────────────────────────────────────────────

const STAT_LABELS: Array<{ key: keyof NonNullable<ReturnType<typeof useYaoSync>['status']>['stats']; label: string }> = [
  { key: 'matters', label: 'Matters' },
  { key: 'timeEntries', label: 'Time entries' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'feeEarners', label: 'Fee earners' },
  { key: 'disbursements', label: 'Disbursements' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'kpiSnapshotsWritten', label: 'KPI snapshots' },
];

export function SyncProgressDrawer() {
  const {
    canSync,
    status,
    drawerOpen,
    setDrawerOpen,
    elapsedSeconds,
    triggerSync,
    isTriggering,
  } = useYaoSync();

  if (!canSync) return null;

  const running = status?.status === 'running';
  const errored = status?.status === 'error';
  const stats = status?.stats ?? {};

  return (
    <>
      {/* Backdrop — non-blocking: clicking it just closes the drawer */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-foreground/20 transition-opacity duration-200',
          drawerOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-label="Yao data sync progress"
        className={cn(
          'fixed right-0 top-0 bottom-0 z-50 w-full max-w-md flex flex-col',
          'bg-card border-l border-border shadow-card',
          'transition-transform duration-200 ease-in-out',
          drawerOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground leading-tight">
              {running ? 'Syncing Yao data' : errored ? 'Sync failed' : 'Sync status'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {running
                ? 'Pulling the latest matters, time entries and invoices.'
                : errored
                  ? 'The last sync did not complete.'
                  : 'Your data is up to date.'}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close progress panel"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Elapsed + stage — the headline */}
          {running && (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Elapsed
              </div>
              <div className="font-mono text-3xl font-bold text-foreground tabular-nums">
                {formatElapsed(elapsedSeconds)}
              </div>

              <div className="mt-4 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Current stage
              </div>
              <div
                key={status?.currentStage ?? 'init'}
                className="text-base font-semibold text-primary transition-opacity duration-300 animate-in fade-in slide-in-from-bottom-1"
              >
                {status?.currentStage ?? 'Starting…'}
              </div>

              {/* Indeterminate progress bar to reinforce activity */}
              <div className="mt-4 h-1 w-full rounded-full bg-border overflow-hidden">
                <div className="h-full w-1/3 bg-primary animate-[sync-bar_1.4s_ease-in-out_infinite] rounded-full" />
              </div>

              <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
                Large firms may take 5–15 minutes. The sync continues in the
                background if you navigate away.
              </p>
            </div>
          )}

          {/* Error */}
          {errored && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-destructive">
                    The sync did not complete
                  </div>
                  <p className="text-xs text-foreground mt-1 break-words">
                    {status?.error ?? 'An unknown error occurred.'}
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  onClick={() => void triggerSync()}
                  disabled={isTriggering}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          )}

          {/* Idle / complete summary */}
          {!running && !errored && (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Last synced
              </div>
              <div className="text-base font-semibold text-foreground">
                {formatRelativeTime(status?.lastPullAt ?? null)}
              </div>
              {status?.lastPullAt && (
                <div className="text-xs text-muted-foreground mt-1">
                  {new Date(status.lastPullAt).toLocaleString('en-GB')}
                </div>
              )}
            </div>
          )}

          {/* Records fetched */}
          {Object.keys(stats).length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                Records fetched
              </div>
              <dl className="grid grid-cols-2 gap-2">
                {STAT_LABELS.map(({ key, label }) => {
                  const value = stats[key];
                  if (typeof value !== 'number') return null;
                  return (
                    <div
                      key={String(key)}
                      className="rounded-md border border-border bg-card p-3"
                    >
                      <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">
                        {label}
                      </dt>
                      <dd className="text-sm font-semibold text-foreground tabular-nums mt-0.5">
                        {value.toLocaleString('en-GB')}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex items-center justify-between gap-3">
          {!running && !errored ? (
            <Button
              size="sm"
              onClick={() => void triggerSync()}
              disabled={isTriggering}
            >
              {isTriggering ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync now
                </>
              )}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              You can close this panel — the sync will keep running.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(false)}>
            Close
          </Button>
        </div>
      </aside>
    </>
  );
}

// Combined export used by the layout.
export function SyncStatus() {
  return (
    <>
      <SyncStatusIndicator />
      <SyncProgressDrawer />
    </>
  );
}