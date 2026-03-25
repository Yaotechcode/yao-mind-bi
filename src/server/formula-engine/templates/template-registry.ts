/**
 * template-registry.ts — Formula Template System
 *
 * Templates are pre-built formula definitions that firms can instantiate
 * with their own parameters. They never execute directly — instantiation
 * produces a CustomFormulaDefinition that the custom executor can run.
 *
 * Parameter substitution: template expressions may contain ParameterRefNodes
 * ({ type: 'parameter', key: '...' }) and template filter values may use
 * "{{paramKey}}" placeholder strings. Both are replaced during instantiation.
 *
 * Design: stateless — FormulaTemplateService is a pure-logic class.
 */

import type {
  ExpressionNode,
  CustomFormulaDefinition,
  FilterDef,
  PostProcessConfig,
} from '../custom/custom-executor.js';
import type {
  FormulaDefinition,
} from '../../../shared/types/index.js';
import { FormulaType, FieldType, EntityType } from '../../../shared/types/index.js';
import type { FormulaResultType } from '../../../shared/formulas/types.js';

// =============================================================================
// Template type definitions
// =============================================================================

export interface TemplateParameter {
  /** Unique key used in {{paramKey}} placeholders and ParameterRefNodes. */
  key: string;
  label: string;
  description: string;
  /** Determines how the value is substituted into the expression tree. */
  type: 'field' | 'number' | 'percentage' | 'entity' | 'select';
  required: boolean;
  defaultValue?: unknown;
  selectOptions?: { value: string; label: string }[];
  validation?: { min?: number; max?: number };
}

/**
 * Extension of ExpressionNode used inside templates.
 * ParameterRefNode is replaced during instantiation — the executor never sees it.
 */
export interface ParameterRefNode {
  type: 'parameter';
  key: string;
  /**
   * Governs how the resolved parameter value is substituted:
   * - 'constant'   → { type: 'constant', value: numericValue }
   * - 'formulaRef' → { type: 'formula', formulaId: value, entityBinding: 'self' }
   */
  resolveAs: 'constant' | 'formulaRef';
}

/** ExpressionNode that may contain ParameterRefNodes (template-only). */
export type TemplateExpressionNode = ExpressionNode | ParameterRefNode;

/** Like CustomFormulaDefinition but allows ParameterRefNodes in the tree. */
export interface TemplateCustomFormulaDefinition {
  expression: TemplateExpressionNode;
  postProcess?: PostProcessConfig;
  resultType?: FormulaResultType;
}

/**
 * Like FilterDef but `value` may be a "{{paramKey}}" placeholder string
 * that is resolved during instantiation.
 */
export interface TemplateFilterDef extends Omit<FilterDef, 'value'> {
  value?: unknown;
}

export interface FormulaTemplate {
  templateId: string;
  name: string;
  description: string;
  category: string;
  entityType: string;
  resultType: FormulaResultType;
  parameters: TemplateParameter[];
  /** Expression tree — may contain ParameterRefNodes and {{}} filter values. */
  definition: TemplateCustomFormulaDefinition;
  /** Human-readable description with {{paramKey}} placeholders for the UI. */
  previewDescription: string;
  tags: string[];
  difficulty: 'basic' | 'intermediate' | 'advanced';
}

// =============================================================================
// Validation result
// =============================================================================

export interface TemplateValidationResult {
  valid: boolean;
  errors: string[];
}

// =============================================================================
// Instantiation options
// =============================================================================

export interface InstantiateOptions {
  /** Human-readable name for the new formula. Defaults to template name. */
  customName?: string;
  /** The user or system creating the formula. */
  userId?: string;
  /** Prefix for the generated formula ID. Defaults to 'F-CUSTOM'. */
  idPrefix?: string;
}

// =============================================================================
// Preview result
// =============================================================================

export interface TemplatePreviewResult {
  definition: CustomFormulaDefinition;
  /** Human-readable description with parameters substituted in. */
  description: string;
}

// =============================================================================
// FormulaTemplateService
// =============================================================================

export class FormulaTemplateService {
  private readonly templateMap: Map<string, FormulaTemplate>;

