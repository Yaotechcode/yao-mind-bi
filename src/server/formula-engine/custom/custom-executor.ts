/**
 * custom-executor.ts — Custom Formula Execution Engine
 *
 * Interprets structured custom formula definitions at runtime.
 * Custom formulas are stored as JSON definition objects (NOT executable code)
 * and evaluated here via a recursive expression tree interpreter.
 *
 * Design: stateless — pure evaluation, no side effects, never throws.
 */

import type { FormulaContext, FormulaResult, FormulaImplementation, EntityFormulaResult } from '../types.js';
import type { EntityDefinition, FormulaDefinition, SnippetDefinition } from '../../../shared/types/index.js';
import type { FormulaResultType } from '../../../shared/formulas/types.js';
import { summariseResults, formatValue } from '../result-formatter.js';

// =============================================================================
// Expression node types
// =============================================================================

export interface FieldRefNode {
  type: 'field';
  /** Entity type key: 'feeEarner', 'matter', 'firm', 'department', 'client'. */
  entity: string;
  /** Field key on that entity (e.g. 'invoicedNetBilling'). */
  field: string;
}

export interface SnippetRefNode {
  type: 'snippet';
  snippetId: string;
  /** 'self' = same entity as formula target; any other string = specific entityId. */
  entityBinding: 'self' | string;
}

export interface FormulaRefNode {
  type: 'formula';
  formulaId: string;
  /** 'self' = same entity as formula target; any other string = specific entityId. */
  entityBinding: 'self' | string;
  /** Key into EntityFormulaResult.additionalValues. Omit for primary value. */
  valueKey?: string;
}

export interface ConstantNode {
  type: 'constant';
  value: number;
}

export interface ConfigNode {
  type: 'config';
  /** Dot-notation path into firmConfig: e.g. 'salariedConfig.costRateMethod'. */
  path: string;
}

