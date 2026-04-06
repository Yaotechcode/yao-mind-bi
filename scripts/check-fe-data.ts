import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const doc = await getLatestEnrichedEntities('63937b4d-b4ab-4a86-b6ae-28135306c757', 'feeEarner');
  const records = (doc?.records ?? []) as Record<string, unknown>[];
  console.log('Record count:', records.length);
  if (records.length > 0) {
    const r = records[0];
    console.log('Keys:', Object.keys(r));
    console.log('Sample:', JSON.stringify(r, null, 2).slice(0, 2000));
  }
}
main().catch(console.error).finally(() => process.exit(0));
