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
  RiskFlagDocument,
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

const ENRICHED_CHUNK_SIZE = 2000;

/**
 * Load all chunks for a firm + entity type, reassemble in chunk_index order,
 * and return a single synthetic document with the combined records array.
 * Returns null if no chunks exist for this entity type.
 */
export async function getLatestEnrichedEntities(
  firmId: string,
  entityType: string
): Promise<EnrichedEntitiesDocument | null> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  const chunks = await col
    .find({ firm_id: firmId, entity_type: entityType })
    .sort({ chunk_index: 1 })
    .toArray();

  if (chunks.length === 0) return null;

  // Combine all chunk records into a single synthetic document
  const first = chunks[0];
  const allRecords = chunks.flatMap(c => c.records);
  return {
    ...first,
    records: allRecords,
    record_count: first.record_count, // total count is stored on every chunk
  };
}

/**
 * Store enriched entity records in chunks of ENRICHED_CHUNK_SIZE to stay
 * under MongoDB's 16MB document limit. Uses replaceOne+upsert keyed on
 * { firm_id, entity_type, chunk_index } — atomic per chunk, eliminates the
 * deleteMany → insertOne race condition under concurrent pipeline runs.
 * After writing all current chunks, deletes any stale chunks with a higher
 * chunk_index than the new total (handles shrinking datasets).
 */
export async function storeEnrichedEntities(
  firmId: string,
  entityType: string,
  records: Record<string, unknown>[],
  sourceUploads: string[],
  dataQuality?: EnrichedEntitiesDocument['data_quality']
): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');

  const totalChunks = Math.max(1, Math.ceil(records.length / ENRICHED_CHUNK_SIZE));
  const dataVersion = new Date().toISOString();
  const now = new Date();

  for (let i = 0; i < totalChunks; i++) {
    const chunk = records.slice(i * ENRICHED_CHUNK_SIZE, (i + 1) * ENRICHED_CHUNK_SIZE);
    await col.replaceOne(
      { firm_id: firmId, entity_type: entityType, chunk_index: i },
      {
        firm_id: firmId,
        entity_type: entityType,
        data_version: dataVersion,
        chunk_index: i,
        total_chunks: totalChunks,
        source_uploads: sourceUploads,
        records: chunk,
        record_count: records.length, // total across all chunks — stored on every chunk
        data_quality: i === 0 ? dataQuality : undefined,
        created_at: now,
      } as EnrichedEntitiesDocument,
      { upsert: true },
    );
  }

  // Remove stale chunks from a previous run that had more chunks than the current one
  await col.deleteMany({
    firm_id: firmId,
    entity_type: entityType,
    chunk_index: { $gte: totalChunks },
  });
}

/**
 * One-time cleanup: for each entity type, keep the chunk set with the highest
 * record_count and delete all others. Works for both old single-doc format
 * (no chunk_index) and new multi-chunk format — all docs in a set share the
 * same record_count, so we delete every doc whose record_count is below the max.
 */
export async function cleanupDuplicateEnrichedEntities(firmId: string): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  const { ObjectId } = await import('mongodb');

  const entityTypes = [
    'feeEarner', 'matter', 'timeEntry', 'invoice',
    'client', 'disbursement', 'department', 'task',
  ];

  for (const entityType of entityTypes) {
    // Project only lightweight fields — never fetch the full records array
    const docs = await col
      .find(
        { firm_id: firmId, entity_type: entityType },
        { projection: { _id: 1, record_count: 1, chunk_index: 1 } },
      )
      .toArray();

    if (docs.length === 0) {
      console.log(`[cleanup] ${entityType}: no documents found`);
      continue;
    }

    // Find the max record_count — all chunks in the same set share this value
    const maxCount = Math.max(...docs.map(d => d.record_count ?? 0));

    // Delete every doc whose record_count is below the max (stale chunk sets)
    const idsToDelete = docs
      .filter(d => (d.record_count ?? 0) < maxCount)
      .map(d => new ObjectId(d._id!.toString()));

    if (idsToDelete.length > 0) {
      const result = await col.deleteMany({ firm_id: firmId, _id: { $in: idsToDelete } });
      const kept = docs.length - idsToDelete.length;
      console.log(`[cleanup] ${entityType}: deleted ${result.deletedCount} stale doc(s), kept ${kept} chunk(s) (record_count=${maxCount})`);
    } else {
      console.log(`[cleanup] ${entityType}: ${docs.length} doc(s), all current (record_count=${maxCount})`);
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

// Safe BSON size threshold: 12MB leaves a 4MB buffer below MongoDB's 16MB limit.
// Payloads above this are split: formulaResults chunks go to calculated_kpis_chunks,
// the header document (without formulaResults) stays in calculated_kpis.
const BSON_SAFE_THRESHOLD_BYTES = 12 * 1024 * 1024; // 12MB
const FORMULA_CHUNK_SIZE = 500; // max entity results per chunk document

/**
 * Estimate serialised BSON size by measuring the JSON string length.
 * JSON ≈ BSON for typical mixed payloads; this is a conservative proxy.
 */
function estimateSize(obj: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(obj) ?? '', 'utf8');
  } catch {
    return Infinity; // treat unserializable as too large
  }
}

