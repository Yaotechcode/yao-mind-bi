import { describe, it, expect } from 'vitest';
import { joinRecords } from '../../../src/server/pipeline/joiner.js';
import type { NormalisedRecord, NormaliseResult, PipelineIndexes } from '../../../src/shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(fileType: string, records: NormalisedRecord[]): NormaliseResult {
  return { fileType, records, recordCount: records.length, normalisedAt: new Date().toISOString() };
}

function makeEmptyIndexes(): PipelineIndexes {
  return {
    feeEarnerById: new Map(), feeEarnerByName: new Map(), feeEarnerByNameFuzzy: [],
    matterById: new Map(), matterByNumber: new Map(),
    invoiceByMatterNumber: new Map(), clientById: new Map(), clientByName: new Map(),
    disbursementByMatterId: new Map(), taskByMatterId: new Map(),
    matterNumbersInWip: new Set(), matterNumbersInMatters: new Set(),
    matterNumbersInInvoices: new Set(), lawyerIdsInWip: new Set(), lawyerIdsInFeeEarners: new Set(),
  };
}

function makeIndexes(overrides: Partial<PipelineIndexes> = {}): PipelineIndexes {
  return { ...makeEmptyIndexes(), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Time entry — matched matter
// ---------------------------------------------------------------------------

describe('joinRecords — time entry matched to matter', () => {
  it('sets hasMatchedMatter: true and copies clientName when matter found by matterNumber', () => {
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', clientName: 'Acme Corp', status: 'Active' };
    const entry: NormalisedRecord = { entryId: 'e-001', matterNumber: '1001', billableValue: 500, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeIndexes({ matterByNumber: new Map([['1001', matter]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0].hasMatchedMatter).toBe(true);
    expect(result.timeEntries[0].clientName).toBe('Acme Corp');
    expect(result.timeEntries[0].matterId).toBe('m-001');
  });

  it('sets hasMatchedMatter: true when matter found by matterId', () => {
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active' };
    const entry: NormalisedRecord = { entryId: 'e-001', matterId: 'm-001', billableValue: 200, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeIndexes({ matterById: new Map([['m-001', matter]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0].hasMatchedMatter).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Time entry — orphaned (no matching matter)
// ---------------------------------------------------------------------------

describe('joinRecords — orphaned time entry', () => {
  it('sets hasMatchedMatter: false and _orphanReason when no matching matter', () => {
    const entry: NormalisedRecord = { entryId: 'e-001', matterNumber: '9999', billableValue: 750, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0].hasMatchedMatter).toBe(false);
    expect(result.timeEntries[0]._orphanReason).toBe('no_matching_matter');
  });

  it('does NOT reject orphaned entries — they appear in timeEntries array', () => {
    const entry: NormalisedRecord = { entryId: 'e-001', matterNumber: '9999', billableValue: 750, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries).toHaveLength(1);
    expect(result.timeEntries[0].billableValue).toBe(750);
  });

  it('counts orphaned entries and their total billableValue in joinStats', () => {
    const entries: NormalisedRecord[] = [
      { entryId: 'e-001', matterNumber: '9999', billableValue: 750, doNotBill: false },
      { entryId: 'e-002', matterNumber: '9999', billableValue: 250, doNotBill: false },
    ];
    const datasets = { wipJson: makeResult('wipJson', entries) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);

    expect(result.joinStats.timeEntries.orphaned).toBe(2);
    expect(result.joinStats.timeEntries.orphanedValue).toBeCloseTo(1000);
    expect(result.joinStats.timeEntries.matched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Time entry — fee earner resolution
// ---------------------------------------------------------------------------

describe('joinRecords — fee earner resolution', () => {
  it('resolves lawyerGrade and lawyerPayModel from fee earner record by lawyerId', () => {
    const feeEarner: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith', grade: 'Partner', payModel: 'FeeShare' };
    const entry: NormalisedRecord = { entryId: 'e-001', lawyerId: 'fe-001', matterNumber: '1001', billableValue: 100, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeIndexes({ feeEarnerById: new Map([['fe-001', feeEarner]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0]._lawyerResolved).toBe(true);
    expect(result.timeEntries[0].lawyerGrade).toBe('Partner');
    expect(result.timeEntries[0].lawyerPayModel).toBe('FeeShare');
  });

  it('falls back to fuzzy name match when lawyerId not in index', () => {
    const feeEarner: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith', grade: 'Associate', payModel: 'Salaried' };
    const entry: NormalisedRecord = { entryId: 'e-001', lawyerName: 'J. Smith', matterNumber: '1001', billableValue: 100, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeIndexes({
      feeEarnerByName: new Map([['john smith', feeEarner]]),
      feeEarnerByNameFuzzy: [{ name: 'John Smith', normalised: 'john smith', record: feeEarner }],
    });

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0]._lawyerResolved).toBe(true);
    expect(result.timeEntries[0].lawyerGrade).toBe('Associate');
  });

  it('sets _lawyerResolved: false and lawyerGrade: null when no match found', () => {
    const entry: NormalisedRecord = { entryId: 'e-001', lawyerName: 'Unknown Person', billableValue: 100, doNotBill: false };
    const datasets = { wipJson: makeResult('wipJson', [entry]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);

    expect(result.timeEntries[0]._lawyerResolved).toBe(false);
    expect(result.timeEntries[0].lawyerGrade).toBeNull();
  });

  it('tracks lawyerResolved/lawyerUnresolved counts in joinStats', () => {
    const feeEarner: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'Alice', grade: 'Partner', payModel: 'FeeShare' };
    const entries: NormalisedRecord[] = [
      { entryId: 'e-001', lawyerId: 'fe-001', billableValue: 100, doNotBill: false },
      { entryId: 'e-002', lawyerName: 'Unknown', billableValue: 50, doNotBill: false },
    ];
    const datasets = { wipJson: makeResult('wipJson', entries) };
    const indexes = makeIndexes({ feeEarnerById: new Map([['fe-001', feeEarner]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.joinStats.timeEntries.lawyerResolved).toBe(1);
    expect(result.joinStats.timeEntries.lawyerUnresolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Matter — closed matters supplement
// ---------------------------------------------------------------------------

describe('joinRecords — matter with closed matters data', () => {
  it('sets hasClosedMatterData: true and supplements fields from closedMatters', () => {
    const fullMatter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Completed' };
    const closedMatter: NormalisedRecord = {
      matterId: 'm-001', matterNumber: '1001',
      invoiceNetBilling: 50000, invoicedDisbursements: 2000,
      invoiceOutstanding: 1000, wipBillable: 55000, wipWriteOff: 500,
    };
    const datasets = {
      fullMattersJson: makeResult('fullMattersJson', [fullMatter]),
      closedMattersJson: makeResult('closedMattersJson', [closedMatter]),
    };
    const indexes = makeIndexes({
      matterById: new Map([['m-001', fullMatter]]),
      matterByNumber: new Map([['1001', fullMatter]]),
    });

    const result = joinRecords(datasets, indexes);

    expect(result.matters[0].hasClosedMatterData).toBe(true);
    expect(result.matters[0].invoiceNetBilling).toBe(50000);
    expect(result.matters[0].wipBillable).toBe(55000);
  });

  it('sets hasClosedMatterData: false when no closed matter entry exists', () => {
    const fullMatter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active' };
    const datasets = { fullMattersJson: makeResult('fullMattersJson', [fullMatter]) };
    const indexes = makeIndexes({ matterById: new Map([['m-001', fullMatter]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.matters[0].hasClosedMatterData).toBe(false);
    expect(result.matters[0].invoiceNetBilling ?? null).toBeNull();
  });

  it('does NOT overwrite existing fields from fullMatter with closedMatter values', () => {
    const fullMatter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active', clientName: 'Original Corp' };
    const closedMatter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', clientName: 'Should Not Overwrite', invoiceNetBilling: 10000 };
    const datasets = {
      fullMattersJson: makeResult('fullMattersJson', [fullMatter]),
      closedMattersJson: makeResult('closedMattersJson', [closedMatter]),
    };
    const indexes = makeIndexes({ matterById: new Map([['m-001', fullMatter]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.matters[0].clientName).toBe('Original Corp');
    expect(result.matters[0].invoiceNetBilling).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// 5. Matter — status derived fields
// ---------------------------------------------------------------------------

describe('joinRecords — matter status derived fields', () => {
  it('sets isActive: true for non-terminal status', () => {
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active' };
    const datasets = { fullMattersJson: makeResult('fullMattersJson', [matter]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);
    expect(result.matters[0].isActive).toBe(true);
  });

  it('sets isActive: false and isClosed: true for COMPLETED status', () => {
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'COMPLETED' };
    const datasets = { fullMattersJson: makeResult('fullMattersJson', [matter]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes);
    expect(result.matters[0].isActive).toBe(false);
    expect(result.matters[0].isClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Invoice — overdue detection and age band
// ---------------------------------------------------------------------------

describe('joinRecords — invoice overdue and age band', () => {
  it('sets isOverdue: true, daysOutstanding, and ageBand for overdue invoice', () => {
    const today = new Date('2024-06-01');
    const dueDate = new Date('2024-04-15'); // 47 days overdue
    const invoice: NormalisedRecord = { invoiceId: 'INV-001', matterNumber: '1001', dueDate, outstanding: 5000 };
    const datasets = { invoicesJson: makeResult('invoicesJson', [invoice]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes, today);

    expect(result.invoices[0].isOverdue).toBe(true);
    expect(result.invoices[0].daysOutstanding).toBeGreaterThan(0);
    expect(result.invoices[0].ageBand).toBe('31-60');
  });

  it('sets isOverdue: false for invoice with zero outstanding', () => {
    const today = new Date('2024-06-01');
    const dueDate = new Date('2024-04-15');
    const invoice: NormalisedRecord = { invoiceId: 'INV-002', matterNumber: '1001', dueDate, outstanding: 0 };
    const datasets = { invoicesJson: makeResult('invoicesJson', [invoice]) };
    const indexes = makeEmptyIndexes();

    const result = joinRecords(datasets, indexes, today);

    expect(result.invoices[0].isOverdue).toBe(false);
  });

  it('assigns correct age bands', () => {
    const today = new Date('2024-06-01');
    const cases: Array<{ daysAgo: number; expectedBand: string }> = [
      { daysAgo: 15, expectedBand: '0-30' },
      { daysAgo: 45, expectedBand: '31-60' },
      { daysAgo: 75, expectedBand: '61-90' },
      { daysAgo: 100, expectedBand: '91-120' },
      { daysAgo: 150, expectedBand: '120+' },
    ];

    for (const { daysAgo, expectedBand } of cases) {
      const dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() - daysAgo);
      const invoice: NormalisedRecord = { invoiceId: `INV-${daysAgo}`, matterNumber: '1001', dueDate, outstanding: 1000 };
      const datasets = { invoicesJson: makeResult('invoicesJson', [invoice]) };
      const result = joinRecords(datasets, makeEmptyIndexes(), today);
      expect(result.invoices[0].ageBand).toBe(expectedBand);
    }
  });

  it('resolves matterStatus from matter index', () => {
    const today = new Date('2024-06-01');
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active', department: 'Litigation' };
    const invoice: NormalisedRecord = { invoiceId: 'INV-001', matterNumber: '1001', outstanding: 0 };
    const datasets = { invoicesJson: makeResult('invoicesJson', [invoice]) };
    const indexes = makeIndexes({ matterByNumber: new Map([['1001', matter]]) });

    const result = joinRecords(datasets, indexes, today);

    expect(result.invoices[0].matterStatus).toBe('Active');
    expect(result.invoices[0].department).toBe('Litigation');
  });
});

// ---------------------------------------------------------------------------
// 7. JoinStats totals
// ---------------------------------------------------------------------------

describe('joinRecords — joinStats totals', () => {
  it('counts total time entries correctly', () => {
    const entries: NormalisedRecord[] = [
      { entryId: 'e-001', billableValue: 100, doNotBill: false },
      { entryId: 'e-002', billableValue: 200, doNotBill: false },
    ];
    const datasets = { wipJson: makeResult('wipJson', entries) };

    const result = joinRecords(datasets, makeEmptyIndexes());

    expect(result.joinStats.timeEntries.total).toBe(2);
  });

  it('counts invoice matterResolved vs matterUnresolved', () => {
    const matter: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001', status: 'Active' };
    const invoices: NormalisedRecord[] = [
      { invoiceId: 'INV-001', matterNumber: '1001', outstanding: 0 },
      { invoiceId: 'INV-002', matterNumber: '9999', outstanding: 0 },
    ];
    const datasets = { invoicesJson: makeResult('invoicesJson', invoices) };
    const indexes = makeIndexes({ matterByNumber: new Map([['1001', matter]]) });

    const result = joinRecords(datasets, indexes);

    expect(result.joinStats.invoices.matterResolved).toBe(1);
    expect(result.joinStats.invoices.matterUnresolved).toBe(1);
  });
});
