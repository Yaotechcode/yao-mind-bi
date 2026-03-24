/**
 * audit-log.ts — Netlify Function
 *
 * GET  /api/audit-log                   → getAuditLog (paginated, filterable)
 * GET  /api/audit-log/history?path=...  → getConfigChangeHistory
 * POST /api/audit-log/rollback          → rollbackConfigChange
 *
 * All endpoints require a valid Supabase Bearer token and return data scoped
 * to the authenticated user's firm.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getAuditLog,
  getConfigChangeHistory,
  rollbackConfigChange,
} from '../services/audit-service.js';

export const handler: Handler = async (event) => {
  try {
    const { userId, firmId } = await authenticateRequest(event);

    const path = event.path ?? '';
    const method = event.httpMethod;
    const qs = event.queryStringParameters ?? {};

    // POST /api/audit-log/rollback
    if (method === 'POST' && path.endsWith('/rollback')) {
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

      const auditEntryId = body['auditEntryId'] as string | undefined;
      if (!auditEntryId) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'auditEntryId is required' }),
        };
      }

      await rollbackConfigChange(firmId, auditEntryId, userId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    // GET /api/audit-log/history?path=...
    if (method === 'GET' && path.endsWith('/history')) {
      const configPath = qs['path'] ?? '';
      if (!configPath) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: '"path" query parameter is required' }),
        };
      }

      const entries = await getConfigChangeHistory(firmId, configPath);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      };
    }

    // GET /api/audit-log
    if (method === 'GET') {
      const result = await getAuditLog(firmId, {
        limit: qs['limit'] ? parseInt(qs['limit'], 10) : 50,
        offset: qs['offset'] ? parseInt(qs['offset'], 10) : 0,
        action: qs['action'],
        entityType: qs['entityType'],
        userId: qs['userId'],
        dateFrom: qs['dateFrom'],
        dateTo: qs['dateTo'],
        search: qs['search'],
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
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

    console.error('[audit-log] Unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
