/**
 * config-import.ts — Netlify Function
 *
 * POST /api/config-import
 *
 * Imports a previously-exported configuration file for the authenticated firm.
 * Request body must be the raw JSON string of an ExportedFullConfig object.
 *
 * Returns an ImportResult with success flag, warnings, import counts, and
 * the backup audit log entry ID created before the import began.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { importFullConfiguration } from '../services/config-export-service.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Request body is required' }),
    };
  }

  try {
    const { userId, firmId } = await authenticateRequest(event);
    const result = await importFullConfiguration(firmId, event.body, userId);

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

    // Surface validation/parsing errors as 400, everything else as 500
    const message = err instanceof Error ? err.message : 'Internal server error';
    const statusCode =
      message.startsWith('Invalid JSON') || message.startsWith('Import validation')
        ? 400
        : 500;

    if (statusCode === 500) {
      console.error('[config-import] Unexpected error:', err);
    }

    return {
      statusCode,
      body: JSON.stringify({ error: message }),
    };
  }
};
