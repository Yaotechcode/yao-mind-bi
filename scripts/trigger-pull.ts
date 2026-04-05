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

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';
const NETLIFY_URL = 'https://yao-mind.netlify.app';

// First reset pull status
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

await supabase.from('pull_status')
  .upsert({ firm_id: FIRM_ID, status: 'idle', error: null, current_stage: null },
    { onConflict: 'firm_id' });

console.log('Pull status reset to idle');

// Trigger the background function directly
const res = await fetch(`${NETLIFY_URL}/.netlify/functions/yao-pull-background`, {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'x-internal-secret': process.env.INTERNAL_API_SECRET ?? ''
  },
  body: JSON.stringify({ firmId: FIRM_ID }),
});

console.log('Response status:', res.status);
const body = await res.text();
console.log('Response:', body.slice(0, 200));
