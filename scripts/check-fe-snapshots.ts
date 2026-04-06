import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get distinct kpi_keys for feeEarner
  const { data: keys } = await supabase
    .from('kpi_snapshots')
    .select('kpi_key')
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757')
    .eq('entity_type', 'feeEarner')
    .limit(200);

  const unique = [...new Set(keys?.map(r => r.kpi_key) ?? [])];
  console.log('Available kpi_keys for feeEarner:', unique);

  // Get a sample fee earner's full snapshot
  const { data: sample } = await supabase
    .from('kpi_snapshots')
    .select('*')
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757')
    .eq('entity_type', 'feeEarner')
    .limit(10);

  console.log('\nSample rows:', JSON.stringify(sample, null, 2));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
