/**
 * firm-config.ts — Netlify Function
 *
 * GET   /api/firm-config  → returns the firm's FirmConfig (merged with defaults)
 * PATCH /api/firm-config  → updates a single config path, writes audit log,
 *                           returns updated FirmConfig
 *
 * Both endpoints require a valid Supabase Bearer token. firmId is always
 * derived from the authenticated user — never trusted from the request body.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getFirmConfig, updateFirmConfig } from '../services/config-service.js';

export const handler: Handler = async (event) => {
  try {
    const { userId, firmId } = await authenticateRequest(event);

    const method = event.httpMethod;

    // GET /api/firm-config
    if (method === 'GET') {
      const config = await getFirmConfig(firmId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      };
    }

    // PATCH /api/firm-config
    if (method === 'PATCH') {
      if (!event.body) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Request body is required' }),
        };
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid JSON in request body' }),
        };
      }

      const path = body['path'];
      if (typeof path !== 'string' || !path) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: '"path" must be a non-empty string' }),
        };
      }

      if (!('value' in body)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: '"value" is required' }),
        };
      }

      const updated = await updateFirmConfig(firmId, path, body['value'], userId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      };
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        statusCode: err.statusCode,
        body: JSON.stringify({ error: err.message }),
      };
    }

    console.error('[firm-config] Unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
