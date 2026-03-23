import { getCollection } from './mongodb.js';
import type {
  RawUploadDocument,
  EnrichedEntitiesDocument,
  CalculatedKpisDocument,
  HistoricalSnapshotDocument,
  CustomEntityRecordDocument,
  CrossReferenceRegistryDocument,
} from '@shared/types/mongodb.js';
import type { CrossReferenceRegistrySerialised } from '@shared/types/pipeline.js';

// =============================================================================
// MongoDB Operations
//
// Every function accepts firm_id as its first argument and includes it in ALL
// queries. MongoDB has no RLS so isolation is enforced here at the application
// layer — never omit firm_id from a query.
// =============================================================================

// ---------------------------------------------------------------------------
// raw_uploads
// ---------------------------------------------------------------------------

/**
 * Persist a new uploaded file and its parsed rows.
 * Returns the inserted document's _id as a string.
 */
export async function storeRawUpload(
  firmId: string,
  fileType: string,
  filename: string,
  content: Record<string, unknown>[],
  uploadedBy: string
): Promise<string> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  const doc: RawUploadDocument = {
    firm_id: firmId,
    file_type: fileType,
    original_filename: filename,
    upload_date: new Date(),
    uploaded_by: uploadedBy,
    raw_content: content,
    record_count: content.length,
    status: 'pending',
  };
  const result = await col.insertOne(doc as Parameters<typeof col.insertOne>[0]);
  return result.insertedId.toString();
}

/**
 * Retrieve recent uploads for a firm, newest first.
 * Default limit is 20.
 */
export async function getUploadHistory(
  firmId: string,
  limit = 20
): Promise<RawUploadDocument[]> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  return col
    .find({ firm_id: firmId })
    .sort({ upload_date: -1 })
    .limit(limit)
    .toArray();
}

// ---------------------------------------------------------------------------
// enriched_entities
// ---------------------------------------------------------------------------

/**
 * Return the most recently created enriched-entity snapshot for a given
 * firm + entity type, or null if none exists.
 */
export async function getLatestEnrichedEntities(
  firmId: string,
  entityType: string
): Promise<EnrichedEntitiesDocument | null> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  const results = await col
    .find({ firm_id: firmId, entity_type: entityType })
    .sort({ data_version: -1 })
    .limit(1)
    .toArray();
  return results[0] ?? null;
}

/**
 * Insert a new enriched-entity snapshot.
 * data_version is an ISO timestamp string — unique per firm + entity_type.
 */
export async function storeEnrichedEntities(
  firmId: string,
  entityType: string,
  records: Record<string, unknown>[],
  sourceUploads: string[],
  dataQuality?: EnrichedEntitiesDocument['data_quality']
): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  const doc: EnrichedEntitiesDocument = {
    firm_id: firmId,
    entity_type: entityType,
    data_version: new Date().toISOString(),
    source_uploads: sourceUploads,
    records,
    record_count: records.length,
    data_quality: dataQuality,
    created_at: new Date(),
  };
  await col.insertOne(doc as Parameters<typeof col.insertOne>[0]);
}

// ---------------------------------------------------------------------------
// calculated_kpis
// ---------------------------------------------------------------------------

/**
 * Return the most recently calculated KPI snapshot for a firm, or null.
 */
export async function getLatestCalculatedKpis(
  firmId: string
): Promise<CalculatedKpisDocument | null> {
  const col = await getCollection<CalculatedKpisDocument>('calculated_kpis');
  const results = await col
    .find({ firm_id: firmId })
    .sort({ calculated_at: -1 })
    .limit(1)
    .toArray();
  return results[0] ?? null;
}

/**
 * Persist a new calculated-KPIs snapshot.
 */
