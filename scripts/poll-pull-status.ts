import { readFileSync } from 'fs';
import { resolve } from 'path';

const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
envContent.split('\n').forEach(line => {
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim().replace(/^'|'$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
});

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';

for (let i = 0; i < 60; i++) {
  const { data } = await supabase
    .from('pull_status')
    .select('*')
    .eq('firm_id', FIRM_ID)
    .single();

  const time = new Date().toISOString().slice(11,19);
  console.log(`[${time}] status: ${data?.status} | stage: ${data?.current_stage ?? '-'} | records: ${JSON.stringify(data?.records_fetched ?? {})}`);

  if (data?.status === 'complete' || data?.status === 'failed') {
    if (data?.error) console.log('ERROR:', data.error);
    break;
  }

  await new Promise(r => setTimeout(r, 5000));
}
