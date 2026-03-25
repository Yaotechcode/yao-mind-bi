/**
 * snippet-engine.ts — Standalone snippet execution engine
 *
 * Executes built-in snippet implementations in topological dependency order.
 * Each snippet runs once per fee earner; results are accumulated and made
 * available to subsequent dependent snippets via priorSnippetResults.
 *
 * The FormulaEngine also handles snippet execution internally (for use within
 * the full formula pipeline). This class provides a standalone API for
 * snippet-only execution and preview.
 */

import type { BuiltInSnippetDefinition } from '../../../shared/formulas/types.js';
import type { AggregatedFeeEarner } from '../../../shared/types/pipeline.js';
import type { FirmConfig } from '../../../shared/types/index.js';
import type { SnippetImplementation, SnippetResult } from '../types.js';

// =============================================================================
// Public result type
// =============================================================================

export interface SnippetEngineResult {
  /** Results keyed by snippetId → entityId. */
  results: Record<string, Record<string, SnippetResult>>;
  executionTimeMs: number;
  errors: { snippetId: string; entityId: string; error: string }[];
}

// =============================================================================
// SnippetEngine
// =============================================================================

export class SnippetEngine {
  private readonly implementations = new Map<string, SnippetImplementation>();

  /** Register a snippet implementation. Replaces any existing registration. */
  registerSnippet(snippetId: string, impl: SnippetImplementation): void {
    this.implementations.set(snippetId, impl);
  }

  /**
   * Execute all registered snippets for all fee earners in dependency order.
   *
   * Uses the `dependsOn` graph in `snippetDefinitions` to determine the correct
   * execution sequence (SN-002 before SN-001, SN-001 before SN-005, etc.).
   * Accumulated results from earlier snippets are passed to later ones via
   * `priorSnippetResults` in the SnippetContext.
   *
   * Errors are caught per fee earner — one failure does not abort the run.
   */
  executeAll(
    snippetDefinitions: BuiltInSnippetDefinition[],
    feeEarners: AggregatedFeeEarner[],
    firmConfig: FirmConfig,
    feeEarnerOverrides: Record<string, Record<string, unknown>>,
  ): SnippetEngineResult {
    const startTime = Date.now();
    const results: Record<string, Record<string, SnippetResult>> = {};
    const errors: { snippetId: string; entityId: string; error: string }[] = [];

    const order = toposort(snippetDefinitions);

    for (const snippetId of order) {
      const impl = this.implementations.get(snippetId);
      if (!impl) continue; // not yet registered — skip quietly

      results[snippetId] = {};

      for (const feeEarner of feeEarners) {
        const entityId = resolveEntityId(feeEarner);
        const override = feeEarnerOverrides[entityId];

        // Provide all previously-computed results for this fee earner so that
        // dependent snippets (e.g. SN-001 reads SN-002) can access them.
        const priorSnippetResults: Record<string, SnippetResult> = {};
        for (const [sid, entityMap] of Object.entries(results)) {
          if (entityMap[entityId]) priorSnippetResults[sid] = entityMap[entityId];
        }

        try {
          const result = impl.execute({
            feeEarner,
            firmConfig,
            feeEarnerOverride: override,
            priorSnippetResults,
          });
          results[snippetId][entityId] = result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ snippetId, entityId, error: message });
          results[snippetId][entityId] = {
            snippetId,
            entityId,
            value: null,
            nullReason: `Snippet error: ${message}`,
          };
        }
      }
    }

    return { results, executionTimeMs: Date.now() - startTime, errors };
  }

  /**
   * Execute a single snippet for a single fee earner in isolation.
   *
   * Note: dependent snippets (e.g. SN-001 needs SN-002) will not have their
   * dependencies pre-computed here — pass `priorSnippetResults` in the override
   * if the caller has them, or use executeAll for the full dependency chain.
   *
   * @throws Never — returns null result with nullReason on any failure.
   */
  executeSingle(
    snippetId: string,
    feeEarner: AggregatedFeeEarner,
    firmConfig: FirmConfig,
    feeEarnerOverride?: Record<string, unknown>,
    priorSnippetResults?: Record<string, SnippetResult>,
  ): SnippetResult {
    const entityId = resolveEntityId(feeEarner);
    const impl = this.implementations.get(snippetId);

    if (!impl) {
      return {
        snippetId,
        entityId,
        value: null,
        nullReason: `No implementation registered for snippet: ${snippetId}`,
      };
    }

    try {
      return impl.execute({ feeEarner, firmConfig, feeEarnerOverride, priorSnippetResults });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { snippetId, entityId, value: null, nullReason: `Snippet error: ${message}` };
    }
  }
}

// =============================================================================
// Private helpers
// =============================================================================

function resolveEntityId(feeEarner: AggregatedFeeEarner): string {
  return feeEarner.lawyerId ?? feeEarner.lawyerName ?? 'unknown';
}

/**
 * Topological sort of snippet definitions by their `dependsOn` graph.
 * Returns snippet IDs in execution order (dependencies first).
 */
function toposort(defs: BuiltInSnippetDefinition[]): string[] {
  const defMap = new Map(defs.map((d) => [d.snippetId, d]));
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of (defMap.get(id)?.dependsOn ?? [])) {
      visit(dep);
    }
    result.push(id);
  }

  for (const def of defs) {
    visit(def.snippetId);
  }

  return result;
}
