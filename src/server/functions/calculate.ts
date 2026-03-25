/**
 * calculate.ts — Netlify Function
 *
 * Triggers the formula engine calculation for a firm.
 *
 * Routes:
 *   POST /api/calculate           → run calculateAll (full recalculation)
 *   POST /api/calculate/affected  → run recalculateAffected for specific formulas
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { CalculationOrchestrator } from '../formula-engine/orchestrator.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';

function isAffectedPath(path: string): boolean {
  return path.replace(/\/$/, '').endsWith('/affected');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const orchestrator = new CalculationOrchestrator();

    // -------------------------------------------------------------------------
    // POST /api/calculate/affected
    // -------------------------------------------------------------------------
    if (isAffectedPath(event.path ?? '')) {
      let changedFormulaIds: string[] = [];
      if (event.body) {
        try {
          const body = JSON.parse(event.body) as Record<string, unknown>;
          if (Array.isArray(body['changedFormulaIds'])) {
            changedFormulaIds = body['changedFormulaIds'] as string[];
          }
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
      }

      const result = await orchestrator.recalculateAffected(firmId, changedFormulaIds);
      return successResponse({
        calculatedAt: result.calculatedAt,
        formulaCount: result.formulaCount,
        successCount: result.successCount,
        errorCount: result.errorCount,
        errors: result.errors,
        totalExecutionTimeMs: result.totalExecutionTimeMs,
      });
    }

    // -------------------------------------------------------------------------
    // POST /api/calculate
    // -------------------------------------------------------------------------
    const result = await orchestrator.calculateAll(firmId);
    return successResponse({
      calculatedAt: result.calculatedAt,
      formulaCount: result.formulaCount,
      successCount: result.successCount,
      errorCount: result.errorCount,
      errors: result.errors,
      totalExecutionTimeMs: result.totalExecutionTimeMs,
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[calculate]', err);
    return errorResponse('Internal server error', 500);
  }
};
