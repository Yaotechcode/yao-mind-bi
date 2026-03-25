/**
 * formula-intelligence.ts — Netlify Function
 *
 * Formula Intelligence API — readiness, versions, templates, AI translation,
 * sandbox, and formula CRUD.
 *
 * Routes:
 *   GET    /api/formulas                             → list all formulas for firm
 *   POST   /api/formulas                             → create custom formula
 *   GET    /api/formulas/readiness                   → readiness for all formulas
 *   GET    /api/formulas/readiness/:formulaId        → readiness for one formula
 *   GET    /api/formulas/versions/:formulaId         → version history
 *   GET    /api/formulas/versions/:formulaId/diff    → version diff (?from=N&to=M)
 *   GET    /api/formulas/version-snapshot            → current version snapshot
 *   GET    /api/formulas/templates                   → list templates
 *   GET    /api/formulas/templates/:id               → get template
 *   POST   /api/formulas/templates/:id/preview       → preview template with params
 *   POST   /api/formulas/templates/:id/instantiate   → instantiate template
 *   POST   /api/formulas/translate                   → AI translate to formula
 *   POST   /api/formulas/sandbox/run                 → dry run sandbox
 *   POST   /api/formulas/sandbox/diff                → diff sandbox vs live
 *   GET    /api/formulas/:formulaId                  → get formula
 *   PUT    /api/formulas/:formulaId                  → update formula (built-ins blocked)
 *   DELETE /api/formulas/:formulaId                  → delete formula (built-ins blocked)
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import { db } from '../lib/supabase.js';
import { getLatestCalculatedKpis, getLatestEnrichedEntities } from '../lib/mongodb-operations.js';
import { FormulaVersionManager } from '../formula-engine/version-manager.js';
import { FormulaTemplateService } from '../formula-engine/templates/template-registry.js';
import { getBuiltInTemplates } from '../formula-engine/templates/built-in-templates.js';
import { FormulaTranslator, AnthropicTranslationClient } from '../formula-engine/ai/formula-translator.js';
import { FormulaSandbox } from '../formula-engine/sandbox/formula-sandbox.js';
import { TranslationRateLimiter } from '../formula-engine/ai/rate-limiter.js';
import {
  checkAllReadiness,
  checkSingleReadiness,
  deriveConfigPaths,
} from '../formula-engine/readiness-checker.js';
import { getBuiltInFormulaDefinitions } from '../../shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../../shared/formulas/built-in-snippets.js';
import { getFirmConfig } from '../services/config-service.js';

// ---------------------------------------------------------------------------
// Module-level singletons (survive warm re-uses, reset on cold start)
// ---------------------------------------------------------------------------

const rateLimiter = new TranslationRateLimiter();

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

const BASE = '/api/formulas';

/** Strip the /api/formulas prefix and trailing slash; return the rest. */
function routeRest(path: string): string {
  const clean = path.replace(/\/$/, '');
  return clean.startsWith(BASE) ? clean.slice(BASE.length) : '';
}

