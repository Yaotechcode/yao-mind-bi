import { joinRecords } from '../src/server/pipeline/joiner';
import { enrichRecords } from '../src/server/pipeline/enricher';
import { buildIndexes } from '../src/server/pipeline/indexer';
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

  // ── TEST DATA ────────────────────────────────────────────────────────────

  const normalisedDatasets: Record<string, NormaliseResult> = {
    feeEarner: makeDataset('feeEarnerCsv', [
      { lawyerId: 'fe-001', lawyerName: 'John Smith',  department: 'Commercial', grade: 'Partner',           payModel: 'Salaried' },
      { lawyerId: 'fe-002', lawyerName: 'Sarah Jones', department: 'Family',     grade: 'Senior Associate',  payModel: 'FeeShare' },
      { lawyerId: 'fe-003', lawyerName: 'David Brown', department: 'Commercial', grade: 'Solicitor',         payModel: 'Salaried' },
    ]),
    fullMattersJson: makeDataset('fullMattersJson', [
      { matterId: 'm-001', matterNumber: '1001', responsibleLawyerId: 'fe-001', responsibleLawyer: 'John Smith',  department: 'Commercial', status: 'IN_PROGRESS', clientName: 'Acme Corp',  budget: 10000, createdDate: new Date('2023-01-01') },
      { matterId: 'm-002', matterNumber: '1002', responsibleLawyerId: 'fe-002', responsibleLawyer: 'Sarah Jones', department: 'Family',     status: 'COMPLETED',   clientName: 'Bob Ltd',   budget: 5000,  createdDate: new Date('2023-06-01') },
      { matterId: 'm-003', matterNumber: '1003', responsibleLawyerId: 'fe-003', responsibleLawyer: 'David Brown', department: 'Commercial', status: 'IN_PROGRESS', clientName: null,        budget: 8000,  createdDate: new Date('2023-09-01') },
    ]),
    closedMattersJson: makeDataset('closedMattersJson', [
      // Supplements m-002 with additional billing data
      { matterId: 'm-002', matterNumber: '1002', invoiceNetBilling: 4800, wipBillable: 5200, wipWriteOff: 400 },
    ]),
    wipJson: makeDataset('wipJson', [
      { entryId: 'w-001', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-01-15'), billableValue: 500,  durationMinutes: 60,  doNotBill: false, rate: 300 },
      { entryId: 'w-002', matterId: 'm-002', matterNumber: '1002', lawyerId: 'fe-002', lawyerName: 'Sarah Jones', date: new Date('2024-01-20'), billableValue: 300,  durationMinutes: 36,  doNotBill: false, rate: 300 },
      { entryId: 'w-003', matterId: null,    matterNumber: null,   lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-02-01'), billableValue: 400,  durationMinutes: 48,  doNotBill: false, rate: 300 }, // orphaned
      { entryId: 'w-004', matterId: 'm-001', matterNumber: '1001', lawyerId: null,     lawyerName: 'J. Smith',    date: new Date('2024-02-10'), billableValue: 250,  durationMinutes: 30,  doNotBill: false, rate: 300 }, // fuzzy lawyer
      { entryId: 'w-005', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', lawyerName: 'John Smith',  date: new Date('2024-02-15'), billableValue: 0,    durationMinutes: 30,  doNotBill: true,  rate: 300 }, // non-chargeable
    ]),
    invoicesJson: makeDataset('invoicesJson', [
      { invoiceId: 'inv-001', matterNumber: '1001', responsibleLawyerId: 'fe-001', subtotal: 2000, total: 2400, outstanding: 0,    paid: 2400, invoiceDate: new Date('2024-01-01'), dueDate: new Date('2024-02-01') },
      { invoiceId: 'inv-002', matterNumber: '1002', responsibleLawyerId: 'fe-002', subtotal: 1500, total: 1800, outstanding: 1800, paid: 0,    invoiceDate: new Date('2024-01-15'), dueDate: new Date('2024-02-15') }, // overdue
      // m-003 has no invoice — client resolution via invoice fallback won't apply
    ]),
    disbursementsJson: makeDataset('disbursementsJson', [
      { transactionId: 'd-001', matterId: 'm-001', matterNumber: '1001', responsibleLawyerId: 'fe-001', subtotal: 200, outstanding: 0,   date: new Date('2024-01-10') },
      { transactionId: 'd-002', matterId: 'm-002', matterNumber: '1002', responsibleLawyerId: 'fe-002', subtotal: 150, outstanding: 150, date: new Date('2024-01-20') },
    ]),
    tasksJson: makeDataset('tasksJson', [
      { taskId: 't-001', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', title: 'Review contract', dueDate: new Date('2024-02-28'), priority: 'HIGH',     status: 'IN_PROGRESS' },
      { taskId: 't-002', matterId: 'm-001', matterNumber: '1001', lawyerId: 'fe-001', title: 'File documents',  dueDate: new Date('2024-01-15'), priority: 'STANDARD', status: 'IN_PROGRESS' }, // overdue
    ]),
    contactsJson: makeDataset('contactsJson', [
      { contactId: 'c-001', displayName: 'Acme Corp' },
      { contactId: 'c-002', displayName: 'Bob Ltd' },
    ]),
  };

  const indexes = buildIndexes(normalisedDatasets, Object.keys(normalisedDatasets));

  // ── JOIN ─────────────────────────────────────────────────────────────────

  console.log('\n--- JOIN: joinRecords ---');

  let joinResult: any;
  try {
    joinResult = joinRecords(normalisedDatasets, indexes, TODAY);
    console.log('✅ joinRecords completed without errors');
    console.log(`   timeEntries: ${joinResult.timeEntries?.length}`);
    console.log(`   matters: ${joinResult.matters?.length}`);
    console.log(`   invoices: ${joinResult.invoices?.length}`);
    console.log(`   disbursements: ${joinResult.disbursements?.length}`);
    console.log(`   tasks: ${joinResult.tasks?.length}`);
    console.log(`   feeEarners: ${joinResult.feeEarners?.length}`);
    console.log(`   clients: ${joinResult.clients?.length}`);
    console.log(`   departments: ${joinResult.departments?.length}`);
  } catch (e: any) {
    console.error('❌ joinRecords threw:', e.message);
    console.error(e.stack);
    process.exit(1);
  }

  // ── ORPHANED WIP — kept, flagged, included in totals ────────────────────

  console.log('\n--- ORPHANED WIP ---');

  const w003 = joinResult.timeEntries?.find((e: any) => e.entryId === 'w-003');
  console.log(w003 !== undefined ? '✅' : '❌',
    `Orphaned entry w-003 is kept (not discarded)`);
  console.log(w003?.hasMatchedMatter === false ? '✅' : '❌',
    `Orphaned w-003 hasMatchedMatter=false: ${w003?.hasMatchedMatter}`);
  console.log(w003?._orphanReason !== undefined ? '✅' : '⚠️ ',
    `Orphaned w-003 has _orphanReason: "${w003?._orphanReason}"`);

  // Stats should include orphaned value
  const teStats = joinResult.stats?.timeEntries ?? joinResult.joinStats?.timeEntries;
  console.log(teStats?.orphaned >= 1 ? '✅' : '⚠️ ',
    `joinStats.timeEntries.orphaned: ${teStats?.orphaned} (expected ≥1)`);
  console.log(teStats?.orphanedValue >= 400 ? '✅' : '⚠️ ',
    `joinStats.timeEntries.orphanedValue: ${teStats?.orphanedValue} (expected ≥400)`);
  console.log(joinResult.timeEntries?.length === 5 ? '✅' : '❌',
    `Total timeEntries: ${joinResult.timeEntries?.length} (expected 5 — orphan kept)`);

  // ── CLOSED MATTERS SUPPLEMENTING ────────────────────────────────────────

  console.log('\n--- CLOSED MATTERS SUPPLEMENT ---');

  const m002 = joinResult.matters?.find((m: any) => m.matterId === 'm-002');
  console.log(m002 !== undefined ? '✅' : '❌', `m-002 found in enriched matters`);
  console.log(m002?.invoiceNetBilling === 4800 ? '✅' : '⚠️ ',
    `m-002 invoiceNetBilling from closed data: ${m002?.invoiceNetBilling} (expected 4800)`);
  console.log(m002?.wipBillable === 5200 ? '✅' : '⚠️ ',
    `m-002 wipBillable from closed data: ${m002?.wipBillable} (expected 5200)`);

  // Original full matters fields should NOT be overwritten
  console.log(m002?.clientName === 'Bob Ltd' ? '✅' : '❌',
    `m-002 clientName preserved from full matters: "${m002?.clientName}" (expected "Bob Ltd")`);
  console.log(m002?.status === 'COMPLETED' ? '✅' : '❌',
    `m-002 status preserved: "${m002?.status}" (expected "COMPLETED")`);

  // ── FUZZY LAWYER MATCHING ────────────────────────────────────────────────

  console.log('\n--- FUZZY LAWYER MATCHING ---');

  const w004 = joinResult.timeEntries?.find((e: any) => e.entryId === 'w-004');
  console.log(w004?._lawyerResolved === true ? '✅' : '⚠️ ',
    `w-004 "J. Smith" lawyer resolved: ${w004?._lawyerResolved}`);
  console.log(w004?.lawyerName === 'John Smith' ? '✅' : '⚠️ ',
    `w-004 lawyerName resolved to: "${w004?.lawyerName}" (expected "John Smith")`);
  console.log(w004?.lawyerGrade !== null && w004?.lawyerGrade !== undefined ? '✅' : '⚠️ ',
    `w-004 lawyerGrade populated: "${w004?.lawyerGrade}"`);

  // ── INVOICE AGE BANDS ────────────────────────────────────────────────────

  console.log('\n--- INVOICE AGE BANDS ---');

  // inv-002: dueDate 2024-02-15, TODAY 2024-03-01 → 15 days overdue → band "0-30"
  const inv002 = joinResult.invoices?.find((i: any) => i.invoiceId === 'inv-002');
  console.log(inv002?.isOverdue === true ? '✅' : '❌',
    `inv-002 isOverdue: ${inv002?.isOverdue} (expected true)`);
  console.log(inv002?.ageBand !== undefined ? '✅' : '⚠️ ',
    `inv-002 ageBand: "${inv002?.ageBand}" (expected "0-30" — 15 days overdue)`);
  console.log(typeof inv002?.daysOutstanding === 'number' ? '✅' : '⚠️ ',
    `inv-002 daysOutstanding: ${inv002?.daysOutstanding}`);

  // inv-001: fully paid, not overdue
  const inv001 = joinResult.invoices?.find((i: any) => i.invoiceId === 'inv-001');
  console.log(inv001?.isOverdue === false ? '✅' : '⚠️ ',
    `inv-001 isOverdue: ${inv001?.isOverdue} (expected false — fully paid)`);

// ── DEPARTMENT RECORDS ───────────────────────────────────────────────────

  console.log('\n--- DEPARTMENT SYNTHESIS ---');

  // Departments are synthesised in Stage 5 (enrichRecords), not Stage 4 (joinRecords)
  // Check enriched result, not joinResult
  const depts = enriched.departments ?? [];
  console.log(depts.length >= 2 ? '✅' : '⚠️ ',
    `Departments created after enrich: ${depts.length} (expected ≥2: Commercial, Family)`);
  const commercial = depts.find((d: any) => d.name === 'Commercial');
  const family     = depts.find((d: any) => d.name === 'Family');
  console.log(commercial !== undefined ? '✅' : '⚠️ ', `Commercial department exists`);
  console.log(family !== undefined ? '✅' : '⚠️ ',     `Family department exists`);

  // Confirm join stage intentionally has empty departments (built in Stage 5)
  console.log(joinResult.departments?.length === 0 ? '✅' : '⚠️ ',
    `joinResult.departments is empty pre-enrich: ${joinResult.departments?.length} (expected 0 — by design)`);

  // ── CLIENT RESOLUTION ────────────────────────────────────────────────────

  console.log('\n--- CLIENT RESOLUTION ---');

  const clients = joinResult.clients ?? [];
  console.log(clients.length >= 2 ? '✅' : '⚠️ ',
    `Clients resolved: ${clients.length} (expected ≥2)`);
  const acme = clients.find((c: any) => c.displayName === 'Acme Corp' || c.clientName === 'Acme Corp');
  console.log(acme !== undefined ? '✅' : '⚠️ ', `Acme Corp client found`);

  // ── ENRICH ───────────────────────────────────────────────────────────────

  console.log('\n--- ENRICH: enrichRecords ---');

  let enriched: any;
  try {
    enriched = enrichRecords(joinResult, TODAY);
    console.log('✅ enrichRecords completed without errors');
  } catch (e: any) {
    console.error('❌ enrichRecords threw:', e.message);
    process.exit(1);
  }

  // durationHours
  const ew001 = enriched.timeEntries?.find((e: any) => e.entryId === 'w-001');
  console.log(ew001?.durationHours === 1 ? '✅' : '⚠️ ',
    `w-001 durationHours: ${ew001?.durationHours} (expected 1 — 60 mins)`);

  // isChargeable
  const ew005 = enriched.timeEntries?.find((e: any) => e.entryId === 'w-005');
  console.log(ew005?.isChargeable === false ? '✅' : '⚠️ ',
    `w-005 isChargeable: ${ew005?.isChargeable} (expected false — doNotBill=true)`);
  console.log(ew001?.isChargeable === true ? '✅' : '⚠️ ',
    `w-001 isChargeable: ${ew001?.isChargeable} (expected true)`);

  // recordedValue = rate × durationHours
  console.log(ew001?.recordedValue === 300 ? '✅' : '⚠️ ',
    `w-001 recordedValue: ${ew001?.recordedValue} (expected 300 — £300/hr × 1hr)`);

  // ageInDays: w-001 date=2024-01-15, TODAY=2024-03-01 → 46 days
  console.log(typeof ew001?.ageInDays === 'number' && ew001.ageInDays > 0 ? '✅' : '⚠️ ',
    `w-001 ageInDays: ${ew001?.ageInDays} (expected ~46)`);

  // weekNumber
  console.log(typeof ew001?.weekNumber === 'number' ? '✅' : '⚠️ ',
    `w-001 weekNumber: ${ew001?.weekNumber}`);

  // monthKey
  console.log(ew001?.monthKey === '2024-01' ? '✅' : '⚠️ ',
    `w-001 monthKey: "${ew001?.monthKey}" (expected "2024-01")`);

  // Task overdue flag
  const et002 = enriched.tasks?.find((t: any) => t.taskId === 't-002');
  console.log(et002?.isOverdue === true ? '✅' : '⚠️ ',
    `t-002 isOverdue: ${et002?.isOverdue} (dueDate 2024-01-15 < TODAY 2024-03-01)`);

  // ── TYPESCRIPT ───────────────────────────────────────────────────────────

  console.log('\n--- TYPESCRIPT ---');
  console.log('Run separately: npx tsc --noEmit');
  console.log('Expected: 0 errors');

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-06  ⚠️  = minor, flag to Claude Code');
  console.log('\nAlso run: npm run test:run to confirm 366 tests still passing');
}

run().catch(console.error);