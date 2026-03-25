/**
 * dependency-graph.ts — Formula engine dependency graph + topological sort
 *
 * Builds a DAG from formula/snippet dependsOn declarations and produces
 * an execution order where every dependency runs before its dependents.
 *
 * Uses Kahn's algorithm (BFS-based topological sort):
 *   - Nodes with no remaining dependencies are processed first
 *   - Snippets are always prioritised over formulas when both are ready
 *   - Nodes that remain unprocessed after BFS form a cycle
 */

import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
} from '../../shared/formulas/types.js';
import type { ExecutionPlan } from './types.js';

// =============================================================================
// Graph Structure
// =============================================================================

export interface DependencyGraph {
  /** All node IDs (formula IDs + snippet IDs). */
  nodes: Set<string>;
  /**
   * adjacency[A] = [B, C] means "once A is computed, B and C may proceed".
   * Edge direction: dependency → dependent.
   */
  adjacency: Map<string, string[]>;
  /** Number of unmet dependencies for each node. */
  inDegree: Map<string, number>;
  /** Which nodes are snippets (vs formulas). */
  snippetIds: Set<string>;
}

// =============================================================================
// Graph Builder
// =============================================================================

/**
 * Build a dependency graph from formula and snippet definitions.
 * Reads each definition's `dependsOn` array to construct directed edges.
 *
 * Edge semantics: "A dependsOn B" → B must execute before A.
 * Graph edge: B → A (B enables A).
 */
export function buildDependencyGraph(
  formulas: BuiltInFormulaDefinition[],
  snippets: BuiltInSnippetDefinition[],
): DependencyGraph {
  const nodes = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const snippetIds = new Set<string>(snippets.map((s) => s.snippetId));

  // Register all nodes with zero in-degree and empty adjacency lists
  for (const snippet of snippets) {
    nodes.add(snippet.snippetId);
    adjacency.set(snippet.snippetId, []);
    inDegree.set(snippet.snippetId, 0);
  }
  for (const formula of formulas) {
    nodes.add(formula.formulaId);
    adjacency.set(formula.formulaId, []);
    inDegree.set(formula.formulaId, 0);
  }

  // Build edges from dependsOn declarations
  const allNodes: Array<{ id: string; dependsOn: string[] }> = [
    ...snippets.map((s) => ({ id: s.snippetId, dependsOn: s.dependsOn })),
    ...formulas.map((f) => ({ id: f.formulaId, dependsOn: f.dependsOn })),
  ];

  for (const { id, dependsOn } of allNodes) {
    for (const dep of dependsOn) {
      if (!nodes.has(dep)) {
        // Dependency declared but not in our registry — skip (may be from a
        // future phase or external source; the readiness checker handles this)
        continue;
      }
      // dep must execute before id: add edge dep → id
      adjacency.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  return { nodes, adjacency, inDegree, snippetIds };
}

// =============================================================================
// Topological Sort
// =============================================================================

/**
 * Kahn's algorithm topological sort.
 *
 * Returns node IDs in execution order — every dependency appears before the
 * nodes that depend on it. Snippets are prioritised over formulas when both
 * are ready at the same step.
 *
 * If circular dependencies are detected, the affected nodes are reported in
 * `circularDependencies` and are NOT included in `order`.
 */
export function topologicalSort(graph: DependencyGraph): {
  order: string[];
  circularDependencies: string[][];
} {
  // Work on a mutable copy of in-degrees — never mutate the graph
  const inDegree = new Map(graph.inDegree);

  // Stable comparator: snippets before formulas, then alphabetical
  const stableCompare = (a: string, b: string): number => {
    const aSnippet = graph.snippetIds.has(a);
    const bSnippet = graph.snippetIds.has(b);
    if (aSnippet && !bSnippet) return -1;
    if (!aSnippet && bSnippet) return 1;
    return a.localeCompare(b);
  };

  // Seed queue with all nodes that have no dependencies
  const queue: string[] = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)
    .sort(stableCompare);

  const order: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);

    // Decrement in-degree for all nodes that depended on this one
    const newlyReady: string[] = [];
    for (const consumer of graph.adjacency.get(nodeId) ?? []) {
      const newDeg = (inDegree.get(consumer) ?? 0) - 1;
      inDegree.set(consumer, newDeg);
      if (newDeg === 0) newlyReady.push(consumer);
    }

    // Insert newly-ready nodes maintaining snippet-first ordering
    newlyReady.sort(stableCompare);
    queue.push(...newlyReady);
  }

  // Any node still with in-degree > 0 is part of a cycle
  const cycleNodes = [...inDegree.entries()]
    .filter(([, deg]) => deg > 0)
    .map(([id]) => id)
    .sort();

  const circularDependencies = cycleNodes.length > 0 ? [cycleNodes] : [];

  return { order, circularDependencies };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a complete execution plan from formula and snippet definitions.
 *
 * The plan separates the sorted execution order into:
 *   - snippetOrder: snippets to run per-fee-earner before any formulas
 *   - formulaOrder: formulas to run after all snippets
 *
 * Any circular dependencies are reported in skippedFormulas.
 */
export function buildExecutionPlan(
  formulas: BuiltInFormulaDefinition[],
  snippets: BuiltInSnippetDefinition[],
): ExecutionPlan {
  const graph = buildDependencyGraph(formulas, snippets);
  const { order, circularDependencies } = topologicalSort(graph);

  const snippetOrder = order.filter((id) => graph.snippetIds.has(id));
  const formulaOrder = order.filter((id) => !graph.snippetIds.has(id));

  const skippedFormulas: { formulaId: string; reason: string }[] = [];

  if (circularDependencies.length > 0) {
    const cycleIds = new Set(circularDependencies.flat());
    const cycleDescription = circularDependencies
      .map((cycle) => cycle.join(' → '))
      .join('; ');

    for (const id of cycleIds) {
      if (!graph.snippetIds.has(id)) {
        skippedFormulas.push({
          formulaId: id,
          reason: `Part of circular dependency: ${cycleDescription}`,
        });
      }
    }
  }

  return { snippetOrder, formulaOrder, skippedFormulas, circularDependencies };
}
