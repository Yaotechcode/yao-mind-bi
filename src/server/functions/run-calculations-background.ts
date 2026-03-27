/**
 * run-calculations-background.ts — Netlify Background Function
 * POST /.netlify/functions/run-calculations-background
 *
 * Triggered by calculate.ts after setCalculationInProgress() is called.
 * Runs the full formula-engine calculation pipeline and creates the daily
 * historical snapshot if one does not yet exist for today.
 *
 * Background functions have up to 15 minutes to complete. The HTTP response
 * is not read by the caller — it fires and forgets.
 *
 * Authentication: shared secret via x-internal-secret header.
 */

import type { Handler } from '@netlify/functions';
import { CalculationOrchestrator } from '../formula-engine/orchestrator.js';
import {
  setCalculationError,
  createHistoricalSnapshot,
  getTodayHistoricalSnapshot,
} from '../lib/mongodb-operations.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify internal shared secret
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';
  const provided = event.headers['x-internal-secret'] ?? '';
  if (!internalSecret || provided !== internalSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let firmId: string | undefined;
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    firmId = typeof body['firmId'] === 'string' ? body['firmId'] : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!firmId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'firmId is required' }) };
  }

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

    console.log(
      `[run-calculations-background] firmId=${firmId}`,
      `formulas=${result.formulaCount}`,
      `success=${result.successCount}`,
      `errors=${result.errorCount}`,
      `duration=${result.totalExecutionTimeMs}ms`,
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, firmId, formulaCount: result.formulaCount }),
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[run-calculations-background] calculation error', { firmId, err });

    try {
      await setCalculationError(firmId, errMsg);
    } catch (flagErr) {
      console.error('[run-calculations-background] failed to set error flag', flagErr);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Calculation failed', message: errMsg }),
    };
  }
};
