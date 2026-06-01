/**
 * YaoConnection — Connect a firm to its Yao practice-management account.
 * Admin/owner only. Backend endpoints under /api/yao-connect, /api/yao-credentials.
 */

import { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, Loader2, CheckCircle2, RefreshCw, Trash2, Edit3 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { DashboardSection } from '@/components/common/DashboardSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionStatus {
  connected: boolean;
  lastVerifiedAt: string | null;
  lastPulledAt: string | null;
}

interface ConnectSuccess { connected: true; attorneyName: string }
interface ConnectFailure { connected: false; error?: string; issues?: string[] }
type ConnectResponse = ConnectSuccess | ConnectFailure;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  return headers;
}

function formatUkDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${date}, ${time}`;
  } catch {
    return iso;
  }
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidCode(s: string): boolean {
  return /^\d+$/.test(s.trim());
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function YaoConnection() {
  const { profile, roleLoading } = useAuth();
  const role = profile?.role ?? '';
  const isAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  // Status
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; code?: string }>({});

  // Action states
  const [connecting, setConnecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Load status on mount (admin only)
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/yao-connect/status', { headers: await authHeaders() });
      if (res.status === 401) {
        setStatusError('Your session has expired — please sign in again.');
        return;
      }
      if (res.status === 403) {
        setStatusError('You need owner or admin permissions to view this.');
        return;
      }
      if (!res.ok) {
        setStatusError('Could not load connection status.');
        return;
      }
      const body = await res.json() as ConnectionStatus;
      setStatus(body);
      setShowForm(!body.connected);
    } catch {
      setStatusError('Could not load connection status.');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (roleLoading || !isAdmin) return;
    loadStatus();
  }, [roleLoading, isAdmin, loadStatus]);

  // Hide section entirely for non-admins
  if (roleLoading) return null;
  if (!isAdmin) return null;

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setCode('');
    setShowPassword(false);
    setFieldErrors({});
  };

  const formValid = isValidEmail(email) && password.length > 0 && isValidCode(code);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    const errs: { email?: string; password?: string; code?: string } = {};
    if (!isValidEmail(email)) errs.email = 'Enter a valid email address.';
    if (!password) errs.password = 'Password is required.';
    if (!isValidCode(code)) errs.code = 'Code must be a whole number.';
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      return;
    }

    setConnecting(true);
    try {
      const res = await fetch('/api/yao-connect', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          email: email.trim(),
          password,
          code: parseInt(code, 10),
        }),
      });

      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        return;
      }
      if (res.status === 403) {
        toast.error('You need owner or admin permissions to do this.');
        return;
      }

      const body = await res.json() as ConnectResponse & { error?: string; issues?: string[]; message?: string };

      if (res.status === 400) {
        if (body.error === 'Validation failed' && Array.isArray(body.issues)) {
          const next: { email?: string; password?: string; code?: string } = {};
          for (const msg of body.issues) {
            const m = msg.toLowerCase();
            if (m.includes('email')) next.email = msg;
            else if (m.includes('password')) next.password = msg;
            else if (m.includes('code')) next.code = msg;
          }
          setFieldErrors(next);
          toast.error('Please fix the highlighted fields.');
          return;
        }
        if ('connected' in body && body.connected === false) {
          toast.error('Yao rejected those credentials — check the email, password and code.');
          return;
        }
        toast.error(body.error ?? 'Could not connect.');
        return;
      }

      if (res.status >= 500) {
        toast.error('Something went wrong saving your credentials.');
        return;
      }

      // 200 success
      if ('connected' in body && body.connected === true) {
        toast.success(`Connected to Yao as ${body.attorneyName}`);
        resetForm();
        setShowForm(false);
        await loadStatus();
      }
    } catch {
      toast.error('Network error — please try again.');
    } finally {
      setConnecting(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/yao-credentials/verify', { headers: await authHeaders() });
      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        return;
      }
      if (res.status === 403) {
        toast.error('You need owner or admin permissions to do this.');
        return;
      }
      if (!res.ok) {
        toast.error('Verification failed — please update your credentials.');
        return;
      }
      const body = await res.json() as { valid: boolean };
      if (body.valid) {
        toast.success('Credentials are valid ✓');
        await loadStatus();
      } else {
        toast.error('Verification failed — please update your credentials.');
      }
    } catch {
      toast.error('Verification failed — please update your credentials.');
    } finally {
      setVerifying(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch('/api/yao-credentials', {
        method: 'DELETE',
        headers: await authHeaders(),
      });
      if (res.status === 401) {
        toast.error('Your session has expired — please sign in again.');
        return;
      }
      if (res.status === 403) {
        toast.error('Only owners can disconnect Yao.');
        return;
      }
      if (!res.ok) {
        toast.error('Could not disconnect. Please try again.');
        return;
      }
      toast.success('Yao credentials removed.');
      setConfirmDisconnect(false);
      setShowForm(true);
      resetForm();
      await loadStatus();
    } catch {
      toast.error('Could not disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <DashboardSection title="Yao API Connection">
      {statusLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading connection status…
        </div>
      )}

      {!statusLoading && statusError && (
        <p className="text-xs text-error">{statusError}</p>
      )}

      {!statusLoading && !statusError && status?.connected && !showForm && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 rounded-lg border border-success/30 bg-success/5">
            <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-foreground">Connected to Yao</p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 mt-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Last verified</dt>
                  <dd className="text-foreground font-medium">{formatUkDateTime(status.lastVerifiedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last data pull</dt>
                  <dd className="text-foreground font-medium">
                    {status.lastPulledAt ? formatUkDateTime(status.lastPulledAt) : 'No pull yet'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleVerify} disabled={verifying}>
              {verifying ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Verifying…</>
              ) : (
                <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-verify</>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { resetForm(); setShowForm(true); setConfirmDisconnect(false); }}
            >
              <Edit3 className="h-3.5 w-3.5 mr-1.5" /> Update credentials
            </Button>
            {isOwner && (
              <Button
                variant={confirmDisconnect ? 'destructive' : 'outline'}
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Disconnecting…</>
                ) : (
                  <><Trash2 className="h-3.5 w-3.5 mr-1.5" /> {confirmDisconnect ? 'Confirm — remove credentials' : 'Disconnect'}</>
                )}
              </Button>
            )}
            {confirmDisconnect && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </Button>
            )}
          </div>
          {confirmDisconnect && (
            <p className="text-xs text-muted-foreground">
              This removes the stored Yao credentials. Continue?
            </p>
          )}
        </div>
      )}

      {!statusLoading && !statusError && (showForm || (status && !status.connected)) && (
        <form onSubmit={handleConnect} className="space-y-4 max-w-md">
          {status && !status.connected && (
            <p className="text-xs text-muted-foreground">
              Not connected. Enter your Yao API credentials to link this firm.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="yao-email" className="text-xs font-semibold">Email</Label>
            <Input
              id="yao-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="firm@example.com"
              disabled={connecting}
              aria-invalid={!!fieldErrors.email}
            />
            {fieldErrors.email && (
              <p className="text-xs text-error">{fieldErrors.email}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="yao-password" className="text-xs font-semibold">Password</Label>
            <div className="relative">
              <Input
                id="yao-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={connecting}
                aria-invalid={!!fieldErrors.password}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {fieldErrors.password && (
              <p className="text-xs text-error">{fieldErrors.password}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="yao-code" className="text-xs font-semibold">Code</Label>
            <Input
              id="yao-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="123456"
              disabled={connecting}
              aria-invalid={!!fieldErrors.code}
            />
            <p className="text-xs text-muted-foreground">
              Your Yao login code (provided by Yao). Required to authenticate.
            </p>
            {fieldErrors.code && (
              <p className="text-xs text-error">{fieldErrors.code}</p>
            )}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button type="submit" disabled={!formValid || connecting}>
              {connecting ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Connecting…</>
              ) : (
                'Connect'
              )}
            </Button>
            {status?.connected && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => { resetForm(); setShowForm(false); }}
                disabled={connecting}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </DashboardSection>
  );
}