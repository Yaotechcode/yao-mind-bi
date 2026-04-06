import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const doc = await getLatestEnrichedEntities(FIRM, 'invoice');
  const invs = (doc?.records ?? []) as Record<string, unknown>[];
  
  console.log('All keys on first invoice:', Object.keys(invs[0] ?? {}));
  console.log('Sample invoice:', JSON.stringify(invs[0], null, 2).slice(0, 2000));

  // Stats across all invoices
  const withFixedFee = invs.filter(inv => Number(inv['billingAmount'] ?? 0) > 0);
  const withTimeEntries = invs.filter(inv => Number(inv['billableEntries'] ?? 0) > 0);
  const withBoth = invs.filter(inv => Number(inv['billingAmount'] ?? 0) > 0 && Number(inv['billableEntries'] ?? 0) > 0);
  
  console.log('\nTotal invoices:', invs.length);
  console.log('With fixed fee (billingAmount > 0):', withFixedFee.length);
  console.log('With time entries (billableEntries > 0):', withTimeEntries.length);
  console.log('With both:', withBoth.length);
  
  const totalBillingAmount = invs.reduce((s, inv) => s + Number(inv['billingAmount'] ?? 0), 0);
  const totalBillableEntries = invs.reduce((s, inv) => s + Number(inv['billableEntries'] ?? 0), 0);
  console.log('\nTotal billingAmount (fixed fee):', totalBillingAmount.toLocaleString('en-GB', {style:'currency', currency:'GBP'}));
  console.log('Total billableEntries (time):', totalBillableEntries.toLocaleString('en-GB', {style:'currency', currency:'GBP'}));
}
main().catch(console.error).finally(() => process.exit(0));
