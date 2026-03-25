/**
 * types.ts — Formula Engine type definitions
 *
 * These types define the EXECUTION framework for formulas.
 * Formula DEFINITIONS live in @shared/formulas/types.ts — they describe what
 * to compute. These types describe how the engine runs computations.
 */

import type {
  AggregatedFeeEarner,
  AggregatedMatter,
  AggregatedClient,
  AggregatedDepartment,
  AggregatedFirm,
} from '../../shared/types/pipeline.js';
import type {
  EnrichedTimeEntry,
  EnrichedInvoice,
  EnrichedDisbursement,
} from '../../shared/types/enriched.js';
import type { FirmConfig } from '../../shared/types/index.js';

// =============================================================================
// Execution Context
// =============================================================================

/**
 * Everything a formula implementation needs to compute its result.
 * Assembled once by buildFormulaContext, then passed to every formula/snippet.
 */
export interface FormulaContext {
  // Aggregated entity data from the pipeline
  feeEarners: AggregatedFeeEarner[];
  matters: AggregatedMatter[];
  invoices: EnrichedInvoice[];
  timeEntries: EnrichedTimeEntry[];
  disbursements: EnrichedDisbursement[];
  departments: AggregatedDepartment[];
  clients: AggregatedClient[];
  firm: AggregatedFirm;

  // Configuration
  firmConfig: FirmConfig;
  /** Per-fee-earner config overrides keyed by fee earner ID. */
  feeEarnerOverrides: Record<string, Record<string, unknown>>;

  /**
   * Pre-computed snippet results — populated as snippets execute.
   * Key: snippetId → entityId → result.
   * Formula implementations read from here instead of recomputing snippets.
   */
  snippetResults: Record<string, Record<string, SnippetResult>>;

  /**
   * Pre-computed formula results — populated as formulas execute.
   * Key: formulaId. Available to formulas that depend on other formulas.
   */
  formulaResults: Record<string, FormulaResult>;

  /** Reference date for age calculations (defaults to today). */
  referenceDate: Date;
}

/**
 * Narrower context passed to snippet implementations.
 * Snippets operate on a single fee earner at a time.
 */
export interface SnippetContext {
  feeEarner: AggregatedFeeEarner;
  firmConfig: FirmConfig;
  feeEarnerOverride?: Record<string, unknown>;
  /**
   * Previously computed snippet results for THIS fee earner.
   * Populated by the SnippetEngine in dependency order.
   * Key: snippetId → the result for the current feeEarner.
   * Snippets that depend on other snippets (e.g. SN-001 depends on SN-002)
   * read their dependency value from here.
   */
  priorSnippetResults?: Record<string, SnippetResult>;
}

// =============================================================================
// Result Types
// =============================================================================

/** Kind of value produced by a formula. Drives formatting and display. */
export type FormulaResultType =
  | 'currency'
  | 'percentage'
  | 'hours'
  | 'days'
  | 'number'
  | 'ratio'
  | 'boolean';

/** Result for a single entity (fee earner, matter, firm, etc.) */
export interface EntityFormulaResult {
  entityId: string;
  entityName: string;
  /** Computed numeric value. Null when inputs are insufficient. */
  value: number | null;
  /** Human-readable formatted value, e.g. "75.2%" or "£1,234.56". Null when value is null. */
  formattedValue: string | null;
  /** Explanation of why value is null. Present only when value is null. */
  nullReason: string | null;
  /** Optional breakdown of how the value was derived. */
  breakdown?: Record<string, unknown>;
  /** For formulas that produce multiple values (e.g., margin AND amount). */
  additionalValues?: Record<string, number | null>;
}

/** Statistical summary computed across all entity results for a formula. */
export interface ResultSummary {
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  total: number | null;
  /** Total number of entities (including nulls). */
  count: number;
  /** Number of entities where value was null. */
  nullCount: number;
}

/**
 * Full result for one formula — across all entities plus a summary.
 * This is what gets stored in CalculatedKpisDocument.
 */
