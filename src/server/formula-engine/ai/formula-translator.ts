/**
 * formula-translator.ts — AI Formula Translation Service
 *
 * Translates natural language descriptions into structured CustomFormulaDefinition
 * objects by calling the Anthropic API with a carefully constructed system prompt.
 *
 * Design:
 * - FormulaTranslator takes an injectable TranslationApiClient so tests can mock
 *   the API call without network access.
 * - buildTranslationSystemPrompt is a pure function — no side effects.
 * - All parsing and validation is synchronous after the async API call.
 */

import type { EntityDefinition, FormulaDefinition, SnippetDefinition } from '../../../shared/types/index.js';
import type { CustomFormulaDefinition, ExpressionNode } from '../custom/custom-executor.js';
import type { TemplateParameter } from '../templates/template-registry.js';
import type { FormulaResultType } from '../../../shared/formulas/types.js';

// =============================================================================
// Public types
// =============================================================================

export interface TranslationResult {
  success: boolean;
  formulaDefinition?: CustomFormulaDefinition;
  formulaName?: string;
  formulaDescription?: string;
  entityType?: string;
  resultType?: FormulaResultType;
  /** 0–1: how confident the AI is in the translation. */
  confidence: number;
  /** Human-readable explanation of what the formula does. */
  explanation: string;
  warnings: string[];
  /** If the formula could be parameterised, suggested parameters. */
  suggestedParameters?: TemplateParameter[];
  error?: string;
}

/** Raw JSON structure the AI is instructed to return. */
interface AiTranslationResponse {
  formulaName: string;
  formulaDescription: string;
  entityType: string;
  resultType: string;
  confidence: number;
  explanation: string;
  warnings: string[];
  expression: ExpressionNode;
  postProcess?: { multiply?: number; round?: number; clamp?: { min: number; max: number }; abs?: boolean };
  suggestedParameters?: TemplateParameter[];
}

// =============================================================================
// Injectable API client interface
// =============================================================================

/**
 * Minimal interface for the Anthropic API call.
 * Inject a mock implementation in tests.
 */
export interface TranslationApiClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Production client that calls the Anthropic Messages API.
 * Lazily imports the SDK so it is only required in production contexts.
 */
export class AnthropicTranslationClient implements TranslationApiClient {
  constructor(private readonly apiKey: string) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    // Dynamic import so tests don't need the SDK
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }
}

// =============================================================================
// FormulaTranslator
// =============================================================================

export class FormulaTranslator {
  constructor(private readonly apiClient: TranslationApiClient) {}

