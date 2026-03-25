import { describe, it, expect } from 'vitest';
import {
  buildDependencyGraph,
  topologicalSort,
  buildExecutionPlan,
} from '../../../src/server/formula-engine/dependency-graph.js';
import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
} from '../../../src/shared/formulas/types.js';
import { EntityType } from '../../../src/shared/types/index.js';

// ---------------------------------------------------------------------------
// Helpers — minimal stubs that satisfy the type
// ---------------------------------------------------------------------------

function makeFormula(
  formulaId: string,
  dependsOn: string[] = [],
): BuiltInFormulaDefinition {
  return {
    formulaId,
    name: formulaId,
    description: '',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach: '',
      nullHandling: 'return null',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: { default: { name: 'Default', description: '', logic: '' } },
    modifiers: [],
    dependsOn,
    displayConfig: { dashboard: 'test' },
  };
}

function makeSnippet(
  snippetId: string,
  dependsOn: string[] = [],
): BuiltInSnippetDefinition {
  return {
    snippetId,
    name: snippetId,
    description: '',
    entityType: EntityType.FEE_EARNER,
    resultType: 'number',
    definition: {
      approach: '',
      nullHandling: 'return null',
      aggregationLevel: 'feeEarner',
    },
    dependsOn,
  };
}

// ---------------------------------------------------------------------------
// buildDependencyGraph
// ---------------------------------------------------------------------------

