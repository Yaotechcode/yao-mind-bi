// src/server/pipeline/pipeline-orchestrator.ts
//
// Pipeline Orchestrator — wires Stages 2–7 for a single file upload.
//
// runFullPipeline: production entry point used by the upload Netlify Function.
//   Stages 2 (Normalise) → 3 (Cross-Reference) → 4 (Index) → 5 (Join) →
//   6 (Enrich) → 7 (Aggregate) → persistence (enriched entities + KPIs).
//
// runPipeline: lightweight test-support function used by pipeline unit tests.
//   Executes Stages 2–6 in-memory without persistence.
//
// buildCrossRefQualityStats / buildKnownGaps: exported for cross-reference tests.

import {
  buildCrossReferenceRegistry,
  applyRegistryToDatasets,
  serialiseRegistry,
  deserialiseRegistry,
} from './cross-reference.js';
import {
  storeCrossReferenceRegistry,
  getCrossReferenceRegistry,
  updateUploadStatus,
  storeNormalisedDataset,
  getAllNormalisedDatasets,
  storeEnrichedEntities,
  storeCalculatedKpis,
  setRecalculationFlag,
} from '../lib/mongodb-operations.js';
import { buildIndexes } from './indexer.js';
import { joinRecords } from './joiner.js';
import { enrichRecords } from './enricher.js';
import { normaliseRecords } from './normaliser.js';
import { aggregate } from './aggregator.js';
import { getBuiltInEntityDefinition } from '../../shared/entities/registry.js';
import type {
  NormaliseResult,
  CrossReferenceRegistry,
  CrossReferenceQualityStats,
  PipelineIndexes,
  JoinResult,
} from '@shared/types/pipeline.js';
import type { DataQualityReport, KnownGap, EntityType, ColumnMapping } from '@shared/types/index.js';
import type { MappingSet as ClientMappingSet } from '../../shared/mapping/types.js';
import type { ParseResult } from '../../client/parsers/types.js';
import type { PipelineRunResult, PipelineWarning } from './pipeline-types.js';

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
  indexes: PipelineIndexes;
  joinResult: JoinResult;
  dataQuality: Partial<DataQualityReport>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the 8-stage pipeline for a firm.
 * Stage 2 (Normalise) is handled by the caller before invoking runPipeline —
 * normalisedDatasets already contains post-normalise records.
 * Stage 3 (Cross-Reference) and Stage 4 (Index) are fully implemented.
 * Stages 5–8 are pass-through stubs pending future implementation.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { firmId, normalisedDatasets } = input;

  // -------------------------------------------------------------------------
  // Stage 2: Normalise — performed by caller; normalisedDatasets is the output
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
  // Stage 4: Index — build lookup maps from cross-reference-resolved records
  // -------------------------------------------------------------------------
  const entityKeys = Object.keys(enrichedAfterCrossRef);
  const indexes = buildIndexes(enrichedAfterCrossRef, entityKeys);

  // -------------------------------------------------------------------------
  // Stage 4: Join — resolve cross-entity references
  // -------------------------------------------------------------------------
  const rawJoinResult = joinRecords(enrichedAfterCrossRef, indexes);

  // Stage 5: Enrich — compute derived fields and synthesise departments
  const joinResult = enrichRecords(rawJoinResult, new Date());

  // -------------------------------------------------------------------------
  // Stages 6–8: stubs (pass-through until implemented)
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
    indexes,
    joinResult,
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

  // WIP orphan rate — WIP entries whose matterNumber doesn't appear in any matter record
  const wipRecords = datasets['wipJson']?.records ?? [];
  const knownMatterNumbers = new Set<string>();
  for (const r of (datasets['fullMattersJson']?.records ?? [])) {
    if (r.matterNumber) knownMatterNumbers.add(String(r.matterNumber));
  }
  for (const r of (datasets['closedMattersJson']?.records ?? [])) {
    if (r.matterNumber) knownMatterNumbers.add(String(r.matterNumber));
  }
  const wipTotalCount = wipRecords.length;
  const wipOrphanCount = wipRecords.filter(
    r => !r.matterNumber || !knownMatterNumbers.has(String(r.matterNumber))
  ).length;
  const wipOrphanRate = wipTotalCount === 0 ? 0 : (wipOrphanCount / wipTotalCount) * 100;

  return {
    matterMappingCoverage,
    feeEarnerMappingCoverage,
    conflicts: _registry.stats.matters.conflicts,
    unresolvedMatterIds,
    unresolvedMatterNumbers,
    unresolvedLawyerNames: Array.from(unresolvedLawyerNamesSet),
    wipOrphanCount,
    wipTotalCount,
    wipOrphanRate,
  };
}

