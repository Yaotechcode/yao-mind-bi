/**
 * built-in-formulas.test.ts
 *
 * Structural integrity tests for the built-in formula and snippet definition registries.
 * Verifies ID uniqueness, dependency graph validity (no cycles, no dangling refs),
 * type correctness, and contract completeness.
 */

import { describe, it, expect } from 'vitest';
import { getBuiltInFormulaDefinitions } from '../../../src/shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../../../src/shared/formulas/built-in-snippets.js';
import { EntityType } from '../../../src/shared/types/index.js';
import type {
  FormulaCategory,
  FormulaResultType,
  AggregationLevel,
} from '../../../src/shared/formulas/types.js';

// =============================================================================
// Helpers
// =============================================================================

const VALID_CATEGORIES: FormulaCategory[] = [
  'utilisation', 'revenue', 'leakage', 'profitability', 'budget', 'debtors', 'composite',
];

const VALID_RESULT_TYPES: FormulaResultType[] = [
  'percentage', 'currency', 'days', 'hours', 'score', 'ratio', 'boolean', 'count',
];

const VALID_AGGREGATION_LEVELS: AggregationLevel[] = [
  'record', 'feeEarner', 'matter', 'department', 'firm',
];

const VALID_ENTITY_TYPES: EntityType[] = Object.values(EntityType);

/** Detects cycles in a dependency graph using DFS. Returns cycle node IDs if found. */
function detectCycle(
  nodeId: string,
  deps: Map<string, string[]>,
  visited: Set<string>,
  stack: Set<string>,
): string[] {
  visited.add(nodeId);
  stack.add(nodeId);

  for (const dep of (deps.get(nodeId) ?? [])) {
    if (!visited.has(dep)) {
      const cycle = detectCycle(dep, deps, visited, stack);
      if (cycle.length > 0) return cycle;
    } else if (stack.has(dep)) {
      return [dep];
    }
  }

  stack.delete(nodeId);
  return [];
}

// =============================================================================
// Load definitions once
// =============================================================================

const formulas = getBuiltInFormulaDefinitions();
const snippets = getBuiltInSnippetDefinitions();

// Combined set of all known IDs for dependency validation
const allFormulaIds = new Set(formulas.map((f) => f.formulaId));
const allSnippetIds = new Set(snippets.map((s) => s.snippetId));
const allKnownIds = new Set([...allFormulaIds, ...allSnippetIds]);

// =============================================================================
// Formula registry — count and uniqueness
// =============================================================================

