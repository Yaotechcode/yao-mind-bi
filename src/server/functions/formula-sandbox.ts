/**
 * formula-sandbox.ts — Netlify Function
 *
 * POST /api/formula-sandbox/run   → SandboxResult
 * POST /api/formula-sandbox/diff  → SandboxDiff
 * POST /api/formula-sandbox/batch → SandboxResult[]
 *
 * All routes are read-only: no data is persisted. Results are only returned
 * to the caller for preview — they do not affect live KPIs.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import { FormulaSandbox } from '../formula-engine/sandbox/formula-sandbox.js';
import type { CustomFormulaDefinition } from '../formula-engine/custom/custom-executor.js';
import type { FormulaDefinition } from '../../shared/types/index.js';
import type { SandboxResult } from '../formula-engine/sandbox/formula-sandbox.js';

// =============================================================================
// Route helpers
// =============================================================================

function getRoute(path: string): 'run' | 'diff' | 'batch' | null {
  const clean = path.replace(/\/$/, '');
  if (clean.endsWith('/run')) return 'run';
  if (clean.endsWith('/diff')) return 'diff';
  if (clean.endsWith('/batch')) return 'batch';
  return null;
}

// =============================================================================
// Handler
// =============================================================================

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Authenticate
  let firmId: string;
  try {
    ({ firmId } = await authenticateRequest(event));
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(err.message, err.statusCode);
    }
    return errorResponse('Authentication failed', 401);
  }

  // 2. Route
  const route = getRoute(event.path ?? '');
  if (!route) {
    return errorResponse('Not found', 404);
  }

  // 3. Parse body
  if (!event.body) {
    return errorResponse('Request body is required', 400);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body) as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const sandbox = new FormulaSandbox();

  // 4. Dispatch
  try {
    if (route === 'run') {
      return await handleRun(firmId, body, sandbox);
    }
    if (route === 'diff') {
      return await handleDiff(firmId, body, sandbox);
    }
    return await handleBatch(firmId, body, sandbox);
  } catch (err) {
    console.error('[formula-sandbox]', err);
    return errorResponse('Internal server error', 500, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};

// =============================================================================
// Route handlers
// =============================================================================

async function handleRun(
  firmId: string,
  body: Record<string, unknown>,
  sandbox: FormulaSandbox,
) {
  const { definition, entityType, resultType, variant } = body;

  if (!definition || typeof definition !== 'object') {
    return errorResponse('"definition" (object) is required', 400);
  }
  if (!entityType || typeof entityType !== 'string') {
    return errorResponse('"entityType" (string) is required', 400);
  }
  if (!resultType || typeof resultType !== 'string') {
    return errorResponse('"resultType" (string) is required', 400);
  }

  const result = await sandbox.dryRun(
    firmId,
    definition as CustomFormulaDefinition | FormulaDefinition,
    entityType,
    resultType,
    typeof variant === 'string' ? variant : undefined,
  );

  return successResponse(result);
}

async function handleDiff(
  firmId: string,
  body: Record<string, unknown>,
  sandbox: FormulaSandbox,
) {
  const { formulaId, sandboxResult } = body;

  if (!formulaId || typeof formulaId !== 'string') {
    return errorResponse('"formulaId" (string) is required', 400);
  }
  if (!sandboxResult || typeof sandboxResult !== 'object') {
    return errorResponse('"sandboxResult" (object) is required', 400);
  }

  const diff = await sandbox.diffWithLive(firmId, formulaId, sandboxResult as SandboxResult);

  return successResponse(diff);
}

async function handleBatch(
  firmId: string,
  body: Record<string, unknown>,
  sandbox: FormulaSandbox,
) {
  const { formulas } = body;

  if (!Array.isArray(formulas) || formulas.length === 0) {
    return errorResponse('"formulas" must be a non-empty array', 400);
  }

  for (let i = 0; i < formulas.length; i++) {
    const f = formulas[i] as Record<string, unknown>;
    if (!f.definition || typeof f.definition !== 'object') {
      return errorResponse(`formulas[${i}].definition is required`, 400);
    }
    if (!f.entityType || typeof f.entityType !== 'string') {
      return errorResponse(`formulas[${i}].entityType is required`, 400);
    }
    if (!f.resultType || typeof f.resultType !== 'string') {
      return errorResponse(`formulas[${i}].resultType is required`, 400);
    }
  }

  const results = await sandbox.dryRunBatch(
    firmId,
    (formulas as Record<string, unknown>[]).map((f) => ({
      definition: f.definition as CustomFormulaDefinition,
      entityType: f.entityType as string,
      resultType: f.resultType as string,
    })),
  );

  return successResponse(results);
}
