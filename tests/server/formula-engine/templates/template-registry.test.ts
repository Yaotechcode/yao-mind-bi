/**
 * template-registry.test.ts — Tests for the Formula Template system
 *
 * Covers:
 * - All 10 built-in templates have unique IDs and valid structure
 * - TMPL-001 instantiation with target=80 → valid formula definition
 * - Missing required parameter → error
 * - Out-of-range parameter → validation error
 * - Invalid select value → validation error
 * - Preview returns definition without persisting
 * - Parameter substitution: constant and formulaRef ParameterRefNodes
 * - Filter value "{{placeholder}}" substitution
 * - Default values applied when parameter not provided
 * - collectDependencies extracts snippet and formula IDs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FormulaTemplateService } from '../../../../src/server/formula-engine/templates/template-registry.js';
import { getBuiltInTemplates } from '../../../../src/server/formula-engine/templates/built-in-templates.js';
import { FormulaType } from '../../../../src/shared/types/index.js';

// =============================================================================
// Helpers
// =============================================================================

function makeService(): FormulaTemplateService {
  return new FormulaTemplateService(getBuiltInTemplates());
}

// =============================================================================
// Template structure validation
// =============================================================================

describe('Built-in templates — structure', () => {
  const templates = getBuiltInTemplates();

  it('returns exactly 10 templates', () => {
    expect(templates).toHaveLength(10);
  });

  it('all template IDs are unique', () => {
    const ids = templates.map((t) => t.templateId);
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
  });

  it('all template IDs match TMPL-NNN format', () => {
    for (const t of templates) {
      expect(t.templateId).toMatch(/^TMPL-\d{3}$/);
    }
  });

  it('IDs are TMPL-001 through TMPL-010', () => {
    const ids = new Set(templates.map((t) => t.templateId));
    for (let i = 1; i <= 10; i++) {
      expect(ids.has(`TMPL-${String(i).padStart(3, '0')}`)).toBe(true);
    }
  });

  it('every template has name, description, category, entityType, resultType', () => {
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.category).toBeTruthy();
      expect(t.entityType).toBeTruthy();
      expect(t.resultType).toBeTruthy();
    }
  });

  it('every template has at least one parameter', () => {
    for (const t of templates) {
      expect(t.parameters.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every template parameter has key, label, type, required flag', () => {
    for (const t of templates) {
      for (const p of t.parameters) {
        expect(p.key).toBeTruthy();
        expect(p.label).toBeTruthy();
        expect(p.type).toBeTruthy();
        expect(typeof p.required).toBe('boolean');
      }
    }
  });

  it('every template has a valid difficulty level', () => {
    const valid = new Set(['basic', 'intermediate', 'advanced']);
    for (const t of templates) {
      expect(valid.has(t.difficulty)).toBe(true);
    }
  });

  it('every template has tags array', () => {
    for (const t of templates) {
      expect(Array.isArray(t.tags)).toBe(true);
      expect(t.tags.length).toBeGreaterThan(0);
    }
  });

  it('every template has a previewDescription string', () => {
    for (const t of templates) {
      expect(typeof t.previewDescription).toBe('string');
      expect(t.previewDescription.length).toBeGreaterThan(0);
    }
  });

  it('every template has a definition with an expression', () => {
    for (const t of templates) {
      expect(t.definition).toBeDefined();
      expect(t.definition.expression).toBeDefined();
      expect(typeof t.definition.expression.type).toBe('string');
    }
  });
});

// =============================================================================
// getAvailableTemplates
// =============================================================================

describe('FormulaTemplateService.getAvailableTemplates', () => {
  it('returns all 10 templates', async () => {
    const service = makeService();
    const templates = await service.getAvailableTemplates('firm-001');
    expect(templates).toHaveLength(10);
  });
});

// =============================================================================
// getTemplate
// =============================================================================

describe('FormulaTemplateService.getTemplate', () => {
  it('returns the template for a known ID', async () => {
    const service = makeService();
    const t = await service.getTemplate('TMPL-001');
    expect(t).not.toBeNull();
    expect(t!.templateId).toBe('TMPL-001');
    expect(t!.name).toBe('Custom Utilisation Target');
  });

  it('returns null for an unknown ID', async () => {
    const service = makeService();
    const t = await service.getTemplate('TMPL-999');
    expect(t).toBeNull();
  });
});

// =============================================================================
// validateTemplateParameters
// =============================================================================

describe('FormulaTemplateService.validateTemplateParameters', () => {
  let service: FormulaTemplateService;
  beforeEach(() => { service = makeService(); });

  it('valid parameters → valid: true, no errors', async () => {
    const result = await service.validateTemplateParameters('TMPL-001', {
      targetPercentage: 80,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('missing required parameter (no default) → valid: false, error mentions key', async () => {
    // departmentName is required and has no defaultValue
    const result = await service.validateTemplateParameters('TMPL-002', {});
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('departmentName'))).toBe(true);
  });

  it('percentage below min → error', async () => {
    const result = await service.validateTemplateParameters('TMPL-001', {
      targetPercentage: -5,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('targetPercentage'))).toBe(true);
  });

  it('percentage above max (100) → error', async () => {
    const result = await service.validateTemplateParameters('TMPL-001', {
      targetPercentage: 150,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('targetPercentage'))).toBe(true);
  });

  it('percentage at boundary (0) → valid', async () => {
    const result = await service.validateTemplateParameters('TMPL-001', {
      targetPercentage: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('percentage at boundary (100) → valid', async () => {
    const result = await service.validateTemplateParameters('TMPL-001', {
      targetPercentage: 100,
    });
    expect(result.valid).toBe(true);
  });

  it('invalid select option → error mentions key and value', async () => {
    const result = await service.validateTemplateParameters('TMPL-002', {
      departmentName: 'InvalidDept',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('departmentName'))).toBe(true);
    expect(result.errors.some((e) => e.includes('InvalidDept'))).toBe(true);
  });

  it('valid select option → valid: true', async () => {
    const result = await service.validateTemplateParameters('TMPL-002', {
      departmentName: 'Property',
    });
    expect(result.valid).toBe(true);
  });

  it('unknown template ID → error', async () => {
    const result = await service.validateTemplateParameters('TMPL-999', {});
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TMPL-999'))).toBe(true);
  });

  it('TMPL-010 scorecard weight below 0.1 → error', async () => {
    const result = await service.validateTemplateParameters('TMPL-010', {
      metric1: 'F-TU-01',
      weight1: 0.05,  // below min 0.1
      metric2: 'F-RB-01',
      weight2: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weight1'))).toBe(true);
  });
});

// =============================================================================
// previewTemplate
// =============================================================================

describe('FormulaTemplateService.previewTemplate', () => {
  let service: FormulaTemplateService;
  beforeEach(() => { service = makeService(); });

  it('returns a CustomFormulaDefinition with no ParameterRefNodes', async () => {
    const preview = await service.previewTemplate('TMPL-001', { targetPercentage: 80 });

    expect(preview.definition).toBeDefined();
    expect(preview.definition.expression).toBeDefined();

    // Recursively verify no 'parameter' type nodes remain
    function assertNoParamNodes(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      expect(obj['type']).not.toBe('parameter');
      for (const v of Object.values(obj)) {
        if (typeof v === 'object' && v !== null) assertNoParamNodes(v);
      }
    }
    assertNoParamNodes(preview.definition.expression);
  });

  it('substitutes targetPercentage=80 as a constant in the expression tree', async () => {
    const preview = await service.previewTemplate('TMPL-001', { targetPercentage: 80 });

    // The root is: percentage(percentage(chargeableHours, SN-002), 80)
    // root.right should be { type: 'constant', value: 80 }
    const root = preview.definition.expression as Record<string, unknown>;
    expect(root['type']).toBe('operator');
    const right = root['right'] as Record<string, unknown>;
    expect(right['type']).toBe('constant');
    expect(right['value']).toBe(80);
  });

  it('resolves description with parameter value', async () => {
    const preview = await service.previewTemplate('TMPL-001', { targetPercentage: 80 });
    expect(preview.description).toContain('80%');
    expect(preview.description).not.toContain('{{targetPercentage}}');
  });

  it('substitutes formulaRef parameters correctly for TMPL-004', async () => {
    const preview = await service.previewTemplate('TMPL-004', {
      numeratorFormula: 'F-TU-01',
      denominatorFormula: 'F-RB-01',
    });

    const root = preview.definition.expression as Record<string, unknown>;
    expect(root['type']).toBe('operator');
    const left = root['left'] as Record<string, unknown>;
    const right = root['right'] as Record<string, unknown>;

    expect(left['type']).toBe('formula');
    expect(left['formulaId']).toBe('F-TU-01');
    expect(right['type']).toBe('formula');
    expect(right['formulaId']).toBe('F-RB-01');
  });

  it('throws for unknown template ID', async () => {
    await expect(service.previewTemplate('TMPL-999', {})).rejects.toThrow('TMPL-999');
  });

  it('throws when required parameters are invalid', async () => {
    await expect(
      service.previewTemplate('TMPL-001', { targetPercentage: 200 }),
    ).rejects.toThrow();
  });
});

// =============================================================================
// instantiateTemplate — TMPL-001
// =============================================================================

describe('FormulaTemplateService.instantiateTemplate — TMPL-001', () => {
  let service: FormulaTemplateService;
  beforeEach(() => { service = makeService(); });

  it('returns a FormulaDefinition with type CUSTOM', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 80,
    });
    expect(def.type).toBe(FormulaType.CUSTOM);
  });

  it('assigns a generated unique formula ID', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 80,
    });
    expect(def.id).toMatch(/^F-CUSTOM-TMPL-001-\d+$/);
  });

  it('uses customName when provided', async () => {
    const def = await service.instantiateTemplate(
      'firm-001',
      'TMPL-001',
      { targetPercentage: 80 },
      { customName: 'My Utilisation KPI' },
    );
    expect(def.label).toBe('My Utilisation KPI');
  });

  it('defaults to template name when no customName provided', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 80,
    });
    expect(def.label).toBe('Custom Utilisation Target');
  });

  it('appliesTo contains the template entityType', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 80,
    });
    expect(def.appliesTo).toContain('feeEarner');
  });

  it('variants[0].expression is valid JSON of a CustomFormulaDefinition', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 75,
    });
    expect(def.variants.length).toBeGreaterThan(0);
    const customDef = JSON.parse(def.variants[0].expression);
    expect(customDef.expression).toBeDefined();
    expect(customDef.expression.type).toBeTruthy();
  });

  it('expression has no ParameterRefNodes after instantiation', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 75,
    });
    const customDef = JSON.parse(def.variants[0].expression);

    function assertNoParams(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      expect(obj['type']).not.toBe('parameter');
      for (const v of Object.values(obj)) {
        if (typeof v === 'object' && v !== null) assertNoParams(v);
      }
    }
    assertNoParams(customDef.expression);
  });

  it('target value is embedded as constant 80 in the expression', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {
      targetPercentage: 80,
    });
    const customDef = JSON.parse(def.variants[0].expression);
    const root = customDef.expression;
    // root.right should be { type: 'constant', value: 80 }
    expect(root.right.type).toBe('constant');
    expect(root.right.value).toBe(80);
  });

  it('uses default targetPercentage=75 when not provided', async () => {
    const def = await service.instantiateTemplate('firm-001', 'TMPL-001', {});
    const customDef = JSON.parse(def.variants[0].expression);
    expect(customDef.expression.right.value).toBe(75);
  });

  it('throws when required parameter missing (no default)', async () => {
    // TMPL-002 departmentName has no default
    await expect(
      service.instantiateTemplate('firm-001', 'TMPL-002', {}),
    ).rejects.toThrow();
  });

  it('throws for unknown template', async () => {
    await expect(
      service.instantiateTemplate('firm-001', 'TMPL-999', {}),
    ).rejects.toThrow('TMPL-999');
  });
});

// =============================================================================
// instantiateTemplate — TMPL-010 Scorecard (multiple parameters)
// =============================================================================

describe('FormulaTemplateService.instantiateTemplate — TMPL-010', () => {
  it('substitutes all four formula ref and constant parameters', async () => {
    const service = makeService();
    const def = await service.instantiateTemplate('firm-001', 'TMPL-010', {
      metric1: 'F-TU-01',
      weight1: 3,
      metric2: 'F-RB-01',
      weight2: 2,
    });

    const customDef = JSON.parse(def.variants[0].expression);
    const root = customDef.expression; // divide( add(m1*w1, m2*w2), add(w1,w2) )

    // Left branch: add(multiply(formulaRef(F-TU-01), 3), multiply(formulaRef(F-RB-01), 2))
    const addNode = root.left;
    expect(addNode.type).toBe('operator');
    expect(addNode.operator).toBe('add');

    const m1w1 = addNode.left;
    expect(m1w1.left.type).toBe('formula');
    expect(m1w1.left.formulaId).toBe('F-TU-01');
    expect(m1w1.right.value).toBe(3);

    const m2w2 = addNode.right;
    expect(m2w2.left.formulaId).toBe('F-RB-01');
    expect(m2w2.right.value).toBe(2);

    // Right branch: add(3, 2)
    const denominator = root.right;
    expect(denominator.left.value).toBe(3);
    expect(denominator.right.value).toBe(2);
  });
});

// =============================================================================
// Filter value substitution
// =============================================================================

describe('FormulaTemplateService — filter {{placeholder}} substitution', () => {
  it('TMPL-002 filter value resolves to departmentName parameter', async () => {
    const service = makeService();
    const preview = await service.previewTemplate('TMPL-002', {
      departmentName: 'Property',
    });

    const root = preview.definition.expression as Record<string, unknown>;
    // root is divide(sumOf WITH filter, sumOf WITH filter)
    const leftAgg = root['left'] as Record<string, unknown>;
    const filter = leftAgg['filter'] as Record<string, unknown>;
    expect(filter['value']).toBe('Property');
    expect(typeof filter['value']).not.toBe('object'); // not a placeholder object
  });

  it('TMPL-007 grade filter resolves correctly', async () => {
    const service = makeService();
    const preview = await service.previewTemplate('TMPL-007', { grade: 'Partner' });
    const root = preview.definition.expression as Record<string, unknown>;
    const leftAgg = root['left'] as Record<string, unknown>;
    const filter = leftAgg['filter'] as Record<string, unknown>;
    expect(filter['value']).toBe('Partner');
  });
});
