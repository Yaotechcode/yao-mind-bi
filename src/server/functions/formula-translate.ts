/**
 * formula-translate.ts — Netlify Function
 * POST /api/formula-translate
 *
 * Translates a natural language formula description into a structured
 * CustomFormulaDefinition using the Anthropic API.
 *
 * Request body: { description: string }
 * Response: TranslationResult
 *
 * Rate limited to 10 translations per minute per firm.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getFirmConfig } from '../services/config-service.js';
import { successResponse, errorResponse } from '../lib/response-helpers.js';
import { FormulaTranslator, AnthropicTranslationClient } from '../formula-engine/ai/formula-translator.js';
import { TranslationRateLimiter } from '../formula-engine/ai/rate-limiter.js';
import type { EntityDefinition } from '../../shared/types/index.js';

// =============================================================================
// Module-level rate limiter (shared across invocations in warm instances)
// =============================================================================

const rateLimiter = new TranslationRateLimiter(10, 60_000);

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

  // 2. Rate limit check
  const rateCheck = rateLimiter.check(firmId);
  if (!rateCheck.allowed) {
    const retrySeconds = Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000);
    return {
      statusCode: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retrySeconds),
      },
      body: JSON.stringify({
        error: 'Rate limit exceeded — maximum 10 formula translations per minute.',
        retryAfterSeconds: retrySeconds,
      }),
    };
  }

  // 3. Parse body
  if (!event.body) {
    return errorResponse('Request body is required', 400);
  }
  let body: { description?: unknown };
  try {
    body = JSON.parse(event.body) as { description?: unknown };
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { description } = body;
  if (!description || typeof description !== 'string') {
    return errorResponse('"description" (string) is required', 400);
  }

  // 4. Load firm config (entity registry, formula registry, snippet registry)
  let firmConfig;
  try {
    firmConfig = await getFirmConfig(firmId);
  } catch (err) {
    return errorResponse('Failed to load firm configuration', 500, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const entityRegistry = firmConfig.entityDefinitions
    ? Object.values(firmConfig.entityDefinitions).filter((d): d is EntityDefinition => d != null)
    : [];
  const formulaRegistry = firmConfig.formulas ?? [];
  const snippetRegistry = firmConfig.snippets ?? [];

  // 5. Build translator with production Anthropic client
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return errorResponse('Anthropic API key not configured', 500);
  }

  const translator = new FormulaTranslator(new AnthropicTranslationClient(apiKey));

  // 6. Record rate limit usage (do this before the async call so the window is tracked)
  rateLimiter.record(firmId);

  // 7. Translate
  let result;
  try {
    result = await translator.translateToFormula(
      description,
      entityRegistry,
      formulaRegistry,
      snippetRegistry,
    );
  } catch (err) {
    return errorResponse('Translation failed', 500, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return successResponse(result);
};
