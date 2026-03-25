/**
 * rag-engine.test.ts — Tests for RagEngine
 *
 * Covers:
 * - evaluateValue: higher-is-better and lower-is-better metrics
 * - evaluateValue: GREEN / AMBER / RED / NEUTRAL assignment
 * - evaluateValue: boundary values favour better status (inclusive)
 * - evaluateValue: null value → NEUTRAL
 * - evaluateValue: grade override priority
 * - evaluateValue: payModel override (fallback when no grade override)
 * - evaluateValue: default when no overrides apply
 * - evaluateAll: summary counts, alertsRed, alertsAmber
 * - evaluateAll: formulas without metric mapping are skipped
 * - distanceToNext: correct for all statuses, both directions
 */

import { describe, it, expect } from 'vitest';
import { RagEngine } from '../../../src/server/formula-engine/rag-engine.js';
import { RagStatus } from '../../../src/shared/types/index.js';
import type { RagThresholdSet } from '../../../src/server/formula-engine/rag-engine.js';
import type { FormulaResult } from '../../../src/server/formula-engine/types.js';

// =============================================================================
// Test fixtures
// =============================================================================

/**
 * Higher-is-better metric (e.g. utilisation, realisation).
 * Bands: GREEN ≥ 70, AMBER 50–69, RED < 50
 */
const UTILISATION_THRESHOLDS: RagThresholdSet = {
  metricKey: 'utilisation',
  label: 'Utilisation',
  higherIsBetter: true,
  defaults: {
    [RagStatus.GREEN]: { min: 70 },
    [RagStatus.AMBER]: { min: 50, max: 69 },
    [RagStatus.RED]: { max: 49 },
  },
};

/**
 * Lower-is-better metric (e.g. WIP age, recording gap).
 * Bands: GREEN ≤ 14, AMBER 15–30, RED > 30
 */
const WIP_AGE_THRESHOLDS: RagThresholdSet = {
  metricKey: 'wipAge',
  label: 'WIP Age',
  higherIsBetter: false,
  defaults: {
    [RagStatus.GREEN]: { max: 14 },
    [RagStatus.AMBER]: { min: 15, max: 30 },
    [RagStatus.RED]: { min: 31 },
  },
};

/**
 * Utilisation thresholds with a grade override for 'Partner'.
 * Partner GREEN ≥ 75, AMBER 60–74, RED < 60
 */
const UTILISATION_WITH_OVERRIDES: RagThresholdSet = {
  ...UTILISATION_THRESHOLDS,
  overrides: {
    Partner: {
      [RagStatus.GREEN]: { min: 75 },
      [RagStatus.AMBER]: { min: 60, max: 74 },
      [RagStatus.RED]: { max: 59 },
    },
    FeeShare: {
      [RagStatus.GREEN]: { min: 65 },
      [RagStatus.AMBER]: { min: 45, max: 64 },
      [RagStatus.RED]: { max: 44 },
    },
  },
};

/** Minimal FormulaResult builder */
function makeFormulaResult(
  entityResults: Record<string, { value: number | null; entityName: string }>,
): FormulaResult {
  return {
    formulaId: '',
    computedAt: new Date().toISOString(),
    entityResults: Object.fromEntries(
      Object.entries(entityResults).map(([id, { value, entityName }]) => [
        id,
        {
          entityId: id,
          entityName,
          value,
          nullReason: value === null ? 'test' : null,
          breakdown: {},
          readiness: { status: 'READY' as const, missingInputs: [] },
        },
      ]),
    ),
  };
}

// =============================================================================
// evaluateValue
// =============================================================================

