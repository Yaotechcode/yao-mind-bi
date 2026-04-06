import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const adapter = new DataSourceAdapter(FIRM);
  await adapter.authenticate();

  const rawInv = await adapter['request']<unknown>(
    'POST', '/invoices/search', { body: { size: 50, page: 1 } }
  );
  const invs = Array.isArray(rawInv) ? rawInv as Record<string, unknown>[] : [];

  let allMatch = true;
  for (const inv of invs.slice(0, 20)) {
    const subtotal  = Number(inv['subtotal']           ?? 0);
    const billing   = Number(inv['billing_amount']     ?? 0);
    const entries   = Number(inv['billable_entries']   ?? 0);
    const firmFees  = Number(inv['total_firm_fees']    ?? 0);
    const disbs     = Number(inv['total_disbursements']?? 0);
    const vat       = Number(inv['vat']                ?? 0);
    const total     = Number(inv['total']              ?? 0);

    // Test hypothesis 1: subtotal = billing + entries + firmFees (disbursements NOT in subtotal)
    const h1 = Math.abs(subtotal - (billing + entries + firmFees)) < 0.02;
    // Test hypothesis 2: total = subtotal + disbursements + vat
    const h2 = Math.abs(total - (subtotal + disbs + vat)) < 0.02;

    if (!h1 || !h2) {
      allMatch = false;
      console.log(`❌ ${inv['_id']}`);
      console.log(`   subtotal=${subtotal} billing=${billing} entries=${entries} firmFees=${firmFees} disbs=${disbs} vat=${vat} total=${total}`);
      console.log(`   H1 (subtotal=billing+entries+firmFees): ${h1} diff=${subtotal-(billing+entries+firmFees)}`);
      console.log(`   H2 (total=subtotal+disbs+vat): ${h2} diff=${total-(subtotal+disbs+vat)}`);
    }
  }
  if (allMatch) console.log('✅ All 20 invoices confirm:\n   subtotal = billing_amount + billable_entries + total_firm_fees\n   total = subtotal + total_disbursements + vat');
}
main().catch(console.error).finally(() => process.exit(0));
