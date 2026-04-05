import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const client = createClient(supabaseUrl, serviceRoleKey);

async function runMigration(filePath) {
  const sql = readFileSync(resolve(filePath), 'utf-8');
  console.log(`\nRunning ${filePath}...`);
  
  try {
    const { error } = await client.rpc('exec_sql', { sql_statement: sql });
    if (error) {
      console.error(`❌ ${filePath} failed:`, error.message);
      return false;
    }
    console.log(`✅ ${filePath} completed`);
    return true;
  } catch (err) {
    console.error(`❌ ${filePath} error:`, err.message);
    return false;
  }
}

async function main() {
  const migrations = [
    'scripts/supabase-migration-001.sql',
    'scripts/supabase-migration-002-functions.sql',
    'scripts/supabase-migration-003-formula-versions.sql',
    'scripts/supabase-migration-004-api-integration.sql',
  ];

  let allSuccess = true;
  for (const migration of migrations) {
    const success = await runMigration(migration);
    if (!success) allSuccess = false;
  }

  process.exit(allSuccess ? 0 : 1);
}

main();
