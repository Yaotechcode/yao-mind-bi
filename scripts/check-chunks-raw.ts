import { config } from 'dotenv';
config({ path: '.env.local' });
import { getDb } from '../src/server/lib/mongodb.js';

async function main() {
  const db = await getDb();
  
  const chunk = await db.collection('calculated_kpis_chunks').findOne({
    firm_id: '63937b4d-b4ab-4a86-b6ae-28135306c757'
  });
  
  console.log('Chunk top-level keys:', Object.keys(chunk ?? {}));
  console.log('Chunk sample (truncated):', 
    JSON.stringify(chunk, null, 2).slice(0, 500));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
