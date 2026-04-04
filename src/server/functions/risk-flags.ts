/**
 * risk-flags.ts — Netlify Function
 *
 * Serves risk flag data from the risk_flags MongoDB collection.
 * Requires partner role or above (owner | admin | partner | department_head).
 *
 *   GET /api/risk-flags
 *
 * Query parameters (all optional):
 *   severity   : high | medium | low
 *   entityType : any entity type string (e.g. feeEarner, matter)
 *   flagType   : WIP_AGE_HIGH | BUDGET_BURN_CRITICAL | DEBTOR_DAYS_HIGH |
 *                UTILISATION_DROP | DORMANT_MATTER | BAD_DEBT_RISK | WRITE_OFF_SPIKE
 *   limit      : integer, default 50
 *
 * Response:
 *   {
 *     firmId:      string,
 *     flaggedAt:   string | null,   // most recent flagged_at across all flags
 *     totalCount:  number,
 *     highCount:   number,
 *     mediumCount: number,
 *     lowCount:    number,
 *     flags:       RiskFlagDocument[]
 *   }
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getRiskFlags } from '../lib/mongodb-operations.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import type { RiskFlagDocument } from '../../shared/types/mongodb.js';

// ---------------------------------------------------------------------------
// Role guard
// ---------------------------------------------------------------------------

const PARTNER_AND_ABOVE = new Set(['owner', 'admin', 'partner', 'department_head']);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId, role } = await authenticateRequest(event);

    if (!PARTNER_AND_ABOVE.has(role)) {
      return errorResponse('Forbidden — partner role or above required', 403);
    }

    const qs = event.queryStringParameters ?? {};

    const severity  = qs['severity']   as RiskFlagDocument['severity'] | undefined;
    const entityType = qs['entityType'] as string | undefined;
    const flagType   = qs['flagType']   as RiskFlagDocument['flag_type'] | undefined;
    const limitRaw   = qs['limit'];
    const limit      = limitRaw ? Math.max(1, parseInt(limitRaw, 10)) : 50;

    // Validate severity if provided
    if (severity && !['high', 'medium', 'low'].includes(severity)) {
      return errorResponse(`Invalid severity '${severity}'. Must be high, medium, or low`, 400);
    }

    const flags = await getRiskFlags(firmId, {
      ...(severity   ? { severity }    : {}),
      ...(entityType ? { entity_type: entityType } : {}),
      ...(flagType   ? { flag_type: flagType }   : {}),
      limit,
    });

    // Derive summary counts from the returned flags
    const highCount   = flags.filter((f) => f.severity === 'high').length;
    const mediumCount = flags.filter((f) => f.severity === 'medium').length;
    const lowCount    = flags.filter((f) => f.severity === 'low').length;

    // Most recent flagged_at across all returned flags
    const latestFlag = flags.reduce<RiskFlagDocument | null>((acc, f) => {
      if (!acc) return f;
      return f.flagged_at > acc.flagged_at ? f : acc;
    }, null);
    const flaggedAt = latestFlag ? latestFlag.flagged_at.toISOString() : null;

    return successResponse({
      firmId,
      flaggedAt,
      totalCount: flags.length,
      highCount,
      mediumCount,
      lowCount,
      flags,
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[risk-flags]', err);
    return errorResponse('Internal server error', 500);
  }
};