/**
 * Upsert the calculated-KPIs snapshot for a firm.
 *
 * If the payload is under 12MB, it is stored as a single document in
 * calculated_kpis (existing behaviour). If it exceeds the safe threshold,
 * the formulaResults are split into chunks stored in calculated_kpis_chunks
 * and the header document (without formulaResults) is stored in calculated_kpis
 * with a chunk_count field so readers know to reassemble.
 *
 * Uses replaceOne + upsert so only one header per firm_id ever exists.
 */
export async function storeCalculatedKpis(
  firmId: string,
  kpis: Record<string, unknown>,
  configVersion: string,
  dataVersion: string
): Promise<void> {
  const calculatedAt = new Date();
  const estimatedBytes = estimateSize(kpis);

  // ------------------------------------------------------------------
  // Fast path: payload fits in a single document
  // ------------------------------------------------------------------
  if (estimatedBytes <= BSON_SAFE_THRESHOLD_BYTES) {
    const col = await getCollection<CalculatedKpisDocument>('calculated_kpis');
    const doc: CalculatedKpisDocument = {
      firm_id: firmId,
      calculated_at: calculatedAt,
      config_version: configVersion,
      data_version: dataVersion,
      kpis,
    };
    await col.replaceOne(
      { firm_id: firmId },
      doc as Parameters<typeof col.replaceOne>[1],
      { upsert: true },
    );
    return;
  }

  // ------------------------------------------------------------------
  // Chunked path: split formulaResults across calculated_kpis_chunks
  // ------------------------------------------------------------------
  console.log(`[mongodb] calculated_kpis payload ~${Math.round(estimatedBytes / 1024 / 1024)}MB — using chunked storage`);

  const formulaResults = kpis['formulaResults'] as Record<string, unknown> | undefined;
  const kpisWithoutFormulas: Record<string, unknown> = { ...kpis };
  delete kpisWithoutFormulas['formulaResults'];

  // Flatten formulaResults into (formulaId, entityId, entityResult) triples
  // and batch them into chunks of FORMULA_CHUNK_SIZE.
  const chunks: Array<{ formulaId: string; entityId: string; entityResult: unknown }[]> = [[]];

  if (formulaResults) {
    for (const [formulaId, result] of Object.entries(formulaResults)) {
      const entityResults = (result as Record<string, unknown>)['entityResults'] as Record<string, unknown> | undefined;
      if (!entityResults) continue;
      for (const [entityId, entityResult] of Object.entries(entityResults)) {
        const last = chunks[chunks.length - 1];
        if (last.length >= FORMULA_CHUNK_SIZE) {
          chunks.push([]);
        }
        chunks[chunks.length - 1].push({ formulaId, entityId, entityResult });
      }
    }
  }

  // Remove trailing empty chunk
  if (chunks.length > 0 && chunks[chunks.length - 1].length === 0) {
    chunks.pop();
  }

  const chunkCount = chunks.length;
  const chunksCol = await getCollection<Record<string, unknown>>('calculated_kpis_chunks');

  // Write chunk documents (upsert by firm_id + chunk_index)
  for (let i = 0; i < chunkCount; i++) {
    await chunksCol.replaceOne(
      { firm_id: firmId, chunk_index: i },
      {
        firm_id: firmId,
        chunk_index: i,
        chunk_count: chunkCount,
        data_version: dataVersion,
        calculated_at: calculatedAt,
        entries: chunks[i],
      },
      { upsert: true },
    );
  }

  // Delete stale chunks from a previous run that had more chunks
  await chunksCol.deleteMany({
    firm_id: firmId,
    chunk_index: { $gte: chunkCount },
  });

  // Write the header document without formulaResults
  const col = await getCollection<CalculatedKpisDocument>('calculated_kpis');
  const headerDoc: CalculatedKpisDocument = {
    firm_id: firmId,
    calculated_at: calculatedAt,
    config_version: configVersion,
    data_version: dataVersion,
    kpis: {
      ...kpisWithoutFormulas,
      formulaResultsChunked: true,
      chunk_count: chunkCount,
    },
  };
  await col.replaceOne(
    { firm_id: firmId },
    headerDoc as Parameters<typeof col.replaceOne>[1],
    { upsert: true },
  );

  console.log(`[mongodb] calculated_kpis stored as header + ${chunkCount} chunks in calculated_kpis_chunks`);
}