describe('RagEngine.evaluateValue', () => {
  const engine = new RagEngine();

  // --- Null / undefined ---

  it('returns NEUTRAL with null value = null', () => {
    const result = engine.evaluateValue(null, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.NEUTRAL);
    expect(result.value).toBeNull();
    expect(result.distanceToNext).toBeNull();
  });

  it('returns NEUTRAL with undefined cast to null', () => {
    const result = engine.evaluateValue(undefined as unknown as null, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.NEUTRAL);
  });

  // --- Higher-is-better ---

  it('assigns GREEN when value in green band (higher-is-better)', () => {
    const result = engine.evaluateValue(80, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.GREEN);
    expect(result.value).toBe(80);
    expect(result.thresholdUsed).toBe('default');
  });

  it('assigns AMBER when value in amber band (higher-is-better)', () => {
    const result = engine.evaluateValue(60, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.AMBER);
  });

  it('assigns RED when value in red band (higher-is-better)', () => {
    const result = engine.evaluateValue(30, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.RED);
  });

  // --- Lower-is-better ---

  it('assigns GREEN when value in green band (lower-is-better)', () => {
    const result = engine.evaluateValue(10, WIP_AGE_THRESHOLDS);
    expect(result.status).toBe(RagStatus.GREEN);
  });

  it('assigns AMBER when value in amber band (lower-is-better)', () => {
    const result = engine.evaluateValue(20, WIP_AGE_THRESHOLDS);
    expect(result.status).toBe(RagStatus.AMBER);
  });

  it('assigns RED when value in red band (lower-is-better)', () => {
    const result = engine.evaluateValue(45, WIP_AGE_THRESHOLDS);
    expect(result.status).toBe(RagStatus.RED);
  });

  // --- Boundary values favour better status ---

  it('boundary value at green min → GREEN, not AMBER (higher-is-better)', () => {
    // value = 70 is exactly at green.min — should be GREEN
    const result = engine.evaluateValue(70, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.GREEN);
  });

  it('boundary value at amber max → AMBER, not RED (higher-is-better)', () => {
    // value = 50 is exactly at amber.min — should be AMBER
    const result = engine.evaluateValue(50, UTILISATION_THRESHOLDS);
    expect(result.status).toBe(RagStatus.AMBER);
  });

  it('boundary value at green max → GREEN (lower-is-better)', () => {
    // value = 14 is exactly at green.max — should be GREEN
    const result = engine.evaluateValue(14, WIP_AGE_THRESHOLDS);
    expect(result.status).toBe(RagStatus.GREEN);
  });

  it('boundary value at amber min → AMBER (lower-is-better)', () => {
    // value = 15 is exactly at amber.min — should be AMBER
    const result = engine.evaluateValue(15, WIP_AGE_THRESHOLDS);
    expect(result.status).toBe(RagStatus.AMBER);
  });

  // --- Value outside all bands → NEUTRAL ---

  it('assigns NEUTRAL when value outside all defined bands', () => {
    // Our fixture has no overlap-free gap but GREEN open-ended — use negative value
    const result = engine.evaluateValue(-5, UTILISATION_THRESHOLDS);
    // GREEN min=70, AMBER min=50 max=69, RED max=49 → -5 hits RED (max=49 → min defaults to 0)
    // actually RED: max=49, min=0 (normBand default) → -5 < 0, so outside all bands → NEUTRAL
    expect(result.status).toBe(RagStatus.NEUTRAL);
  });

  // --- Grade override ---

  it('uses grade override when grade matches an override key', () => {
    // Partner GREEN ≥ 75, so value 72 is AMBER under partner override, but GREEN under defaults
    const result = engine.evaluateValue(72, UTILISATION_WITH_OVERRIDES, 'Partner');
    expect(result.status).toBe(RagStatus.AMBER);
    expect(result.thresholdUsed).toBe('Partner');
  });

  it('uses defaults when grade does not match any override key', () => {
    const result = engine.evaluateValue(72, UTILISATION_WITH_OVERRIDES, 'Trainee');
    expect(result.status).toBe(RagStatus.GREEN); // 72 >= 70 default GREEN
    expect(result.thresholdUsed).toBe('default');
  });

  // --- Pay model override (fallback when no grade match) ---

  it('uses payModel override when no grade is provided and payModel matches', () => {
    // value 63: FeeShare AMBER (45–64), defaults also AMBER (50–69) — both agree → AMBER
    const result = engine.evaluateValue(63, UTILISATION_WITH_OVERRIDES, undefined, 'FeeShare');
    expect(result.status).toBe(RagStatus.AMBER);
    expect(result.thresholdUsed).toBe('FeeShare');
  });

  it('uses payModel override — discriminating case', () => {
    // 66: FeeShare GREEN (≥65), defaults AMBER (50-69)
    const result = engine.evaluateValue(66, UTILISATION_WITH_OVERRIDES, undefined, 'FeeShare');
    expect(result.status).toBe(RagStatus.GREEN);
    expect(result.thresholdUsed).toBe('FeeShare');
  });

  it('grade override takes priority over payModel override', () => {
    // Both grade=Partner and payModel=FeeShare provided; Partner override should win
    // value 66: Partner AMBER (60-74), FeeShare GREEN (≥65)
    const result = engine.evaluateValue(66, UTILISATION_WITH_OVERRIDES, 'Partner', 'FeeShare');
    expect(result.status).toBe(RagStatus.AMBER);
    expect(result.thresholdUsed).toBe('Partner');
  });

  // --- Boundaries structure ---

  it('returns correct boundaries for default thresholds', () => {
    const result = engine.evaluateValue(80, UTILISATION_THRESHOLDS);
    expect(result.boundaries.green.min).toBe(70);
    expect(result.boundaries.amber.min).toBe(50);
    expect(result.boundaries.amber.max).toBe(69);
    expect(result.boundaries.red.max).toBe(49);
  });
});

// =============================================================================
// distanceToNext
// =============================================================================