describe('buildDependencyGraph', () => {
  it('registers all nodes from formulas and snippets', () => {
    const formulas = [makeFormula('F-A'), makeFormula('F-B')];
    const snippets = [makeSnippet('SN-001')];
    const graph = buildDependencyGraph(formulas, snippets);

    expect(graph.nodes.has('F-A')).toBe(true);
    expect(graph.nodes.has('F-B')).toBe(true);
    expect(graph.nodes.has('SN-001')).toBe(true);
    expect(graph.snippetIds.has('SN-001')).toBe(true);
    expect(graph.snippetIds.has('F-A')).toBe(false);
  });

  it('correctly builds in-degrees from dependsOn declarations', () => {
    // F-A depends on SN-001 → SN-001 has no dependencies, F-A has in-degree 1
    const formulas = [makeFormula('F-A', ['SN-001'])];
    const snippets = [makeSnippet('SN-001')];
    const graph = buildDependencyGraph(formulas, snippets);

    expect(graph.inDegree.get('SN-001')).toBe(0);
    expect(graph.inDegree.get('F-A')).toBe(1);
  });

  it('silently ignores dependencies that are not registered', () => {
    const formulas = [makeFormula('F-A', ['UNKNOWN-DEP'])];
    const snippets: BuiltInSnippetDefinition[] = [];
    const graph = buildDependencyGraph(formulas, snippets);

    // F-A has no valid edges — in-degree stays 0
    expect(graph.inDegree.get('F-A')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe('topologicalSort', () => {
  it('simple chain: C has no deps, B depends on C, A depends on B → order C B A', () => {
    // A depends on B, B depends on C, C has no deps
    const formulas = [
      makeFormula('A', ['B']),
      makeFormula('B', ['C']),
      makeFormula('C'),
    ];
    const graph = buildDependencyGraph(formulas, []);
    const { order, circularDependencies } = topologicalSort(graph);

    expect(circularDependencies).toHaveLength(0);
    // C must come before B, B must come before A
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('A'));
  });

  it('diamond: D has no deps; B and C both depend on D; A depends on B and C → D first, A last', () => {
    // A depends on B and C; B and C both depend on D
    const formulas = [
      makeFormula('A', ['B', 'C']),
      makeFormula('B', ['D']),
      makeFormula('C', ['D']),
      makeFormula('D'),
    ];
    const graph = buildDependencyGraph(formulas, []);
    const { order, circularDependencies } = topologicalSort(graph);

    expect(circularDependencies).toHaveLength(0);
    expect(order[0]).toBe('D'); // D has no dependencies
    expect(order[order.length - 1]).toBe('A'); // A depends on everything
    // B and C both come before A
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('A'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('A'));
  });

  it('detects direct circular dependency: A → B → A', () => {
    const formulas = [
      makeFormula('A', ['B']),
      makeFormula('B', ['A']),
    ];
    const graph = buildDependencyGraph(formulas, []);
    const { order, circularDependencies } = topologicalSort(graph);

    // Neither A nor B can be scheduled
    expect(order).toHaveLength(0);
    expect(circularDependencies).toHaveLength(1);
    expect(circularDependencies[0]).toContain('A');
    expect(circularDependencies[0]).toContain('B');
  });

  it('detects indirect circular dependency: A → B → C → A', () => {
    const formulas = [
      makeFormula('A', ['B']),
      makeFormula('B', ['C']),
      makeFormula('C', ['A']),
    ];
    const graph = buildDependencyGraph(formulas, []);
    const { order, circularDependencies } = topologicalSort(graph);

    expect(order).toHaveLength(0);
    expect(circularDependencies).toHaveLength(1);
    expect(circularDependencies[0]).toContain('A');
    expect(circularDependencies[0]).toContain('B');
    expect(circularDependencies[0]).toContain('C');
  });

  it('partial cycle: independent node D is still scheduled despite A → B → A cycle', () => {
    const formulas = [
      makeFormula('A', ['B']),
      makeFormula('B', ['A']),
      makeFormula('D'), // no dependencies — not in cycle
    ];
    const graph = buildDependencyGraph(formulas, []);
    const { order, circularDependencies } = topologicalSort(graph);

    expect(order).toContain('D');
    expect(order).not.toContain('A');
    expect(order).not.toContain('B');
    expect(circularDependencies[0]).toContain('A');
  });
});

// ---------------------------------------------------------------------------
// Snippets always before formulas
// ---------------------------------------------------------------------------

describe('snippet ordering invariant', () => {
  it('independent snippet and formula: snippet comes first', () => {
    const formulas = [makeFormula('F-TU-01')];
    const snippets = [makeSnippet('SN-001')];
    // No dependency declared — but snippets should still sort before formulas
    const graph = buildDependencyGraph(formulas, snippets);
    const { order } = topologicalSort(graph);

    expect(order.indexOf('SN-001')).toBeLessThan(order.indexOf('F-TU-01'));
  });

  it('snippet that a formula depends on comes before the formula', () => {
    const formulas = [makeFormula('F-TU-01', ['SN-001'])];
    const snippets = [makeSnippet('SN-001')];
    const graph = buildDependencyGraph(formulas, snippets);
    const { order } = topologicalSort(graph);

    expect(order.indexOf('SN-001')).toBeLessThan(order.indexOf('F-TU-01'));
  });

  it('snippet chain: SN-002 depends on SN-001 → SN-001 first', () => {
    const formulas: BuiltInFormulaDefinition[] = [];
    const snippets = [
      makeSnippet('SN-001'),
      makeSnippet('SN-002', ['SN-001']),
    ];
    const graph = buildDependencyGraph(formulas, snippets);
    const { order } = topologicalSort(graph);

    expect(order.indexOf('SN-001')).toBeLessThan(order.indexOf('SN-002'));
  });
});

// ---------------------------------------------------------------------------
// buildExecutionPlan
// ---------------------------------------------------------------------------

describe('buildExecutionPlan', () => {
  it('separates snippets and formulas into separate ordered lists', () => {
    const formulas = [makeFormula('F-TU-01', ['SN-001'])];
    const snippets = [makeSnippet('SN-001')];
    const plan = buildExecutionPlan(formulas, snippets);

    expect(plan.snippetOrder).toEqual(['SN-001']);
    expect(plan.formulaOrder).toEqual(['F-TU-01']);
    expect(plan.skippedFormulas).toHaveLength(0);
    expect(plan.circularDependencies).toHaveLength(0);
  });

  it('reports circular-dependency formulas in skippedFormulas', () => {
    const formulas = [makeFormula('F-A', ['F-B']), makeFormula('F-B', ['F-A'])];
    const snippets: BuiltInSnippetDefinition[] = [];
    const plan = buildExecutionPlan(formulas, snippets);

    expect(plan.circularDependencies).toHaveLength(1);
    const skippedIds = plan.skippedFormulas.map((s) => s.formulaId);
    expect(skippedIds).toContain('F-A');
    expect(skippedIds).toContain('F-B');
  });

  it('empty input produces empty plan', () => {
    const plan = buildExecutionPlan([], []);
    expect(plan.snippetOrder).toHaveLength(0);
    expect(plan.formulaOrder).toHaveLength(0);
    expect(plan.skippedFormulas).toHaveLength(0);
    expect(plan.circularDependencies).toHaveLength(0);
  });
});
