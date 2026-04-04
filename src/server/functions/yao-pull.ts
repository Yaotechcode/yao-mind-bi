/**
 * yao-pull.ts — Netlify Function (regular, not background)
 * POST /api/yao-pull
 *
 * User-facing trigger. Validates the request, checks that no pull is already
 * running, then fires yao-pull-background (a Background Function) and returns
 * 202 immediately.
 *
 * The actual pull runs asynchronously in the background. Poll
 * GET /api/dashboard-kpis/pull-status for completion.
 *
 * Authentication: standard JWT via authenticateRequest.
 * Minimum role required: admin (fee_earner / viewer may not trigger a pull).
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getPullStatus } from '../services/pull-status-service.js';

// =============================================================================
// Constants
// =============================================================================

/** Roles that are permitted to trigger a pull. */
const PULL_ALLOWED_ROLES = new Set(['owner', 'admin']);

// =============================================================================
// Handler
// =============================================================================

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ---------------------------------------------------------------------------
  // Authenticate
  // ---------------------------------------------------------------------------
  let firmId: string;
  try {
    const auth = await authenticateRequest(event);
    firmId = auth.firmId;

    if (!PULL_ALLOWED_ROLES.has(auth.role)) {
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

  // ---------------------------------------------------------------------------
  // Check for concurrent pull
  // ---------------------------------------------------------------------------
  try {
    const current = await getPullStatus(firmId);
    if (current?.status === 'running') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'A pull is already running — try again shortly',
          status: 'running',
        }),
      };
    }
  } catch {
    // If we can't read pull status, proceed — the background function will
    // perform its own concurrency check via requireNoConcurrentPull.
  }

  // ---------------------------------------------------------------------------
  // Fire background function
  // ---------------------------------------------------------------------------
  const backgroundUrl = buildBackgroundUrl(event);
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';

  try {
    await fetch(backgroundUrl, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': internalSecret,
      },
      body: JSON.stringify({ firmId }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[yao-pull] failed to trigger background function', { firmId, message });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to start pull', message }),
    };
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Pull started',
      status:  'running',
    }),
  };
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Builds the absolute URL for the background function.
 * In Netlify, Background Functions are at `/.netlify/functions/<name>`.
 * We derive the base URL from the incoming request so this works in both
 * production and branch deploy contexts.
 */
function buildBackgroundUrl(event: Parameters<Handler>[0]): string {
  // Netlify provides the site URL in the DEPLOY_URL or URL env var
  const base =
    process.env['DEPLOY_URL'] ??
    process.env['URL'] ??
    `https://${event.headers?.['host'] ?? 'localhost'}`;

  return `${base}/.netlify/functions/yao-pull-background`;
}
