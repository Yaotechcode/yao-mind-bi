/**
 * yao-credentials.ts — Netlify Function
 *
 * POST   /api/yao-credentials         → store credentials (owner or admin only)
 * DELETE /api/yao-credentials         → delete credentials (owner only)
 * GET    /api/yao-credentials/verify  → verify credentials work → { valid: boolean }
 *
 * firmId is always derived from the authenticated user — never from the request body.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  storeCredentials,
  deleteCredentials,
  verifyCredentials,
} from '../services/credential-service.js';

export const handler: Handler = async (event) => {
  try {
    const auth = await authenticateRequest(event);
    const { userId, firmId, role } = auth;
    const method = event.httpMethod;
    const path = event.path ?? '';

    // GET /api/yao-credentials/verify
    if (method === 'GET' && path.endsWith('/verify')) {
      const valid = await verifyCredentials(firmId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valid }),
      };
    }

    // POST /api/yao-credentials
    if (method === 'POST') {
      if (role !== 'owner' && role !== 'admin') {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Only firm owners and admins can store credentials' }),
        };
      }

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

      const email = body['email'];
      const password = body['password'];

      if (typeof email !== 'string' || !email) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: '"email" must be a non-empty string' }),
        };
      }

      if (typeof password !== 'string' || !password) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: '"password" must be a non-empty string' }),
        };
      }

      await storeCredentials(firmId, email, password, userId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    // DELETE /api/yao-credentials
    if (method === 'DELETE') {
      if (role !== 'owner') {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Only firm owners can delete credentials' }),
        };
      }

      await deleteCredentials(firmId, userId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
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

    console.error('[yao-credentials] Unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
