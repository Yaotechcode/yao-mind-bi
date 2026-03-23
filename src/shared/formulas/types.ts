/**
 * types.ts — Built-in formula registry type definitions
 *
 * These types describe WHAT formulas calculate, not HOW they execute.
 * The formula engine (Phase 1C) reads these definitions and implements the logic.
 */

import { EntityType } from '../types/index.js';

// =============================================================================
// Enumerations
// =============================================================================

export type FormulaCategory =
  | 'utilisation'
  | 'revenue'
  | 'leakage'
  | 'profitability'
  | 'budget'
  | 'debtors'
  | 'composite';

/** Aggregation granularity at which the formula produces its output. */
export type AggregationLevel =
  | 'record'       // per time entry / transaction
  | 'feeEarner'    // per fee earner
  | 'matter'       // per matter
  | 'department'   // per department
  | 'firm';        // firm-wide

/** Kind of value produced by the formula. */
export type FormulaResultType =
  | 'percentage'   // 0–100 or 0–1 proportion
  | 'currency'     // monetary value (£)
  | 'days'         // duration in calendar/working days
  | 'hours'        // duration in hours
  | 'number'       // generic numeric value (counts, scores, indices)
  | 'ratio'        // unitless ratio
  | 'boolean';     // true/false flag

// =============================================================================
// Definition object — plain-English descriptor, NOT executable
// =============================================================================

/**
 * Describes the calculation logic for a formula or snippet.
 * All fields are plain text / field key arrays — no arithmetic or code.
 */
export interface FormulaDefinitionObject {
  /** Plain English description of the calculation approach. */
  approach: string;
  /** Field keys that form the numerator (e.g. ['billableValue', 'durationMinutes']). */
  numeratorFields?: string[];
  /** Field keys that form the denominator. */
  denominatorFields?: string[];
  /** Textual descriptions of any pre-calculation filters applied to the data. */
  filters?: string[];
  /** Firm config keys that affect this formula's behaviour. */
  configDependencies?: string[];
  /** Entity types that must be loaded for this formula to run. */
  dataRequirements?: string[];
  /**
   * What the formula returns when required inputs are absent or zero.
   * Must be explicitly specified — formulas MUST be null-safe.
   */
  nullHandling: string;
  /** The level at which this formula is computed. */
  aggregationLevel: AggregationLevel;
}

// =============================================================================
// Variant definition — describes one calculation mode for a formula
// =============================================================================

export interface FormulaVariantDef {
  /** Human-readable display name for this variant. */
  name: string;
  /** One-sentence description of what distinguishes this variant. */
  description: string;
  /**
   * Plain English description of the logic applied in this variant.
   * No code, no arithmetic — used by the engine as a contract.
   */
  logic: string;
}

// =============================================================================
// Display configuration
// =============================================================================

export interface FormulaDisplayConfig {
  /** Primary dashboard where this formula should be surfaced. */
  dashboard: string;
  /** Visual weight on the dashboard. */
  position?: 'primary' | 'secondary' | 'detail';
  /** Suggested chart type. */
  chartType?: 'bar' | 'gauge' | 'trend' | 'table' | 'scorecard' | 'waterfall' | 'donut';
}

// =============================================================================
// Built-in Formula Definition
// =============================================================================

export interface BuiltInFormulaDefinition {
  /** Stable unique identifier — never changes once assigned. */
  formulaId: string;
  /** Human-readable display name. */
  name: string;
  /** 2–3 sentence description of what this formula measures. */
  description: string;
  /** Grouping for navigation and configuration. */
  category: FormulaCategory;
  /** Always 'built_in' for definitions in this registry. */
  formulaType: 'built_in';
  /** The entity type this formula produces results for. */
  entityType: EntityType;
  /** Type of value the formula returns. */
  resultType: FormulaResultType;
  /**
   * Structured descriptor — read by the formula engine (1C) to execute.
   * NO executable code here.
   */
  definition: FormulaDefinitionObject;
  /** Key of the variant to use by default. Must exist in `variants`. */
  activeVariant: string;
  /**
   * Named calculation modes. Every formula has at least one variant
   * (key: 'default') even if no user-facing choice is exposed.
   */
  variants: Record<string, FormulaVariantDef>;
  /** User-configured modifiers — empty for built-in defaults. */
  modifiers: unknown[];
  /** IDs of formulas (F-XX-XX) or snippets (SN-00X) this depends on. */
  dependsOn: string[];
  /** Where this formula appears in dashboards. */
  displayConfig: FormulaDisplayConfig;
}

// =============================================================================
// Built-in Snippet Definition
// =============================================================================

/**
 * Snippets are reusable calculation sub-steps that formulas compose.
 * They produce a single scalar value rather than a full formula output.
 */
export interface BuiltInSnippetDefinition {
  /** Stable unique identifier (SN-00X). */
  snippetId: string;
  /** Human-readable display name. */
  name: string;
  /** What this snippet computes and when it is used. */
  description: string;
  /** Entity type this snippet operates on. */
  entityType: EntityType;
  /** Type of value produced. */
  resultType: FormulaResultType;
  /** Structured descriptor — read by the formula engine. */
  definition: FormulaDefinitionObject;
  /** Snippet IDs this snippet depends on (must not create cycles). */
  dependsOn: string[];
}