// ---------------------------------------------------------------------------
// KnownGap
// ---------------------------------------------------------------------------

export function buildKnownGaps(
  stats: CrossReferenceQualityStats,
  options?: { wipOrphanThreshold?: number }
): KnownGap[] {
  const wipOrphanThreshold = options?.wipOrphanThreshold ?? 20;
  const gaps: KnownGap[] = [];

  if (stats.matterMappingCoverage < 70) {
    gaps.push({
      code: 'LOW_IDENTIFIER_COVERAGE',
      severity: 'warning',
      message: `Matter identifier coverage is ${stats.matterMappingCoverage.toFixed(0)}% — fewer than 70% of matter records have both ID and number. Upload fullMatters or closedMatters to improve coverage.`,
    });
  }

  if (stats.wipTotalCount > 0 && stats.wipOrphanRate > wipOrphanThreshold) {
    gaps.push({
      code: 'WIP_ORPHAN_GAP',
      severity: 'warning',
      message: `${stats.wipOrphanRate.toFixed(0)}% of WIP entries (${stats.wipOrphanCount} of ${stats.wipTotalCount}) have no matched matter. These entries are included in totals but excluded from matter-level analysis.`,
      affectedCount: stats.wipOrphanCount,
    });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// File type → entity key maps
// ---------------------------------------------------------------------------

const FILE_TYPE_TO_ENTITY_KEY: Record<string, string> = {
  wipJson: 'timeEntry',
  fullMattersJson: 'matter',
  closedMattersJson: 'matter',
  feeEarner: 'feeEarner',
  invoicesJson: 'invoice',
  contactsJson: 'client',
  disbursementsJson: 'disbursement',
  tasksJson: 'task',
};

const ENTITY_KEY_TO_ENUM: Record<string, EntityType> = {
  timeEntry: 'timeEntry' as EntityType,
  matter: 'matter' as EntityType,
  feeEarner: 'feeEarner' as EntityType,
  invoice: 'invoice' as EntityType,
  client: 'client' as EntityType,
  disbursement: 'disbursement' as EntityType,
  task: 'task' as EntityType,
};

// ---------------------------------------------------------------------------
// normaliseUpload — Stage 2 only (synchronous, no DB calls)
// Used by upload.ts phase-1 so it can return quickly.
// ---------------------------------------------------------------------------

export interface NormaliseUploadResult {
  normaliseResult: NormaliseResult;
  entityKey: string;
  /** True when >50% of rows were rejected — caller should abort the upload. */
  aborted: boolean;
  abortReason?: string;
  warnings: PipelineWarning[];
}

export function normaliseUpload(params: {
  fileType: string;
  parseResult: ParseResult;
  mappingSet: ClientMappingSet;
}): NormaliseUploadResult {
  const { fileType, parseResult, mappingSet } = params;

  const entityKey = FILE_TYPE_TO_ENTITY_KEY[fileType];
  if (!entityKey) throw new Error(`Unknown fileType: ${fileType}`);

  const entityTypeEnum = ENTITY_KEY_TO_ENUM[entityKey];
  const entityDef = getBuiltInEntityDefinition(entityTypeEnum as EntityType);
  if (!entityDef) throw new Error(`No entity definition for entityKey: ${entityKey}`);

  const normaliserMappings: ColumnMapping[] = mappingSet.mappings
    .filter(m => m.mappedTo !== null)
    .map(m => ({ sourceColumn: m.rawColumn, targetField: m.mappedTo! }));

  const normaliseResult = normaliseRecords(parseResult.fullRows, normaliserMappings, entityKey, entityDef);

  const rejectedCount = normaliseResult.rejectedRows?.length ?? 0;
  const totalCount = parseResult.fullRows.length;
  const effectiveRejectedCount =
    normaliseResult.records.length === 0 && totalCount > 0 ? totalCount : rejectedCount;
  const rejectedPercent = totalCount > 0 ? (effectiveRejectedCount / totalCount) * 100 : 0;

  const warnings: PipelineWarning[] = (normaliseResult.warnings ?? []).map(w => ({
    stage: 'normalise' as const,
    message: w.message,
    severity: 'warning' as const,
    count: w.affectedRowCount,
  }));

  if (rejectedPercent > 50) {
    const reason = `${effectiveRejectedCount} of ${totalCount} rows rejected (${Math.round(rejectedPercent)}%) — exceeds 50% threshold`;
    return { normaliseResult, entityKey, aborted: true, abortReason: reason, warnings };
  }

  return { normaliseResult, entityKey, aborted: false, warnings };
}

// ---------------------------------------------------------------------------
// runPipelineFromStored — Stages 3–7 + persist (runs in background function)
// Loads the normalised dataset from MongoDB and runs the full pipeline from
// Stage 3 onwards. Intended to be called from process-upload-background.ts.
// ---------------------------------------------------------------------------

export async function runPipelineFromStored(params: {
  firmId: string;
  uploadId: string;
  fileType: string;
}): Promise<FullPipelineResult> {
  const { firmId, uploadId, fileType } = params;
  const startTime = Date.now();
  const stagesCompleted: FullPipelineResult['stagesCompleted'] = [];
  const warnings: PipelineWarning[] = [];

  const entityKey = FILE_TYPE_TO_ENTITY_KEY[fileType];
  if (!entityKey) throw new Error(`Unknown fileType: ${fileType}`);

  // Load all normalised datasets for this firm (upload.ts has already stored ours)
  const allDatasets = await getAllNormalisedDatasets(firmId);
  if (!allDatasets[fileType]) {
    throw new Error(`No normalised dataset found for fileType "${fileType}" — has upload.ts stored it?`);
  }

  // ── Stage 3: Cross-Reference ──────────────────────────────────────────────
  const existingSerialised = await getCrossReferenceRegistry(firmId);
  const existingRegistry = existingSerialised ? deserialiseRegistry(existingSerialised) : undefined;
  const updatedRegistry = buildCrossReferenceRegistry(firmId, allDatasets, existingRegistry);
  const enrichedDatasets = applyRegistryToDatasets(allDatasets, updatedRegistry);
  await storeCrossReferenceRegistry(firmId, serialiseRegistry(updatedRegistry));
  stagesCompleted.push('crossReference');

  // ── Stage 4: Index ────────────────────────────────────────────────────────
  const indexes = buildIndexes(enrichedDatasets, Object.keys(enrichedDatasets));
  stagesCompleted.push('index');

  // ── Stage 5: Join ─────────────────────────────────────────────────────────
  const rawJoinResult = joinRecords(enrichedDatasets, indexes);
  stagesCompleted.push('join');

  // ── Stage 6: Enrich ───────────────────────────────────────────────────────
  const joinResult = enrichRecords(rawJoinResult, new Date());
  stagesCompleted.push('enrich');

  // ── Stage 7: Aggregate ────────────────────────────────────────────────────
  const availableFileTypes = Object.keys(allDatasets);
  const aggregateResult = aggregate(joinResult, new Date(), availableFileTypes);
  stagesCompleted.push('aggregate');

  // ── Persist normalised dataset (update with cross-ref-enriched records) ───
  await storeNormalisedDataset(
    firmId,
    fileType,
    entityKey,
    enrichedDatasets[fileType]?.records ?? allDatasets[fileType].records,
    uploadId,
  );

  // ── Persist enriched entities for all entity types ────────────────────────
  const joinEntityStore: Array<{ records: unknown[]; etype: string }> = [
    { records: joinResult.timeEntries,    etype: 'timeEntry' },
    { records: joinResult.matters,        etype: 'matter' },
    { records: joinResult.feeEarners,     etype: 'feeEarner' },
    { records: joinResult.invoices,       etype: 'invoice' },
    { records: joinResult.clients,        etype: 'client' },
    { records: joinResult.disbursements,  etype: 'disbursement' },
    { records: joinResult.tasks,          etype: 'task' },
    { records: joinResult.departments,    etype: 'department' },
  ];
  for (const { records, etype } of joinEntityStore) {
    if (records.length > 0) {
      await storeEnrichedEntities(
        firmId,
        etype,
        records as Record<string, unknown>[],
        [uploadId],
        etype === entityKey ? {
          quality_score: aggregateResult.dataQuality.overallScore,
          issue_count: aggregateResult.dataQuality.entityIssues.length,
          issues: aggregateResult.dataQuality.entityIssues,
        } : undefined,
      );
    }
  }

  await storeCalculatedKpis(
    firmId,
    { aggregate: aggregateResult as unknown as Record<string, unknown>, generatedAt: new Date().toISOString() },
    'pending',
    new Date().toISOString(),
  );

  await setRecalculationFlag(firmId);
  await updateUploadStatus(firmId, uploadId, 'processed');

  const recordCount = allDatasets[fileType].recordCount;
  return {
    uploadId,
    stagesCompleted,
    warnings,
    recordsProcessed: recordCount,
    recordsPersisted: recordCount,
    duration_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// runFullPipeline — orchestrates Stages 2–7 for a single file upload
// ---------------------------------------------------------------------------

export interface FullPipelineParams {
  firmId: string;
  userId: string;
  uploadId: string;
  fileType: string;
  parseResult: ParseResult;
  mappingSet: ClientMappingSet;
  dryRun?: boolean;
}

export interface FullPipelineResult extends PipelineRunResult {
  aborted?: boolean;
  previewData?: {
    normalisedCount: number;
    rejectedCount: number;
    warnings: unknown[];
  };
}

export async function runFullPipeline(
  params: FullPipelineParams
): Promise<FullPipelineResult> {
  const { firmId, uploadId, fileType, parseResult, mappingSet, dryRun = false } = params;
  const startTime = Date.now();
  const stagesCompleted: FullPipelineResult['stagesCompleted'] = [];
  const warnings: PipelineWarning[] = [];

  const entityKey = FILE_TYPE_TO_ENTITY_KEY[fileType];
  if (!entityKey) {
    throw new Error(`Unknown fileType: ${fileType}`);
  }

  const entityTypeEnum = ENTITY_KEY_TO_ENUM[entityKey];
  const entityDef = getBuiltInEntityDefinition(entityTypeEnum as EntityType);
  if (!entityDef) {
    throw new Error(`No entity definition for entityKey: ${entityKey}`);
  }

  // Convert client MappingSet to normaliser format (ColumnMapping[])
  const normaliserMappings: ColumnMapping[] = mappingSet.mappings
    .filter(m => m.mappedTo !== null)
    .map(m => ({ sourceColumn: m.rawColumn, targetField: m.mappedTo! }));

  // ── Stage 2: Normalise ────────────────────────────────────────────────────
  const normaliseResult = normaliseRecords(
    parseResult.fullRows,
    normaliserMappings,
    entityKey,
    entityDef
  );
  stagesCompleted.push('normalise');

  const rejectedCount = normaliseResult.rejectedRows?.length ?? 0;
  const totalCount = parseResult.fullRows.length;
  // The normaliser strips blank rows via the blank-row filter before they reach
  // rejectedRows tracking. This means blank inputs produce records.length === 0
  // but rejectedRows may be empty. We treat all-blank uploads as fully rejected.
  const effectiveRejectedCount = normaliseResult.records.length === 0 && totalCount > 0
    ? totalCount
    : rejectedCount;
  const rejectedPercent = totalCount > 0 ? (effectiveRejectedCount / totalCount) * 100 : 0;

  // Dry run: return preview, skip persistence
  if (dryRun) {
    return {
      uploadId,
      stagesCompleted,
      warnings,
      recordsProcessed: normaliseResult.recordCount,
      recordsPersisted: 0,
      duration_ms: Date.now() - startTime,
      previewData: {
        normalisedCount: normaliseResult.recordCount,
        rejectedCount: effectiveRejectedCount,
        warnings: normaliseResult.warnings ?? [],
      },
    };
  }

  // Abort if > 50% rejected
  if (rejectedPercent > 50) {
    const msg = `${effectiveRejectedCount} of ${totalCount} rows rejected (${Math.round(rejectedPercent)}%) — exceeds 50% threshold`;
    await updateUploadStatus(firmId, uploadId, 'error', msg);
    return {
      uploadId,
      stagesCompleted,
      warnings,
      recordsProcessed: normaliseResult.recordCount,
      recordsPersisted: 0,
      duration_ms: Date.now() - startTime,
      aborted: true,
    };
  }

  if (normaliseResult.warnings?.length) {
    for (const w of normaliseResult.warnings) {
      warnings.push({ stage: 'normalise', message: w.message, severity: 'warning', count: w.affectedRowCount });
    }
  }

  // ── Stage 3: Cross-Reference ──────────────────────────────────────────────
  const existingDatasets = await getAllNormalisedDatasets(firmId);
  const allDatasets: Record<string, NormaliseResult> = {
    ...existingDatasets,
    [fileType]: normaliseResult,
  };

  const existingSerialised = await getCrossReferenceRegistry(firmId);
  const existingRegistry = existingSerialised ? deserialiseRegistry(existingSerialised) : undefined;
  const updatedRegistry = buildCrossReferenceRegistry(firmId, allDatasets, existingRegistry);
  const enrichedDatasets = applyRegistryToDatasets(allDatasets, updatedRegistry);
  await storeCrossReferenceRegistry(firmId, serialiseRegistry(updatedRegistry));
  stagesCompleted.push('crossReference');

  // ── Stage 4: Index ────────────────────────────────────────────────────────
  const indexes = buildIndexes(enrichedDatasets, Object.keys(enrichedDatasets));
  stagesCompleted.push('index');

  // ── Stage 5: Join ─────────────────────────────────────────────────────────
  const rawJoinResult = joinRecords(enrichedDatasets, indexes);
  stagesCompleted.push('join');

  // ── Stage 6: Enrich ───────────────────────────────────────────────────────
  const joinResult = enrichRecords(rawJoinResult, new Date());
  stagesCompleted.push('enrich');

  // ── Stage 7: Aggregate ────────────────────────────────────────────────────
  const availableFileTypes = Object.keys(allDatasets);
  const aggregateResult = aggregate(joinResult, new Date(), availableFileTypes);
  stagesCompleted.push('aggregate');

  // ── Persist ───────────────────────────────────────────────────────────────
  await storeNormalisedDataset(
    firmId,
    fileType,
    entityKey,
    enrichedDatasets[fileType]?.records ?? normaliseResult.records,
    uploadId
  );

  // Store join-enriched records for every entity type produced by the pipeline.
  // This ensures enriched_entities contains fully resolved records (with fields
  // like hasMatchedMatter, isChargeable, isOverdue, etc.) that the data API
  // can filter on directly.
  const joinEntityStore: Array<{ records: unknown[]; etype: string }> = [
    { records: joinResult.timeEntries, etype: 'timeEntry' },
    { records: joinResult.matters,     etype: 'matter' },
    { records: joinResult.feeEarners,  etype: 'feeEarner' },
    { records: joinResult.invoices,    etype: 'invoice' },
    { records: joinResult.clients,     etype: 'client' },
    { records: joinResult.disbursements, etype: 'disbursement' },
    { records: joinResult.tasks,       etype: 'task' },
    { records: joinResult.departments, etype: 'department' },
  ];
  for (const { records, etype } of joinEntityStore) {
    if (records.length > 0) {
      await storeEnrichedEntities(
        firmId,
        etype,
        records as Record<string, unknown>[],
        [uploadId],
        etype === entityKey ? {
          quality_score: aggregateResult.dataQuality.overallScore,
          issue_count: aggregateResult.dataQuality.entityIssues.length,
          issues: aggregateResult.dataQuality.entityIssues,
        } : undefined
      );
    }
  }

  await storeCalculatedKpis(
    firmId,
    { aggregate: aggregateResult as unknown as Record<string, unknown>, generatedAt: new Date().toISOString() },
    'pending',
    new Date().toISOString()
  );

  await setRecalculationFlag(firmId);

  await updateUploadStatus(firmId, uploadId, 'processed');

  return {
    uploadId,
    stagesCompleted,
    warnings,
    recordsProcessed: normaliseResult.recordCount,
    recordsPersisted: normaliseResult.recordCount,
    duration_ms: Date.now() - startTime,
  };
}
