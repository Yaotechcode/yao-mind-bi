/**
 * LoginPage — /login
 * Email + password sign-in with magic link option.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [mode, setMode] = useState<'password' | 'magic'>('password');

  // Redirect if already logged in
  if (!authLoading && user) {
    navigate('/dashboard', { replace: true });
    return null;
  }

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error: magicError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + '/dashboard' },
      });
      if (magicError) throw magicError;
      setMagicLinkSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-standard-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo area */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-lg bg-primary mx-auto mb-4 flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-lg">Y</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground leading-9">Yao Mind</h1>
          <p className="text-sm text-muted-foreground mt-1">Business intelligence for your firm</p>
        </div>

        <div className="bg-card rounded-lg shadow-card p-6 border border-border">
          {magicLinkSent ? (
            <div className="text-center py-4">
              <p className="text-sm text-foreground font-medium mb-2">Check your email</p>
              <p className="text-xs text-muted-foreground">
                We sent a magic link to <strong>{email}</strong>
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-4"
                onClick={() => setMagicLinkSent(false)}
              >
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={mode === 'password' ? handlePasswordLogin : handleMagicLink}>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@firm.com"
                    required
                    className="rounded-input"
                  />
                </div>

                {mode === 'password' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Password
                      </Label>
                      <Link
                        to="/forgot-password"
                        className="text-[11px] text-primary hover:underline"
                      >
                        Forgot password?
                      </Link>
                    </div>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="rounded-input"
                    />
                  </div>
                )}

                {error && (
                  <p className="text-xs text-destructive bg-destructive/10 rounded-sm px-3 py-2">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading
                    ? 'Signing in…'
                    : mode === 'password'
                      ? 'Sign in'
                      : 'Send magic link'}
                </Button>
              </div>
            </form>
          )}

          {!magicLinkSent && (
            <div className="mt-4 text-center">
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setMode(mode === 'password' ? 'magic' : 'password')}
              >
                {mode === 'password' ? 'Sign in with magic link instead' : 'Sign in with password instead'}
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          New firm?{' '}
          <Link to="/register" className="text-primary hover:underline font-medium">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
