/**
 * auth-middleware.ts
 *
 * Authenticates incoming Netlify Function requests using Supabase JWTs.
 * Every Netlify Function calls authenticateRequest(event) as its first step
 * and uses the returned { userId, firmId, role } for all subsequent service calls.
 *
 * firmId is always derived from the authenticated user — never from the request body.
 */

import { getServerClient } from './supabase.js';
import type { HandlerEvent } from '@netlify/functions';

// =============================================================================
// Types
// =============================================================================

export interface AuthContext {
  userId: string;
  firmId: string;
  role: string;
}

/**
 * Thrown by authenticateRequest. Carries an HTTP status code so that
 * Netlify Function handlers can return the correct response without additional logic.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Extracts and verifies the Bearer token from the Authorization header,
 * then looks up the user's firm_id and role from the user_profiles table.
 *
 * @throws AuthError(401) if the token is missing, invalid, or expired
 * @throws AuthError(403) if the user profile is not found
 */
export async function authenticateRequest(event: HandlerEvent): Promise<AuthContext> {
  const authHeader = (
    event.headers?.['authorization'] ??
    event.headers?.['Authorization'] ??
    ''
  ).trim();

  if (!authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header', 401);
  }

  const token = authHeader.slice(7).trim();
  const db = getServerClient();

  // Verify token with Supabase auth
  const {
    data: { user },
    error: authError,
  } = await db.auth.getUser(token);

  if (authError || !user) {
    throw new AuthError('Invalid or expired token', 401);
  }

  // Look up user profile for firm_id and role
  const { data: profile, error: profileError } = await db
    .from('user_profiles')
    .select('firm_id, role')
    .eq('user_id', user.id)
    .single();

  if (profileError || !profile) {
    throw new AuthError(
      'User profile not found — contact your firm administrator',
      403,
    );
  }

  const p = profile as Record<string, unknown>;

  return {
    userId: user.id,
    firmId: p['firm_id'] as string,
    role: (p['role'] as string) ?? 'viewer',
  };
}
