/**
 * yao-connect.ts — Netlify Function
 * POST /api/yao-connect        — verify + store Yao credentials (owner or admin)
 * GET  /api/yao-connect/status — connection status (any authenticated user)
 *
 * This is the onboarding-style endpoint. Unlike yao-credentials.ts (which simply
 * stores credentials), yao-connect tests them live against the Yao API first,
 * then stores them only on success.
 */

import type { Handler } from '@netlify/functions';
import { z } from 'zod';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { storeCredentials } from '../services/credential-service.js';
import { getPullStatus } from '../services/pull-status-service.js';
import { getServerClient } from '../lib/supabase.js';

// =============================================================================
// Constants
// =============================================================================

const CONNECT_ALLOWED_ROLES = new Set(['owner', 'admin']);

// =============================================================================
// Validation schema
// =============================================================================

const ConnectBodySchema = z.object({
  email:    z.string().email('email must be a valid email address'),
  password: z.string().min(1, 'password must not be empty'),
  code:     z.number().int().optional(),
});

// =============================================================================
// Handler
// =============================================================================

export const handler: Handler = async (event) => {
  const method = event.httpMethod;
  const path   = event.path ?? '';

  // ---------------------------------------------------------------------------
  // GET /api/yao-connect/status
  // ---------------------------------------------------------------------------
  if (method === 'GET' && path.endsWith('/status')) {
    let firmId: string;
    try {
      const auth = await authenticateRequest(event);
      firmId = auth.firmId;
    } catch (err) {
      if (err instanceof AuthError) {
        return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
      }
      return { statusCode: 500, body: JSON.stringify({ error: 'Authentication failed' }) };
    }

    try {
      const [credRow, pullStatus] = await Promise.all([
        fetchCredentialRow(firmId),
        getPullStatus(firmId),
      ]);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connected:       credRow !== null,
          lastVerifiedAt:  credRow?.last_verified_at ?? null,
          lastPulledAt:    pullStatus?.pulledAt ?? null,
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[yao-connect] status error', { firmId, message });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to retrieve connection status' }),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/yao-connect
  // ---------------------------------------------------------------------------
  if (method === 'POST') {
    let firmId: string;
    let userId: string;
    try {
      const auth = await authenticateRequest(event);
      firmId = auth.firmId;
      userId = auth.userId;

      if (!CONNECT_ALLOWED_ROLES.has(auth.role)) {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Insufficient permissions — owner or admin role required' }),
        };
      }
    } catch (err) {
      if (err instanceof AuthError) {
        return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
      }
      return { statusCode: 500, body: JSON.stringify({ error: 'Authentication failed' }) };
    }

    // Parse + validate body
    let parsed: z.infer<typeof ConnectBodySchema>;
    try {
      const raw = JSON.parse(event.body ?? '{}') as unknown;
      const result = ConnectBodySchema.safeParse(raw);
      if (!result.success) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error:  'Validation failed',
            issues: result.error.issues.map((i) => i.message),
          }),
        };
      }
      parsed = result.data;
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const { email, password, code } = parsed;

    // Test credentials against Yao API
    const loginResult = await attemptYaoLogin(email, password, code);
    if (!loginResult.ok) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connected: false, error: 'Invalid credentials' }),
      };
    }

    // Credentials valid — store them
    try {
      await storeCredentials(firmId, email, password, code, userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[yao-connect] storeCredentials failed', { firmId, message });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Credentials verified but could not be saved', message }),
      };
    }

    // Update pull_status to 'idle' if no row exists yet
    await initPullStatusIfAbsent(firmId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connected:    true,
        attorneyName: loginResult.attorneyName,
      }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};

// =============================================================================
// Helpers
// =============================================================================

interface LoginSuccess { ok: true;  attorneyName: string }
interface LoginFailure { ok: false }
type LoginOutcome = LoginSuccess | LoginFailure;

/**
 * Attempts POST /attorneys/login against the Yao API.
 * Returns ok=true with the attorney's display name on success,
 * ok=false on any authentication failure.
 * Never throws — network errors count as login failure.
 */
async function attemptYaoLogin(
  email: string,
  password: string,
  code?: number,
): Promise<LoginOutcome> {
  const baseUrl = process.env['YAO_API_BASE_URL'] ?? 'https://api.yao.legal';

  try {
    const response = await fetch(`${baseUrl}/attorneys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        code !== undefined ? { email, password, code } : { email, password },
      ),
    });

    if (!response.ok) return { ok: false };

    const body = (await response.json()) as Record<string, unknown>;

    // Extract attorney name from common response shapes
    const attorneyName = extractAttorneyName(body) ?? email;

    return { ok: true, attorneyName };
  } catch {
    return { ok: false };
  }
}

/**
 * Extracts a display name from a Yao login response body.
 * Tries common key names; returns null if none found.
 */
function extractAttorneyName(body: Record<string, unknown>): string | null {
  // Direct name fields
  if (typeof body['fullName'] === 'string' && body['fullName']) return body['fullName'];
  if (typeof body['full_name'] === 'string' && body['full_name']) return body['full_name'];
  if (typeof body['name'] === 'string' && body['name']) return body['name'];

  // Composed from first + last
  const first = typeof body['first_name'] === 'string' ? body['first_name'] : '';
  const last  = typeof body['last_name']  === 'string' ? body['last_name']  : '';
  if (first || last) return `${first} ${last}`.trim();

  // Nested attorney/user object
  for (const key of ['attorney', 'user', 'data']) {
    const nested = body[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = extractAttorneyName(nested as Record<string, unknown>);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Fetches the yao_api_credentials row for this firm (metadata only — no decryption).
 * Returns null if no row exists.
 */
async function fetchCredentialRow(
  firmId: string,
): Promise<{ last_verified_at: string | null } | null> {
  const db = getServerClient();
  const { data, error } = await db
    .from('yao_api_credentials')
    .select('last_verified_at')
    .eq('firm_id', firmId)
    .maybeSingle();

  if (error) throw new Error(`fetchCredentialRow failed: ${error.message}`);
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return { last_verified_at: (row['last_verified_at'] as string | null) ?? null };
}

/**
 * Inserts an idle pull_status row for the firm if one does not already exist.
 * Best-effort — errors are logged and swallowed.
 */
async function initPullStatusIfAbsent(firmId: string): Promise<void> {
  try {
    const existing = await getPullStatus(firmId);
    if (existing) return;

    const db = getServerClient();
    await db.from('pull_status').insert({
      firm_id:         firmId,
      status:          'idle',
      started_at:      null,
      completed_at:    null,
      pulled_at:       null,
      current_stage:   null,
      records_fetched: {},
      error:           null,
    });
  } catch (err) {
    console.warn('[yao-connect] initPullStatusIfAbsent failed (non-fatal)', {
      firmId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
