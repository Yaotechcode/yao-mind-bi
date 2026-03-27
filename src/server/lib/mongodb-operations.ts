import { getCollection } from './mongodb.js';
import type {
  RawUploadDocument,
  RawUploadChunkDocument,
  EnrichedEntitiesDocument,
  CalculatedKpisDocument,
  HistoricalSnapshotDocument,
  CustomEntityRecordDocument,
  CrossReferenceRegistryDocument,
  NormalisedDatasetDocument,
  RecalculationFlagDocument,
} from '@shared/types/mongodb.js';
import type {
  CrossReferenceRegistrySerialised,
  NormaliseResult,
  NormalisedRecord,
} from '@shared/types/pipeline.js';

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
  uploadedBy: string,
  totalChunks?: number,
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
    ...(totalChunks != null && { total_chunks: totalChunks, chunks_received: 1 }),
  };
  const result = await col.insertOne(doc as Parameters<typeof col.insertOne>[0]);
  return result.insertedId.toString();
}

/**
 * Append a chunk (chunk_index >= 1) to an existing chunked upload.
 * Stores the chunk's records in raw_upload_chunks and increments
 * chunks_received on the primary raw_uploads document.
 * Returns the updated chunks_received and total_chunks counts so
 * the caller can decide whether to trigger background processing.
 */
export async function storeRawUploadChunk(
  firmId: string,
  uploadId: string,
  chunkIndex: number,
  fileType: string,
  records: Record<string, unknown>[],
): Promise<{ chunksReceived: number; totalChunks: number }> {
  const { ObjectId } = await import('mongodb');

  // Insert the chunk records
  const chunkCol = await getCollection<RawUploadChunkDocument>('raw_upload_chunks');
  await chunkCol.insertOne({
    upload_id: uploadId,
    firm_id: firmId,
    chunk_index: chunkIndex,
    file_type: fileType,
    records,
  } as Parameters<typeof chunkCol.insertOne>[0]);

  // Increment chunks_received on the primary document and return updated counts
  const primaryCol = await getCollection<RawUploadDocument>('raw_uploads');
  const updated = await primaryCol.findOneAndUpdate(
    { _id: new ObjectId(uploadId), firm_id: firmId },
    { $inc: { chunks_received: 1, record_count: records.length } } as never,
    { returnDocument: 'after' },
  );
  if (!updated) throw new Error(`Raw upload document not found: ${uploadId}`);
  return {
    chunksReceived: updated.chunks_received ?? 0,
    totalChunks: updated.total_chunks ?? 1,
  };
}

/**
 * Fetch the full raw records for an upload, reassembling multiple chunks if needed.
 * Chunk 0 records live in raw_uploads.raw_content; chunks 1+ live in raw_upload_chunks.
 * Returns null if the primary document is not found or belongs to a different firm.
 */
export async function getRawUpload(
  firmId: string,
  uploadId: string,
): Promise<Record<string, unknown>[] | null> {
  const primary = await getUploadById(firmId, uploadId);
  if (!primary) return null;

  const content: Record<string, unknown>[] = [...primary.raw_content];

  if ((primary.total_chunks ?? 1) > 1) {
    const chunkCol = await getCollection<RawUploadChunkDocument>('raw_upload_chunks');
    const chunks = await chunkCol
      .find({ firm_id: firmId, upload_id: uploadId })
      .sort({ chunk_index: 1 })
      .toArray();
    for (const chunk of chunks) {
      content.push(...chunk.records);
    }
  }

  return content;
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
 * Upsert the enriched-entity snapshot for a firm + entity type.
 * Uses replaceOne with upsert so only one document per (firm_id, entity_type)
 * ever exists — prevents unbounded accumulation of duplicate snapshots.
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
  await col.replaceOne(
    { firm_id: firmId, entity_type: entityType },
    doc as Parameters<typeof col.replaceOne>[1],
    { upsert: true },
  );
}

/**
 * One-time cleanup: for each entity type, keep only the document with the
 * highest record_count and delete all others. Call this once to fix
 * collections that accumulated duplicates before replaceOne was in place.
 */
