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
  let passCount = 0;
  for (const inv of invs) {
    const subtotal  = Number(inv['subtotal']            ?? 0);
    const billing   = Number(inv['billing_amount']      ?? 0);
    const entries   = Number(inv['billable_entries']    ?? 0);
    const firmFees  = Number(inv['total_firm_fees']     ?? 0);
    const disbs     = Number(inv['total_disbursements'] ?? 0);
    const vat       = Number(inv['vat']                 ?? 0);
    const total     = Number(inv['total']               ?? 0);

    // Revised: subtotal = billing + entries + firmFees + disbursements
    const h1 = Math.abs(subtotal - (billing + entries + firmFees + disbs)) < 0.02;
    // total = subtotal + vat
    const h2 = Math.abs(total - (subtotal + vat)) < 0.02;

    if (!h1 || !h2) {
      allMatch = false;
      console.log(`❌ ${inv['_id']}`);
      console.log(`   subtotal=${subtotal} = billing=${billing} + entries=${entries} + firmFees=${firmFees} + disbs=${disbs}`);
      console.log(`   H1 diff=${(subtotal-(billing+entries+firmFees+disbs)).toFixed(4)}  H2 diff=${(total-(subtotal+vat)).toFixed(4)}`);
    } else {
      passCount++;
    }
  }
  console.log(`\n${passCount}/${invs.length} invoices match revised hypothesis`);
  if (allMatch) {
    console.log('✅ Confirmed:\n   subtotal = billing_amount + billable_entries + total_firm_fees + total_disbursements\n   total = subtotal + vat');
  }
  console.log('\nTherefore:');
  console.log('   feeEarnerRevenue = subtotal - total_firm_fees - total_disbursements');
  console.log('                    = billing_amount + billable_entries');
}
main().catch(console.error).finally(() => process.exit(0));
