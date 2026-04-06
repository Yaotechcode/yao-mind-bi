import { DataSourceAdapter } from '../src/server/datasource/DataSourceAdapter.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const adapter = new DataSourceAdapter(FIRM);
  await adapter.authenticate();

  const rawInv = await adapter['request']<unknown>(
    'POST', '/invoices/search', { body: { size: 50, page: 1 } }
  );
  const invs = Array.isArray(rawInv) ? rawInv as Record<string, unknown>[] : [];

  // Focus on the two large H1 failures with negative billing_amount
  const suspects = invs.filter(inv => Number(inv['billing_amount'] ?? 0) < -100);
  
  for (const inv of suspects) {
    const id = inv['_id'] as string;
    console.log('\n=== Invoice', id, '===');
    console.log('subtotal:', inv['subtotal']);
    console.log('billing_amount:', inv['billing_amount']);
    console.log('billable_entries:', inv['billable_entries']);
    console.log('total_firm_fees:', inv['total_firm_fees']);
    console.log('total_disbursements:', inv['total_disbursements']);
    console.log('write_off:', inv['write_off']);
    console.log('written_off:', inv['written_off']);
    console.log('time_entries_override_value:', inv['time_entries_override_value']);
    console.log('nominal_adjustment_percentage:', inv['nominal_adjustment_percentage']);
    console.log('nominal_adjustment_value:', inv['nominal_adjustment_value']);
    console.log('less_paid_on_account:', inv['less_paid_on_account']);
    console.log('status:', inv['status']);
    console.log('type:', inv['type']);

    // Fetch detail to see if write_off or adjustment explains the gap
    const detail = await adapter['request']<Record<string, unknown>>('GET', `/invoices/${id}`, {});
    const gap = Number(inv['subtotal']) - (Number(inv['billing_amount']) + Number(inv['billable_entries']) + Number(inv['total_firm_fees']) + Number(inv['total_disbursements']));
    console.log('Gap:', gap.toFixed(2));
    console.log('nominal_adjustment_value (detail):', detail['nominal_adjustment_value']);
    console.log('time_entries_override_value (detail):', detail['time_entries_override_value']);
    
    // Check if gap = nominal_adjustment or time_entries_override
    const nomAdj = Number(detail['nominal_adjustment_value'] ?? 0);
    const teOverride = Number(detail['time_entries_override_value'] ?? 0);
    console.log('Gap explained by nominal_adjustment?', Math.abs(gap - nomAdj) < 0.02 ? '✅' : `❌ diff=${(gap-nomAdj).toFixed(2)}`);
    console.log('Gap explained by te_override?', Math.abs(gap - teOverride) < 0.02 ? '✅' : `❌ diff=${(gap-teOverride).toFixed(2)}`);
  }
}
main().catch(console.error).finally(() => process.exit(0));
