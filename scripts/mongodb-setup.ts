/**
 * MongoDB Atlas — collection + index setup script.
 *
 * Run with:
 *   npx tsx scripts/mongodb-setup.ts
 *
 * Requires MONGODB_URI and MONGODB_DB_NAME to be set in .env.local.
 * Use the standard (non-SRV) connection string to avoid querySrv failures:
 *   mongodb://user:pass@h1:27017,h2:27017,h3:27017/db?authSource=admin&replicaSet=rs
 */

import { MongoClient, type Db } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// =============================================================================
// Helpers
// =============================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

async function createCollectionIfMissing(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
    console.log(`  ✓ Created collection: ${name}`);
  } else {
    console.log(`  · Collection already exists: ${name}`);
  }
}

// =============================================================================
// Collection definitions
// =============================================================================

async function setupRawUploads(db: Db): Promise<void> {
  console.log('\n[raw_uploads]');
  await createCollectionIfMissing(db, 'raw_uploads');

  // Schema validation
  await db.command({
    collMod: 'raw_uploads',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'firm_id',
          'file_type',
          'original_filename',
          'upload_date',
          'uploaded_by',
          'raw_content',
          'record_count',
          'status',
        ],
        properties: {
          firm_id:            { bsonType: 'string' },
          file_type:          { bsonType: 'string' },
          original_filename:  { bsonType: 'string' },
          upload_date:        { bsonType: 'date' },
          uploaded_by:        { bsonType: 'string' },
          raw_content:        { bsonType: 'array' },
          record_count:       { bsonType: 'int' },
          status:             { bsonType: 'string', enum: ['pending', 'processing', 'processed', 'error'] },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('raw_uploads');

  await col.createIndex({ firm_id: 1, upload_date: -1 }, { background: true });
  await col.createIndex({ firm_id: 1, file_type: 1 },   { background: true });
  await col.createIndex({ status: 1 },                   { background: true });

  console.log('  ✓ Indexes created');
}

async function setupEnrichedEntities(db: Db): Promise<void> {
  console.log('\n[enriched_entities]');
  await createCollectionIfMissing(db, 'enriched_entities');

  await db.command({
    collMod: 'enriched_entities',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'firm_id',
          'entity_type',
          'data_version',
          'source_uploads',
          'records',
          'record_count',
        ],
        properties: {
          firm_id:        { bsonType: 'string' },
          entity_type:    { bsonType: 'string' },
          data_version:   { bsonType: 'string' },
          source_uploads: { bsonType: 'array' },
          records:        { bsonType: 'array' },
          record_count:   { bsonType: 'int' },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('enriched_entities');

  // Unique partial index: one document per (firm, entity_type, data_version)
  await col.createIndex(
    { firm_id: 1, entity_type: 1, data_version: -1 },
    {
      unique: true,
      partialFilterExpression: { firm_id: { $exists: true }, entity_type: { $exists: true } },
      background: true,
    }
  );

  await col.createIndex({ firm_id: 1, data_version: -1 }, { background: true });

  console.log('  ✓ Indexes created');
}

async function setupCalculatedKpis(db: Db): Promise<void> {
  console.log('\n[calculated_kpis]');
  await createCollectionIfMissing(db, 'calculated_kpis');

  await db.command({
    collMod: 'calculated_kpis',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['firm_id', 'calculated_at', 'config_version', 'data_version'],
        properties: {
          firm_id:        { bsonType: 'string' },
          calculated_at:  { bsonType: 'date' },
          config_version: { bsonType: 'string' },
          data_version:   { bsonType: 'string' },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('calculated_kpis');

  await col.createIndex({ firm_id: 1, calculated_at: -1 },   { background: true });
  await col.createIndex({ firm_id: 1, config_version: 1 },   { background: true });

  console.log('  ✓ Indexes created');
}

async function setupHistoricalSnapshots(db: Db): Promise<void> {
  console.log('\n[historical_snapshots]');
  await createCollectionIfMissing(db, 'historical_snapshots');

  await db.command({
    collMod: 'historical_snapshots',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['firm_id', 'snapshot_date', 'period', 'firm_summary'],
        properties: {
          firm_id:       { bsonType: 'string' },
          snapshot_date: { bsonType: 'date' },
          period:        { bsonType: 'string', enum: ['weekly', 'monthly', 'quarterly', 'annual'] },
          firm_summary:  { bsonType: 'object' },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('historical_snapshots');

  await col.createIndex({ firm_id: 1, snapshot_date: -1, period: 1 }, { background: true });

  console.log('  ✓ Indexes created');
}

async function setupCustomEntityRecords(db: Db): Promise<void> {
  console.log('\n[custom_entity_records]');
  await createCollectionIfMissing(db, 'custom_entity_records');

  await db.command({
    collMod: 'custom_entity_records',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['firm_id', 'entity_type', 'records', 'updated_at'],
        properties: {
          firm_id:     { bsonType: 'string' },
          entity_type: { bsonType: 'string' },
          records:     { bsonType: 'array' },
          updated_at:  { bsonType: 'date' },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('custom_entity_records');

  await col.createIndex({ firm_id: 1, entity_type: 1 }, { background: true });

  console.log('  ✓ Indexes created');
}

async function setupRiskFlags(db: Db): Promise<void> {
  console.log('\n[risk_flags]');
  await createCollectionIfMissing(db, 'risk_flags');

  await db.command({
    collMod: 'risk_flags',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'firm_id',
          'flagged_at',
          'entity_type',
          'entity_id',
          'entity_name',
          'flag_type',
          'severity',
          'detail',
          'kpi_value',
          'threshold',
        ],
        properties: {
          firm_id:     { bsonType: 'string' },
          flagged_at:  { bsonType: 'date' },
          entity_type: { bsonType: 'string' },
          entity_id:   { bsonType: 'string' },
          entity_name: { bsonType: 'string' },
          flag_type:   {
            bsonType: 'string',
            enum: [
              'WIP_AGE_HIGH',
              'BUDGET_BURN_CRITICAL',
              'DEBTOR_DAYS_HIGH',
              'UTILISATION_DROP',
              'DORMANT_MATTER',
              'BAD_DEBT_RISK',
              'WRITE_OFF_SPIKE',
            ],
          },
          severity:    { bsonType: 'string', enum: ['high', 'medium', 'low'] },
          detail:      { bsonType: 'string' },
          kpi_value:   { bsonType: 'double' },
          threshold:   { bsonType: 'double' },
          ai_summary:  { bsonType: 'string' },
        },
      },
    },
    validationLevel: 'moderate',
  });

  const col = db.collection('risk_flags');

  await col.createIndex({ firm_id: 1, flagged_at: -1 },                    { background: true });
  await col.createIndex({ firm_id: 1, flag_type: 1, severity: 1 },         { background: true });
  await col.createIndex({ firm_id: 1, entity_type: 1, entity_id: 1 },      { background: true });

  console.log('  ✓ Indexes created');
}

// =============================================================================
// Entry point
// =============================================================================

async function main(): Promise<void> {
  const uri    = requireEnv('MONGODB_URI');
  const dbName = requireEnv('MONGODB_DB_NAME');

  console.log(`Connecting to MongoDB (db: ${dbName})…`);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  try {
    await setupRawUploads(db);
    await setupEnrichedEntities(db);
    await setupCalculatedKpis(db);
    await setupHistoricalSnapshots(db);
    await setupCustomEntityRecords(db);
    await setupRiskFlags(db);

    console.log('\n✅ MongoDB setup complete.\n');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
