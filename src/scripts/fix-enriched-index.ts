/**
 * fix-enriched-index.ts
 *
 * One-time migration: drops the old unique index on
 * { firm_id, entity_type, data_version } from the enriched_entities
 * collection (which blocks multi-chunk writes that share a data_version)
 * and creates the correct unique index on { firm_id, entity_type, chunk_index }.
 *
 * Usage:
 *   MONGODB_URI=<uri> MONGODB_DB_NAME=<db> npx tsx src/scripts/fix-enriched-index.ts
 */

import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });
if (!process.env['MONGODB_URI']) {
  dotenv.config({ path: '.env.local', encoding: 'utf8', override: true });
}
if (!process.env['MONGODB_URI']) {
  throw new Error('MONGODB_URI not loaded — check .env.local exists');
}

import { getDb } from '../server/lib/mongodb.js';

async function main(): Promise<void> {
  const db = await getDb();
  const col = db.collection('enriched_entities');

  // Drop the old index if it exists — ignore error if it doesn't
  try {
    await col.dropIndex('firm_id_1_entity_type_1_data_version_-1');
    console.log('Dropped old index: firm_id_1_entity_type_1_data_version_-1');
  } catch {
    console.log('Old index not found (already dropped or never existed) — skipping drop');
  }

  // Create the correct unique index
  await col.createIndex(
    { firm_id: 1, entity_type: 1, chunk_index: 1 },
    { unique: true },
  );
  console.log('Created new index: { firm_id, entity_type, chunk_index } unique');

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
