import { describe, it, expect } from 'vitest';

import {
  aggregateWipByMatter,
  aggregateWipByFeeEarner,
  computeRecordingGapDays,
  buildWipEnrichment,
} from '../../../../src/server/datasource/enrich/wip-aggregator.js';

import type { NormalisedTimeEntry } from '../../../../src/server/datasource/normalise/types.js';

// =============================================================================
// Fixture builder
// =============================================================================

function makeEntry(o: Partial<NormalisedTimeEntry> = {}): NormalisedTimeEntry {
  return {
    _id: 'te-1',
    description: 'Drafting',
    activityType: 'Drafting',
    durationHours: 1,
    isChargeable: true,
    doNotBill: false,
    rate: 250,
    clientRate: null,
    units: 6,
    billable: 250,
    writeOff: 0,
    recordedValue: 250,
    status: 'ACTIVE',
    lawyerId: 'att-1',
    lawyerName: 'Alice Smith',
    lawyerDefaultRate: 250,
    lawyerStatus: 'ACTIVE',
    lawyerIntegrationId: null,
    matterId: 'matter-1',
    matterNumber: 1001,
    invoice: null,
    date: '2024-03-01',
    createdAt: '2024-03-01T00:00:00Z',
    updatedAt: '2024-03-01T00:00:00Z',
    ...o,
  };
}

// =============================================================================
// aggregateWipByMatter
// =============================================================================

describe('aggregateWipByMatter()', () => {
  it('groups entries by matterId', () => {
    const entries = [
      makeEntry({ _id: 'te-1', matterId: 'matter-1' }),
      makeEntry({ _id: 'te-2', matterId: 'matter-2' }),
      makeEntry({ _id: 'te-3', matterId: 'matter-1' }),
    ];
    const result = aggregateWipByMatter(entries);
    expect(result.size).toBe(2);
    expect(result.get('matter-1')?.entryCount).toBe(2);
    expect(result.get('matter-2')?.entryCount).toBe(1);
  });

  it('sums totalHours across entries for same matter', () => {
    const entries = [
      makeEntry({ matterId: 'matter-1', durationHours: 1.5 }),
      makeEntry({ matterId: 'matter-1', durationHours: 2.0 }),
    ];
    const result = aggregateWipByMatter(entries);
    expect(result.get('matter-1')?.totalHours).toBeCloseTo(3.5);
  });

  it('sums totalBillable and totalWriteOff', () => {
    const entries = [
      makeEntry({ matterId: 'matter-1', billable: 250, writeOff: 50, recordedValue: 300 }),
      makeEntry({ matterId: 'matter-1', billable: 300, writeOff: 0,  recordedValue: 300 }),
    ];
    const result = aggregateWipByMatter(entries);
    expect(result.get('matter-1')?.totalBillable).toBe(550);
    expect(result.get('matter-1')?.totalWriteOff).toBe(50);
    expect(result.get('matter-1')?.totalRecorded).toBe(600);
  });

  it('separates chargeable from non-chargeable hours', () => {
    const entries = [
      makeEntry({ matterId: 'matter-1', isChargeable: true,  durationHours: 2 }),
      makeEntry({ matterId: 'matter-1', isChargeable: false, durationHours: 1 }),
    ];
    const result = aggregateWipByMatter(entries);
    const summary = result.get('matter-1')!;
    expect(summary.chargeableHours).toBe(2);
    expect(summary.nonChargeableHours).toBe(1);
    expect(summary.totalHours).toBe(3);
  });

  it('tracks lastEntryDate as the latest date', () => {
    const entries = [
      makeEntry({ matterId: 'matter-1', date: '2024-01-15' }),
      makeEntry({ matterId: 'matter-1', date: '2024-03-20' }),
      makeEntry({ matterId: 'matter-1', date: '2024-02-10' }),
    ];
    const result = aggregateWipByMatter(entries);
    expect(result.get('matter-1')?.lastEntryDate).toBe('2024-03-20');
  });

  it('excludes entries with no matterId', () => {
    const entries = [
      makeEntry({ matterId: 'matter-1' }),
      makeEntry({ matterId: null as unknown as string }),
    ];
    const result = aggregateWipByMatter(entries);
    expect(result.size).toBe(1);
    expect(result.has('matter-1')).toBe(true);
  });

  it('returns empty map for empty input', () => {
    expect(aggregateWipByMatter([])).toEqual(new Map());
  });
});

