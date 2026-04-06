import { getLatestEnrichedEntities } from '../src/server/lib/mongodb-operations.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const teDoc = await getLatestEnrichedEntities(FIRM, 'timeEntry');
  const tes = (teDoc?.records ?? []) as Record<string, unknown>[];

  let totalBillable = 0, totalChargeable = 0, totalNonChargeable = 0, totalDoNotBill = 0;
  const byMonth = new Map<string, { hours: number; value: number; count: number }>();

  for (const te of tes) {
    const billable  = Number(te['billableValue'] ?? te['recordedValue'] ?? 0);
    const hours     = Number(te['durationHours'] ?? 0);
    const dnb       = te['doNotBill'] === true;
    const chargeable = te['isChargeable'] !== false && !dnb;

    totalBillable += billable;
    if (chargeable) totalChargeable += billable;
    else totalNonChargeable += billable;
    if (dnb) totalDoNotBill += billable;

    const dateStr = String(te['date'] ?? '').slice(0, 7);
    if (dateStr) {
      const acc = byMonth.get(dateStr) ?? { hours: 0, value: 0, count: 0 };
      acc.hours += hours;
      acc.value += billable;
      acc.count++;
      byMonth.set(dateStr, acc);
    }
  }

  console.log('Time entry summary:');
  console.log('  Total entries:        ', tes.length);
  console.log('  Total billable value: £' + totalBillable.toLocaleString());
  console.log('  Chargeable value:     £' + totalChargeable.toLocaleString());
  console.log('  Non-chargeable value: £' + totalNonChargeable.toLocaleString());
  console.log('  Do-not-bill value:    £' + totalDoNotBill.toLocaleString());

  console.log('\nBy month:');
  [...byMonth.entries()].sort().forEach(([m, v]) =>
    console.log(`  ${m}  entries:${String(v.count).padStart(5)}  hours:${v.hours.toFixed(1).padStart(8)}  value:£${v.value.toLocaleString().padStart(12)}`));
}
main().catch(console.error).finally(() => process.exit(0));
