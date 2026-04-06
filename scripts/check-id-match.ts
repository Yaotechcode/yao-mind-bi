import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';
import { getKpiSnapshots } from '../src/server/services/kpi-snapshot-service.js';

async function main() {
  const [doc, snaps] = await Promise.all([
    getLatestEnrichedEntities('63937b4d-b4ab-4a86-b6ae-28135306c757', 'feeEarner'),
    getKpiSnapshots('63937b4d-b4ab-4a86-b6ae-28135306c757', { entityType: 'feeEarner', period: 'current' }),
  ]);

  const records = (doc?.records ?? []) as Record<string, unknown>[];
  const snapIds = new Set(snaps.filter(s => s.kpi_key === 'F-TU-01').map(s => s.entity_id));
  const recIds  = new Set(records.map(r => String(r['_id'])));

  console.log('Snap entity_ids (F-TU-01):', [...snapIds].slice(0, 5));
  console.log('Enriched record _ids:',       [...recIds].slice(0, 5));

  const matched   = [...snapIds].filter(id => recIds.has(id));
  const unmatched = [...snapIds].filter(id => !recIds.has(id));
  console.log('Matched:', matched.length, '/ Unmatched:', unmatched.length);
  if (unmatched.length > 0) console.log('Unmatched snap ids:', unmatched.slice(0, 3));

  // Check department/grade fields on a matched record
  if (matched.length > 0) {
    const r = records.find(r => String(r['_id']) === matched[0])!;
    console.log('\nMatched record fields relevant to dashboard:');
    console.log('  _id:', r['_id']);
    console.log('  fullName:', r['fullName']);
    console.log('  departmentName:', r['departmentName']);
    console.log('  grade:', r['grade']);
    console.log('  jobTitle:', r['jobTitle']);
    console.log('  wipChargeableHours:', r['wipChargeableHours']);
    console.log('  wipTotalHours:', r['wipTotalHours']);
  }
}
main().catch(console.error).finally(() => process.exit(0));
