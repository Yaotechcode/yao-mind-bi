/**
 * cleanup-duplicates.ts
 *
 * One-time script to remove duplicate enriched_entities documents that
 * accumulated before storeEnrichedEntities was changed from insertOne to
 * replaceOne with upsert.
 *
 * For each entity type, keeps the document with the highest record_count
 * (most recent data) and deletes all others.
 *
 * Usage:
 *   MONGODB_URI=<uri> MONGODB_DB_NAME=<db> FIRM_ID=<firm_id> \
 *     npx tsx src/scripts/cleanup-duplicates.ts
 */

import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });
if (!process.env['MONGODB_URI']) {
  dotenv.config({ path: '.env.local', encoding: 'utf8', override: true });
}
if (!process.env['MONGODB_URI']) {
  throw new Error('MONGODB_URI not loaded — check .env.local exists');
}

import {
  cleanupDuplicateEnrichedEntities,
  cleanupDuplicateCalculatedKpis,
} from '../server/lib/mongodb-operations.js';

async function main(): Promise<void> {
  const firmId = process.env['FIRM_ID'];
  if (!firmId) {
    throw new Error('FIRM_ID env var is required — set it to your firm\'s MongoDB firm_id');
  }

  console.log(`Cleaning up duplicates for firm: ${firmId}`);

  console.log('\n--- enriched_entities ---');
  await cleanupDuplicateEnrichedEntities(firmId);

  console.log('\n--- calculated_kpis ---');
  await cleanupDuplicateCalculatedKpis(firmId);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
