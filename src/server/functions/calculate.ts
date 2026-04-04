/**
 * calculate.ts — Netlify Function
 *
 * Bridges the gap between data upload (1B) and dashboard display (1E).
 * Triggers a full formula-engine recalculation and reports its status.
 *
 *   POST /api/calculate           → fire background calculation, return { status:'calculating' }
 *   POST /api/calculate/affected  → recalculate specific formulas
 *   GET  /api/calculate/status    → return current calculation status
 *
 * POST /api/calculate flow:
 *   1. Authenticate → firmId
 *   2. Check stale flag
 *   3. If not stale and force=false → return { status:'current', calculatedAt }
 *   4. Call setCalculationInProgress(firmId)
 *   5. Fire POST to run-calculations-background (fire-and-forget)
 *   6. Return { status:'calculating' } immediately
 *
 * The background function (run-calculations-background.ts) handles steps 5–8:
 *   5. Run CalculationOrchestrator.calculateAll(firmId)
 *   6. Create daily historical snapshot (at most once per UTC day)
 *   7. On error → call setCalculationError(firmId, message)
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
  setCalculationInProgress,
  setCalculationError,
  getTodayHistoricalSnapshot,
  createHistoricalSnapshot,
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
  const netlifyMatch = clean.match(/\/\.netlify\/functions\/calculate\/?(.*)$/);
  if (netlifyMatch) return netlifyMatch[1] ?? '';
  if (clean.startsWith(BASE)) return clean.slice(BASE.length + 1);
  return '';
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

    // Mark as calculating before running the orchestrator
    await setCalculationInProgress(firmId);

    // Test seam: in Vitest, run synchronously so tests can assert on the result
    if (process.env['VITEST']) {
      try {
        const orchestrator = new CalculationOrchestrator();
        const result = await orchestrator.calculateAll(firmId);

        // Daily historical snapshot (at most once per UTC day)
        const existing = await getTodayHistoricalSnapshot(firmId);
        if (!existing) {
          await createHistoricalSnapshot(firmId, 'daily', result as unknown as Record<string, unknown>);
        }

        const response: CompleteResponse = {
          status: 'complete',
          calculatedAt: result.calculatedAt,
          kpiSummary: {
            formulaCount: result.formulaCount,
            successCount: result.successCount,
            errorCount: result.errorCount,
            blockedCount: 0,
            totalExecutionTimeMs: result.totalExecutionTimeMs,
            ragSummaryGreen: ((result.ragSummary as unknown) as { green: number })?.green ?? 0,
            ragSummaryAmber: ((result.ragSummary as unknown) as { amber: number })?.amber ?? 0,
            ragSummaryRed:   ((result.ragSummary as unknown) as { red: number })?.red   ?? 0,
          },
        };
        return successResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await setCalculationError(firmId, message);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Calculation failed', details: { message } }),
        };
      }
    }

    // Production path: fire-and-forget background function — do NOT await
    const siteUrl = process.env['URL'] ?? 'http://localhost:8888';
    const bgUrl = `${siteUrl}/.netlify/functions/run-calculations-background`;
    const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';
    void fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret },
      body: JSON.stringify({ firmId }),
    }).catch((err: unknown) => {
      console.error('[calculate] failed to trigger background function', err);
    });

    return successResponse({ status: 'calculating' });

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[calculate]', err);
    return errorResponse('Internal server error', 500);
  }
};