describe('getBuiltInFormulaDefinitions', () => {
  it('returns exactly 23 formulas', () => {
    expect(formulas).toHaveLength(23);
  });

  it('all formulaIds are unique', () => {
    const ids = formulas.map((f) => f.formulaId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all formulaIds follow the F-XX-NN pattern', () => {
    const pattern = /^F-[A-Z]{2}-\d{2}$/;
    for (const f of formulas) {
      expect(f.formulaId, `${f.formulaId} does not match F-XX-NN`).toMatch(pattern);
    }
  });

  it('all names are non-empty strings', () => {
    for (const f of formulas) {
      expect(typeof f.name).toBe('string');
      expect(f.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('all descriptions are non-empty strings', () => {
    for (const f of formulas) {
      expect(typeof f.description).toBe('string');
      expect(f.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('all formulaType values are "built_in"', () => {
    for (const f of formulas) {
      expect(f.formulaType).toBe('built_in');
    }
  });
});

// =============================================================================
// Formula — enum field validity
// =============================================================================

describe('formula enum fields', () => {
  it('all categories are valid FormulaCategory values', () => {
    for (const f of formulas) {
      expect(VALID_CATEGORIES, `${f.formulaId} has invalid category "${f.category}"`).toContain(f.category);
    }
  });

  it('all entityTypes are valid EntityType enum values', () => {
    for (const f of formulas) {
      expect(VALID_ENTITY_TYPES, `${f.formulaId} has invalid entityType "${f.entityType}"`).toContain(f.entityType);
    }
  });

  it('all resultTypes are valid FormulaResultType values', () => {
    for (const f of formulas) {
      expect(VALID_RESULT_TYPES, `${f.formulaId} has invalid resultType "${f.resultType}"`).toContain(f.resultType);
    }
  });

  it('all definition.aggregationLevel values are valid', () => {
    for (const f of formulas) {
      expect(
        VALID_AGGREGATION_LEVELS,
        `${f.formulaId} has invalid aggregationLevel "${f.definition.aggregationLevel}"`,
      ).toContain(f.definition.aggregationLevel);
    }
  });
});

// =============================================================================
// Formula — definition object completeness
// =============================================================================

describe('formula definition objects', () => {
  it('all definitions have a non-empty approach string', () => {
    for (const f of formulas) {
      expect(typeof f.definition.approach).toBe('string');
      expect(f.definition.approach.trim().length, `${f.formulaId} approach is empty`).toBeGreaterThan(0);
    }
  });

  it('all definitions have a non-empty nullHandling string', () => {
    for (const f of formulas) {
      expect(typeof f.definition.nullHandling).toBe('string');
      expect(f.definition.nullHandling.trim().length, `${f.formulaId} nullHandling is empty`).toBeGreaterThan(0);
    }
  });

  it('modifiers is always an empty array', () => {
    for (const f of formulas) {
      expect(Array.isArray(f.modifiers)).toBe(true);
      expect(f.modifiers).toHaveLength(0);
    }
  });
});

// =============================================================================
// Formula — variants contract
// =============================================================================

describe('formula variants', () => {
  it('every formula has at least one variant', () => {
    for (const f of formulas) {
      const keys = Object.keys(f.variants);
      expect(keys.length, `${f.formulaId} has no variants`).toBeGreaterThan(0);
    }
  });

  it('activeVariant key exists in variants map', () => {
    for (const f of formulas) {
      expect(
        f.variants,
        `${f.formulaId} activeVariant "${f.activeVariant}" not in variants`,
      ).toHaveProperty(f.activeVariant);
    }
  });

  it('every variant has non-empty name, description, and logic', () => {
    for (const f of formulas) {
      for (const [key, variant] of Object.entries(f.variants)) {
        expect(variant.name.trim().length, `${f.formulaId}.variants.${key}.name is empty`).toBeGreaterThan(0);
        expect(variant.description.trim().length, `${f.formulaId}.variants.${key}.description is empty`).toBeGreaterThan(0);
        expect(variant.logic.trim().length, `${f.formulaId}.variants.${key}.logic is empty`).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// Formula — displayConfig
// =============================================================================

describe('formula displayConfig', () => {
  it('every formula has a displayConfig with a non-empty dashboard', () => {
    for (const f of formulas) {
      expect(f.displayConfig, `${f.formulaId} missing displayConfig`).toBeDefined();
      expect(typeof f.displayConfig.dashboard).toBe('string');
      expect(f.displayConfig.dashboard.trim().length, `${f.formulaId} displayConfig.dashboard is empty`).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Formula — dependency graph
// =============================================================================

describe('formula dependency graph', () => {
  it('all dependsOn references point to known formula or snippet IDs', () => {
    for (const f of formulas) {
      for (const dep of f.dependsOn) {
        expect(
          allKnownIds.has(dep),
          `${f.formulaId} depends on unknown ID "${dep}"`,
        ).toBe(true);
      }
    }
  });

  it('dependency graph is acyclic (no circular dependencies)', () => {
    const depMap = new Map<string, string[]>();
    for (const f of formulas) {
      depMap.set(f.formulaId, f.dependsOn);
    }
    for (const s of snippets) {
      depMap.set(s.snippetId, s.dependsOn);
    }

    const visited = new Set<string>();
    for (const nodeId of depMap.keys()) {
      if (!visited.has(nodeId)) {
        const cycle = detectCycle(nodeId, depMap, visited, new Set());
        expect(cycle, `Cycle detected involving "${nodeId}": ${cycle.join(' → ')}`).toHaveLength(0);
      }
    }
  });
});

// =============================================================================
// Snippet registry — count and uniqueness
// =============================================================================

describe('getBuiltInSnippetDefinitions', () => {
  it('returns exactly 5 snippets', () => {
    expect(snippets).toHaveLength(5);
  });

  it('all snippetIds are unique', () => {
    const ids = snippets.map((s) => s.snippetId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all snippetIds follow the SN-NNN pattern', () => {
    const pattern = /^SN-\d{3}$/;
    for (const s of snippets) {
      expect(s.snippetId, `${s.snippetId} does not match SN-NNN`).toMatch(pattern);
    }
  });

  it('all names are non-empty strings', () => {
    for (const s of snippets) {
      expect(typeof s.name).toBe('string');
      expect(s.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('all descriptions are non-empty strings', () => {
    for (const s of snippets) {
      expect(typeof s.description).toBe('string');
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Snippet — enum field validity
// =============================================================================

describe('snippet enum fields', () => {
  it('all entityTypes are valid EntityType enum values', () => {
    for (const s of snippets) {
      expect(VALID_ENTITY_TYPES, `${s.snippetId} has invalid entityType "${s.entityType}"`).toContain(s.entityType);
    }
  });

  it('all resultTypes are valid FormulaResultType values', () => {
    for (const s of snippets) {
      expect(VALID_RESULT_TYPES, `${s.snippetId} has invalid resultType "${s.resultType}"`).toContain(s.resultType);
    }
  });

  it('all definition.aggregationLevel values are valid', () => {
    for (const s of snippets) {
      expect(
        VALID_AGGREGATION_LEVELS,
        `${s.snippetId} has invalid aggregationLevel "${s.definition.aggregationLevel}"`,
      ).toContain(s.definition.aggregationLevel);
    }
  });
});

// =============================================================================
// Snippet — definition object completeness
// =============================================================================

describe('snippet definition objects', () => {
  it('all definitions have a non-empty approach string', () => {
    for (const s of snippets) {
      expect(typeof s.definition.approach).toBe('string');
      expect(s.definition.approach.trim().length, `${s.snippetId} approach is empty`).toBeGreaterThan(0);
    }
  });

  it('all definitions have a non-empty nullHandling string', () => {
    for (const s of snippets) {
      expect(typeof s.definition.nullHandling).toBe('string');
      expect(s.definition.nullHandling.trim().length, `${s.snippetId} nullHandling is empty`).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Snippet — dependency graph
// =============================================================================

describe('snippet dependency graph', () => {
  it('all snippet dependsOn references point to known snippet IDs', () => {
    for (const s of snippets) {
      for (const dep of s.dependsOn) {
        expect(
          allSnippetIds.has(dep),
          `${s.snippetId} depends on unknown snippet ID "${dep}"`,
        ).toBe(true);
      }
    }
  });
});

// =============================================================================
// Cross-registry — no ID collisions between formulas and snippets
// =============================================================================

describe('cross-registry ID uniqueness', () => {
  it('formula IDs and snippet IDs do not overlap', () => {
    for (const formulaId of allFormulaIds) {
      expect(
        allSnippetIds.has(formulaId),
        `ID "${formulaId}" exists in both formula and snippet registries`,
      ).toBe(false);
    }
  });
});