export interface FormulaResult {
  formulaId: string;
  formulaName: string;
  /** Variant key that was active when this ran. Null for single-variant formulas. */
  variantUsed: string | null;
  resultType: FormulaResultType;
  /**
   * Per-entity results. Key is entityId.
   * For firm-level formulas, key is 'firm'.
   */
  entityResults: Record<string, EntityFormulaResult>;
  summary: ResultSummary;
  /** ISO 8601 timestamp when this result was computed. */
  computedAt: string;
  metadata: {
    executionTimeMs: number;
    /** Which data sources were consulted (e.g. ['wipData', 'firmConfig']). */
    inputsUsed: string[];
    /** Aggregated null reasons across all entities. */
    nullReasons: string[];
    /** Non-fatal issues that did not prevent computation. */
    warnings: string[];
  };
}

/** Result from a single snippet execution for one fee earner. */
export interface SnippetResult {
  snippetId: string;
  entityId: string;
  value: number | null;
  nullReason: string | null;
  /** Optional detail breakdown — how the value was derived. */
  breakdown?: Record<string, unknown>;
}

// =============================================================================
// Implementation Interfaces
// =============================================================================

/** A registered formula implementation — the executable logic for one formula. */
export interface FormulaImplementation {
  formulaId: string;
  /**
   * Execute this formula against the provided context.
   * MUST NOT throw — return null EntityFormulaResults with nullReason on failure.
   */
  execute: (context: FormulaContext, variant?: string) => FormulaResult;
}

/** A registered snippet implementation — produces one value per fee earner. */
export interface SnippetImplementation {
  snippetId: string;
  /**
   * Execute this snippet for a single fee earner.
   * MUST NOT throw — return null value with nullReason on failure.
   */
  execute: (context: SnippetContext) => SnippetResult;
}

// =============================================================================
// Execution Plan
// =============================================================================

/**
 * Execution plan produced by buildExecutionPlan.
 * Defines the order in which snippets and formulas must run.
 */
export interface ExecutionPlan {
  /** Snippet IDs in dependency order (dependencies first). */
  snippetOrder: string[];
  /** Formula IDs in dependency order (dependencies first). */
  formulaOrder: string[];
  /** Formulas that cannot run due to missing implementations or circular deps. */
  skippedFormulas: { formulaId: string; reason: string }[];
  /** Detected circular dependency chains — should be empty. */
  circularDependencies: string[][];
}

// =============================================================================
// Engine Results
// =============================================================================

/** Aggregate result of a full formula engine execution run. */
export interface FormulaEngineResult {
  /** Keyed by formulaId. */
  results: Record<string, FormulaResult>;
  /** Keyed by snippetId → entityId. */
  snippetResults: Record<string, Record<string, SnippetResult>>;
  plan: ExecutionPlan;
  totalExecutionTimeMs: number;
  formulaCount: number;
  successCount: number;
  errorCount: number;
  errors: { formulaId: string; error: string }[];
}

/** Result from executing a single formula (for testing or preview). */
export interface SingleFormulaResult {
  result: FormulaResult;
  /** Only the snippets needed by this formula. */
  snippetResults: Record<string, Record<string, SnippetResult>>;
}

// =============================================================================
// Effective Config
// =============================================================================

/**
 * Merged firm-level + fee-earner-level configuration for a specific fee earner.
 * Fee earner overrides take precedence; firm config fills gaps; system defaults
 * fill any remaining gaps.
 */
export interface EffectiveConfig {
  costRateMethod: 'fully_loaded' | 'direct' | 'market_rate';
  /** Fee share % for this earner (0 for salaried). */
  feeSharePercent: number;
  /** Firm retain % applied before fee share split. */
  firmRetainPercent: number;
  utilisationApproach: 'assume_fulltime' | 'fte_adjusted';
  workingDaysPerWeek: number;
  weeklyTargetHours: number;
  chargeableWeeklyTarget: number;
  annualLeaveEntitlement: number;
  bankHolidaysPerYear: number;
  currency: string;
  /** Raw override map — any additional per-earner values. */
  overrides: Record<string, unknown>;
}
