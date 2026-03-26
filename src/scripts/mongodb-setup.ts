/**
 * mongodb-setup.ts
 *
 * Creates indexes for all MongoDB collections used by the pipeline.
 * Safe to run multiple times — createIndex is idempotent.
 *
 * Usage:
 *   MONGODB_URI=<uri> MONGODB_DB_NAME=<db> npx tsx src/scripts/mongodb-setup.ts
 */

import { getDb } from '../server/lib/mongodb.js';

async function setup(): Promise<void> {
  const db = await getDb();

  // ---------------------------------------------------------------------------
  // raw_uploads
  // ---------------------------------------------------------------------------
  const rawUploads = db.collection('raw_uploads');
  await rawUploads.createIndex({ firm_id: 1, upload_date: -1 });
  await rawUploads.createIndex({ firm_id: 1, file_type: 1, upload_date: -1 });
  console.log('raw_uploads: indexes created');

  // ---------------------------------------------------------------------------
  // normalised_datasets
  // Unique on (firm_id, file_type, chunk_index) — one doc per chunk.
  // Secondary index on (firm_id, file_type) for fast chunk retrieval.
  // ---------------------------------------------------------------------------
  const normalisedDatasets = db.collection('normalised_datasets');
  await normalisedDatasets.createIndex(
    { firm_id: 1, file_type: 1, chunk_index: 1 },
    { unique: true }
  );
  await normalisedDatasets.createIndex({ firm_id: 1, file_type: 1 });
  console.log('normalised_datasets: indexes created');

  // ---------------------------------------------------------------------------
  // enriched_entities
  // ---------------------------------------------------------------------------
  const enrichedEntities = db.collection('enriched_entities');
  await enrichedEntities.createIndex({ firm_id: 1, entity_type: 1 });
  await enrichedEntities.createIndex({ firm_id: 1, entity_type: 1, updated_at: -1 });
  console.log('enriched_entities: indexes created');

  // ---------------------------------------------------------------------------
  // calculated_kpis
  // ---------------------------------------------------------------------------
  const calculatedKpis = db.collection('calculated_kpis');
  await calculatedKpis.createIndex({ firm_id: 1 });
  await calculatedKpis.createIndex({ firm_id: 1, generated_at: -1 });
  console.log('calculated_kpis: indexes created');

  // ---------------------------------------------------------------------------
  // cross_reference_registries
  // ---------------------------------------------------------------------------
  const crossRef = db.collection('cross_reference_registries');
  await crossRef.createIndex({ firm_id: 1 }, { unique: true });
  console.log('cross_reference_registries: indexes created');

  // ---------------------------------------------------------------------------
  // recalculation_flags
  // ---------------------------------------------------------------------------
  const recalcFlags = db.collection('recalculation_flags');
  await recalcFlags.createIndex({ firm_id: 1 }, { unique: true });
  console.log('recalculation_flags: indexes created');

  // ---------------------------------------------------------------------------
  // historical_snapshots
  // ---------------------------------------------------------------------------
  await db.createCollection('historical_snapshots', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['firm_id', 'period', 'snapshot_date'],
        properties: {
          firm_id:       { bsonType: 'string' },
          period:        { bsonType: 'string', enum: ['daily', 'weekly', 'monthly', 'quarterly', 'annual'] },
          snapshot_date: { bsonType: 'date' },
        },
      },
    },
  }).catch(() => {
    // Collection already exists — apply validator update instead
    return db.command({
      collMod: 'historical_snapshots',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['firm_id', 'period', 'snapshot_date'],
          properties: {
            firm_id:       { bsonType: 'string' },
            period:        { bsonType: 'string', enum: ['daily', 'weekly', 'monthly', 'quarterly', 'annual'] },
            snapshot_date: { bsonType: 'date' },
          },
        },
      },
    });
  });
  const snapshots = db.collection('historical_snapshots');
  await snapshots.createIndex({ firm_id: 1, period: 1, snapshot_date: -1 });
  await snapshots.createIndex({ firm_id: 1, snapshot_date: -1 });
  console.log('historical_snapshots: indexes created');

  console.log('\nAll indexes created successfully.');
  process.exit(0);
}

setup().catch((err: unknown) => {
  console.error('MongoDB setup failed:', err);
  process.exit(1);
});
