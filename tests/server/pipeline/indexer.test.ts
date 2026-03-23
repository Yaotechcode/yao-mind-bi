import { describe, it, expect } from 'vitest';
import { buildIndexes, normaliseName, fuzzyMatchLawyer } from '../../../src/server/pipeline/indexer.js';
import type { NormaliseResult, NormalisedRecord } from '../../../src/shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(fileType: string, records: NormalisedRecord[]): NormaliseResult {
  return { fileType, records, recordCount: records.length, normalisedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 1. normaliseName
// ---------------------------------------------------------------------------

describe('normaliseName', () => {
  it('lowercases and trims', () => {
    expect(normaliseName('  John Smith  ')).toBe('john smith');
  });

  it('removes Mr/Mrs/Ms/Dr/Prof titles', () => {
    expect(normaliseName('Dr. Jane Doe')).toBe('jane doe');
    expect(normaliseName('Mrs Jane Doe')).toBe('jane doe');
    expect(normaliseName('Prof. Alan Grant')).toBe('alan grant');
  });

  it('collapses multiple spaces', () => {
    expect(normaliseName('John   Smith')).toBe('john smith');
  });
});

// ---------------------------------------------------------------------------
// 2. buildIndexes — basic population
// ---------------------------------------------------------------------------

describe('buildIndexes — basic population', () => {
  it('populates feeEarnerById', () => {
    const feeEarnerRecord: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith' };
    const datasets = {
      feeEarner: makeResult('feeEarner', [feeEarnerRecord]),
    };

    const indexes = buildIndexes(datasets, ['feeEarner']);

    expect(indexes.feeEarnerById.get('fe-001')).toBe(feeEarnerRecord);
  });

  it('populates feeEarnerByName with normalised name', () => {
    const feeEarnerRecord: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith' };
    const datasets = {
      feeEarner: makeResult('feeEarner', [feeEarnerRecord]),
    };

    const indexes = buildIndexes(datasets, ['feeEarner']);

    expect(indexes.feeEarnerByName.get('john smith')).toBe(feeEarnerRecord);
  });

  it('populates feeEarnerByNameFuzzy', () => {
    const feeEarnerRecord: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith' };
    const datasets = {
      feeEarner: makeResult('feeEarner', [feeEarnerRecord]),
    };

    const indexes = buildIndexes(datasets, ['feeEarner']);

    expect(indexes.feeEarnerByNameFuzzy.some(e => e.record === feeEarnerRecord)).toBe(true);
  });

  it('populates matterById and matterByNumber', () => {
    const matterRecord: NormalisedRecord = { matterId: 'm-001', matterNumber: '1001' };
    const datasets = {
      fullMattersJson: makeResult('fullMattersJson', [matterRecord]),
    };

    const indexes = buildIndexes(datasets, ['fullMattersJson']);

    expect(indexes.matterById.get('m-001')).toBe(matterRecord);
    expect(indexes.matterByNumber.get('1001')).toBe(matterRecord);
  });

  it('populates invoiceByMatterNumber as array', () => {
    const inv1: NormalisedRecord = { invoiceId: 'inv-001', matterNumber: '1001' };
    const inv2: NormalisedRecord = { invoiceId: 'inv-002', matterNumber: '1001' };
    const datasets = {
      invoicesJson: makeResult('invoicesJson', [inv1, inv2]),
    };

    const indexes = buildIndexes(datasets, ['invoicesJson']);

    const invoices = indexes.invoiceByMatterNumber.get('1001');
    expect(invoices).toHaveLength(2);
  });

  it('populates disbursementByMatterId as array', () => {
    const disb: NormalisedRecord = { disbursementId: 'd-001', matterId: 'm-001' };
    const datasets = {
      disbursementsJson: makeResult('disbursementsJson', [disb]),
    };

    const indexes = buildIndexes(datasets, ['disbursementsJson']);

    expect(indexes.disbursementByMatterId.get('m-001')).toHaveLength(1);
  });

  it('populates taskByMatterId as array', () => {
    const task: NormalisedRecord = { taskId: 't-001', matterId: 'm-001' };
    const datasets = {
      tasksJson: makeResult('tasksJson', [task]),
    };

    const indexes = buildIndexes(datasets, ['tasksJson']);

    expect(indexes.taskByMatterId.get('m-001')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. buildIndexes — derived Sets
// ---------------------------------------------------------------------------

describe('buildIndexes — derived sets', () => {
  it('matterNumbersInWip captures unique matter numbers from time entries', () => {
    const records: NormalisedRecord[] = [
      { entryId: 'e1', matterNumber: '1001' },
      { entryId: 'e2', matterNumber: '1001' },
      { entryId: 'e3', matterNumber: '1002' },
    ];
    const datasets = {
      wipJson: makeResult('wipJson', records),
    };

    const indexes = buildIndexes(datasets, ['wipJson']);

    expect(indexes.matterNumbersInWip.size).toBe(2);
    expect(indexes.matterNumbersInWip.has('1001')).toBe(true);
    expect(indexes.matterNumbersInWip.has('1002')).toBe(true);
  });

  it('matterNumbersInMatters captures numbers from fullMattersJson', () => {
    const records: NormalisedRecord[] = [
      { matterId: 'm1', matterNumber: '2001' },
      { matterId: 'm2', matterNumber: '2002' },
    ];
    const datasets = {
      fullMattersJson: makeResult('fullMattersJson', records),
    };

    const indexes = buildIndexes(datasets, ['fullMattersJson']);

    expect(indexes.matterNumbersInMatters.size).toBe(2);
  });

  it('matterNumbersInInvoices captures numbers from invoicesJson', () => {
    const records: NormalisedRecord[] = [
      { invoiceId: 'i1', matterNumber: '3001' },
    ];
    const datasets = {
      invoicesJson: makeResult('invoicesJson', records),
    };

    const indexes = buildIndexes(datasets, ['invoicesJson']);

    expect(indexes.matterNumbersInInvoices.has('3001')).toBe(true);
  });

  it('lawyerIdsInFeeEarners captures IDs from feeEarner dataset', () => {
    const records: NormalisedRecord[] = [
      { lawyerId: 'fe-001', lawyerName: 'Alice' },
      { lawyerId: 'fe-002', lawyerName: 'Bob' },
    ];
    const datasets = {
      feeEarner: makeResult('feeEarner', records),
    };

    const indexes = buildIndexes(datasets, ['feeEarner']);

    expect(indexes.lawyerIdsInFeeEarners.has('fe-001')).toBe(true);
    expect(indexes.lawyerIdsInFeeEarners.has('fe-002')).toBe(true);
  });

  it('lawyerIdsInWip captures IDs from wipJson dataset', () => {
    const records: NormalisedRecord[] = [
      { entryId: 'e1', lawyerId: 'fe-001', matterNumber: '1001' },
    ];
    const datasets = {
      wipJson: makeResult('wipJson', records),
    };

    const indexes = buildIndexes(datasets, ['wipJson']);

    expect(indexes.lawyerIdsInWip.has('fe-001')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. fuzzyMatchLawyer
// ---------------------------------------------------------------------------

describe('fuzzyMatchLawyer', () => {
  const johnSmith: NormalisedRecord = { lawyerId: 'fe-001', lawyerName: 'John Smith' };

  function makeIndexesWithFeeEarner(record: NormalisedRecord) {
    return buildIndexes(
      { feeEarner: makeResult('feeEarner', [record]) },
      ['feeEarner']
    );
  }

  it('matches by exact normalised name', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('John Smith', indexes)).toBe(johnSmith);
  });

  it('matches "J. Smith" to "John Smith" via initials+surname', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('J. Smith', indexes)).toBe(johnSmith);
  });

  it('matches "J Smith" (no dot) to "John Smith"', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('J Smith', indexes)).toBe(johnSmith);
  });

  it('matches by surname only: "Smith" → "John Smith"', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('Smith', indexes)).toBe(johnSmith);
  });

  it('returns null for completely unknown name', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('Unknown Person', indexes)).toBeNull();
  });

  it('returns null for empty string', () => {
    const indexes = makeIndexesWithFeeEarner(johnSmith);
    expect(fuzzyMatchLawyer('', indexes)).toBeNull();
  });
});
