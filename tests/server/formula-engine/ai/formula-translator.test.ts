/**
 * formula-translator.test.ts — Tests for FormulaTranslator
 *
 * All Anthropic API calls are mocked via a deterministic TranslationApiClient
 * implementation — no network access required.
 *
 * Covers:
 * - buildTranslationSystemPrompt includes entity fields and formula names
 * - Successful translation: valid AI response → populated TranslationResult
 * - Invalid JSON response → graceful error
 * - JSON embedded in markdown code block → extracted correctly
 * - Valid structure but expression error → warnings included, success: false
 * - Short description → immediate error (no API call)
 * - API client throws → error propagated gracefully
 * - Low-confidence response → warning added
 * - Rate limiter: allows up to max requests, then blocks
 * - Rate limiter: window resets after windowMs
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FormulaTranslator,
  buildTranslationSystemPrompt,
} from '../../../../src/server/formula-engine/ai/formula-translator.js';
import type { TranslationApiClient } from '../../../../src/server/formula-engine/ai/formula-translator.js';
import { TranslationRateLimiter } from '../../../../src/server/formula-engine/ai/rate-limiter.js';
import type { EntityDefinition, FormulaDefinition, SnippetDefinition } from '../../../../src/shared/types/index.js';
import { EntityType, FieldType, MissingBehaviour } from '../../../../src/shared/types/index.js';

// =============================================================================
// Fixtures
// =============================================================================

const ENTITY_REGISTRY: EntityDefinition[] = [
  {
    entityType: EntityType.FEE_EARNER,
    label: 'Fee Earner',
    labelPlural: 'Fee Earners',
    primaryKey: 'lawyerId',
    displayField: 'lawyerName',
    supportsCustomFields: false,
    fields: [
      { key: 'lawyerName', label: 'Name', type: FieldType.STRING, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
      { key: 'invoicedRevenue', label: 'Invoiced Revenue', type: FieldType.CURRENCY, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
      { key: 'wipChargeableHours', label: 'Chargeable Hours', type: FieldType.NUMBER, required: false, builtIn: true, missingBehaviour: MissingBehaviour.USE_DEFAULT },
    ],
    relationships: [],
  } as EntityDefinition,
];

const FORMULA_REGISTRY: FormulaDefinition[] = [
  { id: 'F-TU-01', label: 'Chargeable Utilisation Rate', description: 'Chargeable hours as % of available hours', type: 'built_in' as any, outputType: FieldType.PERCENTAGE, appliesTo: [EntityType.FEE_EARNER], variants: [] },
  { id: 'F-RB-01', label: 'Realisation Rate', description: 'Invoiced revenue vs WIP billable value', type: 'built_in' as any, outputType: FieldType.PERCENTAGE, appliesTo: [EntityType.FEE_EARNER], variants: [] },
];

const SNIPPET_REGISTRY: SnippetDefinition[] = [
  { id: 'SN-002', label: 'Available Working Hours', description: 'Annual available working hours per fee earner', expression: '', dependencies: [], outputType: FieldType.NUMBER, createdBy: 'system', createdAt: new Date(), updatedAt: new Date() },
];

/** Valid AI response for "revenue per chargeable hour" */
const VALID_AI_RESPONSE = JSON.stringify({
  formulaName: 'Revenue per Chargeable Hour',
  formulaDescription: 'Invoiced revenue divided by chargeable hours.',
  entityType: 'feeEarner',
  resultType: 'currency',
  confidence: 0.95,
  explanation: 'Divides invoiced revenue by chargeable hours.',
  warnings: [],
  expression: {
    type: 'operator',
    operator: 'divide',
    left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
    right: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
  },
  postProcess: { round: 2 },
});

/** Mock client that returns a preset response. */
function mockClient(response: string): TranslationApiClient {
  return {
    async complete(_systemPrompt: string, _userPrompt: string): Promise<string> {
      return response;
    },
  };
}

