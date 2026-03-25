/**
 * kpis.ts — Netlify Function
 *
 * Primary dashboard data endpoint. Serves formula results, RAG assignments,
 * readiness metadata, and stale status from the latest calculated_kpis document.
 *
 * Routes:
 *   GET /api/kpis                          → full formula result set
 *   GET /api/kpis/stale                    → stale flag status
 *   GET /api/kpis/rag-summary              → RAG counts + alert lists
 *   GET /api/kpis/readiness                → readiness for all formulas
 *   GET /api/kpis/formula/:formulaId       → results for a single formula
 *   GET /api/kpis/entity/:entityType/:id   → all KPI results for an entity
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getLatestCalculatedKpis,
  getRecalculationFlag,
} from '../lib/mongodb-operations.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';

// =============================================================================
// Path routing helpers
// =============================================================================

function parsePath(raw: string): string[] {
  // Normalise: strip leading /api/kpis, split remaining segments
  const base = raw.replace(/\/$/, '');
  const after = base.replace(/^.*\/kpis/, '');
  return after.split('/').filter(Boolean);
}

// =============================================================================
// Handler
// =============================================================================

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const segments = parsePath(event.path ?? '');

    // -------------------------------------------------------------------------
    // GET /api/kpis/stale
    // -------------------------------------------------------------------------
    if (segments[0] === 'stale') {
      const flag = await getRecalculationFlag(firmId);
      return successResponse({ isStale: flag?.is_stale ?? false });
    }

    // Load the KPI document (shared by all other routes)
    const [kpisDoc, flagDoc] = await Promise.all([
      getLatestCalculatedKpis(firmId),
      getRecalculationFlag(firmId),
    ]);

    const isStale = flagDoc?.is_stale ?? false;

    if (!kpisDoc) {
      return successResponse({
        calculatedAt: null,
        isStale,
        configVersion: null,
        dataVersion: null,
        formulaVersionSnapshot: null,
        results: {},
        ragAssignments: {},
        ragSummary: null,
        readiness: {},
      });
    }

    const kpis = kpisDoc.kpis as Record<string, unknown>;
    const formulaResults = (kpis['formulaResults'] ?? {}) as Record<string, unknown>;
    const ragAssignments = (kpis['ragAssignments'] ?? {}) as Record<string, unknown>;
    const ragSummary = kpis['ragSummary'] ?? null;
    const readiness = (kpis['readiness'] ?? {}) as Record<string, unknown>;
    const formulaVersionSnapshot = kpis['formulaVersionSnapshot'] ?? null;
    const calculationMetadata = kpis['calculationMetadata'] ?? null;

    const base = {
      calculatedAt: new Date(kpisDoc.calculated_at).toISOString(),
      isStale,
      configVersion: kpisDoc.config_version,
      dataVersion: kpisDoc.data_version,
    };

    // -------------------------------------------------------------------------
    // GET /api/kpis/rag-summary
    // -------------------------------------------------------------------------
    if (segments[0] === 'rag-summary') {
      return successResponse({ ...base, ragSummary });
    }

    // -------------------------------------------------------------------------
    // GET /api/kpis/readiness
    // -------------------------------------------------------------------------
    if (segments[0] === 'readiness') {
      return successResponse({ ...base, readiness });
    }

    // -------------------------------------------------------------------------
    // GET /api/kpis/formula/:formulaId
    // -------------------------------------------------------------------------
    if (segments[0] === 'formula' && segments[1]) {
      const formulaId = segments[1];
      const formulaResult = (formulaResults as Record<string, unknown>)[formulaId] ?? null;
      const formulaRag = (ragAssignments as Record<string, unknown>)[formulaId] ?? null;
      const formulaReadiness = (readiness as Record<string, unknown>)[formulaId] ?? null;

      if (!formulaResult) {
        return errorResponse(`Formula '${formulaId}' not found in latest calculation`, 404);
      }

      return successResponse({
        ...base,
        formulaId,
        result: formulaResult,
        ragAssignments: formulaRag,
        readiness: formulaReadiness,
      });
    }

    // -------------------------------------------------------------------------
    // GET /api/kpis/entity/:entityType/:entityId
    // -------------------------------------------------------------------------
    if (segments[0] === 'entity' && segments[1] && segments[2]) {
      const entityId = segments[2];

      // Collect all formula results for this entity
      const entityKpis: Record<string, unknown> = {};
      const entityRag: Record<string, unknown> = {};

      for (const [formulaId, result] of Object.entries(formulaResults)) {
        const r = result as Record<string, unknown>;
        const entityResults = r['entityResults'] as Record<string, unknown> | undefined;
        if (entityResults && entityResults[entityId] !== undefined) {
          entityKpis[formulaId] = entityResults[entityId];
        }
      }

      for (const [formulaId, assignments] of Object.entries(ragAssignments)) {
        const a = assignments as Record<string, unknown>;
        if (a[entityId] !== undefined) {
          entityRag[formulaId] = a[entityId];
        }
      }

      return successResponse({
        ...base,
        entityId,
        kpis: entityKpis,
        ragAssignments: entityRag,
      });
    }

    // -------------------------------------------------------------------------
    // GET /api/kpis  — full result set
    // -------------------------------------------------------------------------
    return successResponse({
      ...base,
      formulaVersionSnapshot,
      results: formulaResults,
      ragAssignments,
      ragSummary,
      readiness,
      calculationMetadata,
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[kpis]', err);
    return errorResponse('Internal server error', 500);
  }
};
