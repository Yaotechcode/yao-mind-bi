/**
 * test-pull.ts — End-to-end pull verification script
 *
 * Runs a full PullOrchestrator pull for a given firm and prints verification
 * output to the console. Used to validate the API integration pipeline against
 * real Yao data before committing.
 *
 * Usage:
 *   npx tsx scripts/test-pull.ts --firm-id=<uuid>
 *
 * Requires the following env vars (loaded from .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MONGODB_URI, MONGODB_DB_NAME
 *   YAO_CREDENTIAL_ENCRYPTION_KEY
 *   YAO_API_BASE_URL
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// =============================================================================
// Load .env.local before anything else
// =============================================================================

function loadEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.warn(`[env] Could not read ${path} — relying on process.env`);
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnv(resolve(process.cwd(), '.env.local'));

// =============================================================================
// Parse CLI args
// =============================================================================

const firmIdArg = process.argv.find((a) => a.startsWith('--firm-id='));
if (!firmIdArg) {
  console.error('Usage: npx tsx scripts/test-pull.ts --firm-id=<uuid>');
  process.exit(1);
}
const FIRM_ID = firmIdArg.split('=')[1];
if (!FIRM_ID) {
  console.error('Error: --firm-id value is empty');
  process.exit(1);
}

// =============================================================================
// Validate required env vars
// =============================================================================

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MONGODB_URI',
  'MONGODB_DB_NAME',
  'YAO_CREDENTIAL_ENCRYPTION_KEY',
  'YAO_API_BASE_URL',
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(60));
  console.log(' YAO MIND — END-TO-END PULL VERIFICATION');
  console.log('═'.repeat(60));
  console.log(`  firm_id : ${FIRM_ID}`);
  console.log(`  api_url : ${process.env['YAO_API_BASE_URL']}`);
  console.log(`  db      : ${process.env['MONGODB_DB_NAME']}`);
  console.log('═'.repeat(60) + '\n');

  // ── Step 1: Run the pull ──────────────────────────────────────────────────

  const { PullOrchestrator } = await import('../src/server/datasource/PullOrchestrator.js');

  console.log('► Starting pull...\n');
  const startMs = Date.now();

  const orchestrator = new PullOrchestrator(FIRM_ID);
  const result = await orchestrator.run();

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  // ── Step 2: Print top-level result ───────────────────────────────────────

  console.log('\n' + '─'.repeat(60));
  console.log(' PULL RESULT');
  console.log('─'.repeat(60));
  console.log(`  success   : ${result.success ? '✅  true' : '❌  false'}`);
  console.log(`  duration  : ${elapsedSec}s`);
  console.log(`  pulledAt  : ${result.pulledAt}`);

  // ── Step 3: Stats ─────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(60));
  console.log(' STATS');
  console.log('─'.repeat(60));

  const s = result.stats;
  const check = (label: string, actual: number, min: number, max?: number): void => {
    const inRange = actual >= min && (max === undefined || actual <= max);
    const icon = inRange ? '✅' : '⚠️ ';
    const range = max !== undefined ? `(expected ${min}–${max})` : `(expected ≥${min})`;
    console.log(`  ${icon} ${label.padEnd(24)}: ${String(actual).padStart(6)}  ${range}`);
  };

  check('attorneys',          s.attorneys,          10,  30);
  check('matters',            s.matters,            500, 1200);
  check('timeEntries',        s.timeEntries,        5000);
  check('invoices',           s.invoices,           500);
  check('disbursements',      s.disbursements,      1000);
  check('tasks',              s.tasks,              100);
  check('contacts',           s.contacts,           100);
  check('kpiSnapshotsWritten', s.kpiSnapshotsWritten, 100);
  check('riskFlagsGenerated', s.riskFlagsGenerated, 0);

  // ── Step 4: Warnings ──────────────────────────────────────────────────────

  if (result.warnings.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(' WARNINGS');
    console.log('─'.repeat(60));
    result.warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  } else {
    console.log('\n  (no warnings)');
  }

  // ── Step 5: Errors ────────────────────────────────────────────────────────

  if (result.errors.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(' ERRORS');
    console.log('─'.repeat(60));
    result.errors.forEach((e, i) => console.log(`  ${i + 1}. ❌ ${e}`));
    console.log('\n  Pull failed — skipping verification steps.');
    await closeConnections();
    process.exit(1);
  }

  // ── Step 6: Supabase verification ─────────────────────────────────────────

  const { getServerClient } = await import('../src/server/lib/supabase.js');
  const db = getServerClient();

  console.log('\n' + '─'.repeat(60));
  console.log(' SUPABASE VERIFICATION');
  console.log('─'.repeat(60));

  // pull_status
  const { data: pullStatusRow } = await db
    .from('pull_status')
    .select('status, pulled_at, current_stage, error')
    .eq('firm_id', FIRM_ID)
    .single();

  if (pullStatusRow) {
    const ps = pullStatusRow as Record<string, unknown>;
    const ok = ps['status'] === 'complete';
    console.log(`  ${ok ? '✅' : '❌'} pull_status.status = ${ps['status']}`);
    console.log(`     pulled_at      = ${ps['pulled_at']}`);
    if (ps['error']) console.log(`     error          = ${ps['error']}`);
  } else {
    console.log('  ❌ pull_status row not found');
  }

  // kpi_snapshots row count
  const { count: snapshotCount } = await db
    .from('kpi_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('firm_id', FIRM_ID);

  const snapOk = (snapshotCount ?? 0) > 0;
  console.log(`  ${snapOk ? '✅' : '❌'} kpi_snapshots rows = ${snapshotCount ?? 0}`);

  // First 3 snapshot rows
  const { data: sampleSnapshots } = await db
    .from('kpi_snapshots')
    .select('entity_type, entity_name, kpi_key, kpi_value, rag_status, display_value, period')
    .eq('firm_id', FIRM_ID)
    .limit(3);

  if (sampleSnapshots && sampleSnapshots.length > 0) {
    console.log('\n  Sample kpi_snapshots (first 3):');
    for (const row of sampleSnapshots as Record<string, unknown>[]) {
      console.log(
        `    [${row['entity_type']}] ${String(row['entity_name']).padEnd(25)} ` +
        `${String(row['kpi_key']).padEnd(10)} = ${row['display_value']} ` +
        `(${row['rag_status'] ?? 'neutral'})`,
      );
    }
  }

  // ── Step 7: MongoDB verification ──────────────────────────────────────────

  const { getDb } = await import('../src/server/lib/mongodb.js');
  const mdb = await getDb();

  console.log('\n' + '─'.repeat(60));
  console.log(' MONGODB VERIFICATION');
  console.log('─'.repeat(60));

  // enriched_entities stores records in a `records[]` array per chunk document.
  // We inspect the records within each chunk.

  // Password field check — sample records from feeEarner chunks
  const feeEarnerDocs = await mdb
    .collection('enriched_entities')
    .find({ firm_id: FIRM_ID, entity_type: 'feeEarner' })
    .limit(2)
    .toArray();

  let passwordFound = false;
  let feeEarnerSampled = 0;
  for (const doc of feeEarnerDocs) {
    const records = (doc as Record<string, unknown>)['records'] as Record<string, unknown>[] | undefined;
    for (const r of (records ?? []).slice(0, 5)) {
      feeEarnerSampled++;
      if ('password' in r || 'email_default_signature' in r) {
        passwordFound = true;
        console.log(`  ❌ Sensitive field found in feeEarner record: ${r['_id']}`);
      }
    }
  }
  if (!passwordFound && feeEarnerSampled > 0) {
    console.log(`  ✅ No password/signature fields in ${feeEarnerSampled} sampled feeEarner records`);
  } else if (feeEarnerSampled === 0) {
    console.log('  ⚠️  No feeEarner records found in enriched_entities');
  }

  // datePaid check — scan invoice chunks for PAID records
  const invoiceDocs = await mdb
    .collection('enriched_entities')
    .find({ firm_id: FIRM_ID, entity_type: 'invoice' })
    .limit(3)  // first 3 chunks ≈ up to ~1500 records
    .toArray();

  let paidCount = 0;
  let paidWithDate = 0;
  let sampleDatePaid: unknown = null;

  for (const doc of invoiceDocs) {
    const records = (doc as Record<string, unknown>)['records'] as Record<string, unknown>[] | undefined;
    for (const r of records ?? []) {
      if (r['status'] === 'PAID') {
        paidCount++;
        if (r['datePaid'] != null) {
          paidWithDate++;
          if (sampleDatePaid === null) sampleDatePaid = r['datePaid'];
        }
      }
    }
  }

  if (paidCount > 0) {
    const pct = Math.round((paidWithDate / paidCount) * 100);
    const ok = paidWithDate > 0;
    console.log(
      `  ${ok ? '✅' : '⚠️ '} datePaid populated on ${paidWithDate}/${paidCount}` +
      ` sampled PAID invoices (${pct}%)`,
    );
    if (sampleDatePaid) console.log(`     sample datePaid = ${sampleDatePaid}`);
  } else {
    console.log('  ⚠️  No PAID invoices found in sampled enriched_entities chunks');
  }

  // risk_flags count
  const riskFlagCount = await mdb
    .collection('risk_flags')
    .countDocuments({ firm_id: FIRM_ID });

  console.log(`  ${riskFlagCount > 0 ? '✅' : '⚠️ '} risk_flags count = ${riskFlagCount}`);

  // Sample risk flags
  if (riskFlagCount > 0) {
    const sampleFlags = await mdb
      .collection('risk_flags')
      .find({ firm_id: FIRM_ID })
      .limit(5)
      .toArray();

    console.log('\n  Sample risk flags (up to 5):');
    for (const flag of sampleFlags) {
      const f = flag as Record<string, unknown>;
      console.log(
        `    [${f['severity']}] ${String(f['flag_type']).padEnd(25)} ` +
        `${String(f['entity_type']).padEnd(12)} ${f['entity_name']}`,
      );
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log(result.success ? ' ✅  PULL VERIFIED SUCCESSFULLY' : ' ❌  PULL COMPLETED WITH ISSUES');
  console.log('═'.repeat(60) + '\n');

  await closeConnections();
  process.exit(result.success ? 0 : 1);
}

// =============================================================================
// Cleanup
// =============================================================================

async function closeConnections(): Promise<void> {
  // process.exit() terminates all open handles (MongoDB, Supabase HTTP).
  // Nothing explicit to do here — the caller always calls process.exit() after.
}

// =============================================================================
// Run
// =============================================================================

main().catch((err) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
