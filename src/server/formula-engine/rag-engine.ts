/**
 * rag-engine.ts — RAG Status Engine
 *
 * Evaluates every formula result against configurable thresholds to produce
 * GREEN / AMBER / RED / NEUTRAL traffic-light indicators for dashboards.
 *
 * Thresholds come from firmConfig.ragThresholds (RagThresholdSet[]).
 * Evaluation priority per entity: grade override → payModel override → default.
 *
 * Design: stateless — no caching, no side effects, pure evaluation functions.
 */

import type { FormulaResult } from './types.js';
import type { RagThresholdSet, RagGradeThreshold } from '../../shared/types/index.js';
import { RagStatus } from '../../shared/types/index.js';

// =============================================================================
// Public interfaces
// =============================================================================

export type { RagThresholdSet } from '../../shared/types/index.js';

export interface RagBandBoundary {
  min: number;
  max: number;
}

export interface RagAssignment {
  status: RagStatus;
  value: number | null;
  /** Key used to select thresholds: 'default' or the grade/payModel key. */
  thresholdUsed: 'default' | string;
  /** Normalised boundary values actually used for evaluation. */
  boundaries: {
    green: RagBandBoundary;
    amber: RagBandBoundary;
    red: RagBandBoundary;
  };
  /**
   * Distance to the next status boundary (in the improvement direction).
   * - GREEN: safety margin before dropping to AMBER.
   * - AMBER: distance to the GREEN boundary (how much improvement needed).
   * - RED: distance to the AMBER boundary.
   * - NEUTRAL: null.
   */
  distanceToNext: number | null;
}

export interface RagAlert {
  formulaId: string;
  entityId: string;
  entityName: string;
  value: number;
  metric: string;
}

export interface RagEngineResult {
  /** Outer key: formulaId, inner key: entityId. */
  assignments: Record<string, Record<string, RagAssignment>>;
  summary: {
    totalAssignments: number;
    greenCount: number;
    amberCount: number;
    redCount: number;
    neutralCount: number;
  };
  alertsRed: RagAlert[];
  alertsAmber: RagAlert[];
}

// =============================================================================
// Formula → metric key mapping
// =============================================================================

/**
 * Maps formula IDs to the metric keys used in ragThresholds config.
 * Formulas not listed here are skipped during evaluateAll.
 */
export const FORMULA_TO_METRIC: Readonly<Record<string, string>> = {
  'F-TU-01': 'utilisation',
  'F-TU-02': 'recordingGap',
  'F-TU-03': 'nonChargeablePercent',
  'F-RB-01': 'realisation',
  'F-RB-02': 'effectiveRate',
  'F-RB-03': 'revenueMultiple',
  'F-WL-01': 'wipAge',
  'F-WL-02': 'writeOffRate',
  'F-WL-03': 'disbursementRecovery',
  'F-WL-04': 'lockup',
  'F-DM-01': 'debtorDays',
  'F-BS-01': 'budgetBurn',
  'F-PR-01': 'matterMargin',
  'F-CS-02': 'scorecardScore',
  'F-CS-03': 'matterHealthScore',
};

// =============================================================================
// RagEngine
// =============================================================================

export class RagEngine {
  /**
   * Evaluate RAG status for all formula results that have a configured metric.
   *
   * @param formulaResults  Keyed by formulaId.
   * @param ragThresholds   Array from firmConfig.ragThresholds.
   * @param entityMetadata  Optional grade/payModel per entityId for overrides.
   */
  evaluateAll(
    formulaResults: Record<string, FormulaResult>,
    ragThresholds: RagThresholdSet[],
    entityMetadata: Record<string, { grade?: string; payModel?: string }> = {},
  ): RagEngineResult {
    // Build a map from metricKey → threshold config for O(1) lookup
    const thresholdMap = new Map(ragThresholds.map((t) => [t.metricKey, t]));

    const assignments: Record<string, Record<string, RagAssignment>> = {};
    const alertsRed: RagAlert[] = [];
    const alertsAmber: RagAlert[] = [];
    let greenCount = 0;
    let amberCount = 0;
    let redCount = 0;
    let neutralCount = 0;

    for (const [formulaId, result] of Object.entries(formulaResults)) {
      const metricKey = FORMULA_TO_METRIC[formulaId];
      if (!metricKey) continue; // not in formula → metric map

      const thresholds = thresholdMap.get(metricKey);
      if (!thresholds) continue; // no thresholds configured for this metric

      const formulaAssignments = this.evaluateSingle(
        formulaId,
        result,
        thresholds,
        entityMetadata,
      );
      assignments[formulaId] = formulaAssignments;

      for (const [entityId, assignment] of Object.entries(formulaAssignments)) {
        switch (assignment.status) {
          case RagStatus.GREEN:
            greenCount++;
            break;
          case RagStatus.AMBER:
            amberCount++;
            break;
          case RagStatus.RED:
            redCount++;
            break;
          default:
            neutralCount++;
        }

        // Build alerts for RED and AMBER (skip null values)
        if (assignment.value != null) {
          const entityResult = result.entityResults[entityId];
          const entityName = entityResult?.entityName ?? entityId;

          if (assignment.status === RagStatus.RED) {
            alertsRed.push({ formulaId, entityId, entityName, value: assignment.value, metric: metricKey });
          } else if (assignment.status === RagStatus.AMBER) {
            alertsAmber.push({ formulaId, entityId, entityName, value: assignment.value, metric: metricKey });
          }
        }
      }
    }

    return {
      assignments,
      summary: {
        totalAssignments: greenCount + amberCount + redCount + neutralCount,
        greenCount,
        amberCount,
        redCount,
        neutralCount,
      },
      alertsRed,
      alertsAmber,
    };
  }

