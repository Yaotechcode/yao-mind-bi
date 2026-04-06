import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const doc = await getLatestEnrichedEntities(FIRM, 'timeEntry');
  const tes = (doc?.records ?? []) as Record<string, unknown>[];

  console.log('All keys on time entry:', Object.keys(tes[0] ?? {}));
  
  // Check invoice field
  const withInvoice    = tes.filter(te => te['invoice'] != null && te['invoice'] !== '');
  const withoutInvoice = tes.filter(te => te['invoice'] == null || te['invoice'] === '');
  console.log('\nWith invoice field populated:', withInvoice.length);
  console.log('Without invoice field:       ', withoutInvoice.length);
  
  if (withInvoice.length > 0) {
    console.log('\nSample invoiced time entry - invoice field:');
    console.log(JSON.stringify(withInvoice[0]['invoice'], null, 2));
    console.log('Full record keys:', Object.keys(withInvoice[0]));
  }

  // Value of invoiced vs uninvoiced entries
  const invoicedValue   = withInvoice.reduce((s, te) => s + Number(te['billableValue'] ?? 0), 0);
  const uninvoicedValue = withoutInvoice.reduce((s, te) => s + Number(te['billableValue'] ?? 0), 0);
  console.log('\nInvoiced entry value:   £' + invoicedValue.toLocaleString());
  console.log('Uninvoiced entry value: £' + uninvoicedValue.toLocaleString());
}
main().catch(console.error).finally(() => process.exit(0));