export interface OperatorNode {
  type: 'operator';
  operator: BinaryOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface AggregationNode {
  type: 'aggregation';
  function: AggregationFunction;
  /** Entity type to aggregate over. */
  entity: string;
  /** Expression to evaluate for each entity (not required for 'countOf'). */
  expression?: ExpressionNode;
  filter?: FilterDef;
}

export interface IfThenNode {
  type: 'ifThen';
  /** A compare node (or any node returning 1=true / 0=false / null). */
  condition: ExpressionNode;
  then: ExpressionNode;
  else?: ExpressionNode;
}

export interface CompareNode {
  type: 'compare';
  operator: CompareOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

export type ExpressionNode =
  | FieldRefNode
  | SnippetRefNode
  | FormulaRefNode
  | ConstantNode
  | ConfigNode
  | OperatorNode
  | AggregationNode
  | IfThenNode
  | CompareNode;

// =============================================================================
// Supporting types
// =============================================================================

export type BinaryOperator =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'percentage'   // a / b × 100
  | 'min'
  | 'max'
  | 'average';

export type AggregationFunction = 'sumOf' | 'averageOf' | 'countOf' | 'minOf' | 'maxOf';

export type CompareOperator = '>' | '<' | '=' | '>=' | '<=';

export interface FilterDef {
  field: string;
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'in' | 'notIn' | 'isNull' | 'isNotNull';
  value?: unknown;
}

export interface PostProcessConfig {
  /** Multiply the result by this factor. */
  multiply?: number;
  /** Round to this many decimal places. */
  round?: number;
  /** Clamp the result to [min, max]. */
  clamp?: { min: number; max: number };
  /** Take absolute value. */
  abs?: boolean;
}

// =============================================================================
// Custom formula definition
// =============================================================================

export interface CustomFormulaDefinition {
  /** Override the formula ID in the result (used by the standalone executor). */
  formulaId?: string;
  /** Override the formula name in the result. */
  formulaName?: string;
  /** Root expression node. */
  expression: ExpressionNode;
  /** Optional post-processing applied after the expression is evaluated. */
  postProcess?: PostProcessConfig;
  /** Result type for formatting. Defaults to 'number'. */
  resultType?: FormulaResultType;
}

// =============================================================================
// Validation result
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  referencedEntities: string[];
  referencedFormulas: string[];
  referencedSnippets: string[];
  referencedConfigPaths: string[];
}

// =============================================================================
// Internal evaluation context
// =============================================================================

interface EvalContext {
  formulaContext: FormulaContext;
  selfEntityId: string;
  selfEntityType: string;
  selfEntity: Record<string, unknown>;
}

// =============================================================================
// CustomFormulaExecutor
// =============================================================================

export class CustomFormulaExecutor {
  /**
   * Execute a custom formula definition against the provided context.
   * Iterates all entities of targetEntityType, evaluates the expression for each,
   * applies post-processing, and returns a FormulaResult.
   *
   * Never throws — returns null entity results with nullReason on any failure.
   */
  execute(
    definition: CustomFormulaDefinition,
    context: FormulaContext,
    targetEntityType: string,
    formulaId = definition.formulaId ?? 'custom',
    formulaName = definition.formulaName ?? 'Custom Formula',
  ): FormulaResult {
    const startTime = Date.now();
    const entityResults: Record<string, EntityFormulaResult> = {};
    const resultType: FormulaResultType = definition.resultType ?? 'number';
    const nullReasons: string[] = [];
    const warnings: string[] = [];

    const entities = getEntitiesOfType(targetEntityType, context);

    for (const entity of entities) {
      const entityId = resolveEntityId(entity, targetEntityType);
      const entityName = resolveEntityName(entity, targetEntityType);
      const evalCtx: EvalContext = {
        formulaContext: context,
        selfEntityId: entityId,
        selfEntityType: targetEntityType,
        selfEntity: entity as Record<string, unknown>,
      };

      let raw: number | null = null;
      let nullReason: string | null = null;

      try {
        const result = evalExpr(definition.expression, evalCtx);
        if (typeof result === 'string') {
          // compare/ifThen can return a non-numeric when used at the top level
          nullReason = 'Expression did not produce a numeric value';
        } else {
          raw = result;
        }
      } catch (err) {
        nullReason = `Evaluation error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Apply post-processing
      let value: number | null = raw;
      if (value !== null && definition.postProcess) {
        value = applyPostProcess(value, definition.postProcess);
      }

      if (value === null && nullReason === null) {
        nullReason = 'Expression evaluated to null';
      }

      if (nullReason) nullReasons.push(nullReason);

      entityResults[entityId] = {
        entityId,
        entityName,
        value,
        formattedValue: formatValue(value, resultType),
        nullReason,
        breakdown: {},
      };
    }

    return {
      formulaId,
      formulaName,
      variantUsed: null,
      resultType,
      entityResults,
      summary: summariseResults(entityResults),
      computedAt: new Date().toISOString(),
      metadata: {
        executionTimeMs: Date.now() - startTime,
        inputsUsed: [targetEntityType],
        nullReasons: [...new Set(nullReasons)],
        warnings,
      },
    };
  }

  /**
   * Validate a custom formula definition without executing it.
   * Checks that all field/snippet/formula/config references exist,
   * and detects circular formula dependencies.
   */
  validate(
    definition: CustomFormulaDefinition,
    entityRegistry: EntityDefinition[],
    formulaRegistry: FormulaDefinition[],
    snippetRegistry: SnippetDefinition[],
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const referencedEntities = new Set<string>();
    const referencedFormulas = new Set<string>();
    const referencedSnippets = new Set<string>();
    const referencedConfigPaths = new Set<string>();

    // Build lookup sets for fast checking
    const entityFields = buildEntityFieldMap(entityRegistry);
    const formulaIds = new Set(formulaRegistry.map((f) => f.id));
    const snippetIds = new Set(snippetRegistry.map((s) => s.id));

    // Walk the expression tree and collect all references + validate structure
    validateNode(
      definition.expression,
      errors,
      warnings,
      referencedEntities,
      referencedFormulas,
      referencedSnippets,
      referencedConfigPaths,
      entityFields,
      formulaIds,
      snippetIds,
    );

    // Circular dependency check: starting from the root formula (if it has an id),
    // trace through all referenced formulas to detect cycles
    if (definition.formulaId && referencedFormulas.has(definition.formulaId)) {
      errors.push(
        `Circular dependency: formula '${definition.formulaId}' references itself`,
      );
    }
    // Deep cycle check: build adjacency from formula registry
    const circularChain = detectCircularDeps(
      definition.formulaId,
      referencedFormulas,
      formulaRegistry,
    );
    if (circularChain) {
      errors.push(`Circular dependency detected: ${circularChain}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      referencedEntities: [...referencedEntities],
      referencedFormulas: [...referencedFormulas],
      referencedSnippets: [...referencedSnippets],
      referencedConfigPaths: [...referencedConfigPaths],
    };
  }
}

// =============================================================================
// Wrapper: customFormulaAsImplementation
// =============================================================================

/**
 * Wrap a CustomFormulaDefinition in a FormulaImplementation interface so
 * the FormulaEngine treats it identically to a built-in formula.
 *
 * @param formulaDef   The formula registry entry (provides id, label, appliesTo).
 * @param customDef    The structured expression definition.
 */
export function customFormulaAsImplementation(
  formulaDef: { id: string; label: string; appliesTo: string[] },
  customDef: CustomFormulaDefinition,
): FormulaImplementation {
  const executor = new CustomFormulaExecutor();
  const targetEntityType = formulaDef.appliesTo[0] ?? 'feeEarner';

  return {
    formulaId: formulaDef.id,
    execute(context: FormulaContext): FormulaResult {
      return executor.execute(customDef, context, targetEntityType, formulaDef.id, formulaDef.label);
    },
  };
}

// =============================================================================
// Expression evaluator
// =============================================================================

/**
 * Recursively evaluate an expression node.
 * Returns a number (the computed value) or null (when inputs are missing/invalid).
 * Comparison nodes return 1 (true) or 0 (false).
 * Never throws — catches internal errors and returns null.
 */
function evalExpr(node: ExpressionNode, ctx: EvalContext): number | null {
  switch (node.type) {
    case 'constant':
      return node.value;

    case 'field':
      return evalFieldRef(node, ctx);

    case 'snippet':
      return evalSnippetRef(node, ctx);

    case 'formula':
      return evalFormulaRef(node, ctx);

    case 'config':
      return evalConfigRef(node, ctx);

    case 'operator':
      return evalOperator(node, ctx);

    case 'aggregation':
      return evalAggregation(node, ctx);

    case 'compare':
      return evalCompare(node, ctx);

    case 'ifThen':
      return evalIfThen(node, ctx);

    default: {
      // Exhaustiveness guard
      const _x: never = node;
      void _x;
      return null;
    }
  }
}

// --- leaf evaluators ---

function evalFieldRef(node: FieldRefNode, ctx: EvalContext): number | null {
  const entity = resolveEntityRef(node.entity, ctx);
  if (entity === null) return null;
  const raw = entity[node.field];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  const num = Number(raw);
  return isNaN(num) ? null : num;
}

function evalSnippetRef(node: SnippetRefNode, ctx: EvalContext): number | null {
  const entityId = node.entityBinding === 'self' ? ctx.selfEntityId : node.entityBinding;
  const result = ctx.formulaContext.snippetResults?.[node.snippetId]?.[entityId];
  return result?.value ?? null;
}

function evalFormulaRef(node: FormulaRefNode, ctx: EvalContext): number | null {
  const entityId = node.entityBinding === 'self' ? ctx.selfEntityId : node.entityBinding;
  const formulaResult = ctx.formulaContext.formulaResults?.[node.formulaId];
  if (!formulaResult) return null;
  const entityResult = formulaResult.entityResults[entityId];
  if (!entityResult) return null;
  if (node.valueKey) {
    const additional = entityResult.additionalValues?.[node.valueKey];
    return additional ?? null;
  }
  return entityResult.value;
}

function evalConfigRef(node: ConfigNode, ctx: EvalContext): number | null {
  const value = getNestedValue(ctx.formulaContext.firmConfig as unknown as Record<string, unknown>, node.path);
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const num = Number(value);
  return isNaN(num) ? null : num;
}

// --- operator evaluator ---

function evalOperator(node: OperatorNode, ctx: EvalContext): number | null {
  const left = evalExpr(node.left, ctx);
  const right = evalExpr(node.right, ctx);

  // min/max/average: skip null operands rather than propagating null
  if (node.operator === 'min') {
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    return Math.min(left, right);
  }
  if (node.operator === 'max') {
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
  }
  if (node.operator === 'average') {
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    return (left + right) / 2;
  }

  // Arithmetic operators — propagate null from either operand
  if (left === null || right === null) return null;

  switch (node.operator) {
    case 'add':       return left + right;
    case 'subtract':  return left - right;
    case 'multiply':  return left * right;
    case 'divide':
      if (right === 0) return null; // division by zero → null
      return left / right;
    case 'percentage':
      if (right === 0) return null; // avoid division by zero
      return (left / right) * 100;
    default: {
      const _x: never = node.operator;
      void _x;
      return null;
    }
  }
}

// --- compare evaluator (returns 1 = true, 0 = false, null = unknown) ---

function evalCompare(node: CompareNode, ctx: EvalContext): number | null {
  const left = evalExpr(node.left, ctx);
  const right = evalExpr(node.right, ctx);

  // For string equality comparisons, allow non-numeric values via field refs
  const leftRaw = getRawValue(node.left, ctx);
  const rightRaw = getRawValue(node.right, ctx);

  // Use raw strings for equals/notEquals if numeric eval returned null
  const l = left ?? (typeof leftRaw === 'string' ? leftRaw : null);
  const r = right ?? (typeof rightRaw === 'string' ? rightRaw : null);

  if (l === null || r === null) return null;

  switch (node.operator) {
    case '=':  return l === r ? 1 : 0;
    case '>':  return (l as number) > (r as number) ? 1 : 0;
    case '<':  return (l as number) < (r as number) ? 1 : 0;
    case '>=': return (l as number) >= (r as number) ? 1 : 0;
    case '<=': return (l as number) <= (r as number) ? 1 : 0;
    default: {
      const _x: never = node.operator;
      void _x;
      return null;
    }
  }
}

/**
 * Get the raw (possibly non-numeric) value of an expression node.
 * Used for string comparisons in compare nodes.
 */
function getRawValue(node: ExpressionNode, ctx: EvalContext): unknown {
  if (node.type === 'constant') return node.value;
  if (node.type === 'field') {
    const entity = resolveEntityRef(node.entity, ctx);
    return entity?.[node.field] ?? null;
  }
  return null;
}

// --- ifThen evaluator ---

function evalIfThen(node: IfThenNode, ctx: EvalContext): number | null {
  const condition = evalExpr(node.condition, ctx);
  if (condition === null) return null;
  if (condition !== 0) {
    return evalExpr(node.then, ctx);
  }
  return node.else != null ? evalExpr(node.else, ctx) : null;
}

// --- aggregation evaluator ---

function evalAggregation(node: AggregationNode, ctx: EvalContext): number | null {
  const entities = getEntitiesOfType(node.entity, ctx.formulaContext);
  const filtered = node.filter ? entities.filter((e) => matchesFilter(e, node.filter!)) : entities;

  if (node.function === 'countOf') {
    return filtered.length;
  }

  if (!node.expression) return null;

  const values: number[] = [];
  for (const entity of filtered) {
    const entityId = resolveEntityId(entity, node.entity);
    const subCtx: EvalContext = {
      formulaContext: ctx.formulaContext,
      selfEntityId: entityId,
      selfEntityType: node.entity,
      selfEntity: entity as Record<string, unknown>,
    };
    const val = evalExpr(node.expression, subCtx);
    if (val !== null) values.push(val);
  }

  if (values.length === 0) return null;

  switch (node.function) {
    case 'sumOf':     return values.reduce((a, b) => a + b, 0);
    case 'averageOf': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'minOf':     return Math.min(...values);
    case 'maxOf':     return Math.max(...values);
    default: {
      const _x: never = node.function;
      void _x;
      return null;
    }
  }
}

// =============================================================================
// Entity helpers
// =============================================================================

/**
 * Map an entity type string to the corresponding array in FormulaContext.
 */
function getEntitiesOfType(entityType: string, context: FormulaContext): unknown[] {
  switch (entityType) {
    case 'feeEarner':   return context.feeEarners;
    case 'matter':      return context.matters;
    case 'department':  return context.departments;
    case 'client':      return context.clients;
    case 'invoice':     return context.invoices;
    case 'timeEntry':   return context.timeEntries;
    case 'disbursement': return context.disbursements;
    case 'firm':        return [context.firm];
    default:            return [];
  }
}

/** Resolve an entity ref string to the current entity or a lookup (firm only for now). */
function resolveEntityRef(entityType: string, ctx: EvalContext): Record<string, unknown> | null {
  if (entityType === ctx.selfEntityType || entityType === 'self') {
    return ctx.selfEntity;
  }
  // Firm is a single entity — always accessible
  if (entityType === 'firm') {
    return ctx.formulaContext.firm as unknown as Record<string, unknown>;
  }
  // For cross-entity field access within a single-entity expression, we'd need
  // a join — not supported at field level (use aggregation nodes instead)
  return null;
}

function resolveEntityId(entity: unknown, entityType: string): string {
  const e = entity as Record<string, unknown>;
  switch (entityType) {
    case 'feeEarner':  return (e['lawyerId'] ?? e['lawyerName'] ?? 'unknown') as string;
    case 'matter':     return (e['matterId'] ?? e['matterNumber'] ?? 'unknown') as string;
    case 'department': return (e['departmentId'] ?? e['name'] ?? 'unknown') as string;
    case 'client':     return (e['clientId'] ?? e['clientName'] ?? 'unknown') as string;
    case 'firm':       return 'firm';
    default:           return (e['id'] ?? 'unknown') as string;
  }
}

function resolveEntityName(entity: unknown, entityType: string): string {
  const e = entity as Record<string, unknown>;
  switch (entityType) {
    case 'feeEarner':  return (e['lawyerName'] ?? e['lawyerId'] ?? 'Unknown') as string;
    case 'matter':     return (e['matterNumber'] ?? e['matterId'] ?? 'Unknown') as string;
    case 'department': return (e['name'] ?? 'Unknown') as string;
    case 'client':     return (e['clientName'] ?? e['clientId'] ?? 'Unknown') as string;
    case 'firm':       return 'Firm';
    default:           return 'Unknown';
  }
}

// =============================================================================
// Filter helpers
// =============================================================================

function matchesFilter(entity: unknown, filter: FilterDef): boolean {
  const e = entity as Record<string, unknown>;
  const fieldVal = e[filter.field];

  switch (filter.operator) {
    case 'equals':       return fieldVal === filter.value;
    case 'notEquals':    return fieldVal !== filter.value;
    case 'greaterThan':  return typeof fieldVal === 'number' && fieldVal > (filter.value as number);
    case 'lessThan':     return typeof fieldVal === 'number' && fieldVal < (filter.value as number);
    case 'in':           return Array.isArray(filter.value) && filter.value.includes(fieldVal);
    case 'notIn':        return Array.isArray(filter.value) && !filter.value.includes(fieldVal);
    case 'isNull':       return fieldVal === null || fieldVal === undefined;
    case 'isNotNull':    return fieldVal !== null && fieldVal !== undefined;
    default:             return false;
  }
}

// =============================================================================
// Post-processing
// =============================================================================

function applyPostProcess(value: number, pp: PostProcessConfig): number {
  let v = value;
  if (pp.abs) v = Math.abs(v);
  if (pp.multiply !== undefined) v = v * pp.multiply;
  if (pp.clamp)  v = Math.max(pp.clamp.min, Math.min(pp.clamp.max, v));
  if (pp.round !== undefined) {
    const factor = Math.pow(10, pp.round);
    v = Math.round(v * factor) / factor;
  }
  return v;
}

// =============================================================================
// Config path resolution
// =============================================================================

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// =============================================================================
// Validation helpers
// =============================================================================

/** Map from entity type → set of valid field keys. */
function buildEntityFieldMap(registry: EntityDefinition[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const def of registry) {
    map.set(def.entityType as string, new Set(def.fields.map((f) => f.key)));
  }
  return map;
}

function validateNode(
  node: ExpressionNode,
  errors: string[],
  warnings: string[],
  entities: Set<string>,
  formulas: Set<string>,
  snippets: Set<string>,
  configPaths: Set<string>,
  entityFields: Map<string, Set<string>>,
  formulaIds: Set<string>,
  snippetIds: Set<string>,
): void {
  switch (node.type) {
    case 'field': {
      entities.add(node.entity);
      const fields = entityFields.get(node.entity);
      if (!fields) {
        errors.push(`Unknown entity type: '${node.entity}'`);
      } else if (!fields.has(node.field)) {
        errors.push(`Field '${node.field}' does not exist on entity '${node.entity}'`);
      }
      break;
    }

    case 'snippet': {
      snippets.add(node.snippetId);
      if (!snippetIds.has(node.snippetId)) {
        errors.push(`Unknown snippet: '${node.snippetId}'`);
      }
      break;
    }

    case 'formula': {
      formulas.add(node.formulaId);
      if (!formulaIds.has(node.formulaId)) {
        errors.push(`Unknown formula: '${node.formulaId}'`);
      }
      break;
    }

    case 'constant':
      if (typeof node.value !== 'number') {
        errors.push(`Constant value must be a number (got ${typeof node.value})`);
      }
      break;

    case 'config':
      configPaths.add(node.path);
      if (!node.path || !node.path.match(/^[a-zA-Z_][a-zA-Z0-9_.]*$/)) {
        errors.push(`Invalid config path: '${node.path}'`);
      }
      break;

    case 'operator': {
      const validOps: BinaryOperator[] = ['add', 'subtract', 'multiply', 'divide', 'percentage', 'min', 'max', 'average'];
      if (!validOps.includes(node.operator)) {
        errors.push(`Unknown operator: '${node.operator}'`);
      }
      validateNode(node.left, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      validateNode(node.right, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      break;
    }

    case 'aggregation': {
      const validFns: AggregationFunction[] = ['sumOf', 'averageOf', 'countOf', 'minOf', 'maxOf'];
      if (!validFns.includes(node.function)) {
        errors.push(`Unknown aggregation function: '${node.function}'`);
      }
      if (node.function !== 'countOf' && !node.expression) {
        errors.push(`Aggregation '${node.function}' requires an expression`);
      }
      if (node.expression) {
        validateNode(node.expression, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      }
      break;
    }

    case 'compare': {
      const validOps: CompareOperator[] = ['>', '<', '=', '>=', '<='];
      if (!validOps.includes(node.operator)) {
        errors.push(`Unknown compare operator: '${node.operator}'`);
      }
      validateNode(node.left, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      validateNode(node.right, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      break;
    }

    case 'ifThen': {
      validateNode(node.condition, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      validateNode(node.then, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      if (node.else) {
        validateNode(node.else, errors, warnings, entities, formulas, snippets, configPaths, entityFields, formulaIds, snippetIds);
      }
      break;
    }

    default: {
      const _x: never = node;
      void _x;
    }
  }
}

/**
 * Check for circular dependencies in formula references.
 * Returns the cycle chain as a string if one is found, or null.
 *
 * Uses DFS: starting from the candidate formula's references, follow each
 * referenced formula's own dependencies (from the registry) and detect cycles.
 */
function detectCircularDeps(
  rootFormulaId: string | undefined,
  referencedFormulas: Set<string>,
  formulaRegistry: FormulaDefinition[],
): string | null {
  if (!rootFormulaId) return null;

  // Build dependency map from registry (formulaId → formula IDs it depends on)
  // FormulaDefinition uses FormulaVariant.dependencies (field keys), so we
  // look for entries that match formula IDs (F-XX-XX pattern).
  const depMap = new Map<string, string[]>();
  const formulaIdPattern = /^F-[A-Z]+-\d+$/;
  for (const f of formulaRegistry) {
    const deps: string[] = [];
    for (const variant of f.variants ?? []) {
      for (const dep of variant.dependencies ?? []) {
        if (formulaIdPattern.test(dep)) deps.push(dep);
      }
    }
    depMap.set(f.id, deps);
  }

  // DFS from each referenced formula back to root
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(formulaId: string): string | null {
    if (formulaId === rootFormulaId && stack.length > 0) {
      return [...stack, rootFormulaId].join(' → ');
    }
    if (visited.has(formulaId)) return null;
    visited.add(formulaId);
    stack.push(formulaId);
    for (const dep of depMap.get(formulaId) ?? []) {
      const chain = dfs(dep);
      if (chain) return chain;
    }
    stack.pop();
    return null;
  }

  for (const refId of referencedFormulas) {
    visited.clear();
    const chain = dfs(refId);
    if (chain) return chain;
  }

  return null;
}
