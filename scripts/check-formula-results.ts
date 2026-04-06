import { config } from 'dotenv';
config({ path: '.env.local' });
import { getDb } from '../src/server/lib/mongodb.js';

async function main() {
  const db = await getDb();
  
  // Get the calculated_kpis header
  const header = await db.collection('calculated_kpis').findOne({
    firm_id: '63937b4d-b4ab-4a86-b6ae-28135306c757'
  });
  
  console.log('Header keys:', Object.keys(header?.kpis ?? {}));
  
  // Get a chunk that contains fee earner formulas
  const chunks = await db.collection('calculated_kpis_chunks').find({
    firm_id: '63937b4d-b4ab-4a86-b6ae-28135306c757'
  }).limit(5).toArray();
  
  for (const chunk of chunks) {
    console.log('\nChunk formula_id:', chunk.formula_id, 
      'entities:', chunk.entities?.length,
      'sample entity:', JSON.stringify(chunk.entities?.[0])?.slice(0, 200));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
