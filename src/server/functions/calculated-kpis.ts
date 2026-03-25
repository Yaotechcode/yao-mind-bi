/**
 * calculated-kpis.ts — Netlify Function
 * GET  /api/calculated-kpis         → latest KPI snapshot for this firm
 * POST /api/calculated-kpis/trigger → mark KPIs as stale
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getLatestCalculatedKpis,
  getRecalculationFlag,
  setRecalculationFlag,
} from '../lib/mongodb-operations.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';

function isTriggerPath(path: string): boolean {
  return path.replace(/\/$/, '').endsWith('/trigger');
}

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    // POST /api/calculated-kpis/trigger
    if (event.httpMethod === 'POST' && isTriggerPath(event.path ?? '')) {
      await setRecalculationFlag(firmId);
      return successResponse({ triggered: true });
    }

    // GET /api/calculated-kpis
    if (event.httpMethod === 'GET') {
      const [kpisDoc, flagDoc] = await Promise.all([
        getLatestCalculatedKpis(firmId),
        getRecalculationFlag(firmId),
      ]);

      if (!kpisDoc) {
        return successResponse({
          calculatedAt: null,
          isStale: false,
          configVersion: null,
          dataVersion: null,
          kpis: {},
        });
      }

      const kpis = kpisDoc.kpis as Record<string, unknown>;
      return successResponse({
        calculatedAt: new Date(kpisDoc.calculated_at).toISOString(),
        isStale: flagDoc?.is_stale ?? false,
        configVersion: kpisDoc.config_version,
        dataVersion: kpisDoc.data_version,
        formulaVersionSnapshot: kpis['formulaVersionSnapshot'] ?? null,
        results: kpis['formulaResults'] ?? {},
        ragAssignments: kpis['ragAssignments'] ?? {},
        ragSummary: kpis['ragSummary'] ?? null,
        readiness: kpis['readiness'] ?? {},
        calculationMetadata: kpis['calculationMetadata'] ?? null,
      });
    }

    return errorResponse('Method not allowed', 405);
  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[calculated-kpis]', err);
    return errorResponse('Internal server error', 500);
  }
};