  /**
   * Evaluate RAG status for every entity in a single formula result.
   * Returns a map of entityId → RagAssignment.
   */
  evaluateSingle(
    _formulaId: string,
    result: FormulaResult,
    thresholds: RagThresholdSet,
    entityMetadata: Record<string, { grade?: string; payModel?: string }> = {},
  ): Record<string, RagAssignment> {
    const output: Record<string, RagAssignment> = {};

    for (const [entityId, entityResult] of Object.entries(result.entityResults)) {
      const meta = entityMetadata[entityId];
      output[entityId] = this.evaluateValue(
        entityResult.value,
        thresholds,
        meta?.grade,
        meta?.payModel,
      );
    }

    return output;
  }

  /**
   * Evaluate RAG status for a single numeric value.
   *
   * Priority for threshold selection:
   *   1. thresholds.overrides[grade] — if grade is provided and override exists
   *   2. thresholds.overrides[payModel] — if payModel is provided and override exists
   *   3. thresholds.defaults — always available as the fallback
   *
   * Evaluation uses inclusive bounds (>= min, <= max) and checks GREEN first so
   * values exactly at a boundary favour the better status.
   */
  evaluateValue(
    value: number | null,
    thresholds: RagThresholdSet,
    grade?: string,
    payModel?: string,
  ): RagAssignment {
    if (value === null || value === undefined) {
      return buildNeutral(thresholds);
    }

    // Select the threshold set to use
    let thresholdUsed: 'default' | string = 'default';
    let bandSet = thresholds.defaults;

    if (grade && thresholds.overrides?.[grade]) {
      bandSet = thresholds.overrides[grade];
      thresholdUsed = grade;
    } else if (payModel && thresholds.overrides?.[payModel]) {
      bandSet = thresholds.overrides[payModel];
      thresholdUsed = payModel;
    }

    const green = normBand(bandSet[RagStatus.GREEN]);
    const amber = normBand(bandSet[RagStatus.AMBER]);
    const red = normBand(bandSet[RagStatus.RED]);

    const boundaries = { green, amber, red };
    const hib = thresholds.higherIsBetter;

    // Evaluate — check GREEN first so boundary values favour the better status
    let status: RagStatus;

    if (value >= green.min && value <= green.max) {
      status = RagStatus.GREEN;
    } else if (value >= amber.min && value <= amber.max) {
      status = RagStatus.AMBER;
    } else if (value >= red.min && value <= red.max) {
      status = RagStatus.RED;
    } else {
      status = RagStatus.NEUTRAL;
    }

    const distanceToNext = calcDistanceToNext(value, status, boundaries, hib);

    return { status, value, thresholdUsed, boundaries, distanceToNext };
  }
}

// =============================================================================
// Private helpers
// =============================================================================

/** Normalise a RagGradeThreshold to concrete finite-feeling numbers. */
function normBand(t: RagGradeThreshold): RagBandBoundary {
  return {
    min: t.min ?? 0,
    max: t.max ?? Number.MAX_SAFE_INTEGER,
  };
}

/** Return a NEUTRAL assignment for null values or unconfigured metrics. */
function buildNeutral(thresholds: RagThresholdSet): RagAssignment {
  return {
    status: RagStatus.NEUTRAL,
    value: null,
    thresholdUsed: 'default',
    boundaries: {
      green: normBand(thresholds.defaults[RagStatus.GREEN]),
      amber: normBand(thresholds.defaults[RagStatus.AMBER]),
      red: normBand(thresholds.defaults[RagStatus.RED]),
    },
    distanceToNext: null,
  };
}

/**
 * Calculate the distance from the current value to the next (better) status
 * boundary. Returns a positive number representing how much improvement is
 * needed (for AMBER/RED), or the safety margin before the next drop (for GREEN).
 */
function calcDistanceToNext(
  value: number,
  status: RagStatus,
  boundaries: { green: RagBandBoundary; amber: RagBandBoundary; red: RagBandBoundary },
  higherIsBetter: boolean,
): number | null {
  const { green, amber } = boundaries;

  if (status === RagStatus.GREEN) {
    // Safety margin before falling into AMBER
    return higherIsBetter
      ? value - green.min             // how far above the amber/green boundary
      : green.max - value;            // how far below the amber/green boundary
  }

  if (status === RagStatus.AMBER) {
    // Improvement needed to reach GREEN
    return higherIsBetter
      ? green.min - value             // need to increase by this
      : value - green.max;            // need to decrease by this
  }

  if (status === RagStatus.RED) {
    // Improvement needed to reach AMBER
    return higherIsBetter
      ? amber.min - value             // need to increase by this
      : value - amber.max;            // need to decrease by this
  }

  return null;
}