export async function storeCalculatedKpis(
  firmId: string,
  kpis: Record<string, unknown>,
  configVersion: string,
  dataVersion: string
): Promise<void> {
  const col = await getCollection<CalculatedKpisDocument>('calculated_kpis');
  const doc: CalculatedKpisDocument = {
    firm_id: firmId,
    calculated_at: new Date(),
    config_version: configVersion,
    data_version: dataVersion,
    kpis,
  };
  await col.insertOne(doc as Parameters<typeof col.insertOne>[0]);
}

// ---------------------------------------------------------------------------
// historical_snapshots
// ---------------------------------------------------------------------------

/**
 * Create a new historical snapshot for a firm.
 */
export async function createHistoricalSnapshot(
  firmId: string,
  period: HistoricalSnapshotDocument['period'],
  summary: Record<string, unknown>
): Promise<void> {
  const col = await getCollection<HistoricalSnapshotDocument>('historical_snapshots');
  const doc: HistoricalSnapshotDocument = {
    firm_id: firmId,
    snapshot_date: new Date(),
    period,
    firm_summary: summary,
    created_at: new Date(),
  };
  await col.insertOne(doc as Parameters<typeof col.insertOne>[0]);
}

/**
 * Retrieve historical snapshots for a firm.
 *
 * @param firmId     - The firm to query.
 * @param periodType - Filter by period granularity ('weekly' | 'monthly' etc.).
 * @param dateRange  - Optional { from, to } window (inclusive).
 */
export async function getHistoricalSnapshots(
  firmId: string,
  periodType: HistoricalSnapshotDocument['period'],
  dateRange?: { from: Date; to: Date }
): Promise<HistoricalSnapshotDocument[]> {
  const col = await getCollection<HistoricalSnapshotDocument>('historical_snapshots');

  const filter: Record<string, unknown> = { firm_id: firmId, period: periodType };
  if (dateRange) {
    filter['snapshot_date'] = { $gte: dateRange.from, $lte: dateRange.to };
  }

  return col.find(filter).sort({ snapshot_date: -1 }).toArray();
}

// ---------------------------------------------------------------------------
// custom_entity_records
// ---------------------------------------------------------------------------

/**
 * Upsert custom entity records for a firm + entity type.
 * Replaces the entire records array (full snapshot semantics).
 */
export async function upsertCustomEntityRecords(
  firmId: string,
  entityType: string,
  records: Record<string, unknown>[]
): Promise<void> {
  const col = await getCollection<CustomEntityRecordDocument>('custom_entity_records');
  await col.replaceOne(
    { firm_id: firmId, entity_type: entityType },
    { firm_id: firmId, entity_type: entityType, records, updated_at: new Date() },
    { upsert: true }
  );
}

// ---------------------------------------------------------------------------
// cross_reference_registries
// ---------------------------------------------------------------------------

/**
 * Persist (upsert) the cross-reference registry for a firm.
 * One document per firm — replaced on every pipeline run.
 * Maps must be serialised to plain objects before calling this.
 * Always includes firm_id in the filter — MongoDB isolation rule.
 */
export async function storeCrossReferenceRegistry(
  firmId: string,
  registry: CrossReferenceRegistrySerialised
): Promise<void> {
  const col = await getCollection<CrossReferenceRegistryDocument>(
    'cross_reference_registries'
  );
  const doc: CrossReferenceRegistryDocument = {
    firm_id: firmId,
    data: registry,
    updated_at: new Date(),
  };
  await col.replaceOne(
    { firm_id: firmId },
    doc,
    { upsert: true }
  );
}

/**
 * Load the most recently persisted cross-reference registry for a firm.
 * Returns null if no registry has been built yet.
 * Always filters by firm_id — MongoDB isolation rule.
 */
export async function getCrossReferenceRegistry(
  firmId: string
): Promise<CrossReferenceRegistrySerialised | null> {
  const col = await getCollection<CrossReferenceRegistryDocument>(
    'cross_reference_registries'
  );
  const doc = await col.findOne({ firm_id: firmId });
  return doc?.data ?? null;
}