/** Mock client that throws. */
function throwingClient(message: string): TranslationApiClient {
  return {
    async complete(): Promise<string> {
      throw new Error(message);
    },
  };
}

/** Mock client that captures inputs for inspection. */
function capturingClient(response: string): {
  client: TranslationApiClient;
  calls: { systemPrompt: string; userPrompt: string }[];
} {
  const calls: { systemPrompt: string; userPrompt: string }[] = [];
  const client: TranslationApiClient = {
    async complete(systemPrompt, userPrompt) {
      calls.push({ systemPrompt, userPrompt });
      return response;
    },
  };
  return { client, calls };
}

// =============================================================================
// buildTranslationSystemPrompt
// =============================================================================

describe('buildTranslationSystemPrompt', () => {
  it('includes all entity field keys from the registry', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('lawyerName');
    expect(prompt).toContain('invoicedRevenue');
    expect(prompt).toContain('wipChargeableHours');
  });

  it('includes entity type labels', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('feeEarner');
    expect(prompt).toContain('Fee Earner');
  });

  it('includes formula IDs and names', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('F-TU-01');
    expect(prompt).toContain('Chargeable Utilisation Rate');
    expect(prompt).toContain('F-RB-01');
    expect(prompt).toContain('Realisation Rate');
  });

  it('includes snippet IDs and names', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('SN-002');
    expect(prompt).toContain('Available Working Hours');
  });

  it('includes supported operator types', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('divide');
    expect(prompt).toContain('percentage');
    expect(prompt).toContain('aggregation');
    expect(prompt).toContain('ifThen');
  });

  it('includes few-shot examples', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    // The 5 few-shot example descriptions appear in the prompt
    expect(prompt).toContain("effective billing rate");
    expect(prompt).toContain("over budget");
    expect(prompt).toContain("property matters");
    expect(prompt).toContain("75% utilisation");
    expect(prompt).toContain("disbursement");
  });

  it('includes response schema instructions', () => {
    const prompt = buildTranslationSystemPrompt(ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(prompt).toContain('formulaName');
    expect(prompt).toContain('entityType');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('expression');
  });

  it('falls back to default entity section when registry is empty', () => {
    const prompt = buildTranslationSystemPrompt([], [], []);
    // Default section includes common fee earner fields
    expect(prompt).toContain('invoicedRevenue');
    expect(prompt).toContain('wipChargeableHours');
  });

  it('user prompt appears separate from system prompt (via translateToFormula)', async () => {
    const { client, calls } = capturingClient(VALID_AI_RESPONSE);
    const translator = new FormulaTranslator(client);
    await translator.translateToFormula('revenue per hour', ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY);
    expect(calls).toHaveLength(1);
    // System prompt and user prompt are separate
    expect(calls[0].systemPrompt).not.toContain('revenue per hour');
    expect(calls[0].userPrompt).toContain('revenue per hour');
  });
});

// =============================================================================
// FormulaTranslator.translateToFormula — successful translations
// =============================================================================