export async function cleanupDuplicateEnrichedEntities(firmId: string): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  const { ObjectId } = await import('mongodb');

  const entityTypes = [
    'feeEarner', 'matter', 'timeEntry', 'invoice',
    'client', 'disbursement', 'department', 'task',
  ];

  for (const entityType of entityTypes) {
    // Project only _id and record_count — do NOT fetch the full records array.
    // This avoids the "Sort exceeded memory limit" error from sorting large docs.
    const docs = await col
      .find(
        { firm_id: firmId, entity_type: entityType },
        { projection: { _id: 1, record_count: 1 } },
      )
      .toArray();

    if (docs.length <= 1) continue;

    // Find the doc with the highest record_count in JS memory
    const best = docs.reduce((a, b) =>
      (a.record_count ?? 0) >= (b.record_count ?? 0) ? a : b,
    );

    const idsToDelete = docs
      .filter(d => !new ObjectId(d._id!.toString()).equals(new ObjectId(best._id!.toString())))
      .map(d => new ObjectId(d._id!.toString()));

    if (idsToDelete.length > 0) {
      const result = await col.deleteMany({ firm_id: firmId, _id: { $in: idsToDelete } });
      console.log(`[cleanup] ${entityType}: deleted ${result.deletedCount} duplicate(s), kept 1 (record_count=${best.record_count ?? 0})`);
    }
  }
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

// ---------------------------------------------------------------------------
// raw_uploads — status updates
// ---------------------------------------------------------------------------

/**
 * Update the status of a raw_upload document.
 * Always filters by firm_id to enforce data isolation.
 */
export async function updateUploadStatus(
  firmId: string,
  uploadId: string,
  status: RawUploadDocument['status'],
  errorMessage?: string
): Promise<void> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  const { ObjectId } = await import('mongodb');
  const update: Record<string, unknown> = { status };
  if (status === 'processing') update['processing_started_at'] = new Date();
  if (status === 'processed')  update['processing_completed_at'] = new Date();
  if (errorMessage)            update['error_message'] = errorMessage;
  await col.updateOne(
    { _id: new ObjectId(uploadId), firm_id: firmId },
    { $set: update }
  );
}

/**
 * Retrieve a single raw_upload document by id.
 * Returns null if not found or if the document belongs to a different firm.
 */
export async function getUploadById(
  firmId: string,
  uploadId: string
): Promise<RawUploadDocument | null> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  const { ObjectId } = await import('mongodb');
  return col.findOne({ _id: new ObjectId(uploadId), firm_id: firmId });
}

// ---------------------------------------------------------------------------
// normalised_datasets
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 5000;

/**
 * Store the normalised dataset for a file type in chunks of CHUNK_SIZE records
 * to stay under MongoDB's 16MB document size limit.
 * Deletes all existing chunks for the (firm_id, file_type) pair first, then
 * inserts fresh chunks — avoids replaceOne-with-upsert races on chunk count changes.
 */
export async function storeNormalisedDataset(
  firmId: string,
  fileType: string,
  entityKey: string,
  records: NormalisedRecord[],
  sourceUploadId: string
): Promise<void> {
  const col = await getCollection<NormalisedDatasetDocument>('normalised_datasets');

  // Delete ALL existing chunks for this firm + fileType before writing fresh ones.
  // This is the correct replace-all pattern — do not move this after any insert.
  const { deletedCount } = await col.deleteMany({ firm_id: firmId, file_type: fileType });
  if (deletedCount > 0) {
    console.log(`[storeNormalisedDataset] deleted ${deletedCount} stale chunk(s) for ${fileType}`);
  }

  const totalChunks = Math.max(1, Math.ceil(records.length / CHUNK_SIZE));
  const now = new Date();

  for (let i = 0; i < totalChunks; i++) {
    const chunk = records.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await col.insertOne({
      firm_id: firmId,
      file_type: fileType,
      entity_key: entityKey,
      source_upload_id: sourceUploadId,
      chunk_index: i,
      total_chunks: totalChunks,
      records: chunk as Record<string, unknown>[],
      record_count: records.length,
      normalised_at: now,
    } as NormalisedDatasetDocument);
  }
}

/**
 * Load all normalised datasets for a firm as a Record<fileType, NormaliseResult>.
 * Reassembles multi-chunk datasets in chunk_index order transparently.
 * Returns empty record if no datasets have been stored yet.
 */