  constructor(templates: FormulaTemplate[]) {
    this.templateMap = new Map(templates.map((t) => [t.templateId, t]));
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Returns all available templates. */
  async getAvailableTemplates(_firmId?: string): Promise<FormulaTemplate[]> {
    return [...this.templateMap.values()];
  }

  /** Returns a single template by ID, or null if not found. */
  async getTemplate(templateId: string): Promise<FormulaTemplate | null> {
    return this.templateMap.get(templateId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /** Validate provided parameters against a template's parameter spec. */
  async validateTemplateParameters(
    templateId: string,
    parameters: Record<string, unknown>,
  ): Promise<TemplateValidationResult> {
    const template = this.templateMap.get(templateId);
    if (!template) {
      return { valid: false, errors: [`Template '${templateId}' not found`] };
    }
    return validateParams(template, parameters);
  }

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  /**
   * Preview what the formula definition would look like with the given parameters,
   * without persisting anything.
   */
  async previewTemplate(
    templateId: string,
    parameters: Record<string, unknown>,
  ): Promise<TemplatePreviewResult> {
    const template = this.templateMap.get(templateId);
    if (!template) {
      throw new Error(`Template '${templateId}' not found`);
    }

    const { valid, errors } = validateParams(template, parameters);
    if (!valid) {
      throw new Error(`Invalid parameters: ${errors.join('; ')}`);
    }

    const resolved = applyDefaults(template, parameters);
    const substitutedExpr = substituteExpression(template.definition.expression, resolved);
    const definition: CustomFormulaDefinition = {
      ...template.definition,
      expression: substitutedExpr,
    };
    const description = resolveDescription(template.previewDescription, resolved);

    return { definition, description };
  }

  // ---------------------------------------------------------------------------
  // Instantiation
  // ---------------------------------------------------------------------------

  /**
   * Instantiate a template with the provided parameters.
   * Returns a FormulaDefinition ready to be persisted to firmConfig.formulas.
   *
   * Note: this method does NOT persist anything — the caller is responsible
   * for saving the returned FormulaDefinition to the firm's config.
   */
  async instantiateTemplate(
    _firmId: string,
    templateId: string,
    parameters: Record<string, unknown>,
    options?: InstantiateOptions,
  ): Promise<FormulaDefinition> {
    const template = this.templateMap.get(templateId);
    if (!template) {
      throw new Error(`Template '${templateId}' not found`);
    }

    const { valid, errors } = validateParams(template, parameters);
    if (!valid) {
      throw new Error(`Invalid parameters: ${errors.join('; ')}`);
    }

    const resolved = applyDefaults(template, parameters);
    const substitutedExpr = substituteExpression(template.definition.expression, resolved);
    const customDef: CustomFormulaDefinition = {
      ...template.definition,
      expression: substitutedExpr,
    };

    // Generate a stable formula ID
    const prefix = options?.idPrefix ?? 'F-CUSTOM';
    const timestamp = Date.now();
    const formulaId = `${prefix}-${templateId}-${timestamp}`;
    customDef.formulaId = formulaId;
    customDef.formulaName = options?.customName ?? template.name;

    // Wrap as a FormulaDefinition (stored in firmConfig.formulas)
    const formulaDef: FormulaDefinition = {
      id: formulaId,
      label: options?.customName ?? template.name,
      description: resolveDescription(template.previewDescription, resolved),
      type: FormulaType.CUSTOM,
      outputType: resultTypeToFieldType(template.resultType),
      appliesTo: [template.entityType as EntityType],
      variants: [
        {
          id: 'default',
          label: 'Default',
          expression: JSON.stringify(customDef),
          dependencies: collectDependencies(customDef.expression as TemplateExpressionNode),
        },
      ],
    };

    return formulaDef;
  }
}

// =============================================================================
// Private helpers
// =============================================================================

/** Apply default values for any parameter not in the provided map. */
function applyDefaults(
  template: FormulaTemplate,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const param of template.parameters) {
    resolved[param.key] = param.key in parameters ? parameters[param.key] : param.defaultValue;
  }
  return resolved;
}

/** Validate required parameters and range constraints. */
function validateParams(
  template: FormulaTemplate,
  parameters: Record<string, unknown>,
): TemplateValidationResult {
  const errors: string[] = [];

  for (const param of template.parameters) {
    const value = parameters[param.key] ?? param.defaultValue;

    if (param.required && (value === undefined || value === null || value === '')) {
      errors.push(`Required parameter '${param.key}' (${param.label}) is missing`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if ((param.type === 'number' || param.type === 'percentage') && typeof value === 'number') {
      if (param.validation?.min !== undefined && value < param.validation.min) {
        errors.push(`Parameter '${param.key}' must be >= ${param.validation.min} (got ${value})`);
      }
      if (param.validation?.max !== undefined && value > param.validation.max) {
        errors.push(`Parameter '${param.key}' must be <= ${param.validation.max} (got ${value})`);
      }
    }

    if (param.type === 'select' && param.selectOptions) {
      const valid = param.selectOptions.some((o) => o.value === value);
      if (!valid) {
        const allowed = param.selectOptions.map((o) => o.value).join(', ');
        errors.push(`Parameter '${param.key}' value '${value}' is not one of: ${allowed}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Recursively walk a TemplateExpressionNode tree and substitute:
 * - ParameterRefNode → constant or formula ref
 * - FilterDef.value strings matching "{{key}}" → resolved value
 *
 * Returns an ExpressionNode (no ParameterRefNodes remain).
 */
function substituteExpression(
  node: TemplateExpressionNode,
  params: Record<string, unknown>,
): ExpressionNode {
  if (node.type === 'parameter') {
    return resolveParameterRef(node as ParameterRefNode, params);
  }

  // Recursively substitute child nodes
  const n = node as ExpressionNode;

  if (n.type === 'operator') {
    return {
      ...n,
      left: substituteExpression(n.left as TemplateExpressionNode, params),
      right: substituteExpression(n.right as TemplateExpressionNode, params),
    };
  }

  if (n.type === 'aggregation') {
    return {
      ...n,
      expression: n.expression
        ? substituteExpression(n.expression as TemplateExpressionNode, params)
        : undefined,
      filter: n.filter ? substituteFilter(n.filter, params) : undefined,
    };
  }

  if (n.type === 'ifThen') {
    return {
      ...n,
      condition: substituteExpression(n.condition as TemplateExpressionNode, params),
      then: substituteExpression(n.then as TemplateExpressionNode, params),
      else: n.else
        ? substituteExpression(n.else as TemplateExpressionNode, params)
        : undefined,
    };
  }

  if (n.type === 'compare') {
    return {
      ...n,
      left: substituteExpression(n.left as TemplateExpressionNode, params),
      right: substituteExpression(n.right as TemplateExpressionNode, params),
    };
  }

  // Leaf nodes (field, snippet, formula, constant, config) — no substitution needed
  return n;
}

/** Substitute "{{key}}" placeholders in filter values. */
function substituteFilter(filter: FilterDef, params: Record<string, unknown>): FilterDef {
  if (typeof filter.value !== 'string') return filter;
  const match = filter.value.match(/^\{\{(\w+)\}\}$/);
  if (!match) return filter;
  const key = match[1];
  return { ...filter, value: params[key] };
}

/** Resolve a ParameterRefNode to a concrete ExpressionNode. */
function resolveParameterRef(
  node: ParameterRefNode,
  params: Record<string, unknown>,
): ExpressionNode {
  const value = params[node.key];

  switch (node.resolveAs) {
    case 'constant':
      return { type: 'constant', value: Number(value) };

    case 'formulaRef':
      return { type: 'formula', formulaId: String(value), entityBinding: 'self' };

    default: {
      const _x: never = node.resolveAs;
      void _x;
      return { type: 'constant', value: 0 };
    }
  }
}

/** Resolve {{paramKey}} placeholders in the preview description string. */
function resolveDescription(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = params[key];
    return v !== undefined ? String(v) : `{{${key}}}`;
  });
}

/** Collect all referenced formula/snippet IDs from an expression tree. */
function collectDependencies(node: TemplateExpressionNode): string[] {
  const deps = new Set<string>();

  function walk(n: TemplateExpressionNode): void {
    if (n.type === 'formula') deps.add(n.formulaId);
    if (n.type === 'snippet') deps.add(n.snippetId);
    if (n.type === 'parameter') return;
    if (n.type === 'operator') { walk(n.left as TemplateExpressionNode); walk(n.right as TemplateExpressionNode); }
    if (n.type === 'aggregation' && n.expression) walk(n.expression as TemplateExpressionNode);
    if (n.type === 'ifThen') { walk(n.condition as TemplateExpressionNode); walk(n.then as TemplateExpressionNode); if (n.else) walk(n.else as TemplateExpressionNode); }
    if (n.type === 'compare') { walk(n.left as TemplateExpressionNode); walk(n.right as TemplateExpressionNode); }
  }

  walk(node);
  return [...deps];
}

/** Map a FormulaResultType to FieldType for FormulaDefinition.outputType. */
function resultTypeToFieldType(resultType: FormulaResultType): FieldType {
  switch (resultType) {
    case 'currency':    return FieldType.CURRENCY;
    case 'percentage':  return FieldType.PERCENTAGE;
    case 'number':      return FieldType.NUMBER;
    case 'ratio':       return FieldType.NUMBER;
    case 'hours':       return FieldType.NUMBER;
    case 'days':        return FieldType.NUMBER;
    case 'boolean':     return FieldType.BOOLEAN;
    default:            return FieldType.NUMBER;
  }
}
