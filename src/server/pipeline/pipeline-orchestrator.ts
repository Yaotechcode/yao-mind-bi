// src/server/pipeline/pipeline-orchestrator.ts
//
// Pipeline Orchestrator — stub (Task 5 will implement the full version).
// Exports only what cross-reference.test.ts needs for its quality-stats tests.

import type {
  NormaliseResult,
  CrossReferenceRegistry,
  CrossReferenceQualityStats,
} from '@shared/types/pipeline.js';

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

export interface KnownGap {
  code: string;
  severity: 'warning' | 'error' | 'info';
  message: string;
}

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
