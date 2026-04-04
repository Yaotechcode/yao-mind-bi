/**
 * yao-pull-background.ts — Netlify Background Function
 * POST /.netlify/functions/yao-pull-background
 *
 * Runs the full Yao API pull sequence for a firm. Background Functions have
 * no request timeout (up to 15 minutes configured in netlify.toml).
 *
 * Called fire-and-forget by yao-pull.ts after verifying the user is
 * authenticated and no pull is already running.
 *
 * Authentication: internal shared secret via x-internal-secret header.
 * The firmId is passed in the JSON body — it is NOT taken from the token
 * because the token belongs to the triggering user's session, not available
 * in the background context.
 *
 * Background Functions return 202 immediately; the function continues
 * running asynchronously. The caller should poll
 * GET /api/dashboard-kpis/pull-status for completion.
 */

import type { Handler } from '@netlify/functions';
import { PullOrchestrator } from '../datasource/PullOrchestrator.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify internal shared secret — this endpoint must never be callable by
  // external actors directly. Only yao-pull.ts (same deployment) may call it.
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';
  const provided       = event.headers['x-internal-secret'] ?? '';
  if (!internalSecret || provided !== internalSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Parse firmId from body
  let firmId: string | undefined;
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    firmId = typeof body['firmId'] === 'string' ? body['firmId'] : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!firmId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'firmId is required' }) };
  }

  // Run the full pull sequence
  try {
    const orchestrator = new PullOrchestrator(firmId);
    const result = await orchestrator.run();

    console.log(
      `[yao-pull-background] firmId=${firmId}`,
      `success=${result.success}`,
      `kpiSnapshots=${result.stats.kpiSnapshotsWritten}`,
      `riskFlags=${result.stats.riskFlagsGenerated}`,
      `warnings=${result.warnings.length}`,
      `errors=${result.errors.length}`,
    );

    return {
      statusCode: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[yao-pull-background] unexpected error', { firmId, err });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Pull failed unexpectedly', message }),
    };
  }
};
