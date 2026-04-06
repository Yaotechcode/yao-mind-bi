import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const adapter = new DataSourceAdapter(FIRM);
  await adapter.authenticate();

  // Get invoice with both billing_amount and billable_entries
  const rawInv = await adapter['request']<unknown>(
    'POST', '/invoices/search', { body: { size: 20, page: 1 } }
  );
  const invRecords = Array.isArray(rawInv) ? rawInv as Record<string, unknown>[] : [];
  const mixed = invRecords.find(i =>
    Number(i['billing_amount'] ?? 0) > 0 && Number(i['billable_entries'] ?? 0) > 0
  ) ?? invRecords[0];

  const invoiceId = mixed?.['_id'] as string;
  const detail = await adapter['request']<Record<string, unknown>>(
    'GET', `/invoices/${invoiceId}`, {}
  );

  const timeEntries = detail['time_entries'] as Record<string, unknown>[] ?? [];
  const disbursements = detail['disbursements'] as Record<string, unknown>[] ?? [];

  console.log('Invoice:', invoiceId);
  console.log('billing_amount:', detail['billing_amount']);
  console.log('billable_entries:', detail['billable_entries']);
  console.log('total_firm_fees:', detail['total_firm_fees']);
  console.log('subtotal:', detail['subtotal']);
  console.log('total_disbursements:', detail['total_disbursements']);
  console.log('\nTime entries on invoice:', timeEntries.length);
  if (timeEntries.length > 0) {
    console.log('Time entry keys:', Object.keys(timeEntries[0]));
    console.log('First time entry:', JSON.stringify(timeEntries[0], null, 2));
  }
  console.log('\nDisbursements on invoice:', disbursements.length);
  if (disbursements.length > 0) {
    console.log('Disbursement keys:', Object.keys(disbursements[0]));
  }
  
  // Check time entry value sum vs billable_entries
  const teSum = timeEntries.reduce((s, te) => s + Number(te['billable'] ?? te['value'] ?? 0), 0);
  console.log('\nSum of time entry billable values:', teSum);
  console.log('Invoice billable_entries field:  ', detail['billable_entries']);
  console.log('Match:', Math.abs(teSum - Number(detail['billable_entries'])) < 0.01 ? '✅' : '❌ difference: ' + (teSum - Number(detail['billable_entries'])));
}
main().catch(console.error).finally(() => process.exit(0));