export async function getAllNormalisedDatasets(
  firmId: string
): Promise<Record<string, NormaliseResult>> {
  const col = await getCollection<NormalisedDatasetDocument>('normalised_datasets');
  // Sort by chunk_index ascending so chunks arrive in order within each file_type
  const docs = await col.find({ firm_id: firmId }).sort({ chunk_index: 1 }).toArray();

  const result: Record<string, NormaliseResult> = {};
  for (const doc of docs) {
    if (result[doc.file_type]) {
      // Subsequent chunk — append records
      result[doc.file_type].records = [
        ...result[doc.file_type].records,
        ...(doc.records as NormalisedRecord[]),
      ];
    } else {
      // First (or only) chunk — initialise entry with the stored total record_count
      result[doc.file_type] = {
        fileType: doc.entity_key,
        records: doc.records as NormalisedRecord[],
        recordCount: doc.record_count,
        normalisedAt: doc.normalised_at.toISOString(),
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// enriched_entities — delete
// ---------------------------------------------------------------------------

/**
 * Delete all enriched entity snapshots for a firm + entity type.
 * Used when an upload is deleted to clear derived data.
 */
export async function deleteEnrichedEntitiesByType(
  firmId: string,
  entityType: string
): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  await col.deleteMany({ firm_id: firmId, entity_type: entityType });
}

// ---------------------------------------------------------------------------
// recalculation_flags
// ---------------------------------------------------------------------------

/**
 * Mark this firm's calculated KPIs as stale.
 * Called after every successful upload. The formula engine (1C) checks
 * this flag before running and clears it after completion.
 */
export async function setRecalculationFlag(firmId: string): Promise<void> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  await col.replaceOne(
    { firm_id: firmId },
    { firm_id: firmId, is_stale: true, stale_since: new Date() },
    { upsert: true }
  );
}

/**
 * Read the recalculation flag for a firm.
 * Returns null if no flag exists (no uploads yet).
 */
export async function getRecalculationFlag(firmId: string): Promise<RecalculationFlagDocument | null> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  return col.findOne({ firm_id: firmId });
}

/**
 * Clear the recalculation flag for a firm.
 * Called after the formula engine successfully completes a calculation run.
 */
export async function clearRecalculationFlag(firmId: string): Promise<void> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  await col.replaceOne(
    { firm_id: firmId },
    { firm_id: firmId, is_stale: false, stale_since: new Date(), is_calculating: false },
    { upsert: true }
  );
}

/**
 * Mark that a calculation is actively running for a firm.
 * Clears any previous error state. Call before starting the orchestrator.
 */
export async function setCalculationInProgress(firmId: string): Promise<void> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  const existing = await col.findOne({ firm_id: firmId });
  await col.replaceOne(
    { firm_id: firmId },
    {
      firm_id: firmId,
      is_stale: existing?.is_stale ?? true,
      stale_since: existing?.stale_since ?? new Date(),
      is_calculating: true,
      last_error: undefined,
      last_error_at: undefined,
    },
    { upsert: true }
  );
}

/**
 * Record a calculation failure for a firm.
 * Sets is_stale back to true and stores the error message.
 */
export async function setCalculationError(firmId: string, error: string): Promise<void> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  await col.replaceOne(
    { firm_id: firmId },
    {
      firm_id: firmId,
      is_stale: true,
      stale_since: new Date(),
      is_calculating: false,
      last_error: error,
      last_error_at: new Date(),
    },
    { upsert: true }
  );
}

/**
 * Check whether a daily historical snapshot already exists for today.
 * Uses UTC date boundaries to prevent duplicate daily snapshots.
 */
export async function getTodayHistoricalSnapshot(
  firmId: string,
): Promise<HistoricalSnapshotDocument | null> {
  const col = await getCollection<HistoricalSnapshotDocument>('historical_snapshots');
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setUTCHours(23, 59, 59, 999);

  const results = await col
    .find({
      firm_id: firmId,
      period: 'daily',
      snapshot_date: { $gte: startOfDay, $lte: endOfDay },
    })
    .limit(1)
    .toArray();
  return results[0] ?? null;
}
