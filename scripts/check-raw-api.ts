import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';
import { getCredentials } from '../src/server/services/credential-service.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  
  const adapter = new DataSourceAdapter(FIRM);
  await adapter.authenticate();

  // Fetch ONE page of time entries raw (bypass pruner by accessing request directly)
  // @ts-ignore — accessing private method for diagnostic only
  const rawTE = await adapter['request']<Record<string, unknown>[]>(
    'POST', '/time-entries/search',
    { body: { size: 3, page: 1 } }
  );
  const teRecords = (rawTE as unknown as Record<string, unknown>)['result'] as Record<string, unknown>[] ?? rawTE as unknown as Record<string, unknown>[];
  const firstTE = Array.isArray(teRecords) ? teRecords[0] : null;
  
  console.log('=== RAW TIME ENTRY KEYS ===');
  if (firstTE) {
    console.log('All keys:', Object.keys(firstTE));
    console.log('invoice field:', JSON.stringify(firstTE['invoice'], null, 2));
    console.log('billable field:', firstTE['billable']);
    console.log('work_type field:', firstTE['work_type']);
    console.log('status field:', firstTE['status']);
  }

  // Fetch ONE page of invoices raw
  const rawInv = await adapter['request']<unknown>(
    'POST', '/invoices/search',
    { body: { size: 3, page: 1 } }
  );
  const invRecords = Array.isArray(rawInv) ? rawInv as Record<string, unknown>[] : [];
  const firstInv = invRecords[0] ?? null;

  console.log('\n=== RAW INVOICE KEYS ===');
  if (firstInv) {
    console.log('All keys:', Object.keys(firstInv));
    console.log('billing_amount:', firstInv['billing_amount']);
    console.log('billable_entries:', firstInv['billable_entries']);
    console.log('total_firm_fees:', firstInv['total_firm_fees']);
    console.log('date_paid:', firstInv['date_paid']);
    console.log('credited:', firstInv['credited']);
    console.log('type:', firstInv['type']);
    console.log('\nFull sample:', JSON.stringify(firstInv, null, 2).slice(0, 3000));
  }
}
main().catch(console.error).finally(() => process.exit(0));
