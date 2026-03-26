/**
 * RegisterPage — /register
 * Creates a new firm + admin user via Supabase.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [firmName, setFirmName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin + '/dashboard',
          data: {
            firm_name: firmName,
            display_name: displayName,
          },
        },
      });
      if (signUpError) throw signUpError;
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-standard-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-lg bg-primary mx-auto mb-4 flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-lg">Y</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground leading-9">Create your firm</h1>
          <p className="text-sm text-muted-foreground mt-1">Set up Yao Mind for your practice</p>
        </div>

        <div className="bg-card rounded-lg shadow-card p-6 border border-border">
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="firmName" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Firm name
              </Label>
              <Input
                id="firmName"
                value={firmName}
                onChange={(e) => setFirmName(e.target.value)}
                placeholder="Smith & Partners LLP"
                required
                className="rounded-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="displayName" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Your name
              </Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Smith"
                required
                className="rounded-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="regEmail" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Email
              </Label>
              <Input
                id="regEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@firm.com"
                required
                className="rounded-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="regPassword" className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Password
              </Label>
              <Input
                id="regPassword"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 8 characters"
                required
                minLength={8}
                className="rounded-input"
              />
            </div>

            {error && (
              <p className="text-xs text-destructive bg-destructive/10 rounded-sm px-3 py-2">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creating…' : 'Create firm'}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-primary hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
