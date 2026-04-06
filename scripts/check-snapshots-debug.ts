import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Try kpi_snapshots with no filters
  const { data: snap, error: e1, count } = await supabase
    .from('kpi_snapshots')
    .select('*', { count: 'exact', head: true });
  console.log('kpi_snapshots total rows:', count, 'error:', e1?.message);

  // Get a sample row if any exist
  const { data: sample, error: e2 } = await supabase
    .from('kpi_snapshots')
    .select('*')
    .limit(3);
  console.log('sample rows:', JSON.stringify(sample, null, 2));
  console.log('sample error:', e2?.message);

  // Check pull_status to confirm last pull
  const { data: pulls } = await supabase
    .from('pull_status')
    .select('firm_id, status, started_at, records_fetched')
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757');
  console.log('pull_status:', JSON.stringify(pulls, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
