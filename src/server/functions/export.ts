/**
 * export.ts — Netlify Function
 *
 * Handles dashboard export requests.
 *
 *   POST /api/export/pdf  → generateDashboardPdf  → returns application/pdf
 *   POST /api/export/csv  → generateDashboardCsv  → returns text/csv
 *
 * Both endpoints:
 *   - Authenticate via authenticateRequest
 *   - Derive firmId from auth token (never from request body)
 *   - Load FirmConfig for PDF header
 *   - Log the export in audit_log
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { errorResponse } from '../lib/response-helpers.js';
import { getFirmConfig } from '../services/config-service.js';
import { generateDashboardPdf } from '../services/pdf-export-service.js';
import { generateDashboardCsv } from '../services/csv-export-service.js';
import { getServerClient } from '../lib/supabase.js';
import { AuditAction } from '../../shared/types/index.js';

const BASE = '/api/export';

function routeSegment(path: string): string {
  const clean = path.replace(/\/$/, '');
  return clean.startsWith(BASE) ? clean.slice(BASE.length + 1) : '';
}

async function writeAuditLog(
  firmId: string,
  userId: string,
  dashboardId: string,
  format: string,
): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from('audit_log')
    .insert({
      firm_id:     firmId,
      user_id:     userId,
      action:      AuditAction.EXPORT,
      entity_type: 'export',
      entity_id:   dashboardId,
      description: `Exported ${dashboardId} dashboard as ${format.toUpperCase()}`,
    });
  if (error) {
    console.error('[export] audit_log write failed:', error.message);
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId, userId } = await authenticateRequest(event);
    const segment = routeSegment(event.path ?? '');

    if (segment !== 'pdf' && segment !== 'csv') {
      return errorResponse('Not found', 404);
    }

    // Parse body
    let body: Record<string, unknown> = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return errorResponse('Invalid JSON body', 400);
      }
    }

    const dashboardId = typeof body['dashboardId'] === 'string' ? body['dashboardId'] : '';
    const filters     = (body['filters'] as Record<string, unknown>) ?? {};

    if (!dashboardId) {
      return errorResponse('dashboardId is required', 400);
    }

    if (segment === 'pdf') {
      const config = await getFirmConfig(firmId);
      const buffer = await generateDashboardPdf(firmId, dashboardId, filters, config);
      await writeAuditLog(firmId, userId, dashboardId, 'pdf');

      return {
        statusCode: 200,
        headers: {
          'Content-Type':        'application/pdf',
          'Content-Disposition': `attachment; filename="${dashboardId}.pdf"`,
        },
        body:            buffer.toString('base64'),
        isBase64Encoded: true,
      };
    }

    // CSV
    const { csv, filename } = await generateDashboardCsv(firmId, dashboardId, filters);
    await writeAuditLog(firmId, userId, dashboardId, 'csv');

    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body:            csv,
      isBase64Encoded: false,
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[export]', err);
    return errorResponse('Internal server error', 500);
  }
};