// =============================================================================
// aggregateWipByFeeEarner
// =============================================================================

describe('aggregateWipByFeeEarner()', () => {
  it('groups entries by lawyerId', () => {
    const entries = [
      makeEntry({ _id: 'te-1', lawyerId: 'att-1' }),
      makeEntry({ _id: 'te-2', lawyerId: 'att-2' }),
      makeEntry({ _id: 'te-3', lawyerId: 'att-1' }),
    ];
    const result = aggregateWipByFeeEarner(entries);
    expect(result.size).toBe(2);
    expect(result.get('att-1')?.entryCount).toBe(2);
    expect(result.get('att-2')?.entryCount).toBe(1);
  });

  it('groups entries with no lawyerId under __unknown__', () => {
    const entries = [
      makeEntry({ lawyerId: null }),
      makeEntry({ lawyerId: null }),
    ];
    const result = aggregateWipByFeeEarner(entries);
    expect(result.get('__unknown__')?.entryCount).toBe(2);
  });

  it('sums billable correctly per fee earner', () => {
    const entries = [
      makeEntry({ lawyerId: 'att-1', billable: 250, recordedValue: 250 }),
      makeEntry({ lawyerId: 'att-1', billable: 300, recordedValue: 300 }),
    ];
    const result = aggregateWipByFeeEarner(entries);
    expect(result.get('att-1')?.totalBillable).toBe(550);
  });

  it('separates chargeable/non-chargeable hours per fee earner', () => {
    const entries = [
      makeEntry({ lawyerId: 'att-1', isChargeable: true,  durationHours: 3 }),
      makeEntry({ lawyerId: 'att-1', isChargeable: false, durationHours: 1 }),
    ];
    const result = aggregateWipByFeeEarner(entries);
    const s = result.get('att-1')!;
    expect(s.chargeableHours).toBe(3);
    expect(s.nonChargeableHours).toBe(1);
  });
});

// =============================================================================
// activityBreakdown
// =============================================================================

describe('activityBreakdown', () => {
  it('groups by activityType correctly', () => {
    const entries = [
      makeEntry({ activityType: 'Drafting',   durationHours: 1, billable: 250 }),
      makeEntry({ activityType: 'Telephone',  durationHours: 0.5, billable: 125 }),
      makeEntry({ activityType: 'Drafting',   durationHours: 2, billable: 500 }),
    ];
    const result = aggregateWipByMatter(entries);
    const breakdown = result.get('matter-1')?.activityBreakdown;
    expect(breakdown?.['Drafting']?.hours).toBeCloseTo(3);
    expect(breakdown?.['Drafting']?.value).toBe(750);
    expect(breakdown?.['Telephone']?.hours).toBe(0.5);
    expect(breakdown?.['Telephone']?.value).toBe(125);
  });

  it('groups null activityType under __unknown__', () => {
    const entries = [
      makeEntry({ activityType: null, durationHours: 1, billable: 200 }),
    ];
    const result = aggregateWipByMatter(entries);
    const breakdown = result.get('matter-1')?.activityBreakdown;
    expect(breakdown?.['__unknown__']).toBeDefined();
    expect(breakdown?.['__unknown__']?.hours).toBe(1);
  });

  it('accumulates multiple activities for same type', () => {
    const entries = [
      makeEntry({ activityType: 'Email', durationHours: 0.25, billable: 50 }),
      makeEntry({ activityType: 'Email', durationHours: 0.25, billable: 50 }),
      makeEntry({ activityType: 'Email', durationHours: 0.5,  billable: 100 }),
    ];
    const result = aggregateWipByMatter(entries);
    const breakdown = result.get('matter-1')?.activityBreakdown;
    expect(breakdown?.['Email']?.hours).toBe(1);
    expect(breakdown?.['Email']?.value).toBe(200);
  });
});

// =============================================================================
// computeRecordingGapDays
// =============================================================================

