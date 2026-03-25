/**
 * calculate.ts — Netlify Function
 *
 * Bridges the gap between data upload (1B) and dashboard display (1E).
 * Triggers a full formula-engine recalculation and reports its status.
 *
 *   POST /api/calculate           → run (or skip if current + force=false)
 *   POST /api/calculate/affected  → recalculate specific formulas
 *   GET  /api/calculate/status    → return current calculation status
 *
 * POST /api/calculate flow:
 *   1. Authenticate → firmId
 *   2. Check stale flag
 *   3. If not stale and force=false → return { status:'current', calculatedAt }
 *   4. Set is_calculating flag
 *   5. Run CalculationOrchestrator.calculateAll(firmId)
 *   6. Create daily historical snapshot (at most once per UTC day)
 *   7. Return { status:'complete', calculatedAt, kpiSummary }
 *   8. On error → record last_error, return 500
 *
 * GET /api/calculate/status derives status from recalculation_flags:
 *   is_calculating = true          → 'calculating'
 *   is_stale = true, last_error    → 'error'
 *   is_stale = true                → 'stale'
 *   is_stale = false (or no doc)   → 'current'
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { CalculationOrchestrator } from '../formula-engine/orchestrator.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import {
  getRecalculationFlag,
  getLatestCalculatedKpis,
  createHistoricalSnapshot,
  getTodayHistoricalSnapshot,
  setCalculationInProgress,
  setCalculationError,
} from '../lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalculationStatus = 'current' | 'stale' | 'calculating' | 'error';

interface StatusResponse {
  status: CalculationStatus;
  lastCalculatedAt: string | null;
  staleSince: string | null;
  error: string | null;
}

interface CompleteResponse {
  status: 'complete' | 'current';
  calculatedAt: string | null;
  kpiSummary: {
    formulaCount: number;
    successCount: number;
    errorCount: number;
    blockedCount: number;
    totalExecutionTimeMs: number;
    ragSummaryGreen: number;
    ragSummaryAmber: number;
    ragSummaryRed: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

const BASE = '/api/calculate';

function segment(path: string): string {
  const clean = path.replace(/\/$/, '');
  return clean.startsWith(BASE) ? clean.slice(BASE.length + 1) : '';
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

function deriveStatus(
  isCalculating: boolean,
  isStale: boolean,
  lastError: string | null | undefined,
): CalculationStatus {
  if (isCalculating)        return 'calculating';
  if (isStale && lastError) return 'error';
  if (isStale)              return 'stale';
  return 'current';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);
    const path = event.path ?? '';
    const seg  = segment(path);
    const method = event.httpMethod;

    // -----------------------------------------------------------------------
    // GET /api/calculate/status
    // -----------------------------------------------------------------------
    if (method === 'GET' && seg === 'status') {
      const [flagDoc, kpisDoc] = await Promise.all([
        getRecalculationFlag(firmId),
        getLatestCalculatedKpis(firmId),
      ]);

      const isCalculating = flagDoc?.is_calculating ?? false;
      const isStale       = flagDoc?.is_stale ?? false;
      const lastError     = flagDoc?.last_error ?? null;
      const staleSince    = flagDoc?.is_stale
        ? new Date(flagDoc.stale_since).toISOString()
        : null;
      const lastCalcAt = kpisDoc
        ? new Date(kpisDoc.calculated_at).toISOString()
        : null;

      const response: StatusResponse = {
        status: deriveStatus(isCalculating, isStale, lastError),
        lastCalculatedAt: lastCalcAt,
        staleSince,
        error: lastError,
      };
      return successResponse(response);
    }

    if (method !== 'POST') {
      return errorResponse('Method not allowed', 405);
    }

    // -----------------------------------------------------------------------
    // POST /api/calculate/affected
    // -----------------------------------------------------------------------
    if (seg === 'affected') {
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

      const orchestrator = new CalculationOrchestrator();
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

    // -----------------------------------------------------------------------
    // POST /api/calculate
    // -----------------------------------------------------------------------
    if (seg !== '') {
      return errorResponse('Not found', 404);
    }

    // Parse force flag from body or query string
    let force = false;
    if (event.queryStringParameters?.['force'] === 'true') force = true;
    if (event.body) {
      try {
        const body = JSON.parse(event.body) as Record<string, unknown>;
        if (body['force'] === true) force = true;
      } catch {
        // ignore — force remains false
      }
    }

    // Check stale flag
    const flagDoc = await getRecalculationFlag(firmId);
    const isStale = flagDoc?.is_stale ?? false;

    // If current and not forced, return cached state
    if (!isStale && !force) {
      const kpisDoc = await getLatestCalculatedKpis(firmId);
      const response: CompleteResponse = {
        status: 'current',
        calculatedAt: kpisDoc ? new Date(kpisDoc.calculated_at).toISOString() : null,
        kpiSummary: null,
      };
      return successResponse(response);
    }

    // Mark as calculating
    await setCalculationInProgress(firmId);

    try {
      const orchestrator = new CalculationOrchestrator();
      const result = await orchestrator.calculateAll(firmId);

      // Create daily historical snapshot if none exists for today
      const existingSnapshot = await getTodayHistoricalSnapshot(firmId);
      if (!existingSnapshot) {
        const ragSummary = result.ragSummary as Record<string, unknown>;
        await createHistoricalSnapshot(firmId, 'daily', {
          firmId,
          calculatedAt:  result.calculatedAt,
          dataVersion:   result.dataVersion,
          configVersion: result.configVersion,
          formulaCount:  result.formulaCount,
          successCount:  result.successCount,
          errorCount:    result.errorCount,
          ragSummary:    ragSummary ?? {},
        });
      }

      const rag = result.ragSummary as { green?: number; amber?: number; red?: number } | undefined;

      const response: CompleteResponse = {
        status: 'complete',
        calculatedAt: result.calculatedAt,
        kpiSummary: {
          formulaCount:         result.formulaCount,
          successCount:         result.successCount,
          errorCount:           result.errorCount,
          blockedCount:         result.executionPlan.skippedFormulas.length,
          totalExecutionTimeMs: result.totalExecutionTimeMs,
          ragSummaryGreen:      rag?.green ?? 0,
          ragSummaryAmber:      rag?.amber ?? 0,
          ragSummaryRed:        rag?.red ?? 0,
        },
      };
      return successResponse(response);

    } catch (calcErr) {
      const errMsg = calcErr instanceof Error ? calcErr.message : String(calcErr);
      await setCalculationError(firmId, errMsg);
      console.error('[calculate] Calculation failed:', calcErr);
      return errorResponse('Calculation failed', 500, { message: errMsg });
    }

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[calculate]', err);
    return errorResponse('Internal server error', 500);
  }
};
