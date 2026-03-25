/**
 * engine.ts — Formula Engine
 *
 * The execution framework that formula implementations plug into.
 * Does NOT contain any specific formula calculations — those are in 1C-02..1C-06.
 *
 * Responsibilities:
 *   - Registry for formula/snippet implementations
 *   - Execution plan construction (dependency ordering)
 *   - Executing all formulas in dependency order (executeAll)
 *   - Executing a single formula for testing/preview (executeSingle)
 *   - Catching errors — formulas must never throw, but the engine also guards
 *
 * Design: pure execution framework — no database calls, no side effects.
 */

import { buildExecutionPlan as buildPlan } from './dependency-graph.js';
import type {
  FormulaImplementation,
  SnippetImplementation,
  FormulaContext,
  FormulaResult,
  FormulaEngineResult,
  SingleFormulaResult,
  ExecutionPlan,
  SnippetResult,
} from './types.js';
import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
} from '../../shared/formulas/types.js';

export class FormulaEngine {
  /** Registered formula implementations, keyed by formulaId. */
  private readonly implementations = new Map<string, FormulaImplementation>();

  /** Registered snippet implementations, keyed by snippetId. */
  private readonly snippetImplementations = new Map<string, SnippetImplementation>();

  // ===========================================================================
  // Registration
  // ===========================================================================

  /** Register a formula implementation. Replaces any existing registration. */
  registerFormula(formulaId: string, impl: FormulaImplementation): void {
    this.implementations.set(formulaId, impl);
  }

  /** Register a snippet implementation. Replaces any existing registration. */
  registerSnippet(snippetId: string, impl: SnippetImplementation): void {
    this.snippetImplementations.set(snippetId, impl);
  }

  // ===========================================================================
  // Execution Plan
  // ===========================================================================

  /**
   * Build an execution plan from formula and snippet definitions.
   * Determines the order in which snippets and formulas must run.
   * Detects and reports circular dependencies.
   */
  buildExecutionPlan(
    formulaDefinitions: BuiltInFormulaDefinition[],
    snippetDefinitions: BuiltInSnippetDefinition[],
  ): ExecutionPlan {
    return buildPlan(formulaDefinitions, snippetDefinitions);
  }

  // ===========================================================================
  // Execute All
  // ===========================================================================

  /**
   * Execute all snippets and formulas in dependency order.
   *
   * Snippet execution: for each snippet in snippetOrder, runs the implementation
   * against every fee earner and stores results in context.snippetResults.
   *
   * Formula execution: for each formula in formulaOrder, runs the implementation
   * and stores results in context.formulaResults.
   *
   * Errors are caught and recorded — execution continues with remaining formulas.
   * The context object is mutated in place (snippetResults + formulaResults populated).
   */
  async executeAll(
    plan: ExecutionPlan,
    context: FormulaContext,
  ): Promise<FormulaEngineResult> {
    const startTime = Date.now();
    const errors: { formulaId: string; error: string }[] = [];

    // ------------------------------------------------------------------
    // Phase 1: Execute snippets in dependency order
    // ------------------------------------------------------------------
    for (const snippetId of plan.snippetOrder) {
      const impl = this.snippetImplementations.get(snippetId);
      if (!impl) {
        // Not yet implemented (future phases register snippets). Skip quietly.
        continue;
      }

      context.snippetResults[snippetId] ??= {};

      for (const feeEarner of context.feeEarners) {
        const entityId = resolveEntityId(feeEarner.lawyerId, feeEarner.lawyerName);
        const override = context.feeEarnerOverrides[entityId];
        try {
          const result = impl.execute({
            feeEarner,
            firmConfig: context.firmConfig,
            feeEarnerOverride: override,
          });
          context.snippetResults[snippetId][entityId] = result;
        } catch (err) {
          context.snippetResults[snippetId][entityId] = {
            snippetId,
            entityId,
            value: null,
            nullReason: `Snippet execution error: ${errorMessage(err)}`,
          };
        }
      }
    }

    // ------------------------------------------------------------------
    // Phase 2: Execute formulas in dependency order
    // ------------------------------------------------------------------
    let successCount = 0;
    const results: Record<string, FormulaResult> = {};

    for (const formulaId of plan.formulaOrder) {
      const impl = this.implementations.get(formulaId);
      if (!impl) {
        plan.skippedFormulas.push({
          formulaId,
          reason: 'No implementation registered',
        });
        continue;
      }

      try {
        const result = impl.execute(context);
        context.formulaResults[formulaId] = result;
        results[formulaId] = result;
        successCount++;
      } catch (err) {
        errors.push({ formulaId, error: errorMessage(err) });
      }
    }

    return {
      results,
      snippetResults: context.snippetResults,
      plan,
      totalExecutionTimeMs: Date.now() - startTime,
      formulaCount: plan.formulaOrder.length,
      successCount,
      errorCount: errors.length,
      errors,
    };
  }

  // ===========================================================================
  // Execute Single
  // ===========================================================================

  /**
   * Execute a single formula — for testing or dashboard preview.
   *
   * Runs all registered snippet implementations first (to ensure the formula
   * has access to any snippet results it depends on), then executes the formula.
   *
   * Snippet results are merged into a copy of the context so the caller's
   * context is not mutated.
   *
   * @throws Error if no implementation is registered for formulaId.
   */
  async executeSingle(
    formulaId: string,
    context: FormulaContext,
  ): Promise<SingleFormulaResult> {
    const impl = this.implementations.get(formulaId);
    if (!impl) {
      throw new Error(`No implementation registered for formula: ${formulaId}`);
    }

    // Run all registered snippets to populate snippet results
    const localSnippetResults: Record<string, Record<string, SnippetResult>> = {};

    for (const [snippetId, snippetImpl] of this.snippetImplementations) {
      localSnippetResults[snippetId] = {};

      for (const feeEarner of context.feeEarners) {
        const entityId = resolveEntityId(feeEarner.lawyerId, feeEarner.lawyerName);
        const override = context.feeEarnerOverrides[entityId];
        try {
          const result = snippetImpl.execute({
            feeEarner,
            firmConfig: context.firmConfig,
            feeEarnerOverride: override,
          });
          localSnippetResults[snippetId][entityId] = result;
        } catch (err) {
          localSnippetResults[snippetId][entityId] = {
            snippetId,
            entityId,
            value: null,
            nullReason: `Snippet execution error: ${errorMessage(err)}`,
          };
        }
      }
    }

    // Merge newly-computed snippet results into a context copy (non-mutating)
    const executionContext: FormulaContext = {
      ...context,
      snippetResults: {
        ...context.snippetResults,
        ...localSnippetResults,
      },
    };

    const result = impl.execute(executionContext);

    return { result, snippetResults: localSnippetResults };
  }
}

// =============================================================================
// Private Helpers
// =============================================================================

/** Derive a stable entity ID for a fee earner (prefer lawyerId over name). */
function resolveEntityId(
  lawyerId: string | undefined,
  lawyerName: string | undefined,
): string {
  return lawyerId ?? lawyerName ?? 'unknown';
}

/** Extract a safe error message string from an unknown caught value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
