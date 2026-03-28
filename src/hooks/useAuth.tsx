import { useState, useEffect, createContext, useContext, useCallback, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export interface Profile {
  id: string;
  firm_id: string | null;
  email: string;
  display_name: string | null;
  role: string;
  department: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface AuthResult {
  error: Error | null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  roleLoading: boolean;
  isYaoAdmin: boolean;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isYaoAdmin, setIsYaoAdmin] = useState(false);
  const [loading, setLoading] = useState(true); // starts TRUE — critical
  const [roleLoading, setRoleLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string) => {
    setRoleLoading(true);
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setProfile(data as Profile);
        setIsYaoAdmin(data.role === 'yao_admin');
      } else {
        setProfile(null);
        setIsYaoAdmin(false);
      }
    } catch (error) {
      console.error('[AuthProvider] Error fetching profile:', error);
      setProfile(null);
      setIsYaoAdmin(false);
    } finally {
      setRoleLoading(false);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user, fetchProfile]);

  useEffect(() => {
    let mounted = true;

    // 1. Get initial session — only set loading=false AFTER this resolves
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      if (!mounted) return;
      setSession(initialSession);
      setUser(initialSession?.user ?? null);

      if (initialSession?.user) {
        fetchProfile(initialSession.user.id).finally(() => {
          if (mounted) setLoading(false);
        });
      } else {
        setRoleLoading(false);
        setLoading(false);
      }
    }).catch((error) => {
      console.error('[AuthProvider] getSession error:', error);
      if (mounted) {
        setRoleLoading(false);
        setLoading(false);
      }
    });

    // 2. Listen for auth state changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      if (nextSession?.user) {
        // Defer to avoid Supabase deadlock
        setTimeout(() => {
          if (mounted) fetchProfile(nextSession.user.id);
        }, 0);
      } else {
        setProfile(null);
        setIsYaoAdmin(false);
        setRoleLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  }, []);

  const signOut = useCallback(async () => {
    setProfile(null);
    setIsYaoAdmin(false);
    setUser(null);
    setSession(null);
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) console.error('[AuthProvider] Sign out error:', error);
    window.location.href = '/login';
  }, []);

  return (
    <AuthContext.Provider value={{
      user, session, profile, loading, roleLoading, isYaoAdmin,
      signIn, signOut, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
