/**
 * config-export.ts — Netlify Function
 *
 * POST /api/config-export
 *
 * Exports the authenticated firm's complete configuration as JSON.
 * The response body is the ExportedFullConfig object — callers can save it
 * as a .json file for backup or cross-firm import.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { exportFullConfiguration } from '../services/config-export-service.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { userId, firmId } = await authenticateRequest(event);
    const result = await exportFullConfiguration(firmId, userId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        statusCode: err.statusCode,
        body: JSON.stringify({ error: err.message }),
      };
    }

    console.error('[config-export] Unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
      }),
    };
  }
};
