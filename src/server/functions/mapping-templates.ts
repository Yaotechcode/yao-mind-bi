/**
 * mapping-templates.ts — Netlify Function
 *
 * GET    /api/mapping-templates              → listMappingTemplates (optionally ?fileType=)
 * GET    /api/mapping-templates/:id          → getMappingTemplate
 * POST   /api/mapping-templates              → createMappingTemplate
 * PUT    /api/mapping-templates/:id          → updateMappingTemplate
 * DELETE /api/mapping-templates/:id          → deleteMappingTemplate
 *
 * All endpoints require a valid Supabase Bearer token and return data scoped
 * to the authenticated user's firm.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  listMappingTemplates,
  getMappingTemplate,
  createMappingTemplate,
  updateMappingTemplate,
  deleteMappingTemplate,
} from '../services/mapping-templates-service.js';

// ---------------------------------------------------------------------------
// Helper: extract :id from path  (e.g. /api/mapping-templates/abc123 → abc123)
// ---------------------------------------------------------------------------

function extractId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'mapping-templates' ? last : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    const path = event.path ?? '';
    const method = event.httpMethod;
    const qs = event.queryStringParameters ?? {};
    const templateId = extractId(path);

    // -----------------------------------------------------------------------
    // GET /api/mapping-templates
    // GET /api/mapping-templates/:id
    // -----------------------------------------------------------------------
    if (method === 'GET') {
      if (templateId) {
        const template = await getMappingTemplate(firmId, templateId);
        if (!template) {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: 'Template not found' }),
          };
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(template),
        };
      }

      const templates = await listMappingTemplates(firmId, qs['fileType'] ?? undefined);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(templates),
      };
    }

    // -----------------------------------------------------------------------
    // POST /api/mapping-templates
    // -----------------------------------------------------------------------
    if (method === 'POST') {
      if (!event.body) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      const { name, fileType, mappings, typeOverrides } = body as {
        name?: string;
        fileType?: string;
        mappings?: Record<string, string>;
        typeOverrides?: Record<string, string>;
      };

      if (!name || typeof name !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: '"name" is required' }) };
      }
      if (!fileType || typeof fileType !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: '"fileType" is required' }) };
      }
      if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
        return { statusCode: 400, body: JSON.stringify({ error: '"mappings" must be an object' }) };
      }

      const template = await createMappingTemplate(firmId, {
        name,
        fileType,
        mappings,
        typeOverrides,
      });

      return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(template),
      };
    }

    // -----------------------------------------------------------------------
    // PUT /api/mapping-templates/:id
    // -----------------------------------------------------------------------
    if (method === 'PUT') {
      if (!templateId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Template ID is required' }) };
      }
      if (!event.body) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      const { name, mappings, typeOverrides } = body as {
        name?: string;
        mappings?: Record<string, string>;
        typeOverrides?: Record<string, string>;
      };

      const template = await updateMappingTemplate(firmId, templateId, {
        name,
        mappings,
        typeOverrides,
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(template),
      };
    }

    // -----------------------------------------------------------------------
    // DELETE /api/mapping-templates/:id
    // -----------------------------------------------------------------------
    if (method === 'DELETE') {
      if (!templateId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Template ID is required' }) };
      }

      await deleteMappingTemplate(firmId, templateId);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    if (err instanceof AuthError) {
      return {
        statusCode: err.statusCode,
        body: JSON.stringify({ error: err.message }),
      };
    }

    console.error('[mapping-templates]', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
