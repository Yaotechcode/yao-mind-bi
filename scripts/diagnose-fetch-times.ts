/**
 * diagnose-fetch-times.ts
 *
 * Measures how long each entity fetch takes against the live Yao API.
 * Fetches are run SEQUENTIALLY so timings are clean and comparable.
 *
 * Usage:
 *   npx tsx scripts/diagnose-fetch-times.ts
 *
 * Requires .env.local with YAO_API_BASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, and ENCRYPTION_KEY.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load .env.local before any service imports
// ---------------------------------------------------------------------------

const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
envContent.split('\n').forEach(line => {
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim().replace(/^'|'$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Imports (after env is loaded)
// ---------------------------------------------------------------------------

import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';

const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  .toISOString()
  .split('T')[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function timed<T>(
  label: string,
  fn: () => Promise<T[]>,
): Promise<T[]> {
  const start = Date.now();
  console.time(label);
  let result: T[];
  try {
    result = await fn();
  } catch (err) {
    console.timeEnd(label);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`[${label}] ERROR after ${elapsed}s:`, (err as Error).message);
    return [];
  }
  console.timeEnd(label);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[${label}] fetched ${result.length} records in ${elapsed}s`);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('Yao API fetch diagnostics');
  console.log(`Firm:      ${FIRM_ID}`);
  console.log(`From date: ${fromDate} (3-month lookback)`);
  console.log('='.repeat(60));

  const adapter = new DataSourceAdapter(FIRM_ID);

  console.log('\nAuthenticating...');
  const authStart = Date.now();
  await adapter.authenticate();
  console.log(`Auth complete in ${((Date.now() - authStart) / 1000).toFixed(1)}s\n`);

  const totalStart = Date.now();

  await timed('fetchAttorneys',  () => adapter.fetchAttorneys());
  await timed('fetchDepartments', () => adapter.fetchDepartments());
  await timed('fetchCaseTypes',  () => adapter.fetchCaseTypes());
  const matters = await timed('fetchMatters', () => adapter.fetchMatters());
  await timed('fetchTimeEntries', () => adapter.fetchTimeEntries(fromDate));
  await timed('fetchInvoices',   () => adapter.fetchInvoices(fromDate));
  // LEDGERS DISABLED — pending Yao API server-side type filtering
  // Re-enable once API supports types filter on POST /ledgers/search
  // const archivedMatterIds = new Set(
  //   matters.filter((m) => m.status === 'ARCHIVED').map((m) => m._id),
  // );
  // await timed('fetchLedgers', () => adapter.fetchLedgers(fromDate, archivedMatterIds));
  void matters; // used by archivedMatterIds above when ledgers re-enabled
  await timed('fetchTasks',      () => adapter.fetchTasks());
  await timed('fetchContacts',   () => adapter.fetchContacts());

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);

  const warnings = adapter.getWarnings();
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    warnings.forEach(w => console.warn(' ⚠', w));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total fetch time: ${totalElapsed}s`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