function parseBody(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entity-type availability map (for readiness checker)
// ---------------------------------------------------------------------------

async function buildEntityTypes(firmId: string) {
  const [kpisDoc, timeEntryDoc, invoiceDoc, disbursementDoc] = await Promise.all([
    getLatestCalculatedKpis(firmId),
    getLatestEnrichedEntities(firmId, 'timeEntry'),
    getLatestEnrichedEntities(firmId, 'invoice'),
    getLatestEnrichedEntities(firmId, 'disbursement'),
  ]);

  const aggregate = kpisDoc?.kpis?.['aggregate'] as Record<string, unknown> | undefined;
  const feeEarners = (aggregate?.feeEarners as unknown[] | undefined) ?? [];
  const matters    = (aggregate?.matters    as unknown[] | undefined) ?? [];
  const clients    = (aggregate?.clients    as unknown[] | undefined) ?? [];
  const departments = (aggregate?.departments as unknown[] | undefined) ?? [];

  const timeEntryCount    = ((timeEntryDoc?.records    as unknown[] | undefined) ?? []).length;
  const invoiceCount      = ((invoiceDoc?.records      as unknown[] | undefined) ?? []).length;
  const disbursementCount = ((disbursementDoc?.records as unknown[] | undefined) ?? []).length;

  return {
    feeEarner:    { present: feeEarners.length > 0,    recordCount: feeEarners.length },
    matter:       { present: matters.length > 0,       recordCount: matters.length },
    timeEntry:    { present: timeEntryCount > 0,       recordCount: timeEntryCount },
    invoice:      { present: invoiceCount > 0,         recordCount: invoiceCount },
    disbursement: { present: disbursementCount > 0,    recordCount: disbursementCount },
    department:   { present: departments.length > 0,   recordCount: departments.length },
    client:       { present: clients.length > 0,       recordCount: clients.length },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  try {
    const { firmId, userId } = await authenticateRequest(event);
    const rest   = routeRest(event.path ?? '');
    const method = event.httpMethod;

    // -----------------------------------------------------------------------
    // GET /api/formulas/readiness
    // -----------------------------------------------------------------------
    if (rest === '/readiness' && method === 'GET') {
      const [firmConfig, entityTypes] = await Promise.all([
        getFirmConfig(firmId),
        buildEntityTypes(firmId),
      ]);
      const configPaths = deriveConfigPaths(firmConfig);
      const formulas  = getBuiltInFormulaDefinitions();
      const snippets  = getBuiltInSnippetDefinitions();
      const readiness = checkAllReadiness(
        formulas, snippets, { entityTypes, configPaths }, firmConfig,
      );
      return successResponse({ readiness });
    }

    // -----------------------------------------------------------------------
    // GET /api/formulas/readiness/:formulaId
    // -----------------------------------------------------------------------
    const readinessOneMatch = rest.match(/^\/readiness\/(.+)$/);
    if (readinessOneMatch && method === 'GET') {
      const formulaId = readinessOneMatch[1];
      const [firmConfig, entityTypes] = await Promise.all([
        getFirmConfig(firmId),
        buildEntityTypes(firmId),
      ]);
      const configPaths = deriveConfigPaths(firmConfig);
      const result = checkSingleReadiness(formulaId, { entityTypes, configPaths }, firmConfig);
      return successResponse({ formulaId, readiness: result });
    }

    // -----------------------------------------------------------------------
    // GET /api/formulas/versions/:formulaId/diff?from=N&to=M
    // -----------------------------------------------------------------------
    const diffMatch = rest.match(/^\/versions\/([^/]+)\/diff$/);
    if (diffMatch && method === 'GET') {
      const formulaId = diffMatch[1];
      const from = Number(event.queryStringParameters?.from);
      const to   = Number(event.queryStringParameters?.to);
      if (!from || !to || isNaN(from) || isNaN(to)) {
        return errorResponse('Query params from and to (version numbers) are required', 400);
      }
      const versionManager = new FormulaVersionManager();
      try {
        const diff = await versionManager.diffVersions(firmId, formulaId, from, to);
        return successResponse({ diff });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Diff failed', 404);
      }
    }

    // -----------------------------------------------------------------------
    // GET /api/formulas/versions/:formulaId
    // -----------------------------------------------------------------------
    const versionsMatch = rest.match(/^\/versions\/([^/]+)$/);
    if (versionsMatch && method === 'GET') {
      const formulaId = versionsMatch[1];
      const versionManager = new FormulaVersionManager();
      const versions = await versionManager.getVersionHistory(firmId, formulaId);
      return successResponse({ formulaId, versions });
    }

    // -----------------------------------------------------------------------
    // GET /api/formulas/version-snapshot
    // -----------------------------------------------------------------------
    if (rest === '/version-snapshot' && method === 'GET') {
      const versionManager = new FormulaVersionManager();
      const formulaIds = [
        ...getBuiltInFormulaDefinitions().map((f) => f.formulaId),
        ...getBuiltInSnippetDefinitions().map((s) => s.snippetId),
      ];
      const snapshot = await versionManager.createFormulaVersionSnapshot(firmId, formulaIds);
      return successResponse({ snapshot });
    }

    // -----------------------------------------------------------------------
    // Template routes
    // -----------------------------------------------------------------------
    const templateService = new FormulaTemplateService(getBuiltInTemplates());

    if (rest === '/templates' && method === 'GET') {
      const templates = await templateService.getAvailableTemplates(firmId);
      return successResponse({ templates });
    }

    const templatePreviewMatch = rest.match(/^\/templates\/([^/]+)\/preview$/);
    if (templatePreviewMatch && method === 'POST') {
      const templateId  = templatePreviewMatch[1];
      const body        = parseBody(event.body);
      const parameters  = (body?.parameters as Record<string, unknown>) ?? {};
      try {
        const preview = await templateService.previewTemplate(templateId, parameters);
        return successResponse({ templateId, preview });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Preview failed', 400);
      }
    }

    const templateInstantiateMatch = rest.match(/^\/templates\/([^/]+)\/instantiate$/);
    if (templateInstantiateMatch && method === 'POST') {
      const templateId = templateInstantiateMatch[1];
      const body       = parseBody(event.body);
      const parameters = (body?.parameters as Record<string, unknown>) ?? {};
      const options    = body?.options as Record<string, unknown> | undefined;
      try {
        const formula = await templateService.instantiateTemplate(firmId, templateId, parameters, {
          customName: options?.customName as string | undefined,
          userId,
          idPrefix: options?.idPrefix as string | undefined,
        });
        return successResponse({ templateId, formula });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Instantiation failed', 400);
      }
    }

    const templateGetMatch = rest.match(/^\/templates\/([^/]+)$/);
    if (templateGetMatch && method === 'GET') {
      const templateId = templateGetMatch[1];
      const template   = await templateService.getTemplate(templateId);
      if (!template) return errorResponse('Template not found', 404);
      return successResponse({ template });
    }

    // -----------------------------------------------------------------------
    // POST /api/formulas/translate
    // -----------------------------------------------------------------------
    if (rest === '/translate' && method === 'POST') {
      const body        = parseBody(event.body);
      const description = body?.description as string | undefined;
      if (!description) return errorResponse('description is required', 400);

      const limitResult = rateLimiter.check(firmId);
      if (!limitResult.allowed) {
        return errorResponse(
          `Rate limit exceeded — retry after ${Math.ceil((limitResult.retryAfterMs ?? 60_000) / 1000)}s`,
          429,
        );
      }

      const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
      if (!apiKey) return errorResponse('AI translation not configured on this server', 503);

      rateLimiter.record(firmId);

      const translator  = new FormulaTranslator(new AnthropicTranslationClient(apiKey));
      const firmConfig  = await getFirmConfig(firmId);
      const entityDefs  = firmConfig.entityDefinitions
        ? Object.values(firmConfig.entityDefinitions)
        : [];

      const result = await translator.translateToFormula(
        description,
        entityDefs,
        firmConfig.formulas ?? [],
        firmConfig.snippets ?? [],
      );
      return successResponse({ result });
    }

    // -----------------------------------------------------------------------
    // POST /api/formulas/sandbox/run
    // -----------------------------------------------------------------------
    if (rest === '/sandbox/run' && method === 'POST') {
      const body = parseBody(event.body);
      if (!body?.formulaDefinition) return errorResponse('formulaDefinition is required', 400);
      const sandbox = new FormulaSandbox();
      const result  = await sandbox.dryRun(
        firmId,
        body.formulaDefinition as never,
        (body.entityType as string | undefined) ?? 'feeEarner',
        (body.resultType as string | undefined) ?? 'percentage',
        body.variant as string | undefined,
      );
      return successResponse({ result });
    }

    // -----------------------------------------------------------------------
    // POST /api/formulas/sandbox/diff
    // -----------------------------------------------------------------------
    if (rest === '/sandbox/diff' && method === 'POST') {
      const body = parseBody(event.body);
      if (!body?.formulaId || !body?.sandboxResult) {
        return errorResponse('formulaId and sandboxResult are required', 400);
      }
      const sandbox = new FormulaSandbox();
      const diff    = await sandbox.diffWithLive(
        firmId,
        body.formulaId as string,
        body.sandboxResult as never,
      );
      return successResponse({ diff });
    }

    // -----------------------------------------------------------------------
    // Formula CRUD: GET/POST /api/formulas
    // -----------------------------------------------------------------------
    if (rest === '' || rest === '/') {
      if (method === 'GET') {
        const { data, error } = await db.server
          .from('formula_registry')
          .select('*')
          .eq('firm_id', firmId)
          .order('created_at', { ascending: true });

        if (error) return errorResponse('Failed to load formulas', 500);
        return successResponse({ formulas: data ?? [] });
      }

      if (method === 'POST') {
        const body = parseBody(event.body);
        if (!body) return errorResponse('Request body is required', 400);

        const formulaId = body.formulaId as string | undefined;
        const name      = body.name as string | undefined;
        if (!formulaId || !name) return errorResponse('formulaId and name are required', 400);

        const { data, error } = await db.server
          .from('formula_registry')
          .insert({
            firm_id:       firmId,
            formula_id:    formulaId,
            formula_type:  'custom',
            name,
            description:   (body.description as string | undefined) ?? null,
            category:      (body.category    as string | undefined) ?? null,
            entity_type:   (body.entityType  as string | undefined) ?? 'feeEarner',
            result_type:   (body.resultType  as string | undefined) ?? 'number',
            definition:    body.definition    ?? {},
            active_variant:(body.activeVariant as string | undefined) ?? null,
            variants:      body.variants       ?? null,
            modifiers:     body.modifiers      ?? [],
            depends_on:    body.dependsOn      ?? [],
            display_config:body.displayConfig  ?? null,
            is_active:     true,
          })
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            return errorResponse('A formula with this ID already exists for this firm', 409);
          }
          return errorResponse('Failed to create formula', 500);
        }
        return successResponse({ formula: data }, 201);
      }

      return errorResponse('Method not allowed', 405);
    }

    // -----------------------------------------------------------------------
    // Formula CRUD: GET/PUT/DELETE /api/formulas/:formulaId
    // -----------------------------------------------------------------------
    const formulaMatch = rest.match(/^\/([^/]+)$/);
    if (formulaMatch) {
      const formulaId = formulaMatch[1];

      if (method === 'GET') {
        const { data, error } = await db.server
          .from('formula_registry')
          .select('*')
          .eq('firm_id', firmId)
          .eq('formula_id', formulaId)
          .single();

        if (error || !data) return errorResponse('Formula not found', 404);
        return successResponse({ formula: data });
      }

      if (method === 'PUT') {
        const { data: existing, error: fetchErr } = await db.server
          .from('formula_registry')
          .select('formula_type')
          .eq('firm_id', firmId)
          .eq('formula_id', formulaId)
          .single();

        if (fetchErr || !existing) return errorResponse('Formula not found', 404);
        if ((existing as { formula_type: string }).formula_type === 'built_in') {
          return errorResponse('Built-in formulas cannot be modified', 403);
        }

        const body = parseBody(event.body);
        if (!body) return errorResponse('Request body is required', 400);

        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.name        !== undefined) updates['name']          = body.name;
        if (body.description !== undefined) updates['description']   = body.description;
        if (body.definition  !== undefined) updates['definition']    = body.definition;
        if (body.activeVariant !== undefined) updates['active_variant'] = body.activeVariant;
        if (body.variants    !== undefined) updates['variants']      = body.variants;
        if (body.modifiers   !== undefined) updates['modifiers']     = body.modifiers;
        if (body.dependsOn   !== undefined) updates['depends_on']    = body.dependsOn;
        if (body.isActive    !== undefined) updates['is_active']     = body.isActive;

        const { data, error } = await db.server
          .from('formula_registry')
          .update(updates)
          .eq('firm_id', firmId)
          .eq('formula_id', formulaId)
          .select()
          .single();

        if (error) return errorResponse('Failed to update formula', 500);
        return successResponse({ formula: data });
      }

      if (method === 'DELETE') {
        const { data: existing, error: fetchErr } = await db.server
          .from('formula_registry')
          .select('formula_type')
          .eq('firm_id', firmId)
          .eq('formula_id', formulaId)
          .single();

        if (fetchErr || !existing) return errorResponse('Formula not found', 404);
        if ((existing as { formula_type: string }).formula_type === 'built_in') {
          return errorResponse('Built-in formulas cannot be deleted', 403);
        }

        const { error } = await db.server
          .from('formula_registry')
          .delete()
          .eq('firm_id', firmId)
          .eq('formula_id', formulaId);

        if (error) return errorResponse('Failed to delete formula', 500);
        return successResponse({ deleted: true, formulaId });
      }

      return errorResponse('Method not allowed', 405);
    }

    return errorResponse('Not found', 404);

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[formula-intelligence]', err);
    return errorResponse('Internal server error', 500);
  }
};
