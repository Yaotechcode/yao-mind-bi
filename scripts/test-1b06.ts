import { joinRecords } from '../src/server/pipeline/joiner';
import { enrichRecords } from '../src/server/pipeline/enricher';
import { buildIndexes } from '../src/server/pipeline/indexer';
import { aggregate } from '../src/server/pipeline/aggregator';
import { buildDataQualityReport } from '../src/server/pipeline/data-quality';
import type { NormaliseResult } from '../src/shared/types/pipeline';

function makeDataset(fileType: string, records: Record<string, any>[]): NormaliseResult {
  return {
    fileType,
    records,
    recordCount: records.length,
    normalisedAt: new Date().toISOString(),
    warnings: [],
  } as unknown as NormaliseResult;
}

const TODAY = new Date('2024-03-01T00:00:00Z');

async function run() {

  const normalisedDatasets: Record<string, NormaliseResult> = {
    feeEarner: makeDataset('feeEarnerCsv', [
      { lawyerId: 'fe-001', lawyerName: 'John Smith',  department: 'Commercial', grade: 'Partner',          payModel: 'Salaried' },
      { lawyerId: 'fe-002', lawyerName: 'Sarah Jones', department: 'Family',     grade: 'Senior Associate', payModel: 'FeeShare' },
    ]),
    fullMattersJson: makeDataset('fullMattersJson', [
      { matterId: 'm-001', matterNumber: '1001', responsibleLawyerId: 'fe-001', responsibleLawyer: 'John Smith',  department: 'Commercial', status: 'IN_PROGRESS', clientName: 'Acme Corp', budget: 10000, createdDate: new Date('2023-01-01') },
      { matterId: 'm-002', matterNumber: '1002', responsibleLawyerId: 'fe-002', responsibleLawyer: 'Sarah Jones', department: 'Family',     status: 'COMPLETED',   clientName: 'Bob Ltd',  budget: 5000,  createdDate: new Date('2023-06-01') },
    ]),
    wipJson: makeDataset('wipJson', [
      { entryId: 'w-001', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-01-15'), billableValue: 500, durationMinutes: 60, doNotBill: false, rate: 300 },
      { entryId: 'w-002', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-02-20'), billableValue: 300, durationMinutes: 36, doNotBill: false, rate: 300 },
      { entryId: 'w-003', matterId: 'm-002', matterNumber: '1002', lawyerId: 'fe-002', lawyerName: 'Sarah Jones', date: new Date('2024-01-20'), billableValue: 400, durationMinutes: 48, doNotBill: false, rate: 300 },
      { entryId: 'w-004', matterId: null,    matterNumber: null,   lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-02-01'), billableValue: 200, durationMinutes: 24, doNotBill: false, rate: 300 }, // orphaned
      { entryId: 'w-005', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-02-10'), billableValue: 0,   durationMinutes: 30, doNotBill: true,  rate: 300 }, // non-chargeable
    ]),
    invoicesJson: makeDataset('invoicesJson', [
      { invoiceId: 'inv-001', matterNumber: '1001', responsibleLawyerId: 'fe-001', subtotal: 2000, total: 2400, outstanding: 0,   paid: 2400, invoiceDate: new Date('2024-01-01'), dueDate: new Date('2024-02-01') },
      { invoiceId: 'inv-002', matterNumber: '1002', responsibleLawyerId: 'fe-002', subtotal: 400,  total: 480,  outstanding: 480, paid: 0,    invoiceDate: new Date('2024-01-15'), dueDate: new Date('2024-02-15') },
    ]),
    contactsJson: makeDataset('contactsJson', [
      { contactId: 'c-001', displayName: 'Acme Corp' },
      { contactId: 'c-002', displayName: 'Bob Ltd' },
    ]),
  };

  const availableFileTypes = Object.keys(normalisedDatasets);
  const indexes    = buildIndexes(normalisedDatasets, availableFileTypes);
  const joinResult = joinRecords(normalisedDatasets, indexes, TODAY);
  const enriched   = enrichRecords(joinResult, TODAY);

  // ── AGGREGATE ────────────────────────────────────────────────────────────

  console.log('\n--- AGGREGATE ---');

  let agg: any;
  try {
    agg = aggregate(enriched, TODAY, availableFileTypes);
    console.log('✅ aggregate completed without errors');
    console.log(`   matters: ${agg.matters?.length}`);
    console.log(`   feeEarners: ${agg.feeEarners?.length}`);
    console.log(`   clients: ${agg.clients?.length}`);
    console.log(`   departments: ${agg.departments?.length}`);
    console.log(`   firm: ${agg.firm ? 'present' : 'missing'}`);
  } catch (e: any) {
    console.error('❌ aggregate threw:', e.message);
    console.error(e.stack);
    process.exit(1);
  }

  // ── MATTER AGGREGATES ────────────────────────────────────────────────────

  console.log('\n--- MATTER AGGREGATES ---');

  const m001 = agg.matters?.find((m: any) => m.matterId === 'm-001');
  console.log(m001 !== undefined ? '✅' : '❌', `m-001 found`);

  // WIP: w-001(500) + w-002(300) + w-005(0) = 800 billable
  console.log(m001?.wipTotalBillable >= 800 ? '✅' : '⚠️ ',
    `m-001 wipTotalBillable: ${m001?.wipTotalBillable} (expected ≥800)`);

  // Hours: 60+36+30 = 126 mins = 2.1 hrs
  console.log(m001?.wipTotalHours > 0 ? '✅' : '⚠️ ',
    `m-001 wipTotalHours: ${m001?.wipTotalHours} (expected ~2.1)`);

  // Invoice: inv-001 subtotal=2000
  console.log(m001?.invoicedNetBilling >= 2000 ? '✅' : '⚠️ ',
    `m-001 invoicedNetBilling: ${m001?.invoicedNetBilling} (expected ≥2000)`);

  // Chargeable vs non-chargeable split
  console.log(m001?.wipChargeableHours > 0 ? '✅' : '⚠️ ',
    `m-001 wipChargeableHours: ${m001?.wipChargeableHours}`);
  console.log(m001?.wipNonChargeableHours > 0 ? '✅' : '⚠️ ',
    `m-001 wipNonChargeableHours: ${m001?.wipNonChargeableHours} (w-005 is non-chargeable)`);

  // ── FEE EARNER AGGREGATES ────────────────────────────────────────────────

  console.log('\n--- FEE EARNER AGGREGATES ---');

  const fe001 = agg.feeEarners?.find((f: any) => f.lawyerId === 'fe-001');
  console.log(fe001 !== undefined ? '✅' : '❌', `fe-001 found`);

  // Total WIP value incl orphaned: w-001(500) + w-002(300) + w-004(200) + w-005(0) = 1000
  console.log(fe001?.wipTotalValue >= 1000 ? '✅' : '⚠️ ',
    `fe-001 wipTotalValue (incl orphaned): ${fe001?.wipTotalValue} (expected ≥1000)`);

  // Orphaned tracked separately
  console.log(fe001?.wipOrphanedValue >= 200 ? '✅' : '⚠️ ',
    `fe-001 wipOrphanedValue: ${fe001?.wipOrphanedValue} (expected ≥200)`);
  console.log(fe001?.wipOrphanedHours > 0 ? '✅' : '⚠️ ',
    `fe-001 wipOrphanedHours: ${fe001?.wipOrphanedHours}`);

  // recordingGapDays: last entry 2024-02-20, TODAY 2024-03-01, leap year = 10 days
  console.log(fe001?.recordingGapDays === 10 ? '✅' : '⚠️ ',
    `fe-001 recordingGapDays: ${fe001?.recordingGapDays} (expected 10)`);

  // Invoice revenue
  console.log(fe001?.invoicedRevenue >= 2000 ? '✅' : '⚠️ ',
    `fe-001 invoicedRevenue: ${fe001?.invoicedRevenue} (expected ≥2000)`);

  // ── FIRM SUMMARY ─────────────────────────────────────────────────────────

  console.log('\n--- FIRM SUMMARY ---');

  const firm = agg.firm;
  console.log(firm !== undefined ? '✅' : '❌', `Firm summary present`);

  // totalWipValue includes orphaned entries
  console.log(firm?.totalWipValue >= 1400 ? '✅' : '⚠️ ',
    `firm totalWipValue (incl orphaned): ${firm?.totalWipValue} (expected ≥1400)`);

// orphanedWip summary object
  const orphaned = firm?.orphanedWip;
  console.log(orphaned !== undefined ? '✅' : '⚠️ ',
    `firm.orphanedWip present`);
  console.log(orphaned?.orphanedWipEntryCount >= 1 ? '✅' : '⚠️ ',
    `firm.orphanedWip.orphanedWipEntryCount: ${orphaned?.orphanedWipEntryCount} (expected ≥1)`);
  console.log(orphaned?.orphanedWipValue >= 200 ? '✅' : '⚠️ ',
    `firm.orphanedWip.orphanedWipValue: ${orphaned?.orphanedWipValue} (expected ≥200)`);
  console.log(typeof orphaned?.orphanedWipPercent === 'number' ? '✅' : '⚠️ ',
    `firm.orphanedWip.orphanedWipPercent: ${orphaned?.orphanedWipPercent?.toFixed(1)}%`);
  console.log(typeof orphaned?.orphanedWipNote === 'string' ? '✅' : '⚠️ ',
    `firm.orphanedWip.orphanedWipNote present`);

  // Firm counts
  console.log(firm?.feeEarnerCount === 2 ? '✅' : '⚠️ ',
    `firm.feeEarnerCount: ${firm?.feeEarnerCount} (expected 2)`);
  console.log(firm?.matterCount === 2 ? '✅' : '⚠️ ',
    `firm.matterCount: ${firm?.matterCount} (expected 2)`);

  // ── DUAL SOURCE OF TRUTH ─────────────────────────────────────────────────

  console.log('\n--- DUAL SOURCE OF TRUTH (discrepancies) ---');

  const dqr = agg.dataQuality;
  console.log(dqr !== undefined ? '✅' : '❌', `dataQuality present on AggregateResult`);

  const discrepancies = dqr?.discrepancies ?? [];
  console.log(Array.isArray(discrepancies) ? '✅' : '⚠️ ',
    `discrepancies is array: ${discrepancies.length} items`);
  console.log(`   discrepancy types: [${discrepancies.map((d: any) => d.type).join(', ')}]`);

  // ── DATA QUALITY REPORT ──────────────────────────────────────────────────

  console.log('\n--- DATA QUALITY REPORT ---');

  console.log(typeof dqr?.overallScore === 'number' ? '✅' : '⚠️ ',
    `overallScore: ${dqr?.overallScore}/100`);

  const gaps = dqr?.knownGaps ?? [];
  console.log(gaps.length > 0 ? '✅' : '⚠️ ',
    `knownGaps present: ${gaps.length}`);
  console.log(`   gap gapIds: [${gaps.map((g: any) => g.gapId).join(', ')}]`);

  // MISSING_CLOSED_MATTERS should be present (closedMattersJson not in availableFileTypes)
  const hasMissingClosed = gaps.some((g: any) =>
    g.gapId?.toUpperCase().includes('CLOSED') ||
    g.gapId?.toUpperCase().includes('MISSING')
  );
  console.log(hasMissingClosed ? '✅' : '⚠️ ',
    `MISSING_CLOSED_MATTERS gap present: ${hasMissingClosed}`);

// fileCoverage
  const fileCoverage = dqr?.filesCoverage ?? [];
  console.log(fileCoverage.length > 0 ? '✅' : '⚠️ ',
    `filesCoverage entries: ${fileCoverage.length}`);
  console.log(`   filesCoverage fileTypes: [${fileCoverage.map((f: any) => f.fileType).join(', ')}]`);
  const wipCoverage = fileCoverage.find((f: any) =>
    f.fileType === 'wipJson' || f.fileType === 'wip'
  );
  console.log(`   wipCoverage object: ${JSON.stringify(wipCoverage)}`);
  console.log(wipCoverage?.isPresent === true ? '✅' : '⚠️ ',
    `wipJson marked present: ${wipCoverage?.fileType} present=${wipCoverage?.present}`);

  // Recommendations sorted by priority (1=most urgent)
  const recs = dqr?.recommendations ?? [];
  console.log(recs.length > 0 ? '✅' : '⚠️ ',
    `recommendations: ${recs.length}`);
  if (recs.length >= 2) {
    console.log(recs[0]?.priority <= recs[1]?.priority ? '✅' : '⚠️ ',
      `sorted by priority: ${recs[0]?.priority} ≤ ${recs[1]?.priority}`);
  }

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-07  ⚠️  = minor, flag to Claude Code');
  console.log('\nAlso run: npm run test:run to confirm 381 tests still passing');
}

run().catch(console.error);