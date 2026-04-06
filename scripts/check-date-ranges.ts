import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';

  const [teDoc, invDoc] = await Promise.all([
    getLatestEnrichedEntities(FIRM, 'timeEntry'),
    getLatestEnrichedEntities(FIRM, 'invoice'),
  ]);

  const tes = (teDoc?.records ?? []) as Record<string, unknown>[];
  const invs = (invDoc?.records ?? []) as Record<string, unknown>[];

  const teDates = tes.map(r => String(r['date'] ?? '')).filter(Boolean).sort();
  const invDates = invs.map(r => String(r['invoiceDate'] ?? '')).filter(Boolean).sort();

  console.log('Time entries:', tes.length);
  console.log('  Oldest:', teDates[0]);
  console.log('  Newest:', teDates[teDates.length - 1]);

  console.log('Invoices:', invs.length);
  console.log('  Oldest:', invDates[0]);
  console.log('  Newest:', invDates[invDates.length - 1]);
}
main().catch(console.error).finally(() => process.exit(0));