describe('computeRecordingGapDays()', () => {
  it('returns 0 when last entry is today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [makeEntry({ lawyerId: 'att-1', date: today })];
    expect(computeRecordingGapDays(entries, 'att-1')).toBe(0);
  });

  it('returns correct gap in days', () => {
    const ref = new Date('2024-03-20');
    const entries = [makeEntry({ lawyerId: 'att-1', date: '2024-03-15' })];
    expect(computeRecordingGapDays(entries, 'att-1', ref)).toBe(5);
  });

  it('returns null when no entries exist for the lawyer', () => {
    const entries = [makeEntry({ lawyerId: 'att-2' })];
    expect(computeRecordingGapDays(entries, 'att-1')).toBeNull();
  });

  it('returns null for empty entries array', () => {
    expect(computeRecordingGapDays([], 'att-1')).toBeNull();
  });

  it('uses the most recent entry date, not the first', () => {
    const ref = new Date('2024-03-20');
    const entries = [
      makeEntry({ lawyerId: 'att-1', date: '2024-03-10' }), // 10 days ago
      makeEntry({ lawyerId: 'att-1', date: '2024-03-18' }), // 2 days ago — most recent
      makeEntry({ lawyerId: 'att-1', date: '2024-03-05' }), // 15 days ago
    ];
    expect(computeRecordingGapDays(entries, 'att-1', ref)).toBe(2);
  });

  it('ignores entries belonging to other lawyers', () => {
    const ref = new Date('2024-03-20');
    const entries = [
      makeEntry({ lawyerId: 'att-2', date: '2024-03-19' }), // recent but different lawyer
      makeEntry({ lawyerId: 'att-1', date: '2024-03-10' }),
    ];
    expect(computeRecordingGapDays(entries, 'att-1', ref)).toBe(10);
  });

  it('returns 0 (not negative) when reference date is before last entry', () => {
    const ref = new Date('2024-03-01');
    const entries = [makeEntry({ lawyerId: 'att-1', date: '2024-03-05' })];
    expect(computeRecordingGapDays(entries, 'att-1', ref)).toBe(0);
  });
});

// =============================================================================
// buildWipEnrichment
// =============================================================================

describe('buildWipEnrichment()', () => {
  it('returns all four keys', () => {
    const result = buildWipEnrichment([makeEntry()]);
    expect(result).toHaveProperty('byMatter');
    expect(result).toHaveProperty('byFeeEarner');
    expect(result).toHaveProperty('orphaned');
    expect(result).toHaveProperty('totalStats');
  });

  it('separates orphaned entries (no matterId)', () => {
    const entries = [
      makeEntry({ _id: 'te-1', matterId: 'matter-1' }),
      makeEntry({ _id: 'te-2', matterId: null as unknown as string }),
    ];
    const result = buildWipEnrichment(entries);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]._id).toBe('te-2');
  });

  it('orphaned entries are NOT included in byMatter', () => {
    const entries = [
      makeEntry({ _id: 'te-1', matterId: 'matter-1' }),
      makeEntry({ _id: 'te-2', matterId: null as unknown as string }),
    ];
    const result = buildWipEnrichment(entries);
    expect(result.byMatter.size).toBe(1);
  });

  it('orphaned entries ARE counted in byFeeEarner totals', () => {
    const entries = [
      makeEntry({ lawyerId: 'att-1', matterId: 'matter-1', durationHours: 1 }),
      makeEntry({ lawyerId: 'att-1', matterId: null as unknown as string, durationHours: 2 }),
    ];
    const result = buildWipEnrichment(entries);
    // Both entries by att-1 should be in fee earner map
    expect(result.byFeeEarner.get('att-1')?.totalHours).toBeCloseTo(3);
  });

  it('totalStats sums across all entries including orphaned', () => {
    const entries = [
      makeEntry({ billable: 200, writeOff: 0,  recordedValue: 200, durationHours: 1 }),
      makeEntry({ billable: 300, writeOff: 50, recordedValue: 350, durationHours: 1.5 }),
    ];
    const result = buildWipEnrichment(entries);
    expect(result.totalStats.totalBillable).toBe(500);
    expect(result.totalStats.totalWriteOff).toBe(50);
    expect(result.totalStats.totalRecorded).toBe(550);
    expect(result.totalStats.totalHours).toBeCloseTo(2.5);
    expect(result.totalStats.entryCount).toBe(2);
  });

  it('handles empty input', () => {
    const result = buildWipEnrichment([]);
    expect(result.byMatter.size).toBe(0);
    expect(result.byFeeEarner.size).toBe(0);
    expect(result.orphaned).toHaveLength(0);
    expect(result.totalStats.entryCount).toBe(0);
  });
});
