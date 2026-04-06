import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { count } = await supabase
    .from('kpi_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757');
  console.log('Total rows:', count);

  const { data } = await supabase
    .from('kpi_snapshots')
    .select('entity_type, entity_name, kpi_key, kpi_value, rag_status')
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757')
    .limit(5);
  console.log('Sample:', JSON.stringify(data, null, 2));

  // Count by entity_type
  const { data: all } = await supabase
    .from('kpi_snapshots')
    .select('entity_type')
    .eq('firm_id', '63937b4d-b4ab-4a86-b6ae-28135306c757');
  
  const counts: Record<string, number> = {};
  for (const r of all ?? []) {
    counts[r.entity_type] = (counts[r.entity_type] ?? 0) + 1;
  }
  console.log('By entity_type:', counts);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
