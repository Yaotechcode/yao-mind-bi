import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Environment variable validation
// =============================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

// =============================================================================
// Server client (service role — full access, server-side only)
// Use this in Netlify Functions where you need to bypass RLS.
// NEVER expose the service role key to the browser.
// =============================================================================

let _serverClient: SupabaseClient | null = null;

export function getServerClient(): SupabaseClient {
  if (!_serverClient) {
    _serverClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return _serverClient;
}

// =============================================================================
// Client (anon key — respects RLS, safe for browser usage)
// Use this when you want Supabase to enforce Row Level Security
// and act on behalf of the authenticated user.
// =============================================================================

let _anonClient: SupabaseClient | null = null;

export function getAnonClient(): SupabaseClient {
  if (!_anonClient) {
    _anonClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_ANON_KEY')
    );
  }
  return _anonClient;
}

// =============================================================================
// Typed database helpers
// =============================================================================

/** Run a query with the server (service-role) client. */
export const db = {
  get server() {
    return getServerClient();
  },
  get anon() {
    return getAnonClient();
  },
};