  /**
   * Translate a natural language description into a CustomFormulaDefinition.
   *
   * The flow:
   *   1. Build a system prompt containing the entity schema + operators + few-shot examples
   *   2. Call the API with the user's description
   *   3. Parse and validate the JSON response
   *   4. Return a TranslationResult
   */
  async translateToFormula(
    description: string,
    entityRegistry: EntityDefinition[],
    formulaRegistry: FormulaDefinition[],
    snippetRegistry: SnippetDefinition[],
  ): Promise<TranslationResult> {
    if (!description || description.trim().length < 5) {
      return {
        success: false,
        confidence: 0,
        explanation: '',
        warnings: [],
        error: 'Description is too short. Please provide more detail.',
      };
    }

    const systemPrompt = buildTranslationSystemPrompt(entityRegistry, formulaRegistry, snippetRegistry);
    const userPrompt = buildUserPrompt(description);

    let rawResponse: string;
    try {
      rawResponse = await this.apiClient.complete(systemPrompt, userPrompt);
    } catch (err) {
      return {
        success: false,
        confidence: 0,
        explanation: '',
        warnings: [],
        error: `API call failed: ${err instanceof Error ? err.message : String(err)}. Please try again.`,
      };
    }

    // Extract JSON from the response (the AI may wrap it in markdown code blocks)
    const jsonString = extractJson(rawResponse);
    if (!jsonString) {
      return {
        success: false,
        confidence: 0,
        explanation: '',
        warnings: [],
        error: 'Could not parse AI response — no valid JSON found.',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      return {
        success: false,
        confidence: 0,
        explanation: '',
        warnings: [],
        error: 'Could not parse AI response — malformed JSON.',
      };
    }

    const validationErrors = validateAiResponse(parsed);
    const aiResponse = parsed as AiTranslationResponse;

    const formulaDefinition: CustomFormulaDefinition = {
      expression: aiResponse.expression,
      resultType: aiResponse.resultType as FormulaResultType,
      ...(aiResponse.postProcess ? { postProcess: aiResponse.postProcess } : {}),
    };

    const warnings = [...(aiResponse.warnings ?? [])];
    if (validationErrors.length > 0) {
      warnings.push(...validationErrors.map((e) => `Definition issue: ${e}`));
    }

    // Low confidence warning
    if (aiResponse.confidence < 0.5) {
      warnings.push(
        'The description is too vague. Try something like "Show revenue per chargeable hour for each fee earner" or "Count matters over budget".',
      );
    }

    return {
      success: validationErrors.length === 0,
      formulaDefinition,
      formulaName: aiResponse.formulaName,
      formulaDescription: aiResponse.formulaDescription,
      entityType: aiResponse.entityType,
      resultType: aiResponse.resultType as FormulaResultType,
      confidence: aiResponse.confidence ?? 0,
      explanation: aiResponse.explanation ?? '',
      warnings,
      suggestedParameters: aiResponse.suggestedParameters,
    };
  }
}

// =============================================================================
// System prompt builder (exported for testing)
// =============================================================================

/**
 * Build the system prompt for formula translation.
 * Includes the entity schema, available operators, snippet/formula catalogue,
 * and 5 few-shot translation examples.
 */
export function buildTranslationSystemPrompt(
  entityRegistry: EntityDefinition[],
  formulaRegistry: FormulaDefinition[],
  snippetRegistry: SnippetDefinition[],
): string {
  const entitySection = buildEntitySection(entityRegistry);
  const formulaSection = buildFormulaCatalogueSection(formulaRegistry, snippetRegistry);
  const operatorSection = buildOperatorSection();
  const examples = buildFewShotExamples();
  const schema = buildResponseSchema();

  return [
    '# Formula Translation System',
    '',
    'You translate natural language descriptions of law firm KPIs into structured formula definitions.',
    'You MUST return ONLY a JSON object — no prose, no markdown, no explanation outside the JSON.',
    '',
    '## Available Entity Types and Fields',
    entitySection,
    '',
    '## Available Formulas and Snippets',
    formulaSection,
    '',
    '## Supported Expression Node Types and Operators',
    operatorSection,
    '',
    '## Response Schema',
    schema,
    '',
    '## Translation Examples',
    examples,
    '',
    'Now translate the user\'s description. Return ONLY the JSON object.',
  ].join('\n');
}

// =============================================================================
// Section builders (private)
// =============================================================================

function buildEntitySection(entityRegistry: EntityDefinition[]): string {
  if (entityRegistry.length === 0) {
    return buildDefaultEntitySection();
  }

  const lines: string[] = [];
  for (const entity of entityRegistry) {
    lines.push(`### ${entity.label} (entityType: "${entity.entityType}")`);
    for (const field of entity.fields) {
      lines.push(`  - ${field.key} (${field.type}): ${field.label}`);
    }
  }
  return lines.join('\n');
}

function buildDefaultEntitySection(): string {
  return [
    '### Fee Earner (entityType: "feeEarner")',
    '  - lawyerId (string): Lawyer ID',
    '  - lawyerName (string): Lawyer Name',
    '  - wipTotalHours (number): Total WIP Hours',
    '  - wipChargeableHours (number): Chargeable WIP Hours',
    '  - wipNonChargeableHours (number): Non-Chargeable WIP Hours',
    '  - wipChargeableValue (currency): Chargeable WIP Value',
    '  - wipTotalValue (currency): Total WIP Value',
    '  - wipWriteOffValue (currency): WIP Write-Off Value',
    '  - invoicedRevenue (currency): Total Invoiced Revenue',
    '  - invoicedOutstanding (currency): Outstanding Invoiced Amount',
    '  - recordingGapDays (number): Days Since Last WIP Entry',
    '',
    '### Matter (entityType: "matter")',
    '  - matterId (string): Matter ID',
    '  - matterNumber (string): Matter Number',
    '  - wipTotalHours (number): Total WIP Hours',
    '  - wipChargeableHours (number): Chargeable Hours',
    '  - wipTotalBillable (currency): Total WIP Billable Value',
    '  - wipTotalWriteOff (currency): Total Write-Off',
    '  - invoicedNetBilling (currency): Invoiced Net Billing',
    '  - invoicedOutstanding (currency): Invoice Outstanding',
    '  - invoicedPaid (currency): Amount Paid',
    '',
    '### Firm (entityType: "firm")',
    '  - totalWipHours (number): Total WIP Hours',
    '  - totalChargeableHours (number): Total Chargeable Hours',
    '  - totalWipValue (currency): Total WIP Value',
    '  - totalInvoicedRevenue (currency): Total Revenue',
    '  - totalOutstanding (currency): Total Outstanding',
    '  - feeEarnerCount (number): Total Fee Earner Count',
  ].join('\n');
}

function buildFormulaCatalogueSection(
  formulaRegistry: FormulaDefinition[],
  snippetRegistry: SnippetDefinition[],
): string {
  const lines: string[] = [];

  if (snippetRegistry.length > 0) {
    lines.push('### Snippets (pre-computed values — reference with type: "snippet")');
    for (const s of snippetRegistry) {
      lines.push(`  - ${s.id}: ${s.label} — ${s.description}`);
    }
    lines.push('');
  } else {
    lines.push('### Snippets');
    lines.push('  - SN-002: Available Working Hours — total annual available working hours per fee earner');
    lines.push('  - SN-005: Cost Rate by Pay Model — hourly cost rate (salary-based or fee-share)');
    lines.push('');
  }

  if (formulaRegistry.length > 0) {
    lines.push('### Existing Formulas (reference with type: "formula", formulaId: "<id>")');
    for (const f of formulaRegistry) {
      lines.push(`  - ${f.id}: ${f.label} — ${f.description}`);
    }
  } else {
    lines.push('### Existing Formulas (reference with type: "formula")');
    lines.push('  - F-TU-01: Chargeable Utilisation Rate');
    lines.push('  - F-RB-01: Realisation Rate');
    lines.push('  - F-RB-02: Effective Hourly Rate');
    lines.push('  - F-WL-02: Write-Off Rate');
    lines.push('  - F-DM-01: Debtor Days');
  }

  return lines.join('\n');
}

function buildOperatorSection(): string {
  return [
    '### Expression Node Types',
    '  { "type": "field", "entity": "<entityType>", "field": "<fieldKey>" }',
    '  { "type": "snippet", "snippetId": "<id>", "entityBinding": "self" }',
    '  { "type": "formula", "formulaId": "<id>", "entityBinding": "self" }',
    '  { "type": "constant", "value": <number> }',
    '  { "type": "config", "path": "<dot.path>" }',
    '',
    '### Operator Node (arithmetic)',
    '  { "type": "operator", "operator": "add"|"subtract"|"multiply"|"divide"|"percentage"|"min"|"max"|"average",',
    '    "left": <ExpressionNode>, "right": <ExpressionNode> }',
    '  Note: "percentage" = left / right × 100',
    '',
    '### Aggregation Node (cross-entity)',
    '  { "type": "aggregation", "function": "sumOf"|"averageOf"|"countOf"|"minOf"|"maxOf",',
    '    "entity": "<entityType>", "expression": <ExpressionNode>,',
    '    "filter": { "field": "<key>", "operator": "equals"|"notEquals"|"greaterThan"|"lessThan"|"isNull"|"isNotNull", "value": <any> } }',
    '',
    '### Conditional Node',
    '  { "type": "ifThen", "condition": <CompareNode>, "then": <ExpressionNode>, "else": <ExpressionNode> }',
    '  { "type": "compare", "operator": ">"|"<"|"="|">="|"<=", "left": <ExpressionNode>, "right": <ExpressionNode> }',
    '',
    '### Post-Processing (optional)',
    '  { "multiply": <number>, "round": <decimalPlaces>, "clamp": { "min": <n>, "max": <n> }, "abs": true }',
  ].join('\n');
}

function buildResponseSchema(): string {
  return [
    'Return a JSON object with EXACTLY these fields:',
    '{',
    '  "formulaName": "Short human-readable name",',
    '  "formulaDescription": "One sentence description",',
    '  "entityType": "feeEarner"|"matter"|"firm"|"department"|"client",',
    '  "resultType": "percentage"|"currency"|"number"|"ratio"|"days"|"hours",',
    '  "confidence": 0.0-1.0,',
    '  "explanation": "Human-readable explanation of the formula logic",',
    '  "warnings": ["any caveats or data dependency notes"],',
    '  "expression": { <ExpressionNode> },',
    '  "postProcess": { <optional> },',
    '  "suggestedParameters": [ <optional TemplateParameter array> ]',
    '}',
  ].join('\n');
}

function buildFewShotExamples(): string {
  return [
    // Example 1
    'USER: "What\'s each fee earner\'s effective billing rate?"',
    'ASSISTANT:',
    JSON.stringify({
      formulaName: 'Revenue per Chargeable Hour',
      formulaDescription: 'Total invoiced revenue divided by total chargeable hours for each fee earner.',
      entityType: 'feeEarner',
      resultType: 'currency',
      confidence: 0.95,
      explanation: 'Divides each fee earner\'s invoiced revenue by their chargeable WIP hours to give an effective hourly rate.',
      warnings: [],
      expression: {
        type: 'operator',
        operator: 'divide',
        left: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        right: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
      },
      postProcess: { round: 2 },
    }, null, 2),
    '',
    // Example 2
    'USER: "Show me which matters are over budget"',
    'ASSISTANT:',
    JSON.stringify({
      formulaName: 'Over-Budget Flag',
      formulaDescription: 'Returns WIP billable value for matters where it exceeds the budget.',
      entityType: 'matter',
      resultType: 'currency',
      confidence: 0.88,
      explanation: 'Compares WIP billable value to the matter budget. Returns the WIP value if over budget, null if within budget.',
      warnings: ['Requires budget field to be populated on matters.'],
      expression: {
        type: 'ifThen',
        condition: {
          type: 'compare',
          operator: '>',
          left: { type: 'field', entity: 'matter', field: 'wipTotalBillable' },
          right: { type: 'field', entity: 'matter', field: 'budget' },
        },
        then: { type: 'field', entity: 'matter', field: 'wipTotalBillable' },
      },
    }, null, 2),
    '',
    // Example 3
    'USER: "Calculate the average realisation rate for property matters"',
    'ASSISTANT:',
    JSON.stringify({
      formulaName: 'Average Realisation Rate (Property)',
      formulaDescription: 'Average billing realisation rate across all Property department matters.',
      entityType: 'firm',
      resultType: 'percentage',
      confidence: 0.82,
      explanation: 'Averages invoicedNetBilling / wipTotalBillable × 100 across matters filtered to the Property department.',
      warnings: ['Requires department field on matters.'],
      expression: {
        type: 'aggregation',
        function: 'averageOf',
        entity: 'matter',
        expression: {
          type: 'operator',
          operator: 'percentage',
          left: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
          right: { type: 'field', entity: 'matter', field: 'wipTotalBillable' },
        },
        filter: { field: 'department', operator: 'equals', value: 'Property' },
      },
      postProcess: { round: 1 },
    }, null, 2),
    '',
    // Example 4
    'USER: "How much would we save if all fee earners hit 75% utilisation?"',
    'ASSISTANT:',
    JSON.stringify({
      formulaName: 'Utilisation Gap at 75% Target',
      formulaDescription: 'Shortfall in chargeable hours per fee earner vs a 75% utilisation target.',
      entityType: 'feeEarner',
      resultType: 'hours',
      confidence: 0.78,
      explanation: 'Calculates how many additional chargeable hours each fee earner would need to reach 75% utilisation of their available working hours (from SN-002).',
      warnings: ['Available hours (SN-002) must have been computed for this snippet reference to work.'],
      expression: {
        type: 'operator',
        operator: 'subtract',
        left: {
          type: 'operator',
          operator: 'multiply',
          left: { type: 'snippet', snippetId: 'SN-002', entityBinding: 'self' },
          right: { type: 'constant', value: 0.75 },
        },
        right: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
      },
      postProcess: { clamp: { min: 0, max: 10000 } },
    }, null, 2),
    '',
    // Example 5
    'USER: "Rank clients by total fees minus disbursement exposure"',
    'ASSISTANT:',
    JSON.stringify({
      formulaName: 'Net Client Value (Fees minus Outstanding)',
      formulaDescription: 'Total invoiced revenue less outstanding balance per client.',
      entityType: 'client',
      resultType: 'currency',
      confidence: 0.85,
      explanation: 'Subtracts the client\'s outstanding balance from their total invoiced amount to show net collected value. Higher is better.',
      warnings: [],
      expression: {
        type: 'operator',
        operator: 'subtract',
        left: { type: 'field', entity: 'client', field: 'totalInvoiced' },
        right: { type: 'field', entity: 'client', field: 'totalOutstanding' },
      },
      postProcess: { round: 2 },
    }, null, 2),
  ].join('\n');
}

// =============================================================================
// User prompt builder
// =============================================================================

function buildUserPrompt(description: string): string {
  return `Translate this formula description into a JSON formula definition:\n\n"${description}"`;
}

// =============================================================================
// Response validation
// =============================================================================

const VALID_EXPRESSION_TYPES = new Set([
  'field', 'snippet', 'formula', 'constant', 'config',
  'operator', 'aggregation', 'ifThen', 'compare',
]);

function validateAiResponse(parsed: unknown): string[] {
  const errors: string[] = [];

  if (!parsed || typeof parsed !== 'object') {
    errors.push('Response is not an object');
    return errors;
  }

  const r = parsed as Record<string, unknown>;

  if (!r['formulaName'] || typeof r['formulaName'] !== 'string') {
    errors.push('Missing or invalid formulaName');
  }
  if (!r['entityType'] || typeof r['entityType'] !== 'string') {
    errors.push('Missing or invalid entityType');
  }
  if (!r['expression'] || typeof r['expression'] !== 'object') {
    errors.push('Missing or invalid expression');
  } else {
    const exprErrors = validateExpressionNode(r['expression']);
    errors.push(...exprErrors);
  }
  if (typeof r['confidence'] !== 'number' || r['confidence'] < 0 || r['confidence'] > 1) {
    errors.push('confidence must be a number between 0 and 1');
  }

  return errors;
}

function validateExpressionNode(node: unknown, depth = 0): string[] {
  if (depth > 20) return ['Expression too deeply nested (max 20 levels)'];
  if (!node || typeof node !== 'object') return ['Expression node must be an object'];

  const n = node as Record<string, unknown>;
  const type = n['type'];

  if (typeof type !== 'string' || !VALID_EXPRESSION_TYPES.has(type)) {
    return [`Invalid expression node type: ${JSON.stringify(type)}`];
  }

  const errors: string[] = [];

  if (type === 'operator') {
    if (!n['left'] || !n['right']) errors.push('operator node requires left and right');
    if (n['left']) errors.push(...validateExpressionNode(n['left'], depth + 1));
    if (n['right']) errors.push(...validateExpressionNode(n['right'], depth + 1));
  }
  if (type === 'aggregation') {
    if (!n['entity']) errors.push('aggregation node requires entity');
    if (n['expression']) errors.push(...validateExpressionNode(n['expression'], depth + 1));
  }
  if (type === 'ifThen') {
    if (!n['condition'] || !n['then']) errors.push('ifThen node requires condition and then');
    if (n['condition']) errors.push(...validateExpressionNode(n['condition'], depth + 1));
    if (n['then']) errors.push(...validateExpressionNode(n['then'], depth + 1));
    if (n['else']) errors.push(...validateExpressionNode(n['else'], depth + 1));
  }
  if (type === 'compare') {
    if (!n['left'] || !n['right']) errors.push('compare node requires left and right');
    if (n['left']) errors.push(...validateExpressionNode(n['left'], depth + 1));
    if (n['right']) errors.push(...validateExpressionNode(n['right'], depth + 1));
  }
  if (type === 'field') {
    if (!n['entity'] || !n['field']) errors.push('field node requires entity and field');
  }
  if (type === 'constant') {
    if (typeof n['value'] !== 'number') errors.push('constant node requires numeric value');
  }

  return errors;
}

// =============================================================================
// JSON extraction helper
// =============================================================================

/**
 * Extract a JSON object from an AI response that may contain markdown fences
 * or leading/trailing prose.
 */
function extractJson(text: string): string | null {
  // Try to find a JSON code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Find the first { and last } and try that substring
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return null;
}
