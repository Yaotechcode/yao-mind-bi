import { getKpiSnapshots } from '../src/server/services/kpi-snapshot-service.js';

async function main() {
  const snaps = await getKpiSnapshots('63937b4d-b4ab-4a86-b6ae-28135306c757', { entityType: 'feeEarner', period: 'current' });
  const tuSnaps = snaps.filter(s => s.kpi_key === 'F-TU-01').slice(0, 5);
  console.log('F-TU-01 sample entity_ids:');
  tuSnaps.forEach(s => console.log(' ', s.entity_id, '|', s.entity_name));
  console.log('Total feeEarner snap rows:', snaps.length);
  console.log('Distinct kpi_keys:', [...new Set(snaps.map(s => s.kpi_key))].join(', '));
}
main().catch(console.error).finally(() => process.exit(0));
