/**
 * dashboard.ts — Netlify Function
 *
 * Routes dashboard data requests to the dashboard service.
 *
 *   GET /api/dashboard/firm-overview          → getFirmOverviewData
 *   GET /api/dashboard/fee-earner-performance → getFeeEarnerPerformanceData
 *   GET /api/dashboard/wip                    → getWipData
 *   GET /api/dashboard/billing                → getBillingCollectionsData
 *   GET /api/dashboard/matters                → getMatterAnalysisData
 *   GET /api/dashboard/clients                → getClientIntelligenceData
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
  type DashboardFilters,
} from '../services/dashboard-service.js';

const BASE = '/api/dashboard';

function routeSegment(path: string): string {
  const clean = path.replace(/\/$/, '');
  const netlifyMatch = clean.match(/\/\.netlify\/functions\/dashboard\/?(.*)$/);
  if (netlifyMatch) return netlifyMatch[1] ?? '';
  if (clean.startsWith(BASE)) return clean.slice(BASE.length + 1);
  return '';
}

function parseFilters(qs: Record<string, string | undefined> | null): DashboardFilters {
  if (!qs) return {};
  const filters: DashboardFilters = {};
  if (qs['department'])  filters.department  = qs['department'] as string;
  if (qs['grade'])       filters.grade       = qs['grade'] as string;
  if (qs['payModel'])    filters.payModel    = qs['payModel'] as string;
  if (qs['activeOnly'])  filters.activeOnly  = qs['activeOnly'] === 'true';
  if (qs['feeEarner'])   filters.feeEarner   = qs['feeEarner'] as string;
  if (qs['caseType'])    filters.caseType    = qs['caseType'] as string;
  if (qs['status'])      filters.status      = qs['status'] as string;
  if (qs['lawyer'])      filters.lawyer      = qs['lawyer'] as string;
  if (qs['hasBudget'])   filters.hasBudget   = qs['hasBudget'] === 'true';
  if (qs['minValue'])    filters.minValue    = Number(qs['minValue']);
  if (qs['minMatters'])  filters.minMatters  = Number(qs['minMatters']);
  if (qs['minRevenue'])  filters.minRevenue  = Number(qs['minRevenue']);
  if (qs['groupBy'])     filters.groupBy     = qs['groupBy'] as DashboardFilters['groupBy'];
  if (qs['sortBy'])      filters.sortBy      = qs['sortBy'] as string;
  if (qs['sortDir'])     filters.sortDir     = qs['sortDir'] as 'asc' | 'desc';
  if (qs['limit'])       filters.limit       = Number(qs['limit']);
  if (qs['offset'])      filters.offset      = Number(qs['offset']);
  return filters;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const segment = routeSegment(event.path ?? '');
    const filters = parseFilters(event.queryStringParameters);

    switch (segment) {
      case 'firm-overview':
        return successResponse(await getFirmOverviewData(firmId));

      case 'fee-earner-performance':
        return successResponse(await getFeeEarnerPerformanceData(firmId, filters));

      case 'wip':
        return successResponse(await getWipData(firmId, filters));

      case 'billing':
        return successResponse(await getBillingCollectionsData(firmId, filters));

      case 'matters':
        return successResponse(await getMatterAnalysisData(firmId, filters));

      case 'clients':
        return successResponse(await getClientIntelligenceData(firmId, filters));

      default:
        return errorResponse('Not found', 404);
    }

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[dashboard]', err);
    return errorResponse('Internal server error', 500);
  }
};
