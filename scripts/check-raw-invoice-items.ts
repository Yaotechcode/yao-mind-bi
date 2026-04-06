import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const adapter = new DataSourceAdapter(FIRM);
  await adapter.authenticate();

  // Get a sample invoice ID first
  const rawInv = await adapter['request']<unknown>(
    'POST', '/invoices/search',
    { body: { size: 5, page: 1 } }
  );
  const invRecords = Array.isArray(rawInv) ? rawInv as Record<string, unknown>[] : [];
  
  // Find one with both billing_amount and billable_entries > 0 (mixed invoice)
  const mixed = invRecords.find(i => 
    Number(i['billing_amount'] ?? 0) > 0 && Number(i['billable_entries'] ?? 0) > 0
  ) ?? invRecords[0];
  
  const invoiceId = mixed?.['_id'] as string;
  console.log('Testing invoice:', invoiceId);
  console.log('billing_amount:', mixed?.['billing_amount']);
  console.log('billable_entries:', mixed?.['billable_entries']);

  // Try common line item / detail endpoints
  const endpoints = [
    `/invoices/${invoiceId}`,
    `/invoices/${invoiceId}/items`,
    `/invoices/${invoiceId}/lines`,
    `/invoices/${invoiceId}/entries`,
    `/invoices/${invoiceId}/time-entries`,
    `/invoices/${invoiceId}/details`,
  ];

  for (const ep of endpoints) {
    try {
      const result = await adapter['request']<unknown>('GET', ep, {});
      console.log(`\n✅ ${ep} — SUCCESS`);
      const str = JSON.stringify(result, null, 2);
      console.log(str.slice(0, 1500));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ ${ep} — ${msg}`);
    }
  }
}
main().catch(console.error).finally(() => process.exit(0));