/**
 * One-time cleanup: keep only the most recent calculated_kpis document for a
 * firm (by calculated_at) and delete all others. Projects only _id and
 * calculated_at to avoid loading the full KPI payload into memory.
 */
export async function cleanupDuplicateCalculatedKpis(firmId: string): Promise<void> {
  const col = await getCollection<CalculatedKpisDocument>('calculated_kpis');
  const { ObjectId } = await import('mongodb');

  const docs = await col
    .find(
      { firm_id: firmId },
      { projection: { _id: 1, calculated_at: 1 } },
    )
    .toArray();

  if (docs.length <= 1) {
    console.log('[cleanup] calculated_kpis: nothing to clean');
    return;
  }

  const best = docs.reduce((a, b) =>
    new Date(a.calculated_at) >= new Date(b.calculated_at) ? a : b,
  );

  const idsToDelete = docs
    .filter(d => !new ObjectId(d._id!.toString()).equals(new ObjectId(best._id!.toString())))
    .map(d => new ObjectId(d._id!.toString()));

  const result = await col.deleteMany({ firm_id: firmId, _id: { $in: idsToDelete } });
  console.log(`[cleanup] calculated_kpis: deleted ${result.deletedCount} duplicate(s), kept 1`);
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
 * to stay under MongoDB's 16MB document size limit. Uses replaceOne+upsert
 * keyed on { firm_id, file_type, chunk_index } — atomic per chunk, eliminates
 * the deleteMany → insertOne race condition under concurrent pipeline runs.
 * After writing all current chunks, deletes any stale chunks with a higher
 * chunk_index than the new total (handles shrinking datasets).
 */
export async function storeNormalisedDataset(
  firmId: string,
  fileType: string,
  entityKey: string,
  records: NormalisedRecord[],
  sourceUploadId: string
): Promise<void> {
  const col = await getCollection<NormalisedDatasetDocument>('normalised_datasets');

  const totalChunks = Math.max(1, Math.ceil(records.length / CHUNK_SIZE));
  const now = new Date();

  for (let i = 0; i < totalChunks; i++) {
    const chunk = records.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await col.replaceOne(
      { firm_id: firmId, file_type: fileType, chunk_index: i },
      {
        firm_id: firmId,
        file_type: fileType,
        entity_key: entityKey,
        source_upload_id: sourceUploadId,
        chunk_index: i,
        total_chunks: totalChunks,
        records: chunk as Record<string, unknown>[],
        record_count: records.length,
        normalised_at: now,
      } as NormalisedDatasetDocument,
      { upsert: true },
    );
  }

  // Remove stale chunks from a previous run that had more chunks than the current one
  await col.deleteMany({
    firm_id: firmId,
    file_type: fileType,
    chunk_index: { $gte: totalChunks },
  });
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

// ---------------------------------------------------------------------------
// risk_flags
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<RiskFlagDocument['severity'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Replace all risk flags for a firm with a fresh set.
 * Deletes existing flags first, then inserts the new batch.
 * A pull with zero flags results in an empty collection for that firm.
 */
export async function storeRiskFlags(
  firmId: string,
  flags: RiskFlagDocument[],
): Promise<void> {
  const col = await getCollection<RiskFlagDocument>('risk_flags');
  await col.deleteMany({ firm_id: firmId });
  if (flags.length > 0) {
    const docs = flags.map((f) => ({ ...f, firm_id: firmId }));
    await col.insertMany(docs as Parameters<typeof col.insertMany>[0]);
  }
}

/**
 * Return risk flags for a firm, sorted by severity (high first) then flagged_at DESC.
 * All filter parameters are optional.
 */
export async function getRiskFlags(
  firmId: string,
  options?: {
    severity?: RiskFlagDocument['severity'];
    entity_type?: string;
    flag_type?: RiskFlagDocument['flag_type'];
    limit?: number;
  },
): Promise<RiskFlagDocument[]> {
  const col = await getCollection<RiskFlagDocument>('risk_flags');

  const filter: Record<string, unknown> = { firm_id: firmId };
  if (options?.severity)    filter['severity']    = options.severity;
  if (options?.entity_type) filter['entity_type'] = options.entity_type;
  if (options?.flag_type)   filter['flag_type']   = options.flag_type;

  const docs = await col
    .find(filter)
    .sort({ flagged_at: -1 })
    .limit(options?.limit ?? 0)
    .toArray();

  // Sort by severity (high → medium → low) then preserve flagged_at DESC within each bucket
  return docs.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.flagged_at.getTime() - a.flagged_at.getTime(),
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
