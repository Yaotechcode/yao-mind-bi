/**
 * migrate-pull-lookback.ts
 *
 * One-time migration: sets dataPullLookbackMonths: 13 in the
 * working_time_defaults JSONB column for all firms that currently have it
 * absent or set to the old default (≤ 3).
 *
 * Run with: npx tsx scripts/migrate-pull-lookback.ts
 */
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
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TARGET_VALUE = 13;

async function main() {
  const { data: rows, error } = await supabase
    .from('firm_config')
    .select('firm_id, working_time_defaults');

  if (error) {
    console.error('Failed to read firm_config:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('No firms found in firm_config.');
    return;
  }

  console.log(`Found ${rows.length} firm(s). Checking dataPullLookbackMonths in working_time_defaults...`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const firmId = row.firm_id as string;
    const wtd = (row.working_time_defaults ?? {}) as Record<string, unknown>;
    const current = wtd['dataPullLookbackMonths'];

    if (current == null || (typeof current === 'number' && current < TARGET_VALUE)) {
      const updatedWtd = { ...wtd, dataPullLookbackMonths: TARGET_VALUE };

      const { error: writeError } = await supabase
        .from('firm_config')
        .update({
          working_time_defaults: updatedWtd,
          updated_at: new Date().toISOString(),
        })
        .eq('firm_id', firmId);

      if (writeError) {
        console.error(`  ERROR updating firm ${firmId}: ${writeError.message}`);
      } else {
        const was = current == null ? 'absent' : String(current);
        console.log(`  Updated firm ${firmId}: dataPullLookbackMonths ${was} → ${TARGET_VALUE}`);
        updatedCount++;
      }
    } else {
      console.log(`  Skipped firm ${firmId}: already ${current}`);
      skippedCount++;
    }
  }

  console.log(`\nDone. Updated: ${updatedCount}, Skipped: ${skippedCount}`);
}

main().catch(console.error).finally(() => process.exit(0));