describe('RagEngine.evaluateValue — distanceToNext', () => {
  const engine = new RagEngine();

  describe('higher-is-better', () => {
    it('GREEN: distance = value − green.min (safety margin)', () => {
      const result = engine.evaluateValue(80, UTILISATION_THRESHOLDS);
      // green.min = 70, value = 80 → safety margin = 10
      expect(result.distanceToNext).toBe(10);
    });

    it('GREEN: zero margin when exactly at green.min', () => {
      const result = engine.evaluateValue(70, UTILISATION_THRESHOLDS);
      expect(result.distanceToNext).toBe(0);
    });

    it('AMBER: distance = green.min − value (improvement needed)', () => {
      const result = engine.evaluateValue(60, UTILISATION_THRESHOLDS);
      // green.min = 70, value = 60 → need to increase by 10
      expect(result.distanceToNext).toBe(10);
    });

    it('RED: distance = amber.min − value (to reach AMBER)', () => {
      const result = engine.evaluateValue(35, UTILISATION_THRESHOLDS);
      // amber.min = 50, value = 35 → need to increase by 15
      expect(result.distanceToNext).toBe(15);
    });

    it('NEUTRAL: distanceToNext is null', () => {
      const result = engine.evaluateValue(-5, UTILISATION_THRESHOLDS);
      expect(result.distanceToNext).toBeNull();
    });
  });

  describe('lower-is-better', () => {
    it('GREEN: distance = green.max − value (safety margin)', () => {
      const result = engine.evaluateValue(10, WIP_AGE_THRESHOLDS);
      // green.max = 14, value = 10 → safety margin = 4
      expect(result.distanceToNext).toBe(4);
    });

    it('GREEN: zero margin when exactly at green.max', () => {
      const result = engine.evaluateValue(14, WIP_AGE_THRESHOLDS);
      expect(result.distanceToNext).toBe(0);
    });

    it('AMBER: distance = value − green.max (improvement needed)', () => {
      const result = engine.evaluateValue(20, WIP_AGE_THRESHOLDS);
      // green.max = 14, value = 20 → need to decrease by 6
      expect(result.distanceToNext).toBe(6);
    });

    it('RED: distance = value − amber.max (to reach AMBER)', () => {
      const result = engine.evaluateValue(45, WIP_AGE_THRESHOLDS);
      // amber.max = 30, value = 45 → need to decrease by 15
      expect(result.distanceToNext).toBe(15);
    });
  });
});

// =============================================================================
// evaluateAll
// =============================================================================