describe('FormulaTranslator.translateToFormula — success', () => {
  it('returns success: true with valid formula definition', async () => {
    const translator = new FormulaTranslator(mockClient(VALID_AI_RESPONSE));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(true);
    expect(result.formulaDefinition).toBeDefined();
    expect(result.formulaName).toBe('Revenue per Chargeable Hour');
    expect(result.entityType).toBe('feeEarner');
    expect(result.resultType).toBe('currency');
    expect(result.confidence).toBe(0.95);
    expect(result.error).toBeUndefined();
  });

  it('formula definition expression is the divide operator node', async () => {
    const translator = new FormulaTranslator(mockClient(VALID_AI_RESPONSE));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    const expr = result.formulaDefinition!.expression as Record<string, unknown>;
    expect(expr['type']).toBe('operator');
    expect(expr['operator']).toBe('divide');
  });

  it('postProcess is passed through', async () => {
    const translator = new FormulaTranslator(mockClient(VALID_AI_RESPONSE));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.formulaDefinition!.postProcess?.round).toBe(2);
  });

  it('explanation is populated', async () => {
    const translator = new FormulaTranslator(mockClient(VALID_AI_RESPONSE));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(typeof result.explanation).toBe('string');
    expect(result.explanation.length).toBeGreaterThan(5);
  });

  it('extracts JSON from markdown code block', async () => {
    const wrapped = '```json\n' + VALID_AI_RESPONSE + '\n```';
    const translator = new FormulaTranslator(mockClient(wrapped));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(true);
    expect(result.formulaDefinition).toBeDefined();
  });

  it('extracts JSON surrounded by prose text', async () => {
    const withProse = 'Here is the formula:\n' + VALID_AI_RESPONSE + '\nI hope that helps!';
    const translator = new FormulaTranslator(mockClient(withProse));
    const result = await translator.translateToFormula(
      'revenue per hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// FormulaTranslator.translateToFormula — error cases
// =============================================================================

describe('FormulaTranslator.translateToFormula — error handling', () => {
  it('returns error when description is too short', async () => {
    const called = vi.fn();
    const translator = new FormulaTranslator({ complete: called });
    const result = await translator.translateToFormula(
      'hi',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(called).not.toHaveBeenCalled(); // no API call for short descriptions
  });

  it('returns error when API client throws', async () => {
    const translator = new FormulaTranslator(throwingClient('Network timeout'));
    const result = await translator.translateToFormula(
      'revenue per chargeable hour please',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('API call failed');
    expect(result.error).toContain('Network timeout');
    expect(result.error).toContain('try again');
  });

  it('returns error when AI returns non-JSON text', async () => {
    const translator = new FormulaTranslator(mockClient('I cannot help with that request.'));
    const result = await translator.translateToFormula(
      'revenue per chargeable hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not parse AI response');
  });

  it('returns error when AI returns malformed JSON', async () => {
    const translator = new FormulaTranslator(mockClient('{ formulaName: missing_quotes }'));
    const result = await translator.translateToFormula(
      'revenue per chargeable hour',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns success:false with warnings when expression structure is invalid', async () => {
    const badExprResponse = JSON.stringify({
      formulaName: 'Bad Formula',
      formulaDescription: 'Has an invalid expression',
      entityType: 'feeEarner',
      resultType: 'number',
      confidence: 0.7,
      explanation: 'Test',
      warnings: [],
      expression: {
        type: 'operator',
        operator: 'divide',
        // Missing left and right
      },
    });
    const translator = new FormulaTranslator(mockClient(badExprResponse));
    const result = await translator.translateToFormula(
      'revenue per chargeable hour for each fee earner',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.success).toBe(false);
    expect(result.warnings.some((w) => w.includes('Definition issue'))).toBe(true);
  });

  it('adds vague-description warning when confidence < 0.5', async () => {
    const lowConfidenceResponse = JSON.stringify({
      formulaName: 'Uncertain Formula',
      formulaDescription: 'Could not determine formula',
      entityType: 'feeEarner',
      resultType: 'number',
      confidence: 0.3,
      explanation: 'Not sure what this means',
      warnings: [],
      expression: {
        type: 'field',
        entity: 'feeEarner',
        field: 'wipChargeableHours',
      },
    });
    const translator = new FormulaTranslator(mockClient(lowConfidenceResponse));
    const result = await translator.translateToFormula(
      'do the thing with numbers',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.warnings.some((w) => w.includes('too vague'))).toBe(true);
  });

  it('passes through AI-supplied warnings', async () => {
    const warnResponse = JSON.stringify({
      formulaName: 'Formula with Warning',
      formulaDescription: 'Test',
      entityType: 'matter',
      resultType: 'number',
      confidence: 0.8,
      explanation: 'Uses optional field',
      warnings: ['budget field may not be populated'],
      expression: { type: 'field', entity: 'matter', field: 'wipTotalBillable' },
    });
    const translator = new FormulaTranslator(mockClient(warnResponse));
    const result = await translator.translateToFormula(
      'show matters where cost exceeds budget amount',
      ENTITY_REGISTRY, FORMULA_REGISTRY, SNIPPET_REGISTRY,
    );
    expect(result.warnings).toContain('budget field may not be populated');
  });
});

// =============================================================================
// TranslationRateLimiter
// =============================================================================

describe('TranslationRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new TranslationRateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const check = limiter.check('firm-001');
      expect(check.allowed).toBe(true);
      limiter.record('firm-001');
    }
  });

  it('blocks the (max+1)th request', () => {
    const limiter = new TranslationRateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      limiter.record('firm-001');
    }
    const check = limiter.check('firm-001');
    expect(check.allowed).toBe(false);
    expect(check.retryAfterMs).toBeGreaterThan(0);
    expect(check.remainingRequests).toBe(0);
  });

  it('decrements remainingRequests with each recorded request', () => {
    const limiter = new TranslationRateLimiter(5, 60_000);
    const first = limiter.check('firm-001');
    expect(first.remainingRequests).toBe(4); // 5 - 0 existing - 1 = 4
    limiter.record('firm-001');
    const second = limiter.check('firm-001');
    expect(second.remainingRequests).toBe(3);
  });

  it('isolates rate limits per firm', () => {
    const limiter = new TranslationRateLimiter(2, 60_000);
    limiter.record('firm-001');
    limiter.record('firm-001');
    expect(limiter.check('firm-001').allowed).toBe(false);
    expect(limiter.check('firm-002').allowed).toBe(true);
  });

  it('resets after the window expires (injectable time)', () => {
    let fakeNow = 0;
    const limiter = new TranslationRateLimiter(2, 60_000, () => fakeNow);

    // Fill the window
    limiter.record('firm-001');
    limiter.record('firm-001');
    expect(limiter.check('firm-001').allowed).toBe(false);

    // Advance time beyond the window
    fakeNow = 61_000;
    expect(limiter.check('firm-001').allowed).toBe(true);
  });

  it('partial window expiry: only expired requests are pruned', () => {
    let fakeNow = 0;
    const limiter = new TranslationRateLimiter(3, 60_000, () => fakeNow);

    limiter.record('firm-001');  // at t=0
    fakeNow = 30_000;
    limiter.record('firm-001');  // at t=30s

    fakeNow = 61_000; // t=0 request expires; t=30s is still active
    const check = limiter.check('firm-001');
    expect(check.allowed).toBe(true);
    expect(check.remainingRequests).toBe(1); // 3 - 1 active - 1 = 1
  });

  it('clear() removes all records for a firm', () => {
    const limiter = new TranslationRateLimiter(2, 60_000);
    limiter.record('firm-001');
    limiter.record('firm-001');
    expect(limiter.check('firm-001').allowed).toBe(false);
    limiter.clear('firm-001');
    expect(limiter.check('firm-001').allowed).toBe(true);
  });

  it('clear() without argument clears all firms', () => {
    const limiter = new TranslationRateLimiter(2, 60_000);
    limiter.record('firm-001');
    limiter.record('firm-001');
    limiter.record('firm-002');
    limiter.record('firm-002');
    limiter.clear();
    expect(limiter.check('firm-001').allowed).toBe(true);
    expect(limiter.check('firm-002').allowed).toBe(true);
  });

  it('retryAfterMs is approx windowMs when all slots used at t=0', () => {
    let fakeNow = 0;
    const limiter = new TranslationRateLimiter(1, 60_000, () => fakeNow);
    limiter.record('firm-001');

    fakeNow = 1000; // 1 second later
    const check = limiter.check('firm-001');
    expect(check.allowed).toBe(false);
    // Oldest request at t=0 expires at t=60_000; now is t=1000
    expect(check.retryAfterMs).toBeCloseTo(59_000, -2); // within 100ms
  });
});
