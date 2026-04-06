import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const [invDoc, teDoc] = await Promise.all([
    getLatestEnrichedEntities(FIRM, 'invoice'),
    getLatestEnrichedEntities(FIRM, 'timeEntry'),
  ]);
  const invs = (invDoc?.records ?? []) as Record<string, unknown>[];
  const tes  = (teDoc?.records  ?? []) as Record<string, unknown>[];

  // Aggregate time entry billable value per matter
  const wipByMatter = new Map<string, number>();
  for (const te of tes) {
    const key = String(te['matterId'] ?? te['matterNumber'] ?? '');
    if (!key) continue;
    wipByMatter.set(key, (wipByMatter.get(key) ?? 0) + Number(te['billableValue'] ?? te['recordedValue'] ?? 0));
  }

  // Invoice totals
  const subtotalSum   = invs.reduce((s, i) => s + Number(i['subtotal']          ?? 0), 0);
  const firmFeesSum   = invs.reduce((s, i) => s + Number(i['totalFirmFees']     ?? 0), 0);
  const disbSum       = invs.reduce((s, i) => s + Number(i['totalDisbursements']?? 0), 0);
  const vatSum        = invs.reduce((s, i) => s + Number(i['vat']               ?? 0), 0);
  const totalSum      = invs.reduce((s, i) => s + Number(i['total']             ?? 0), 0);
  const withFirmFees  = invs.filter(i => Number(i['totalFirmFees'] ?? 0) > 0).length;

  // For each invoice, derive: feeEarnerRevenue = subtotal - totalFirmFees
  // Then split: timeRevenue vs fixedFeeRevenue using WIP linkage
  let timeRevTotal = 0, fixedFeeTotal = 0, firmFeeTotal2 = 0;
  for (const inv of invs) {
    const subtotal  = Number(inv['subtotal']      ?? 0);
    const firmFees  = Number(inv['totalFirmFees'] ?? 0);
    const feRevenue = subtotal - firmFees; // attributable to fee earner
    firmFeeTotal2  += firmFees;

    const matterId = String(inv['matterId'] ?? inv['matterNumber'] ?? '');
    const wipValue = wipByMatter.get(matterId) ?? 0;
    const timeRev  = Math.min(feRevenue, wipValue); // capped at fee earner revenue
    const fixedRev = Math.max(0, feRevenue - timeRev);
    timeRevTotal    += timeRev;
    fixedFeeTotal   += fixedRev;
  }

  console.log('Invoice breakdown across all', invs.length, 'invoices:');
  console.log('  subtotal (all fees):       £' + subtotalSum.toLocaleString());
  console.log('  totalFirmFees (sundries):  £' + firmFeesSum.toLocaleString(), `(${withFirmFees} invoices)`);
  console.log('  totalDisbursements:        £' + disbSum.toLocaleString());
  console.log('  vat:                       £' + vatSum.toLocaleString());
  console.log('  total (inc VAT+disb):      £' + totalSum.toLocaleString());
  console.log('');
  console.log('Derived fee earner revenue split:');
  console.log('  time-based revenue:        £' + timeRevTotal.toLocaleString());
  console.log('  fixed-fee revenue:         £' + fixedFeeTotal.toLocaleString());
  console.log('  firm fees (excluded):      £' + firmFeeTotal2.toLocaleString());
  console.log('  fee earner total:          £' + (timeRevTotal + fixedFeeTotal).toLocaleString());
}
main().catch(console.error).finally(() => process.exit(0));
