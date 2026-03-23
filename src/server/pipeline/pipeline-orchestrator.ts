// src/server/pipeline/pipeline-orchestrator.ts
//
// Pipeline Orchestrator — stub (Task 5 will implement the full version).
// Exports only what cross-reference.test.ts needs for its quality-stats tests.

import {
  buildCrossReferenceRegistry,
  applyRegistryToDatasets,
  serialiseRegistry,
  deserialiseRegistry,
} from './cross-reference.js';
import {
  storeCrossReferenceRegistry,
  getCrossReferenceRegistry,
} from '../lib/mongodb-operations.js';
import type {
  NormaliseResult,
  CrossReferenceRegistry,
  CrossReferenceQualityStats,
} from '@shared/types/pipeline.js';
import type { DataQualityReport, KnownGap } from '@shared/types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PipelineInput {
  firmId: string;
  /**
   * One entry per uploaded file type. In production this comes from Stage 2
   * (Normalise). Until Stage 2 is implemented, callers can pass pre-normalised
   * records directly.
   */
  normalisedDatasets: Record<string, NormaliseResult>;
}

export interface PipelineResult {
  firmId: string;
  completedAt: string;
  crossReferenceRegistry: CrossReferenceRegistry;
  /** Enriched datasets after all stages have run. */
  enrichedDatasets: Record<string, NormaliseResult>;
  dataQuality: Partial<DataQualityReport>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the 8-stage pipeline for a firm.
 * Stages 2 and 4–8 are pass-through stubs pending future implementation.
 * Stage 3 (Cross-Reference) is fully implemented.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { firmId, normalisedDatasets } = input;

  // -------------------------------------------------------------------------
  // Stage 2: Normalise — stub (pass-through until 1B-04)
  // -------------------------------------------------------------------------
  const stageOneOutput = normalisedDatasets;

  // -------------------------------------------------------------------------
  // Stage 3: Cross-Reference Resolution
  // -------------------------------------------------------------------------

  // Load existing registry from MongoDB (null if first run for this firm)
  const existing = await getCrossReferenceRegistry(firmId);
  const existingRegistry = existing ? deserialiseRegistry(existing) : undefined;

  // Build updated registry (merges with existing if present)
  const crossReferenceRegistry = buildCrossReferenceRegistry(
    firmId,
    stageOneOutput,
    existingRegistry
  );

  // Apply registry to fill in missing identifiers across all datasets
  const enrichedAfterCrossRef = applyRegistryToDatasets(
    stageOneOutput,
    crossReferenceRegistry
  );

  // Persist updated registry to MongoDB
  await storeCrossReferenceRegistry(firmId, serialiseRegistry(crossReferenceRegistry));

  // -------------------------------------------------------------------------
  // Stages 4–8: stubs (pass-through until implemented)
  // -------------------------------------------------------------------------
  const enrichedDatasets = enrichedAfterCrossRef;

  // -------------------------------------------------------------------------
  // Data quality report (partial — cross-reference section only for now)
  // -------------------------------------------------------------------------
  const crossRefStats = buildCrossRefQualityStats(enrichedDatasets, crossReferenceRegistry);
  const dataQuality: Partial<DataQualityReport> = {
    firmId,
    generatedAt: new Date(),
    crossReference: crossRefStats,
    knownGaps: buildKnownGaps(crossRefStats),
  };

  return {
    firmId,
    completedAt: new Date().toISOString(),
    crossReferenceRegistry,
    enrichedDatasets,
    dataQuality,
  };
}

// ---------------------------------------------------------------------------
// buildCrossRefQualityStats
// ---------------------------------------------------------------------------

export function buildCrossRefQualityStats(
  datasets: Record<string, NormaliseResult>,
  _registry: CrossReferenceRegistry
): CrossReferenceQualityStats {
  const allRecords = Object.values(datasets).flatMap(d => d.records);

  const total = allRecords.length;
  const withBoth = allRecords.filter(r => r.matterId && r.matterNumber).length;
  const matterMappingCoverage = total === 0 ? 100 : (withBoth / total) * 100;

  const feeEarnerTotal = allRecords.filter(r => r.lawyerId || r.lawyerName).length;
  const feeEarnerBoth = allRecords.filter(r => r.lawyerId && r.lawyerName).length;
  const feeEarnerMappingCoverage = feeEarnerTotal === 0 ? 100 : (feeEarnerBoth / feeEarnerTotal) * 100;

  const unresolvedMatterIds = allRecords.filter(r => r.matterId && !r.matterNumber).length;
  const unresolvedMatterNumbers = allRecords.filter(r => r.matterNumber && !r.matterId).length;

  const unresolvedLawyerNamesSet = new Set<string>();
  for (const r of allRecords) {
    if (r.lawyerName && !r.lawyerId) {
      unresolvedLawyerNamesSet.add(String(r.lawyerName));
    }
  }

  return {
    matterMappingCoverage,
    feeEarnerMappingCoverage,
    conflicts: _registry.stats.matters.conflicts,
    unresolvedMatterIds,
    unresolvedMatterNumbers,
    unresolvedLawyerNames: Array.from(unresolvedLawyerNamesSet),
  };
}

// ---------------------------------------------------------------------------
// KnownGap
// ---------------------------------------------------------------------------

export function buildKnownGaps(stats: CrossReferenceQualityStats): KnownGap[] {
  const gaps: KnownGap[] = [];

  if (stats.matterMappingCoverage < 70) {
    gaps.push({
      code: 'LOW_IDENTIFIER_COVERAGE',
      severity: 'warning',
      message: `Matter identifier coverage is ${stats.matterMappingCoverage.toFixed(0)}% — fewer than 70% of matter records have both ID and number. Upload fullMatters or closedMatters to improve coverage.`,
    });
  }

  return gaps;
}