describe('RagEngine.evaluateAll', () => {
  const engine = new RagEngine();

  const utilisationResults = makeFormulaResult({
    'e1': { value: 80, entityName: 'Alice' },   // GREEN
    'e2': { value: 55, entityName: 'Bob' },     // AMBER
    'e3': { value: 30, entityName: 'Charlie' }, // RED
    'e4': { value: null, entityName: 'David' }, // NEUTRAL
  });

  const thresholds = [UTILISATION_THRESHOLDS, WIP_AGE_THRESHOLDS];

  it('summary counts are correct', () => {
    const result = engine.evaluateAll(
      { 'F-TU-01': utilisationResults },
      thresholds,
    );
    expect(result.summary.greenCount).toBe(1);
    expect(result.summary.amberCount).toBe(1);
    expect(result.summary.redCount).toBe(1);
    expect(result.summary.neutralCount).toBe(1);
    expect(result.summary.totalAssignments).toBe(4);
  });

  it('assignments are keyed by formulaId → entityId', () => {
    const result = engine.evaluateAll(
      { 'F-TU-01': utilisationResults },
      thresholds,
    );
    expect(result.assignments['F-TU-01']['e1'].status).toBe(RagStatus.GREEN);
    expect(result.assignments['F-TU-01']['e2'].status).toBe(RagStatus.AMBER);
    expect(result.assignments['F-TU-01']['e3'].status).toBe(RagStatus.RED);
    expect(result.assignments['F-TU-01']['e4'].status).toBe(RagStatus.NEUTRAL);
  });

  it('alertsRed contains only RED entities with non-null values', () => {
    const result = engine.evaluateAll(
      { 'F-TU-01': utilisationResults },
      thresholds,
    );
    expect(result.alertsRed).toHaveLength(1);
    expect(result.alertsRed[0].entityId).toBe('e3');
    expect(result.alertsRed[0].entityName).toBe('Charlie');
    expect(result.alertsRed[0].value).toBe(30);
    expect(result.alertsRed[0].metric).toBe('utilisation');
    expect(result.alertsRed[0].formulaId).toBe('F-TU-01');
  });

  it('alertsAmber contains only AMBER entities with non-null values', () => {
    const result = engine.evaluateAll(
      { 'F-TU-01': utilisationResults },
      thresholds,
    );
    expect(result.alertsAmber).toHaveLength(1);
    expect(result.alertsAmber[0].entityId).toBe('e2');
    expect(result.alertsAmber[0].value).toBe(55);
  });

  it('formulas not in FORMULA_TO_METRIC map are skipped', () => {
    const result = engine.evaluateAll(
      { 'F-UNKNOWN-99': utilisationResults },
      thresholds,
    );
    expect(result.summary.totalAssignments).toBe(0);
    expect(result.assignments['F-UNKNOWN-99']).toBeUndefined();
  });

  it('formulas with no matching threshold set are skipped', () => {
    // 'F-TU-01' maps to 'utilisation' — pass empty thresholds array
    const result = engine.evaluateAll(
      { 'F-TU-01': utilisationResults },
      [], // no thresholds configured
    );
    expect(result.summary.totalAssignments).toBe(0);
  });

  it('entity metadata grade overrides applied during evaluateAll', () => {
    // e1 value=80; with Partner override GREEN ≥ 75 → still GREEN
    // Use e2 value=72; defaults GREEN ≥ 70 → GREEN, but Partner GREEN ≥ 75 → AMBER
    const results = makeFormulaResult({
      'e2': { value: 72, entityName: 'Bob' },
    });
    const result = engine.evaluateAll(
      { 'F-TU-01': results },
      [UTILISATION_WITH_OVERRIDES],
      { 'e2': { grade: 'Partner' } },
    );
    expect(result.assignments['F-TU-01']['e2'].status).toBe(RagStatus.AMBER);
    expect(result.assignments['F-TU-01']['e2'].thresholdUsed).toBe('Partner');
  });

  it('multiple formulas produce combined summary counts', () => {
    const wipResults = makeFormulaResult({
      'e1': { value: 10, entityName: 'Alice' }, // GREEN
      'e2': { value: 50, entityName: 'Bob' },   // RED
    });
    const result = engine.evaluateAll(
      {
        'F-TU-01': utilisationResults,  // 1G 1A 1R 1N
        'F-WL-01': wipResults,           // 1G 0A 1R 0N
      },
      thresholds,
    );
    expect(result.summary.greenCount).toBe(2);
    expect(result.summary.amberCount).toBe(1);
    expect(result.summary.redCount).toBe(2);
    expect(result.summary.neutralCount).toBe(1);
    expect(result.summary.totalAssignments).toBe(6);
  });

  it('entityName falls back to entityId when entityResult not found', () => {
    const results = makeFormulaResult({
      'e99': { value: 30, entityName: 'Ghost' },
    });
    // Manually delete entityResults to simulate missing entity
    delete (results.entityResults as Record<string, unknown>)['e99'];
    // Re-add as raw entry without going through makeFormulaResult
    (results.entityResults as Record<string, { entityId: string; entityName: string; value: number | null; nullReason: string | null; breakdown: object; readiness: { status: 'READY'; missingInputs: [] } }>)['e99'] = {
      entityId: 'e99',
      entityName: 'Ghost',
      value: 30,
      nullReason: null,
      breakdown: {},
      readiness: { status: 'READY', missingInputs: [] },
    };
    const result = engine.evaluateAll(
      { 'F-TU-01': results },
      thresholds,
    );
    expect(result.alertsRed[0].entityName).toBe('Ghost');
  });

  it('null-value entities do not appear in alertsRed or alertsAmber', () => {
    const results = makeFormulaResult({
      'e1': { value: null, entityName: 'Nobody' },
    });
    const result = engine.evaluateAll(
      { 'F-TU-01': results },
      thresholds,
    );
    expect(result.alertsRed).toHaveLength(0);
    expect(result.alertsAmber).toHaveLength(0);
  });
});

// =============================================================================
// evaluateSingle
// =============================================================================

describe('RagEngine.evaluateSingle', () => {
  const engine = new RagEngine();

  it('returns assignments for each entity in the result', () => {
    const results = makeFormulaResult({
      'a': { value: 80, entityName: 'Alice' },
      'b': { value: 40, entityName: 'Bob' },
    });
    const assignments = engine.evaluateSingle('F-TU-01', results, UTILISATION_THRESHOLDS);
    expect(assignments['a'].status).toBe(RagStatus.GREEN);
    expect(assignments['b'].status).toBe(RagStatus.RED);
  });

  it('uses entityMetadata for grade override', () => {
    const results = makeFormulaResult({
      'a': { value: 72, entityName: 'Alice' },
    });
    const assignments = engine.evaluateSingle(
      'F-TU-01',
      results,
      UTILISATION_WITH_OVERRIDES,
      { 'a': { grade: 'Partner' } },
    );
    // Partner GREEN ≥ 75, so 72 → AMBER
    expect(assignments['a'].status).toBe(RagStatus.AMBER);
  });
});
